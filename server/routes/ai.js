'use strict';
const express = require('express');
const { getDb } = require('../db');
const kb = require('../services/ai-kb');
const { askLimiter } = require('../middleware/rate-limit');
const llm = require('../services/llm');

// cost guard per server instance: at most AI_DAILY_LIMIT model calls per day (default 3000)
const daily = { day: '', n: 0 };
function underDailyLimit() {
  const d = new Date().toISOString().slice(0, 10), max = Number(process.env.AI_DAILY_LIMIT) || 3000;
  if (daily.day !== d) { daily.day = d; daily.n = 0; }
  if (daily.n >= max) return false; daily.n++; return true;
}
function aiOn(settings) { return settings.use_ai !== false && llm.isConfigured(); }

const router = express.Router();
const MAX_MESSAGE = 500;

// GET /api/ai/config — what the chat UI needs on load (no company data, just status + messages)
router.get('/config', async (req, res, next) => {
  try {
    const ctx = await kb.load(getDb());
    res.json({
      enabled: ctx.settings.enabled,
      welcome: ctx.settings.welcome,
      kb_count: ctx.count,                    // number of approved entries
      ai: aiOn(ctx.settings),                 // an AI model answers general questions too (company facts still only from approved entries)
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
    // history: last turns of this conversation. Accepts ["question", ...] or [{role, content}, ...]
    const raw = Array.isArray(body.history) ? body.history.slice(-8) : [];
    const turns = raw.map((h) => (typeof h === 'string' ? { role: 'user', content: h } : h && typeof h.content === 'string' ? { role: h.role === 'assistant' ? 'assistant' : 'user', content: h.content } : null))
      .filter(Boolean).map((h) => ({ role: h.role, content: h.content.slice(0, 1200) }));
    const history = turns.filter((h) => h.role === 'user').map((h) => h.content.slice(0, 300)).slice(-3);

    const db = getDb();
    const r = await kb.ask(db, message, history);
    if (!r.ctx.settings.enabled) return res.json({ answered: false, disabled: true, message: 'المساعد متوقف مؤقتًا.', suggestions: [] });

    // 1) an approved answer matches -> show it exactly as the owner wrote it
    if (r.answered) {
      return res.json({ answered: true, source: 'kb', answer: r.answer, matched_question: r.matched_question, category: r.category, suggestions: [] });
    }
    // 2) AI model (if the owner switched it on and the key is set on the server)
    if (aiOn(r.ctx.settings) && underDailyLimit()) {
      try {
        const answer = await llm.complete(r.ctx.entries, r.ctx.settings.fallback, turns.concat([{ role: 'user', content: message }]));
        kb.logUnanswered(db, message).catch(() => {});   // still tell the owner which questions had no approved entry
        return res.json({ answered: true, source: 'ai', answer, category: '', suggestions: [] });
      } catch (e) {
        console.error(JSON.stringify({ level: 'error', msg: 'ai provider failed', status: e && e.status, detail: String(e && e.message).slice(0, 300) }));
      }
    }
    // 3) nothing approved and no AI -> honest fallback
    kb.logUnanswered(db, message).catch(() => {});
    res.json({ answered: false, message: r.ctx.settings.fallback, suggestions: r.suggestions.map((s) => ({ question: s.question })) });
  } catch (err) { next(err); }
});

module.exports = router;
