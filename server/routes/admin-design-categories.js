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

// GET /api/admin/design-categories/:type — all categories for this type
router.get('/:type', checkType, async (req, res) => {
  try {
    const db = getDb();
    const docs = await db
      .collection('design_categories')
      .find({ type: req.params.type })
      .sort({ display_order: 1, created_at: 1 })
      .toArray();
    res.json(docs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/design-categories/:type — create (multipart: image?, name, description)
router.post('/:type', checkType, upload.single('image'), async (req, res) => {
  try {
    const db = getDb();
    const { type } = req.params;
    const { name, description = '' } = req.body;
    if (!name) return res.status(400).json({ error: 'اسم التصنيف مطلوب' });

    const dup = await db.collection('design_categories').findOne({ type, name });
    if (dup) return res.status(409).json({ error: 'هذا التصنيف موجود بالفعل' });

    let image_url = null, image_public_id = null;
    if (req.file) {
      const up = await uploadBuffer(req.file.buffer, {
        folder: `design-categories/${type}`,
        filename: req.file.originalname,
        contentType: req.file.mimetype,
      });
      image_url = up.url;
      image_public_id = up.publicId;
    }

    const maxOrderDoc = await db.collection('design_categories').find({ type }).sort({ display_order: -1 }).limit(1).toArray();
    const nextOrder = (maxOrderDoc[0]?.display_order || 0) + 1;

    const id = uuidv4();
    const now = new Date();
    await db.collection('design_categories').insertOne({
      _id: id, type, name, description, image_url, image_public_id,
      display_order: nextOrder, created_at: now, updated_at: now,
    });

    res.status(201).json({ ok: true, id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/admin/design-categories/:type/:id — update, optionally replace image
router.put('/:type/:id', checkType, upload.single('image'), async (req, res) => {
  try {
    const db = getDb();
    const { type, id } = req.params;
    const existing = await db.collection('design_categories').findOne({ _id: id, type });
    if (!existing) return res.status(404).json({ error: 'التصنيف غير موجود' });

    const { name, description } = req.body;

    if (name && name !== existing.name) {
      const dup = await db.collection('design_categories').findOne({ type, name, _id: { $ne: id } });
      if (dup) return res.status(409).json({ error: 'هذا الاسم مستخدم بالفعل' });
    }

    const update = {
      name: name ?? existing.name,
      description: description ?? existing.description,
      updated_at: new Date(),
    };

    if (req.file) {
      await deleteByPublicId(existing.image_public_id);
      const up = await uploadBuffer(req.file.buffer, {
        folder: `design-categories/${type}`,
        filename: req.file.originalname,
        contentType: req.file.mimetype,
      });
      update.image_url = up.url;
      update.image_public_id = up.publicId;
    }

    // keep existing designs pointing at the old category name in sync with a rename
    if (name && name !== existing.name) {
      await db.collection('designs').updateMany({ type, category: existing.name }, { $set: { category: name } });
    }

    await db.collection('design_categories').updateOne({ _id: id, type }, { $set: update });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/admin/design-categories/:type/:id
router.delete('/:type/:id', checkType, async (req, res) => {
  try {
    const db = getDb();
    const { type, id } = req.params;
    const existing = await db.collection('design_categories').findOne({ _id: id, type });
    if (!existing) return res.status(404).json({ error: 'التصنيف غير موجود' });

    await deleteByPublicId(existing.image_public_id);
    await db.collection('design_categories').deleteOne({ _id: id, type });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
