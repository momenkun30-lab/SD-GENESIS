const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { upload } = require('../middleware/upload');
const { uploadBuffer, deleteByPublicId } = require('../services/storage');

const router = express.Router();
router.use(requireAdmin);

const VALID_TYPES = ['website', 'app'];

function checkType(req, res, next) {
  if (!VALID_TYPES.includes(req.params.type)) return res.status(400).json({ error: 'نوع غير صالح' });
  next();
}

// GET /api/admin/designs/:type — all designs (visible + hidden), for the admin table
router.get('/:type', checkType, async (req, res) => {
  try {
    const db = getDb();
    const docs = await db
      .collection('designs')
      .find({ type: req.params.type })
      .sort({ display_order: 1, created_at: 1 })
      .toArray();
    res.json(docs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/designs/:type — create a new design (multipart: image, name, design_id?, category, description)
router.post('/:type', checkType, upload.single('image'), async (req, res) => {
  try {
    const db = getDb();
    const { type } = req.params;
    const { name, category = '', description = '', design_id } = req.body;
    if (!name) return res.status(400).json({ error: 'اسم التصميم مطلوب' });
    if (!req.file) return res.status(400).json({ error: 'صورة التصميم مطلوبة' });

    const finalDesignId = design_id?.trim() || `${type.toUpperCase()}-${uuidv4().slice(0, 6).toUpperCase()}`;
    const existing = await db.collection('designs').findOne({ type, design_id: finalDesignId });
    if (existing) return res.status(409).json({ error: 'رقم التصميم هذا مستخدم بالفعل' });

    const up = await uploadBuffer(req.file.buffer, {
      folder: `designs/${type}`,
      filename: req.file.originalname,
      contentType: req.file.mimetype,
    });

    const maxOrderDoc = await db.collection('designs').find({ type }).sort({ display_order: -1 }).limit(1).toArray();
    const nextOrder = (maxOrderDoc[0]?.display_order || 0) + 1;

    const id = uuidv4();
    const now = new Date();
    await db.collection('designs').insertOne({
      _id: id,
      type,
      design_id: finalDesignId,
      name,
      category,
      description,
      image_url: up.url,
      image_public_id: up.publicId,
      display_order: nextOrder,
      visible: true,
      selection_count: 0,
      created_at: now,
      updated_at: now,
    });

    res.status(201).json({ ok: true, id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/admin/designs/:type/:id — update fields, optionally replace the image
router.put('/:type/:id', checkType, upload.single('image'), async (req, res) => {
  try {
    const db = getDb();
    const { type, id } = req.params;
    const existing = await db.collection('designs').findOne({ _id: id, type });
    if (!existing) return res.status(404).json({ error: 'التصميم غير موجود' });

    const { name, category, description, design_id, visible, display_order } = req.body;

    if (design_id && design_id.trim() !== existing.design_id) {
      const dup = await db.collection('designs').findOne({ type, design_id: design_id.trim(), _id: { $ne: id } });
      if (dup) return res.status(409).json({ error: 'رقم التصميم هذا مستخدم بالفعل' });
    }

    const update = {
      name: name ?? existing.name,
      category: category ?? existing.category,
      description: description ?? existing.description,
      design_id: design_id?.trim() || existing.design_id,
      visible: visible === undefined ? existing.visible : (visible === 'true' || visible === true),
      display_order: display_order !== undefined ? Number(display_order) : existing.display_order,
      updated_at: new Date(),
    };

    if (req.file) {
      await deleteByPublicId(existing.image_public_id);
      const up = await uploadBuffer(req.file.buffer, {
        folder: `designs/${type}`,
        filename: req.file.originalname,
        contentType: req.file.mimetype,
      });
      update.image_url = up.url;
      update.image_public_id = up.publicId;
    }

    await db.collection('designs').updateOne({ _id: id, type }, { $set: update });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/admin/designs/:type/:id
router.delete('/:type/:id', checkType, async (req, res) => {
  try {
    const db = getDb();
    const { type, id } = req.params;
    const existing = await db.collection('designs').findOne({ _id: id, type });
    if (!existing) return res.status(404).json({ error: 'التصميم غير موجود' });

    await deleteByPublicId(existing.image_public_id);
    await db.collection('designs').deleteOne({ _id: id, type });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/designs/:type/:id/move — swap display_order with the neighboring visible item ("up" or "down")
router.post('/:type/:id/move', checkType, async (req, res) => {
  try {
    const db = getDb();
    const { type, id } = req.params;
    const { direction } = req.body;
    if (!['up', 'down'].includes(direction)) return res.status(400).json({ error: 'اتجاه غير صالح' });

    const all = await db.collection('designs').find({ type }).sort({ display_order: 1, created_at: 1 }).toArray();
    const idx = all.findIndex((d) => d._id === id);
    if (idx === -1) return res.status(404).json({ error: 'التصميم غير موجود' });

    const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= all.length) return res.json({ ok: true }); // already at edge, no-op

    const a = all[idx];
    const b = all[swapIdx];
    await db.collection('designs').updateOne({ _id: a._id }, { $set: { display_order: b.display_order } });
    await db.collection('designs').updateOne({ _id: b._id }, { $set: { display_order: a.display_order } });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
