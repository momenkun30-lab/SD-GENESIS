'use strict';
const express = require('express');
const { getDb } = require('../db');
const { requireAdmin } = require('../middleware/auth');
const kb = require('../services/ai-kb');

const router = express.Router();
router.use(requireAdmin);

router.get('/meta', (req, res) => res.json({ categories: kb.CATEGORIES, limits: kb.LIMITS, defaults: kb.DEFAULT_SETTINGS }));

// ---- knowledge base entries
router.get('/kb', async (req, res, next) => {
  try { res.json(await kb.listEntries(getDb(), { q: String(req.query.q || '').slice(0, 100), category: String(req.query.category || '').slice(0, 40) })); } catch (e) { next(e); }
});
router.get('/kb/export', async (req, res, next) => {
  try {
    const docs = await kb.listEntries(getDb(), { limit: 5000 });
    res.setHeader('Content-Disposition', 'attachment; filename="sd-genesis-knowledge.json"');
    res.json(docs.map(({ question, alt_questions, keywords, answer, category, active }) => ({ question, alt_questions, keywords, answer, category, active })));
  } catch (e) { next(e); }
});
router.post('/kb/import', express.json({ limit: '2mb' }), async (req, res, next) => {
  try {
    const r = await kb.importEntries(getDb(), req.body && req.body.entries);
    if (r.errors) return res.status(400).json({ error: r.errors[0] });
    res.json(r);
  } catch (e) { next(e); }
});
router.post('/kb', async (req, res, next) => {
  try {
    const r = await kb.createEntry(getDb(), req.body || {});
    if (r.errors) return res.status(400).json({ error: r.errors.join(' — ') });
    res.status(201).json(r.entry);
  } catch (e) { next(e); }
});
router.put('/kb/:id', async (req, res, next) => {
  try {
    const r = await kb.updateEntry(getDb(), req.params.id, req.body || {});
    if (r.errors) return res.status(400).json({ error: r.errors.join(' — ') });
    if (r.notFound) return res.status(404).json({ error: 'المادة غير موجودة' });
    res.json(r.entry);
  } catch (e) { next(e); }
});
router.delete('/kb/:id', async (req, res, next) => {
  try { const r = await kb.deleteEntry(getDb(), req.params.id); res.status(r.deleted ? 200 : 404).json(r.deleted ? { ok: true } : { error: 'المادة غير موجودة' }); } catch (e) { next(e); }
});

// ---- questions users asked that had no approved answer
router.get('/unanswered', async (req, res, next) => { try { res.json(await kb.listUnanswered(getDb())); } catch (e) { next(e); } });
router.delete('/unanswered/:id', async (req, res, next) => { try { res.json(await kb.deleteUnanswered(getDb(), req.params.id)); } catch (e) { next(e); } });

// ---- settings (welcome text, fallback text, confidence, on/off)
router.get('/settings', async (req, res, next) => { try { res.json(Object.assign(await kb.getSettings(getDb()), { ai_model: require('../services/llm').publicInfo() })); } catch (e) { next(e); } });
router.put('/settings', async (req, res, next) => { try { res.json(await kb.saveSettings(getDb(), req.body || {})); } catch (e) { next(e); } });

module.exports = router;
