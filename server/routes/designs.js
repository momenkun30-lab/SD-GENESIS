const express = require('express');
const { getDb } = require('../db');
const router = express.Router();

const VALID_TYPES = ['website', 'app'];

function serializeDesign(doc) {
  return {
    id: doc._id,
    design_id: doc.design_id,
    name: doc.name,
    category: doc.category,  // Old text field (kept for backward compatibility)
    category_id: doc.category_id || null,  // New foreign key to categories
    description: doc.description,
    image_url: doc.image_url,
    display_order: doc.display_order,
    selection_count: doc.selection_count || 0,
    visible: doc.visible !== false,
    type: doc.type,
    created_at: doc.created_at,
    updated_at: doc.updated_at
  };
}

// GET /api/designs/:type - visible designs, optionally filtered by category
// Optional query: ?category=CATEGORY_ID (or "all")
router.get('/:type', async (req, res) => {
  try {
    const { type } = req.params;
    const { category } = req.query;
    
    if (!VALID_TYPES.includes(type)) {
      return res.status(400).json({ error: 'نوع غير صالح' });
    }

    const db = getDb();
    const filter = { type, visible: true };
    
    // If category filter is provided and not "all", apply it
    if (category && category !== 'all') {
      filter.category_id = category;
    }

    const docs = await db
      .collection('designs')
      .find(filter)
      .sort({ display_order: 1, created_at: 1 })
      .toArray();

    res.json(docs.map(serializeDesign));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/designs/:type/:id - single design
router.get('/:type/:id', async (req, res) => {
  try {
    const { type, id } = req.params;
    if (!VALID_TYPES.includes(type)) {
      return res.status(400).json({ error: 'نوع غير صالح' });
    }
    
    const db = getDb();
    const doc = await db.collection('designs').findOne({ _id: id, type, visible: true });
    if (!doc) {
      return res.status(404).json({ error: 'التصميم غير موجود' });
    }
    
    res.json(serializeDesign(doc));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/designs/:type/:id/select - increments the "chosen" counter
router.post('/:type/:id/select', async (req, res) => {
  try {
    const { type, id } = req.params;
    if (!VALID_TYPES.includes(type)) {
      return res.status(400).json({ error: 'نوع غير صالح' });
    }
    
    const db = getDb();
    await db.collection('designs').updateOne(
      { _id: id, type },
      { $inc: { selection_count: 1 } }
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
