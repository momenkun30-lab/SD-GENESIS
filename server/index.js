require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
const rateLimit = require('express-rate-limit');
const { connect } = require('./db');

const publicApi = require('./routes/apps');
const adminApi = require('./routes/admin');
const setupApi = require('./routes/setup');
const settingsApi = require('./routes/settings');
const brandingApi = require('./routes/branding');
const designsApi = require('./routes/designs');
const adminDesignsApi = require('./routes/admin-designs');
const categoriesApi = require('./routes/categories');              // NEW
const adminCategoriesApi = require('./routes/admin-categories');  // NEW

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

const limiter = rateLimit({ windowMs: 60 * 1000, max: 300 });
app.use('/api', limiter);

app.use('/api', publicApi);
app.use('/api/admin', adminApi);
app.use('/api/setup', setupApi);
app.use('/api/settings', settingsApi);
app.use('/api/admin/branding', brandingApi);
app.use('/api/designs', designsApi);
app.use('/api/admin/designs', adminDesignsApi);
app.use('/api/categories', categoriesApi);              // NEW
app.use('/api/admin/categories', adminCategoriesApi);  // NEW

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

connect()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Release Dock running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('فشل الاتصال بقاعدة البيانات، الخادم لن يبدأ:', err.message);
    process.exit(1);
  });
