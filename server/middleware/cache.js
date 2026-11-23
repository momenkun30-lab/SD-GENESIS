'use strict';
/**
 * Public GET endpoints change rarely, so:
 *  1) responses are cached in memory for a few seconds per server instance,
 *  2) identical requests that arrive while one is being computed share that single computation ("single-flight"),
 *  3) `Cache-Control: s-maxage` lets Vercel's edge CDN serve repeats without waking the function at all.
 * Cached paths are an explicit allow-list — downloads, admin and POST routes are never cached.
 */
const CACHEABLE = [
  /^\/api\/apps(\?.*)?$/,
  /^\/api\/apps\/[^/?]+(\?.*)?$/,        // detail only: "/download" has one more segment and is NOT cacheable
  /^\/api\/settings(\?.*)?$/,
  /^\/api\/videos(\?.*)?$/,
  /^\/api\/design-categories\/[^/?]+(\?.*)?$/,
  /^\/api\/designs\/[^/?]+(\/[^/?]+)?(\?.*)?$/,
  /^\/api\/categories\/[^/?]+(\/[^/?]+)?(\?.*)?$/,
  /^\/api\/ai\/config(\?.*)?$/,
];

function microCache({ ttl = 15000, max = 300, edge = { sMaxAge: 30, swr: 120 } } = {}) {
  const store = new Map();     // url -> { exp, status, type, body }
  const inflight = new Map();  // url -> [ { res, next } ]

  function middleware(req, res, next) {
    if (req.method !== 'GET' || !CACHEABLE.some((re) => re.test(req.originalUrl))) return next();
    const key = req.originalUrl;
    const now = Date.now();
    const hit = store.get(key);
    if (hit && hit.exp > now) {
      res.set('X-Cache', 'HIT');
      res.set('Cache-Control', `public, max-age=0, s-maxage=${edge.sMaxAge}, stale-while-revalidate=${edge.swr}`);
      res.type(hit.type);
      return res.status(hit.status).send(hit.body);
    }
    // someone is already computing this exact response: wait for it instead of hitting the database again
    if (inflight.has(key)) { inflight.get(key).push({ res, next }); return; }
    const waiters = [];
    inflight.set(key, waiters);

    let captured = null;
    const origSend = res.send.bind(res);
    res.send = function patched(body) {
      if (res.statusCode === 200 && (typeof body === 'string' || Buffer.isBuffer(body))) {
        captured = { body, type: String(res.get('Content-Type') || 'application/json; charset=utf-8') };
      }
      return origSend(body);
    };
    res.set('X-Cache', 'MISS');
    res.set('Cache-Control', `public, max-age=0, s-maxage=${edge.sMaxAge}, stale-while-revalidate=${edge.swr}`);

    let settled = false;
    function settle() {
      if (settled) return; settled = true;
      inflight.delete(key);
      if (captured) {
        if (store.size >= max) store.delete(store.keys().next().value);
        store.set(key, { exp: Date.now() + ttl, status: 200, type: captured.type, body: captured.body });
        for (const w of waiters) { w.res.set('X-Cache', 'SHARED'); w.res.set('Cache-Control', res.get('Cache-Control')); w.res.type(captured.type); w.res.status(200).send(captured.body); }
      } else {
        for (const w of waiters) w.next();   // leader failed or was not cacheable: let each waiter run normally
      }
    }
    res.on('finish', settle);
    res.on('close', settle);
    next();
  }
  middleware.clear = () => store.clear();
  middleware.size = () => store.size;
  return middleware;
}

/** After any successful admin write, drop cached public data so the owner sees changes immediately on this instance. */
function clearOnWrite(cache) {
  return function (req, res, next) {
    if (req.method !== 'GET') res.on('finish', () => { if (res.statusCode < 400) cache.clear(); });
    next();
  };
}

module.exports = { microCache, clearOnWrite, CACHEABLE };
