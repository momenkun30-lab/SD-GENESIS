const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { upload } = require('../middleware/upload');
const { uploadBuffer, deleteByPublicId } = require('../services/storage');

const router = express.Router();
router.use(requireAdmin);

const ALLOWED_VIDEO = /\.(mp4|webm|mov)$/i;
const ALLOWED_IMAGE = /\.(png|jpe?g|webp|gif)$/i;
const fields = upload.fields([{ name: 'video', maxCount: 1 }, { name: 'thumbnail', maxCount: 1 }]);

async function saveFile(file, folder) {
  return uploadBuffer(file.buffer, { folder, filename: file.originalname, contentType: file.mimetype });
}

// GET /api/admin/videos — all videos (visible + hidden)
router.get('/', async (req, res) => {
  try {
    const docs = await getDb().collection('videos').find({}).sort({ display_order: 1, created_at: 1 }).toArray();
    res.json(docs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/videos — create (multipart: video, thumbnail, title, description, video_type, design_type)
router.post('/', fields, async (req, res) => {
  try {
    const db = getDb();
    const { title, description = '', video_type = '', design_type = '' } = req.body;
    const videoFile = req.files?.video?.[0];
    const thumbFile = req.files?.thumbnail?.[0];
    if (!title || !title.trim()) return res.status(400).json({ error: 'عنوان الفيديو مطلوب' });
    if (!videoFile) return res.status(400).json({ error: 'ملف الفيديو مطلوب' });
    if (!ALLOWED_VIDEO.test(videoFile.originalname)) return res.status(400).json({ error: 'صيغة الفيديو غير مدعومة (mp4 / webm / mov)' });
    if (thumbFile && !ALLOWED_IMAGE.test(thumbFile.originalname)) return res.status(400).json({ error: 'صيغة الصورة المصغرة غير مدعومة' });

    const v = await saveFile(videoFile, 'videos');
    const t = thumbFile ? await saveFile(thumbFile, 'video-thumbs') : null;

    const last = await db.collection('videos').find({}).sort({ display_order: -1 }).limit(1).toArray();
    const now = new Date();
    const id = uuidv4();
    await db.collection('videos').insertOne({
      _id: id,
      title: title.trim(),
      description,
      video_type: video_type.trim(),
      design_type: design_type.trim(),
      video_url: v.url,
      video_public_id: v.publicId,
      thumbnail_url: t ? t.url : null,
      thumbnail_public_id: t ? t.publicId : null,
      display_order: (last[0]?.display_order || 0) + 1,
      visible: true,
      created_at: now,
      updated_at: now,
    });
    res.status(201).json({ ok: true, id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/admin/videos/:id — edit fields / replace video or thumbnail / show-hide
router.put('/:id', fields, async (req, res) => {
  try {
    const db = getDb();
    const existing = await db.collection('videos').findOne({ _id: req.params.id });
    if (!existing) return res.status(404).json({ error: 'الفيديو غير موجود' });

    const { title, description, video_type, design_type, visible, display_order } = req.body;
    const update = {
      title: title !== undefined ? title.trim() || existing.title : existing.title,
      description: description ?? existing.description,
      video_type: video_type !== undefined ? video_type.trim() : existing.video_type,
      design_type: design_type !== undefined ? design_type.trim() : existing.design_type,
      visible: visible === undefined ? existing.visible : (visible === 'true' || visible === true),
      display_order: display_order !== undefined ? Number(display_order) : existing.display_order,
      updated_at: new Date(),
    };

    const videoFile = req.files?.video?.[0];
    const thumbFile = req.files?.thumbnail?.[0];
    if (videoFile) {
      if (!ALLOWED_VIDEO.test(videoFile.originalname)) return res.status(400).json({ error: 'صيغة الفيديو غير مدعومة' });
      const v = await saveFile(videoFile, 'videos');
      await deleteByPublicId(existing.video_public_id);
      update.video_url = v.url;
      update.video_public_id = v.publicId;
    }
    if (thumbFile) {
      if (!ALLOWED_IMAGE.test(thumbFile.originalname)) return res.status(400).json({ error: 'صيغة الصورة المصغرة غير مدعومة' });
      const t = await saveFile(thumbFile, 'video-thumbs');
      await deleteByPublicId(existing.thumbnail_public_id);
      update.thumbnail_url = t.url;
      update.thumbnail_public_id = t.publicId;
    }

    await db.collection('videos').updateOne({ _id: existing._id }, { $set: update });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/admin/videos/:id
router.delete('/:id', async (req, res) => {
  try {
    const db = getDb();
    const existing = await db.collection('videos').findOne({ _id: req.params.id });
    if (!existing) return res.status(404).json({ error: 'الفيديو غير موجود' });
    await deleteByPublicId(existing.video_public_id);
    await deleteByPublicId(existing.thumbnail_public_id);
    await db.collection('videos').deleteOne({ _id: existing._id });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/videos/:id/move  { direction: 'up' | 'down' }
router.post('/:id/move', async (req, res) => {
  try {
    const db = getDb();
    const { direction } = req.body;
    if (!['up', 'down'].includes(direction)) return res.status(400).json({ error: 'اتجاه غير صالح' });
    const all = await db.collection('videos').find({}).sort({ display_order: 1, created_at: 1 }).toArray();
    const idx = all.findIndex((v) => v._id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'الفيديو غير موجود' });
    const swap = direction === 'up' ? idx - 1 : idx + 1;
    if (swap < 0 || swap >= all.length) return res.json({ ok: true });
    // re-number sequentially so equal/missing orders can never block a swap
    const reordered = all.slice();
    [reordered[idx], reordered[swap]] = [reordered[swap], reordered[idx]];
    await Promise.all(reordered.map((v, i) => db.collection('videos').updateOne({ _id: v._id }, { $set: { display_order: i + 1 } })));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
