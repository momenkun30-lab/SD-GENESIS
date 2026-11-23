const express = require('express');
const crypto = require('crypto');
const { getDb } = require('../db');

const router = express.Router();

// short in-memory cooldown to stop double-click / bot spam from inflating the
// counter, without touching how downloads are recorded in the database.
const recentHits = new Map(); // key: `${ipHash}:${appId}` -> timestamp
const COOLDOWN_MS = 15_000;

function hashIp(ip) {
  return crypto.createHash('sha256').update(String(ip)).digest('hex').slice(0, 16);
}

function serializeApp(doc, { full = false } = {}) {
  const base = {
    id: doc._id,
    name: doc.name,
    slug: doc.slug,
    description: doc.description,
    version: doc.version,
    size_bytes: doc.size_bytes,
    icon_url: doc.icon_url || null,
    screenshots: doc.screenshots || [],
    download_count: doc.download_count || 0,
    updated_at: doc.updated_at,
  };
  if (full) base.changelog = doc.changelog;
  return base;
}

// GET /api/apps — published apps only
router.get('/apps', async (req, res) => {
  try {
    const db = getDb();
    const docs = await db.collection('apps').find({ published: true }).sort({ updated_at: -1 }).toArray();
    res.json(docs.map((d) => serializeApp(d)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/apps/:slug
router.get('/apps/:slug', async (req, res) => {
  try {
    const db = getDb();
    const doc = await db.collection('apps').findOne({ slug: req.params.slug, published: true });
    if (!doc) return res.status(404).json({ error: 'التطبيق غير موجود' });
    res.json(serializeApp(doc, { full: true }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/apps/:slug/download — the only place download_count changes.
// The actual file lives on Cloudinary, so we just count and redirect there.
router.get('/apps/:slug/download', async (req, res) => {
  try {
    const db = getDb();
    const doc = await db.collection('apps').findOne({ slug: req.params.slug, published: true });
    if (!doc || !doc.file_url) return res.status(404).json({ error: 'ملف التطبيق غير متاح' });

    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
    const ipHash = hashIp(ip);
    const key = `${ipHash}:${doc._id}`;
    const now = Date.now();
    const last = recentHits.get(key);

    const withinCooldown = last && now - last < COOLDOWN_MS;
    if (!withinCooldown) {
      if (recentHits.size > 5000) { for (const [k, ts] of recentHits) if (now - ts > COOLDOWN_MS) recentHits.delete(k); if (recentHits.size > 5000) recentHits.clear(); }
      recentHits.set(key, now);
      await db.collection('apps').updateOne({ _id: doc._id }, { $inc: { download_count: 1 } });
      await db.collection('downloads').insertOne({ app_id: doc._id, ip_hash: ipHash, downloaded_at: new Date() });
    }

    res.redirect(doc.file_url);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
