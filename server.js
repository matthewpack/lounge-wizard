const express     = require('express');
const compression = require('compression');
const path        = require('path');
const fs          = require('fs');

const app  = express();
const PORT = process.env.PORT || 8082;

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
        const params = new URLSearchParams({ query, location, country: '', departDate: date });
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

// loungeFrom = HH:MM — the earliest entry time (computed as flight dep time − 3 h)
function buildHxUrl({ airport, departureDate, loungeFrom, adults, children, infants, flight, agentCode }) {
    const hashParams = new URLSearchParams({
        agent:           agentCode || 'WEB1',
        depart:          airport,
        out:             departureDate,
        lounge_from:     loungeFrom,
        adults:          String(adults || 1),
        children:        String(children || 0),
        infants:         String(infants || 0),
        redirectReferal: 'lounge',
        from_categories: 'true',
    });
    if (flight?.code)              hashParams.set('flight',   flight.code);
    if (flight?.departureTerminal) hashParams.set('terminal', flight.departureTerminal);
    return `https://www.holidayextras.com/static/?selectProduct=lo&reloadKey=lounge-wizard#/categories?${hashParams}`;
}

function loungeSearchHandler(req, res) {
    const { airport, departureDate, loungeFrom, adults, children, infants, flight, agentCode } = req.body || {};

    if (!airport || !departureDate || !loungeFrom)
        return res.status(400).json({ error: 'missing required lounge fields' });

    const redirectUrl = buildHxUrl(req.body);

    const entry = {
        ts:            new Date().toISOString(),
        agentCode:     agentCode || 'WEB1',
        airport,
        departureDate,
        loungeFrom,
        adults:        adults  || 1,
        children:      children || 0,
        infants:       infants  || 0,
        flight:        flight?.code || null,
        terminal:      flight?.departureTerminal || '',
    };
    searchLog.push(entry);
    if (searchLog.length > LOG_MAX) searchLog.shift();

    console.log('\n' + '='.repeat(60));
    console.log('  POST /api/lounge/search');
    console.log(`  ${entry.ts}`);
    console.log(`  ${airport} | ${departureDate} | from ${loungeFrom} | ${adults}A ${children}C ${infants}I`);
    if (flight) console.log(`  flight: ${flight.code} (terminal ${flight.departureTerminal || '-'})`);
    console.log(`  → ${redirectUrl.slice(0, 90)}...`);
    console.log('='.repeat(60) + '\n');

    res.json({ redirectUrl });
}

function logHandler(req, res) {
    res.json(searchLog);
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
