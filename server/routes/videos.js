const express = require('express');
const { getDb } = require('../db');

const router = express.Router();

function serializeVideo(d) {
  return {
    id: d._id,
    title: d.title,
    description: d.description || '',
    video_type: d.video_type || '',
    design_type: d.design_type || '',
    video_url: d.video_url,
    thumbnail_url: d.thumbnail_url || null,
    display_order: d.display_order,
  };
}

// GET /api/videos — visible videos only, in the admin-defined order
router.get('/', async (req, res) => {
  try {
    const db = getDb();
    const docs = await db
      .collection('videos')
      .find({ visible: true })
      .sort({ display_order: 1, created_at: 1 })
      .toArray();
    res.json(docs.map(serializeVideo));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
