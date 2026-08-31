const express = require('express');
const { getDb } = require('../db');

const router = express.Router();
const VALID_TYPES = ['website', 'app'];

// GET /api/design-categories/:type — categories with a live count of visible designs in each
router.get('/:type', async (req, res) => {
  try {
    const { type } = req.params;
    if (!VALID_TYPES.includes(type)) return res.status(400).json({ error: 'نوع غير صالح' });

    const db = getDb();
    const categories = await db
      .collection('design_categories')
      .find({ type })
      .sort({ display_order: 1, created_at: 1 })
      .toArray();

    const counts = await db
      .collection('designs')
      .aggregate([
        { $match: { type, visible: true } },
        { $group: { _id: '$category', count: { $sum: 1 } } },
      ])
      .toArray();
    const countMap = Object.fromEntries(counts.map((c) => [c._id, c.count]));

    res.json(
      categories.map((c) => ({
        id: c._id,
        name: c.name,
        description: c.description,
        image_url: c.image_url,
        design_count: countMap[c.name] || 0,
      }))
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
