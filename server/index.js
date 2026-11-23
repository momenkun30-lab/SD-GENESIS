require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
const { apiLimiter, loginLimiter, actionLimiter } = require('./middleware/rate-limit');
const { microCache, clearOnWrite } = require('./middleware/cache');
const { requestContext, securityHeaders, notFoundApi, errorHandler, hookProcess } = require('./middleware/errors');

const { connect } = require('./db');
const publicApi = require('./routes/apps');
const adminApi = require('./routes/admin');
const uploadSignApi = require('./routes/upload-sign');
const setupApi = require('./routes/setup');
const settingsApi = require('./routes/settings');
const brandingApi = require('./routes/branding');
const designsApi = require('./routes/designs');
const adminDesignsApi = require('./routes/admin-designs');
const designCategoriesApi = require('./routes/design-categories');
const adminDesignCategoriesApi = require('./routes/admin-design-categories');
const videosApi = require('./routes/videos');
const adminVideosApi = require('./routes/admin-videos');
const aiApi = require('./routes/ai');
const adminAiApi = require('./routes/admin-ai');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1); // Render/Railway sit behind a proxy — needed for correct client IPs

hookProcess();
app.disable('x-powered-by');
app.use(requestContext);      // request id + slow/failed request logging
app.use(securityHeaders);
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

// rate limits (per server instance): whole API, admin login brute-force, download/select actions
app.use('/api', apiLimiter);
app.use('/api/admin/login', loginLimiter);
app.use('/api/apps/:slug/download', actionLimiter);

// public data: in-memory micro-cache + single-flight + CDN headers. Mounted BEFORE the DB-connect step so cache hits cost nothing.
const publicCache = microCache({ ttl: 15000 });
app.use('/api', publicCache);
app.use('/api/admin', clearOnWrite(publicCache));
app.use('/api/setup', clearOnWrite(publicCache));

// make sure the DB is connected before any API route (serverless cold starts)
app.use('/api', async (req, res, next) => {
  try { await connect(); next(); } catch (err) { res.status(500).json({ error: 'فشل الاتصال بقاعدة البيانات: ' + err.message }); }
});

app.use('/api', publicApi);
app.use('/api/admin/upload', uploadSignApi);
app.use('/api/admin', adminApi);
app.use('/api/setup', setupApi);
app.use('/api/settings', settingsApi);
app.use('/api/admin/branding', brandingApi);
app.use('/api/designs', designsApi);
app.use('/api/admin/designs', adminDesignsApi);
app.use('/api/design-categories', designCategoriesApi);
app.use('/api/admin/design-categories', adminDesignCategoriesApi);
app.use('/api/videos', videosApi);
app.use('/api/admin/videos', adminVideosApi);
app.use('/api/ai', aiApi);
app.use('/api/admin/ai', adminAiApi);

// icons/screenshots/app files/branding/design images are hosted on Supabase — public/ only serves the site itself
app.use(express.static(path.join(__dirname, '..', 'public'), {
  etag: true,
  setHeaders(res, file) {
    // HTML must always revalidate (so a new deploy shows at once); images/fonts/scripts can be cached by browsers and CDN
    if (/\.html$/i.test(file)) res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
    else res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
  },
}));

app.get('/setup', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'setup.html'));
});

app.get('/products', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'products.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'admin.html'));
});

app.get('*', (req, res) => {
  if (req.path.startsWith('/api')) return notFoundApi(req, res);
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.use(errorHandler);   // logs with request id, hides internals in production

if (process.env.VERCEL) {
  module.exports = app; // Vercel runs the app as a serverless function — no listen()
} else {
  connect()
    .then(() => {
      app.listen(PORT, () => console.log(`Release Dock running on port ${PORT}`));
    })
    .catch((err) => {
      console.error('فشل الاتصال بقاعدة البيانات، الخادم لن يبدأ:', err.message);
      process.exit(1);
    });
  module.exports = app;
}
