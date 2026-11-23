'use strict';
const express = require('express');
const { getDb } = require('../db');
const kb = require('../services/ai-kb');
const { askLimiter } = require('../middleware/rate-limit');

const router = express.Router();
const MAX_MESSAGE = 500;

// GET /api/ai/config — what the chat UI needs on load (no company data, just status + messages)
router.get('/config', async (req, res, next) => {
  try {
    const ctx = await kb.load(getDb());
    res.json({
      enabled: ctx.settings.enabled,
      welcome: ctx.settings.welcome,
      kb_count: ctx.count,                    // number of approved entries (0 until the owner adds some)
      max_message: MAX_MESSAGE,
    });
  } catch (err) { next(err); }
});

// POST /api/ai/ask — { message, history?: string[] }  ->  answer ONLY from approved knowledge, else the fallback message
router.post('/ask', askLimiter, async (req, res, next) => {
  try {
    const body = req.body || {};
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    if (!message) return res.status(400).json({ error: 'اكتب سؤالك أولًا' });
    if (message.length > MAX_MESSAGE) return res.status(400).json({ error: `الحد الأقصى للسؤال ${MAX_MESSAGE} حرفًا` });
    const history = Array.isArray(body.history) ? body.history.filter((h) => typeof h === 'string').slice(-3).map((h) => h.slice(0, 300)) : [];

    const db = getDb();
    const r = await kb.ask(db, message, history);
    if (!r.ctx.settings.enabled) return res.json({ answered: false, disabled: true, message: 'المساعد متوقف مؤقتًا.', suggestions: [] });

    if (r.answered) {
      return res.json({ answered: true, answer: r.answer, matched_question: r.matched_question, category: r.category, suggestions: [] });
    }
    // fire-and-forget: remember the question so the owner can add an approved answer later
    kb.logUnanswered(db, message).catch(() => {});
    res.json({ answered: false, message: r.ctx.settings.fallback, suggestions: r.suggestions.map((s) => ({ question: s.question })) });
  } catch (err) { next(err); }
});

module.exports = router;
