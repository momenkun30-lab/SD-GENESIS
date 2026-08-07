const express = require('express');
const { getDb } = require('../db');

const router = express.Router();

const VALID_TYPES = ['website', 'app'];

function serializeDesign(doc) {
  return {
    id: doc._id,
    design_id: doc.design_id,
    name: doc.name,
    category: doc.category,
    description: doc.description,
    image_url: doc.image_url,
    display_order: doc.display_order,
    selection_count: doc.selection_count || 0,
  };
}

// GET /api/designs/:type — visible designs only, ordered for display
router.get('/:type', async (req, res) => {
  try {
    const { type } = req.params;
    if (!VALID_TYPES.includes(type)) return res.status(400).json({ error: 'نوع غير صالح' });

    const db = getDb();
    const docs = await db
      .collection('designs')
      .find({ type, visible: true })
      .sort({ display_order: 1, created_at: 1 })
      .toArray();

    res.json(docs.map(serializeDesign));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/designs/:type/:id — single design detail
router.get('/:type/:id', async (req, res) => {
  try {
    const { type, id } = req.params;
    if (!VALID_TYPES.includes(type)) return res.status(400).json({ error: 'نوع غير صالح' });

    const db = getDb();
    const doc = await db.collection('designs').findOne({ _id: id, type, visible: true });
    if (!doc) return res.status(404).json({ error: 'التصميم غير موجود' });

    res.json(serializeDesign(doc));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/designs/:type/:id/select — increments the "chosen" counter, called when a visitor picks a design
router.post('/:type/:id/select', async (req, res) => {
  try {
    const { type, id } = req.params;
    if (!VALID_TYPES.includes(type)) return res.status(400).json({ error: 'نوع غير صالح' });

    const db = getDb();
    await db.collection('designs').updateOne({ _id: id, type }, { $inc: { selection_count: 1 } });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
