const express     = require('express');
const compression = require('compression');
const path        = require('path');
const fs          = require('fs');
const { Pool }    = require('pg');

const app  = express();
const PORT = process.env.PORT || 8082;

// ─── Postgres ─────────────────────────────────────────────────────────────────
const db = process.env.DATABASE_URL
    ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
    : null;

async function initDb() {
    if (!db) { console.log('[db] DATABASE_URL not set — using in-memory log only'); return; }
    await db.query(`
        CREATE TABLE IF NOT EXISTS lounge_search_log (
            id                          SERIAL       PRIMARY KEY,
            ts                          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
            agent_code                  VARCHAR(20),
            visitor_id                  VARCHAR(100),
            auth_token                  TEXT,
            airport                     VARCHAR(3),
            airport_name                VARCHAR(100),
            departure_date              DATE,
            lounge_from                 VARCHAR(5),
            is_manual                   BOOLEAN      NOT NULL DEFAULT FALSE,
            adults                      SMALLINT,
            children                    SMALLINT,
            infants                     SMALLINT,
            flight_code                 VARCHAR(20),
            flight_departure_time       VARCHAR(5),
            flight_departure_terminal   VARCHAR(30),
            flight_arrival_airport      VARCHAR(3),
            flight_dest                 VARCHAR(100),
            redirect_url                TEXT
        )
    `);
    // Add columns to existing tables that predate this schema version
    await db.query(`ALTER TABLE lounge_search_log ADD COLUMN IF NOT EXISTS airport_name VARCHAR(100)`);
    await db.query(`ALTER TABLE lounge_search_log ADD COLUMN IF NOT EXISTS is_manual BOOLEAN NOT NULL DEFAULT FALSE`);
    await db.query(`CREATE INDEX IF NOT EXISTS lounge_search_log_ts_idx ON lounge_search_log (ts DESC)`);
    console.log('[db] lounge_search_log table ready');
}

initDb().catch(e => console.error('[db] init error:', e.message));

const SELECT_COLS = `
    ts, agent_code AS "agentCode", visitor_id AS "visitorId", auth_token AS "authToken",
    airport, airport_name AS "airportName", departure_date AS "departureDate",
    lounge_from AS "loungeFrom", is_manual AS "isManual",
    adults, children, infants,
    flight_code AS "flightCode",
    flight_departure_time     AS "flightDepartureTime",
    flight_departure_terminal AS "flightDepartureTerminal",
    flight_arrival_airport    AS "flightArrivalAirport",
    flight_dest               AS "flightDest",
    redirect_url              AS "redirectUrl"
`;

async function logSearch(entry) {
    if (!db) return;
    try {
        await db.query(`
            INSERT INTO lounge_search_log (
                agent_code, visitor_id, auth_token,
                airport, airport_name, departure_date, lounge_from, is_manual,
                adults, children, infants,
                flight_code, flight_departure_time, flight_departure_terminal,
                flight_arrival_airport, flight_dest,
                redirect_url
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
        `, [
            entry.agentCode, entry.visitorId || null, entry.authToken || null,
            entry.airport, entry.airportName || null, entry.departureDate, entry.loungeFrom, entry.isManual || false,
            entry.adults, entry.children, entry.infants,
            entry.flightCode || null, entry.flightDepartureTime || null, entry.flightDepartureTerminal || null,
            entry.flightArrivalAirport || null, entry.flightDest || null,
            entry.redirectUrl,
        ]);
    } catch (e) {
        console.error('[db] lounge_search_log insert error:', e.message);
    }
}

const MOUNT_PATH = (process.env.MOUNT_PATH || '').replace(/\/$/, '');

app.use(compression());
app.use(express.json());

// ─── Flight API proxy ─────────────────────────────────────────────────────────
const flightCache = new Map();
const CACHE_TTL   = 4 * 60 * 60 * 1000;

async function flightsHandler(req, res) {
    const { location, date, query = '' } = req.query;

    if (!location || !date)                   return res.status(400).json({ error: 'location and date required' });
    if (!/^[A-Z]{3}$/.test(location))         return res.status(400).json({ error: 'invalid location' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date))   return res.status(400).json({ error: 'invalid date' });

    const key    = location + ':' + date + ':out' + (query ? ':q:' + query : '');
    const cached = flightCache.get(key);
    if (cached && cached.expires > Date.now()) return res.json(cached.data);

    try {
        const params   = new URLSearchParams({ query, location, country: '', departDate: date });
        const url      = `https://www.holidayextras.com/dock-yard/flight/search?${params}`;
        const upstream = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'lounge-wizard/1.0' } });
        if (!upstream.ok) return res.status(upstream.status).json({ error: 'upstream error' });
        const data = await upstream.json();
        flightCache.set(key, { data, expires: Date.now() + CACHE_TTL });
        res.json(data);
    } catch (e) {
        console.error('[flights]', e.message);
        res.status(502).json({ error: 'fetch failed' });
    }
}

// ─── Lounge search ────────────────────────────────────────────────────────────
const searchLog = [];
const LOG_MAX   = 200;

function buildHxUrl({ airport, departureDate, loungeFrom, adults, children, infants, flight, agentCode }) {
    const from = `${departureDate} ${loungeFrom}:00`;
    const hashParams = new URLSearchParams({
        agent:        agentCode || 'WEB1',
        ppts:         '',
        customer_ref: '',
        lang:         'en',
        launch_id:    'rddef100',
        campaign_id:  '65642',
        adults:       String(adults || 1),
        children:     String(children || 0),
        infants:      String(infants || 0),
        from,
        depart:       airport,
    });
    if (flight?.departureTerminal) hashParams.set('terminal', flight.departureTerminal);
    if (flight?.code)              hashParams.set('flight',   flight.code);
    // URLSearchParams encodes spaces as + but HX expects %20
    return `https://www.holidayextras.com/static/?selectProduct=lo#/lounge?${hashParams.toString().replace(/\+/g, '%20')}`;
}

// HolidayExtras sets auth_token as HttpOnly so JS can't read it, but the
// browser still sends it in the Cookie header on same-domain POSTs.
function readAuthTokenFromCookie(req) {
    const raw = req.headers.cookie;
    if (!raw) return null;
    const m = raw.match(/(?:^|;\s*)auth_token=([^;]+)/);
    if (!m) return null;
    try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; }
}

function loungeSearchHandler(req, res) {
    const { airport, airportName, departureDate, loungeFrom, isManual, adults, children, infants, flight, agentCode, visitorId, authToken, prefetch } = req.body || {};

    if (!airport || !departureDate || !loungeFrom)
        return res.status(400).json({ error: 'missing required lounge fields' });

    const redirectUrl = buildHxUrl(req.body);

    // Summary-page prefetch: just return the URL — do not log.
    if (prefetch) return res.json({ redirectUrl });

    const resolvedAuthToken = readAuthTokenFromCookie(req) || authToken || null;

    const entry = {
        ts:                       new Date().toISOString(),
        agentCode:                agentCode || 'WEB1',
        visitorId:                visitorId || null,
        authToken:                resolvedAuthToken,
        airport,
        airportName:              airportName || null,
        departureDate,
        loungeFrom,
        isManual:                 isManual || false,
        adults:                   adults  || 1,
        children:                 children || 0,
        infants:                  infants  || 0,
        flightCode:               flight?.code              || null,
        flightDepartureTime:      flight?.departureTime     || null,
        flightDepartureTerminal:  flight?.departureTerminal || null,
        flightArrivalAirport:     flight?.arrivalAirport    || null,
        flightDest:               flight?.dest              || null,
        redirectUrl,
    };
    searchLog.push(entry);
    if (searchLog.length > LOG_MAX) searchLog.shift();
    logSearch(entry);

    console.log('\n' + '='.repeat(60));
    console.log('  POST /api/lounge/search');
    console.log(`  ${entry.ts}`);
    console.log(`  ${airport} | ${departureDate} | from ${loungeFrom} | ${adults}A ${children}C ${infants}I`);
    if (flight) console.log(`  flight: ${flight.code} (terminal ${flight.departureTerminal || '-'}) → ${flight.dest || flight.arrivalAirport || ''}`);
    console.log(`  → ${redirectUrl.slice(0, 90)}...`);
    console.log('='.repeat(60) + '\n');

    res.json({ redirectUrl });
}

// ─── Admin log (auth-gated via ?key=ADMIN_KEY) ───────────────────────────────
const ADMIN_KEY = process.env.ADMIN_KEY;

function checkAuth(req, res) {
    if (ADMIN_KEY && req.query.key !== ADMIN_KEY) {
        res.status(401).type('text/plain').send('Unauthorised — add ?key=YOUR_KEY to the URL');
        return false;
    }
    return true;
}

async function fetchRows({ limit = 500, offset = 0, all = false } = {}) {
    if (db) {
        const window = all ? '' : `WHERE ts >= NOW() - INTERVAL '24 hours'`;
        const { rows } = await db.query(
            `SELECT ${SELECT_COLS} FROM lounge_search_log ${window} ORDER BY ts DESC LIMIT $1 OFFSET $2`,
            [limit, offset]
        );
        const { rows: [{ count }] } = await db.query(
            `SELECT COUNT(*) FROM lounge_search_log ${window}`
        );
        return { total: parseInt(count, 10), rows };
    }
    const rows = [...searchLog].reverse();
    return { total: rows.length, rows };
}

async function logHandler(req, res) {
    if (!checkAuth(req, res)) return;
    res.setHeader('Cache-Control', 'no-store');
    const limit  = parseInt(req.query.limit)  || 500;
    const offset = parseInt(req.query.offset) || 0;
    try {
        const { total, rows } = await fetchRows({ limit, offset });
        res.json({ total, limit, offset, rows });
    } catch (e) {
        console.error('[db] log query error:', e.message);
        res.status(500).json({ error: e.message });
    }
}

async function logCsvHandler(req, res) {
    if (!checkAuth(req, res)) return;
    const cols = ['ts','agentCode','visitorId','authToken','airport','airportName','departureDate','loungeFrom','isManual',
                  'adults','children','infants',
                  'flightCode','flightDepartureTime','flightDepartureTerminal','flightArrivalAirport','flightDest',
                  'redirectUrl'];
    const esc = v => v == null ? '' : `"${String(v).replace(/"/g,'""')}"`;
    try {
        const { rows } = await fetchRows({ limit: 5000, all: true });
        const csv = [cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\n');
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="lounge-searches-${new Date().toISOString().slice(0,10)}.csv"`);
        res.send(csv);
    } catch (e) {
        res.status(500).type('text/plain').send('Export failed: ' + e.message);
    }
}

function adminHandler(req, res) {
    if (!checkAuth(req, res)) return;
    const keyParam = ADMIN_KEY ? `?key=${encodeURIComponent(ADMIN_KEY)}` : '';
    const mount    = req.baseUrl || '';
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Lounge Wizard — Search Log</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;background:#f8f8f8;color:#222}
header{background:#552e92;color:#fff;padding:.875rem 1.25rem;display:flex;align-items:center;justify-content:space-between;gap:1rem}
header h1{font-size:1rem;font-weight:700}
header a{color:#e2d9f3;font-size:.8rem;text-decoration:none;border:1px solid #7c5cbf;border-radius:6px;padding:.3rem .75rem}
header a:hover{background:#3d2070}
.bar{padding:.625rem 1.25rem;background:#fff;border-bottom:1px solid #e2e8f0;display:flex;gap:1rem;align-items:center;flex-wrap:wrap}
.bar input{border:1px solid #cbd5e0;border-radius:6px;padding:.35rem .65rem;font-size:13px;width:280px}
.stat{font-size:.8rem;color:#718096}
.stat strong{color:#222}
table{width:100%;border-collapse:collapse;background:#fff}
th{background:#f1f0f8;color:#552e92;font-weight:700;font-size:.72rem;text-transform:uppercase;letter-spacing:.05em;padding:.5rem .75rem;text-align:left;position:sticky;top:0;white-space:nowrap}
td{padding:.45rem .75rem;border-bottom:1px solid #f0f0f0;vertical-align:top;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
tr:hover td{background:#faf8ff}
.wrap{overflow-x:auto;max-height:calc(100vh - 100px)}
.apt{display:inline-block;background:#ede7f6;color:#512da8;font-weight:700;font-size:.72rem;padding:2px 6px;border-radius:3px}
.flt{font-family:ui-monospace,Menlo,monospace;font-size:.78rem}
.nil{color:#999}
.sent a{color:#2e7d32;text-decoration:none;font-weight:600}
.sent a:hover{text-decoration:underline}
</style></head><body>
<header>
  <h1>🛋️ Lounge Wizard — Search Log ${db ? '(last 24h)' : '(in-memory)'}</h1>
  <nav style="display:flex;gap:.5rem;align-items:center">
    <a href="${mount}/api/log.csv${keyParam}" download>⬇ CSV</a>
    <a href="${mount}/api/log${keyParam}">JSON</a>
  </nav>
</header>
<div class="bar">
  <input type="search" id="q" placeholder="Filter by airport, flight, visitor ID, agent…" oninput="filter()">
  <span class="stat" id="stat"></span>
</div>
<div class="wrap"><table id="tbl">
<thead><tr>
  <th>Time</th><th>Agent</th><th>Visitor ID</th><th>Auth token</th>
  <th>Airport</th><th>Date</th><th>Entry time</th>
  <th>Pax</th><th>Flight</th><th>Terminal</th><th>Destination</th>
  <th>Sent to</th>
</tr></thead>
<tbody id="tbody"></tbody>
</table></div>
<script>
let rows=[];
async function load(){
  const r=await fetch('${mount}/api/log${keyParam}');
  const d=await r.json();
  rows=d.rows||[];
  document.getElementById('stat').innerHTML='<strong>'+rows.length+'</strong> searches';
  render(rows);
}
function esc(s){return s==null?'':String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');}
function fmt(ts){if(!ts)return'';const d=new Date(ts);return d.toLocaleDateString('en-GB',{day:'2-digit',month:'short'})+' '+d.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});}
function fmtDate(d){if(!d)return'';return new Date(d).toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'2-digit'});}
function nilOr(v){return v?esc(v):'<span class="nil">—</span>';}
function copyBtn(v){return'<button data-v="'+esc(v)+'" onclick="navigator.clipboard.writeText(this.dataset.v);this.textContent=\\'✓\\';setTimeout(()=>this.textContent=\\'⧉\\',1200)" title="Copy" style="background:none;border:none;cursor:pointer;font-size:0.85em;opacity:0.6;padding:0">⧉</button>';}
function shortCell(v,len){if(!v)return'<span class="nil">—</span>';const s=v.slice(0,len)+(v.length>len?'…':'');return'<span title="'+esc(v)+'">'+esc(s)+'</span> '+copyBtn(v);}
function flt(code,time){if(!code)return'<span class="nil">—</span>';const t=time?' '+esc(time):'';return'<span class="flt">'+esc(code)+'</span>'+t;}
function sent(url){if(!url)return'<span class="nil">—</span>';return'<span class="sent"><a href="'+esc(url)+'" target="_blank">open ↗</a></span>';}
function aptCell(code,name){return'<span class="apt">'+esc(code)+'</span>'+(name?' <span style="color:#555;font-size:.8em">'+esc(name)+'</span>':'');}
function entryCell(t,manual){if(!t)return'<span class="nil">—</span>';return esc(t)+(manual?' <span style="background:#fff3cd;color:#856404;font-size:.7em;padding:1px 4px;border-radius:3px;font-weight:600">manual</span>':' <span style="background:#e8f5e9;color:#2e7d32;font-size:.7em;padding:1px 4px;border-radius:3px">est</span>');}
function render(data){
  document.getElementById('tbody').innerHTML=data.map(r=>'<tr>'+
    '<td title="'+esc(r.ts)+'">'+fmt(r.ts)+'</td>'+
    '<td>'+esc(r.agentCode)+'</td>'+
    '<td>'+shortCell(r.visitorId,12)+'</td>'+
    '<td>'+shortCell(r.authToken,10)+'</td>'+
    '<td>'+aptCell(r.airport,r.airportName)+'</td>'+
    '<td>'+fmtDate(r.departureDate)+'</td>'+
    '<td>'+entryCell(r.loungeFrom,r.isManual)+'</td>'+
    '<td>'+esc(r.adults)+'A '+esc(r.children)+'C '+esc(r.infants)+'I</td>'+
    '<td>'+flt(r.flightCode,r.flightDepartureTime)+'</td>'+
    '<td>'+nilOr(r.flightDepartureTerminal)+'</td>'+
    '<td>'+nilOr(r.flightDest||r.flightArrivalAirport)+'</td>'+
    '<td>'+sent(r.redirectUrl)+'</td>'+
  '</tr>').join('');
}
function filter(){
  const q=document.getElementById('q').value.toLowerCase();
  render(q?rows.filter(r=>JSON.stringify(r).toLowerCase().includes(q)):rows);
}
load();
</script></body></html>`);
}

// ─── index.html with injected base path ───────────────────────────────────────
let _indexHtml = null;
function getIndexHtml() {
    if (!_indexHtml) _indexHtml = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
    return _indexHtml;
}

function indexHandler(req, res) {
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    const mountedAt = req.baseUrl || '';
    if (!mountedAt) {
        res.sendFile(path.join(__dirname, 'index.html'));
    } else {
        const html = getIndexHtml()
            .replace('<head>', `<head><base href="${mountedAt}/">`)
            .replace('</head>', `<script>window._basePath='${mountedAt}'</script></head>`);
        res.send(html);
    }
}

// ─── Router ───────────────────────────────────────────────────────────────────
function mountRoutes(router) {
    router.get('/api/flights',          flightsHandler);
    router.post('/api/lounge/search',   loungeSearchHandler);
    router.get('/api/log',              logHandler);
    router.get('/api/log.csv',          logCsvHandler);
    router.get('/admin',                adminHandler);

    router.use(express.static(path.join(__dirname), {
        maxAge: '30d',
        etag:   true,
        lastModified: true,
        index: false,
        setHeaders(res, filePath) {
            if (filePath.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache');
        },
    }));

    router.get('*', indexHandler);
}

if (MOUNT_PATH) {
    const subRouter = express.Router();
    mountRoutes(subRouter);
    app.use(MOUNT_PATH, subRouter);
    console.log(`[mount] Serving at ${MOUNT_PATH}`);
}

const rootRouter = express.Router();
mountRoutes(rootRouter);
app.use('/', rootRouter);

app.listen(PORT, () => console.log(`Lounge wizard listening on port ${PORT}${MOUNT_PATH ? ' (also at ' + MOUNT_PATH + ')' : ''}`));
