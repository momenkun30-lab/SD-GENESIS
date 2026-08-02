const express = require('express');
const { getDb } = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { upload } = require('../middleware/upload');
const { uploadBuffer, deleteByPublicId } = require('../services/storage');

const router = express.Router();
router.use(requireAdmin);

// GET /api/admin/branding — current uploaded assets, for prefilling the admin UI
router.get('/', async (req, res) => {
  try {
    const db = getDb();
    const doc = await db.collection('settings').findOne({ _id: 'site' });
    res.json({
      hero_video_url: doc?.hero_video_url || null,
      logo_url: doc?.logo_url || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/branding — upload/replace the video and/or logo (multipart: fields "video", "logo")
router.post(
  '/',
  upload.fields([{ name: 'video', maxCount: 1 }, { name: 'logo', maxCount: 1 }]),
  async (req, res) => {
    try {
      const db = getDb();
      const existing = (await db.collection('settings').findOne({ _id: 'site' })) || {};
      const videoFile = req.files?.video?.[0];
      const logoFile = req.files?.logo?.[0];

      if (!videoFile && !logoFile) {
        return res.status(400).json({ error: 'أرفق فيديو أو شعارًا على الأقل' });
      }

      const update = {};

      if (videoFile) {
        await deleteByPublicId(existing.hero_video_public_id);
        const up = await uploadBuffer(videoFile.buffer, {
          folder: 'branding',
          filename: videoFile.originalname,
          contentType: videoFile.mimetype,
        });
        update.hero_video_url = up.url;
        update.hero_video_public_id = up.publicId;
      }

      if (logoFile) {
        await deleteByPublicId(existing.logo_public_id);
        const up = await uploadBuffer(logoFile.buffer, {
          folder: 'branding',
          filename: logoFile.originalname,
          contentType: logoFile.mimetype,
        });
        update.logo_url = up.url;
        update.logo_public_id = up.publicId;
      }

      update.updated_at = new Date();
      await db.collection('settings').updateOne({ _id: 'site' }, { $set: update }, { upsert: true });

      const doc = await db.collection('settings').findOne({ _id: 'site' });
      res.json({ ok: true, hero_video_url: doc.hero_video_url || null, logo_url: doc.logo_url || null });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// DELETE /api/admin/branding/:type — remove one asset (type = "video" or "logo"), reverting to the fallback
router.delete('/:type', async (req, res) => {
  try {
    const { type } = req.params;
    if (!['video', 'logo'].includes(type)) return res.status(400).json({ error: 'نوع غير صالح' });

    const db = getDb();
    const existing = (await db.collection('settings').findOne({ _id: 'site' })) || {};
    const publicIdField = type === 'video' ? 'hero_video_public_id' : 'logo_public_id';
    const urlField = type === 'video' ? 'hero_video_url' : 'logo_url';

    await deleteByPublicId(existing[publicIdField]);
    await db
      .collection('settings')
      .updateOne({ _id: 'site' }, { $unset: { [publicIdField]: '', [urlField]: '' }, $set: { updated_at: new Date() } }, { upsert: true });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
