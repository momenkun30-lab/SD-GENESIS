const express = require('express');
const { requireAdmin } = require('../middleware/auth');
const { createSignedUpload } = require('../services/storage');

const router = express.Router();
router.use(requireAdmin);

const ALLOWED = /\.(png|jpe?g|webp|gif|svg|mp4|webm|mov|apk|exe|msi|dmg|zip|pkg|deb|appimage|ipa)$/i;
const MAX = 49 * 1024 * 1024;

router.post('/sign', express.json(), async (req, res) => {
  try {
    const { filename, size } = req.body || {};
    if (!filename || !ALLOWED.test(filename)) return res.status(400).json({ error: 'صيغة الملف غير مدعومة' });
    if (Number(size) > MAX) return res.status(400).json({ error: 'الحد الأقصى لحجم الملف 49 ميجابايت' });
    res.json(await createSignedUpload('uploads', filename));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
