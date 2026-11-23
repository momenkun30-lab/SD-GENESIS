'use strict';
const crypto = require('crypto');

const isProd = process.env.NODE_ENV === 'production';

function log(level, data) {
  // one JSON line per event: Vercel / Render log viewers can filter on it
  const line = JSON.stringify(Object.assign({ t: new Date().toISOString(), level }, data));
  (level === 'error' ? console.error : console.log)(line);
}

function requestContext(req, res, next) {
  req.id = (req.headers['x-request-id'] && String(req.headers['x-request-id']).slice(0, 64)) || crypto.randomUUID();
  res.setHeader('X-Request-Id', req.id);
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    if (res.statusCode >= 500) log('error', { id: req.id, method: req.method, url: req.originalUrl.split('?')[0], status: res.statusCode, ms: Math.round(ms) });
    else if (ms > 1500) log('warn', { id: req.id, msg: 'slow request', method: req.method, url: req.originalUrl.split('?')[0], status: res.statusCode, ms: Math.round(ms) });
  });
  next();
}

function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
}

function notFoundApi(req, res) { res.status(404).json({ error: 'غير موجود' }); }

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const status = Number(err && (err.status || err.statusCode)) || 500;
  log('error', { id: req.id, method: req.method, url: (req.originalUrl || '').split('?')[0], status, msg: err && err.message, stack: isProd ? undefined : err && err.stack });
  if (res.headersSent) return;
  const message = status >= 500 && isProd ? 'حدث خطأ في الخادم، حاول لاحقًا' : (err && err.message) || 'حدث خطأ في الخادم';
  res.status(status).json({ error: message, request_id: req.id });
}

let hooked = false;
function hookProcess() {
  if (hooked) return; hooked = true;
  process.on('unhandledRejection', (r) => log('error', { msg: 'unhandledRejection', detail: String(r && r.stack ? r.stack : r) }));
  process.on('uncaughtException', (e) => log('error', { msg: 'uncaughtException', detail: String(e && e.stack ? e.stack : e) }));
}

module.exports = { requestContext, securityHeaders, notFoundApi, errorHandler, hookProcess, log };
