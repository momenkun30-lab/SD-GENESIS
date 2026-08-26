const express = require('express');
const { getDb } = require('../db');
const router = express.Router();

const VALID_TYPES = ['website', 'app'];

// Serialization helper
function serializeCategory(doc) {
  return {
    id: doc._id,
    name: doc.name,
    description: doc.description || '',
    icon: doc.icon || '📁',
    cover_image: doc.cover_image || '',
    type: doc.type,
    display_order: doc.display_order || 0,
    visible: doc.visible !== false,
    design_count: doc.design_count || 0,
    created_at: doc.created_at,
    updated_at: doc.updated_at
  };
}

// GET /api/categories/:type - Get all visible categories for a type
router.get('/:type', async (req, res) => {
  try {
    const { type } = req.params;
    if (!VALID_TYPES.includes(type)) {
      return res.status(400).json({ error: 'نوع غير صالح' });
    }

    const db = getDb();
    
    // Get all visible categories for this type
    const categories = await db
      .collection('categories')
      .find({ type, visible: true })
      .sort({ display_order: 1, name: 1 })
      .toArray();

    // Count designs per category
    const designCounts = await db
      .collection('designs')
      .aggregate([
        { $match: { type, visible: true } },
        { $group: { _id: '$category_id', count: { $sum: 1 } } }
      ])
      .toArray();

    const countMap = {};
    designCounts.forEach(dc => {
      countMap[dc._id] = dc.count;
    });

    // Enrich categories with design counts
    const enriched = categories.map(cat => ({
      ...serializeCategory(cat),
      design_count: countMap[cat._id] || 0
    }));

    res.json(enriched);
  } catch (err) {
    console.error('Error fetching categories:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/categories/:type/:id - Get single category
router.get('/:type/:id', async (req, res) => {
  try {
    const { type, id } = req.params;
    if (!VALID_TYPES.includes(type)) {
      return res.status(400).json({ error: 'نوع غير صالح' });
    }

    const db = getDb();
    const category = await db.collection('categories').findOne({ _id: id, type });
    
    if (!category) {
      return res.status(404).json({ error: 'التصنيف غير موجود' });
    }

    res.json(serializeCategory(category));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
