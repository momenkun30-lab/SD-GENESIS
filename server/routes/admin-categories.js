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
  if (!VALID_TYPES.includes(req.params.type)) {
    return res.status(400).json({ error: 'نوع غير صالح' });
  }
  next();
}

// GET /api/admin/categories/:type - All categories (visible + hidden)
router.get('/:type', checkType, async (req, res) => {
  try {
    const db = getDb();
    const categories = await db
      .collection('categories')
      .find({ type: req.params.type })
      .sort({ display_order: 1, name: 1 })
      .toArray();

    // Get design counts
    const designCounts = await db
      .collection('designs')
      .aggregate([
        { $match: { type: req.params.type } },
        { $group: { _id: '$category_id', count: { $sum: 1 } } }
      ])
      .toArray();

    const countMap = {};
    designCounts.forEach(dc => { countMap[dc._id] = dc.count; });

    const enriched = categories.map(cat => ({
      ...cat,
      design_count: countMap[cat._id] || 0
    }));

    res.json(enriched);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/categories/:type - Create new category
router.post('/:type', checkType, upload.single('cover_image'), async (req, res) => {
  try {
    const db = getDb();
    const { type } = req.params;
    const { name, description = '', icon = '📁', visible = true, display_order } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'اسم التصنيف مطلوب' });
    }

    // Check for duplicate name
    const existing = await db.collection('categories').findOne({ type, name: name.trim() });
    if (existing) {
      return res.status(409).json({ error: 'اسم التصنيف مستخدم بالفعل' });
    }

    let coverImageUrl = '';
    let coverImagePublicId = '';

    if (req.file) {
      const up = await uploadBuffer(req.file.buffer, {
        folder: `categories/${type}`,
        filename: req.file.originalname,
        contentType: req.file.mimetype
      });
      coverImageUrl = up.url;
      coverImagePublicId = up.publicId;
    }

    // Auto-set display_order if not provided
    let order = display_order;
    if (order === undefined || order === null || order === '') {
      const maxOrderDoc = await db.collection('categories')
        .find({ type })
        .sort({ display_order: -1 })
        .limit(1)
        .toArray();
      order = (maxOrderDoc[0]?.display_order || 0) + 1;
    } else {
      order = Number(order);
    }

    const id = uuidv4();
    const now = new Date();

    await db.collection('categories').insertOne({
      _id: id,
      type,
      name: name.trim(),
      description: description.trim(),
      icon: icon.trim() || '📁',
      cover_image: coverImageUrl,
      cover_image_public_id: coverImagePublicId,
      display_order: order,
      visible: visible === 'true' || visible === true,
      created_at: now,
      updated_at: now
    });

    res.status(201).json({ ok: true, id });
  } catch (err) {
    console.error('Error creating category:', err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/admin/categories/:type/:id - Update category
router.put('/:type/:id', checkType, upload.single('cover_image'), async (req, res) => {
  try {
    const db = getDb();
    const { type, id } = req.params;

    const existing = await db.collection('categories').findOne({ _id: id, type });
    if (!existing) {
      return res.status(404).json({ error: 'التصنيف غير موجود' });
    }

    const { name, description, icon, visible, display_order } = req.body;

    // Check duplicate name if changing
    if (name && name.trim() !== existing.name) {
      const dup = await db.collection('categories').findOne({
        type,
        name: name.trim(),
        _id: { $ne: id }
      });
      if (dup) {
        return res.status(409).json({ error: 'اسم التصنيف مستخدم بالفعل' });
      }
    }

    const update = {
      name: name?.trim() ?? existing.name,
      description: description?.trim() ?? existing.description,
      icon: icon?.trim() ?? existing.icon,
      visible: visible === undefined ? existing.visible : (visible === 'true' || visible === true),
      display_order: display_order !== undefined && display_order !== '' ? Number(display_order) : existing.display_order,
      updated_at: new Date()
    };

    // Replace cover image if uploaded
    if (req.file) {
      if (existing.cover_image_public_id) {
        await deleteByPublicId(existing.cover_image_public_id);
      }
      const up = await uploadBuffer(req.file.buffer, {
        folder: `categories/${type}`,
        filename: req.file.originalname,
        contentType: req.file.mimetype
      });
      update.cover_image = up.url;
      update.cover_image_public_id = up.publicId;
    }

    await db.collection('categories').updateOne(
      { _id: id, type },
      { $set: update }
    );

    res.json({ ok: true });
  } catch (err) {
    console.error('Error updating category:', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/admin/categories/:type/:id
router.delete('/:type/:id', checkType, async (req, res) => {
  try {
    const db = getDb();
    const { type, id } = req.params;

    const existing = await db.collection('categories').findOne({ _id: id, type });
    if (!existing) {
      return res.status(404).json({ error: 'التصنيف غير موجود' });
    }

    // Check if any designs use this category
    const designCount = await db.collection('designs').countDocuments({ category_id: id });
    
    if (designCount > 0) {
      return res.status(409).json({ 
        error: `لا يمكن الحذف — يوجد ${designCount} تصميم مرتبط بهذا التصنيف. انقل التصاميم أولاً أو احذف التصاميم.`,
        design_count: designCount
      });
    }

    // Delete cover image if exists
    if (existing.cover_image_public_id) {
      await deleteByPublicId(existing.cover_image_public_id);
    }

    await db.collection('categories').deleteOne({ _id: id, type });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
