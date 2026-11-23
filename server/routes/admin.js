const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db');
const { requireAdmin, JWT_SECRET } = require('../middleware/auth');
const { upload } = require('../middleware/upload');
const { uploadBuffer, deleteByPublicId } = require('../services/storage');

const router = express.Router();

function slugify(name) {
  return (
    name
      .toString()
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9\u0600-\u06FF]+/g, '-')
      .replace(/^-+|-+$/g, '') || uuidv4().slice(0, 8)
  );
}

// ---------- Auth ----------
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'أدخل اسم المستخدم وكلمة المرور' });

    const db = getDb();
    const admin = await db.collection('admins').findOne({ username });
    // async compare: compareSync would block the whole server (CPU-heavy) while checking the password
    if (!admin || !(await bcrypt.compare(String(password), admin.password_hash))) {
      return res.status(401).json({ error: 'بيانات الدخول غير صحيحة' });
    }

    const token = jwt.sign({ id: admin._id.toString(), username: admin.username }, JWT_SECRET, { expiresIn: '12h' });
    res.cookie('admin_token', token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 12 * 60 * 60 * 1000,
    });
    res.json({ ok: true, username: admin.username });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/logout', (req, res) => {
  res.clearCookie('admin_token');
  res.json({ ok: true });
});

router.get('/me', requireAdmin, (req, res) => {
  res.json({ username: req.admin.username });
});

// everything below requires a valid admin session
router.use(requireAdmin);

// ---------- Apps CRUD ----------
router.get('/apps', async (req, res) => {
  try {
    const db = getDb();
    const docs = await db.collection('apps').find({}).sort({ updated_at: -1 }).toArray();
    res.json(docs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post(
  '/apps',
  upload.fields([{ name: 'icon', maxCount: 1 }, { name: 'screenshots', maxCount: 8 }, { name: 'file', maxCount: 1 }]),
  async (req, res) => {
    try {
      const db = getDb();
      const { name, description = '', version = '1.0.0', changelog = '', published } = req.body;
      if (!name) return res.status(400).json({ error: 'اسم التطبيق مطلوب' });

      const id = uuidv4();
      let slug = slugify(name);
      const exists = await db.collection('apps').findOne({ slug });
      if (exists) slug = `${slug}-${id.slice(0, 6)}`;

      const iconFile = req.files?.icon?.[0];
      const screenshotFiles = req.files?.screenshots || [];
      const packageFile = req.files?.file?.[0];

      let icon_url = null, icon_public_id = null;
      if (iconFile) {
        const up = await uploadBuffer(iconFile.buffer, {
          folder: 'icons',
          filename: iconFile.originalname,
          contentType: iconFile.mimetype,
        });
        icon_url = up.url;
        icon_public_id = up.publicId;
      }

      const screenshots = [];
      const screenshot_public_ids = [];
      for (const f of screenshotFiles) {
        const up = await uploadBuffer(f.buffer, {
          folder: 'screenshots',
          filename: f.originalname,
          contentType: f.mimetype,
        });
        screenshots.push(up.url);
        screenshot_public_ids.push(up.publicId);
      }

      let file_url = null, file_public_id = null;
      if (packageFile) {
        const up = await uploadBuffer(packageFile.buffer, {
          folder: 'files',
          filename: packageFile.originalname,
          contentType: packageFile.mimetype,
        });
        file_url = up.url;
        file_public_id = up.publicId;
      }

      const now = new Date();
      await db.collection('apps').insertOne({
        _id: id,
        name,
        slug,
        description,
        version,
        size_bytes: packageFile ? packageFile.size : 0,
        changelog,
        icon_url,
        icon_public_id,
        screenshots,
        screenshot_public_ids,
        file_url,
        file_public_id,
        file_name: packageFile ? packageFile.originalname : null,
        published: published === 'true' || published === true,
        download_count: 0,
        created_at: now,
        updated_at: now,
      });

      res.status(201).json({ ok: true, id, slug });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

router.put(
  '/apps/:id',
  upload.fields([{ name: 'icon', maxCount: 1 }, { name: 'screenshots', maxCount: 8 }, { name: 'file', maxCount: 1 }]),
  async (req, res) => {
    try {
      const db = getDb();
      const existing = await db.collection('apps').findOne({ _id: req.params.id });
      if (!existing) return res.status(404).json({ error: 'التطبيق غير موجود' });

      const { name, description, version, changelog, published } = req.body;
      const iconFile = req.files?.icon?.[0];
      const screenshotFiles = req.files?.screenshots || [];
      const packageFile = req.files?.file?.[0];

      const update = {
        name: name ?? existing.name,
        description: description ?? existing.description,
        version: version ?? existing.version,
        changelog: changelog ?? existing.changelog,
        published: published === undefined ? existing.published : (published === 'true' || published === true),
        updated_at: new Date(),
      };

      if (iconFile) {
        await deleteByPublicId(existing.icon_public_id);
        const up = await uploadBuffer(iconFile.buffer, {
          folder: 'icons',
          filename: iconFile.originalname,
          contentType: iconFile.mimetype,
        });
        update.icon_url = up.url;
        update.icon_public_id = up.publicId;
      }

      if (screenshotFiles.length) {
        for (const pid of existing.screenshot_public_ids || []) await deleteByPublicId(pid);
        const screenshots = [];
        const screenshot_public_ids = [];
        for (const f of screenshotFiles) {
          const up = await uploadBuffer(f.buffer, {
            folder: 'screenshots',
            filename: f.originalname,
            contentType: f.mimetype,
          });
          screenshots.push(up.url);
          screenshot_public_ids.push(up.publicId);
        }
        update.screenshots = screenshots;
        update.screenshot_public_ids = screenshot_public_ids;
      }

      if (packageFile) {
        await deleteByPublicId(existing.file_public_id);
        const up = await uploadBuffer(packageFile.buffer, {
          folder: 'files',
          filename: packageFile.originalname,
          contentType: packageFile.mimetype,
        });
        update.file_url = up.url;
        update.file_public_id = up.publicId;
        update.file_name = packageFile.originalname;
        update.size_bytes = packageFile.size;
      }

      await db.collection('apps').updateOne({ _id: req.params.id }, { $set: update });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

router.delete('/apps/:id', async (req, res) => {
  try {
    const db = getDb();
    const existing = await db.collection('apps').findOne({ _id: req.params.id });
    if (!existing) return res.status(404).json({ error: 'التطبيق غير موجود' });

    await deleteByPublicId(existing.icon_public_id);
    await deleteByPublicId(existing.file_public_id);
    for (const pid of existing.screenshot_public_ids || []) await deleteByPublicId(pid);

    await db.collection('apps').deleteOne({ _id: req.params.id });
    await db.collection('downloads').deleteMany({ app_id: req.params.id });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Stats ----------
router.get('/stats', async (req, res) => {
  try {
    const db = getDb();
    const apps = await db.collection('apps').find({}).toArray();
    const totals = {
      apps: apps.length,
      downloads: apps.reduce((sum, a) => sum + (a.download_count || 0), 0),
    };

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const daily = await db
      .collection('downloads')
      .aggregate([
        { $match: { downloaded_at: { $gte: thirtyDaysAgo } } },
        { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$downloaded_at' } }, count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ])
      .toArray();

    const topApps = [...apps]
      .sort((a, b) => (b.download_count || 0) - (a.download_count || 0))
      .slice(0, 10)
      .map((a) => ({ name: a.name, slug: a.slug, download_count: a.download_count || 0 }));

    res.json({ totals, daily: daily.map((d) => ({ day: d._id, count: d.count })), topApps });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
