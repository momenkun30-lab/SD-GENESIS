require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
const rateLimit = require('express-rate-limit');

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

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1); // Render/Railway sit behind a proxy — needed for correct client IPs

app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

// generous global limiter; the download route has its own dedicated cooldown
const limiter = rateLimit({ windowMs: 60 * 1000, max: 300 });
app.use('/api', limiter);

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

// icons/screenshots/app files/branding/design images are hosted on Supabase — public/ only serves the site itself
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/setup', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'setup.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'admin.html'));
});

app.get('*', (req, res) => {
  if (req.path.startsWith('/api')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'حدث خطأ في الخادم' });
});

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
