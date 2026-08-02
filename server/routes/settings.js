const express = require('express');
const { getDb } = require('../db');

const router = express.Router();

// GET /api/settings — public, read-only. Returns whatever branding assets the admin has uploaded.
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

module.exports = router;
