const multer = require('multer');
const { publicUrlFor } = require('../services/storage');

const ALLOWED_IMAGE = /\.(png|jpe?g|webp|gif|svg)$/i;
const ALLOWED_PACKAGE = /\.(apk|exe|msi|dmg|zip|pkg|deb|appimage|ipa)$/i;
const PRE_MIME = 'application/x-preuploaded';

function fileFilter(req, file, cb) {
  if ((file.fieldname === 'icon' || file.fieldname === 'screenshots') && !ALLOWED_IMAGE.test(file.originalname)) {
    return cb(new Error('صيغة الصورة غير مدعومة'));
  }
  if (file.fieldname === 'file' && !ALLOWED_PACKAGE.test(file.originalname)) {
    return cb(new Error('صيغة ملف التطبيق غير مدعومة'));
  }
  cb(null, true);
}

const base = multer({
  storage: multer.memoryStorage(),
  fileFilter,
  limits: { fileSize: 4 * 1024 * 1024 },
});

function resolveMarkers(req) {
  const files = [];
  if (req.file) files.push(req.file);
  if (Array.isArray(req.files)) files.push(...req.files);
  else if (req.files) Object.values(req.files).forEach((a) => files.push(...a));
  for (const f of files) {
    if (f.mimetype !== PRE_MIME) continue;
    const m = JSON.parse(f.buffer.toString('utf8'));
    if (!m.path || /\.\./.test(m.path) || !/^[A-Za-z0-9/_.-]+$/.test(m.path)) throw new Error('مسار الملف غير صالح');
    f.buffer = { __pre: { url: publicUrlFor(m.path), publicId: m.path } };
    f.size = Number(m.size) || 0;
    f.mimetype = m.type || 'application/octet-stream';
  }
}

function wrap(mw) {
  return (req, res, next) => {
    mw(req, res, (err) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'حجم الملف كبير، حدّث الصفحة وأعد المحاولة' });
        return next(err);
      }
      try { resolveMarkers(req); next(); } catch (e) { res.status(400).json({ error: e.message }); }
    });
  };
}

const upload = {
  single: (n) => wrap(base.single(n)),
  fields: (f) => wrap(base.fields(f)),
  array: (n, m) => wrap(base.array(n, m)),
};

module.exports = { upload };
