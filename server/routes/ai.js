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
const MAX_CHAT_MESSAGE = 4000;

// GET /api/ai/config — what the chat UI needs on load (no company data, just status + messages)
router.get('/config', async (req, res, next) => {
  try {
    const ctx = await kb.load(getDb());
    res.json({
      enabled: ctx.settings.enabled,
      welcome: ctx.settings.welcome,
      kb_count: ctx.count,                    // number of approved entries
      ai: aiOn(ctx.settings),                 // a language model answers (company facts from approved entries)
      web_search: aiOn(ctx.settings) && llm.publicInfo().web_search === true,
      max_chat: MAX_CHAT_MESSAGE,
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

// POST /api/ai/chat — the real assistant, streamed (Server-Sent Events)
// body: { messages: [{role:'user'|'assistant', content}] }  (whole conversation, last = the new user message)
// events: status {text} · delta {text} · sources {items} · done {model, source} · error {message, retry}
router.post('/chat', askLimiter, async (req, res, next) => {
  let ctx;
  try {
    const raw = Array.isArray((req.body || {}).messages) ? req.body.messages.slice(-40) : [];
    const msgs = raw.filter((m) => m && typeof m.content === 'string' && m.content.trim())
      .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content.slice(0, 8000) }));
    const lastMsg = msgs[msgs.length - 1];
    if (!lastMsg || lastMsg.role !== 'user') return res.status(400).json({ error: 'اكتب رسالتك أولًا' });
    if (lastMsg.content.length > MAX_CHAT_MESSAGE) return res.status(400).json({ error: `الحد الأقصى للرسالة ${MAX_CHAT_MESSAGE} حرف` });
    ctx = await kb.load(getDb());
  } catch (err) { return next(err); }

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  if (res.flushHeaders) res.flushHeaders();
  const send = (event, data) => { if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
  const ctrl = new AbortController();
  res.on('close', () => { if (!res.writableEnded) ctrl.abort(); });          // user pressed stop or left the page
  const ping = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, 15000);
  const finish = () => { clearInterval(ping); if (!res.writableEnded) res.end(); };

  try {
    const msgs = req.body.messages.slice(-40).filter((m) => m && typeof m.content === 'string' && m.content.trim())
      .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content.slice(0, 8000) }));
    const question = msgs[msgs.length - 1].content;
    if (!ctx.settings.enabled) { send('error', { message: 'المساعد متوقف مؤقتًا.', retry: false }); return finish(); }

    const kbAnswer = () => {
      const userTurns = msgs.filter((m) => m.role === 'user').map((m) => m.content);
      return kb.ask(getDb(), question, userTurns.slice(-4, -1));
    };

    if (aiOn(ctx.settings) && underDailyLimit()) {
      send('status', { text: 'يفكّر…' });
      try {
        const out = await llm.stream(ctx.entries, ctx.settings.fallback, msgs, (ev) => {
          if (ev.type === 'delta') send('delta', { text: ev.text });
          else if (ev.type === 'status') send('status', { text: ev.text });
        }, ctrl.signal);
        if (out.sources && out.sources.length) send('sources', { items: out.sources });
        send('done', { source: 'ai', model: out.model });
        return finish();
      } catch (e) {
        if (ctrl.signal.aborted) return finish();
        console.error(JSON.stringify({ level: 'error', msg: 'ai provider failed', status: e && e.status, detail: String(e && e.message).slice(0, 300) }));
        // the model failed: an approved answer is still better than nothing
        const r = await kbAnswer().catch(() => null);
        if (r && r.answered) { send('delta', { text: r.answer }); send('done', { source: 'kb', category: r.category, degraded: true }); return finish(); }
        send('error', { message: 'تعذّر الوصول إلى نموذج الذكاء الاصطناعي الآن. حاول مرة أخرى بعد قليل.', retry: true });
        return finish();
      }
    }
    // no model configured / switched off: approved knowledge only
    const r = await kbAnswer();
    if (r.answered) { send('delta', { text: r.answer }); send('done', { source: 'kb', category: r.category }); }
    else {
      kb.logUnanswered(getDb(), question).catch(() => {});
      send('delta', { text: ctx.settings.fallback }); send('done', { source: 'none', suggestions: r.suggestions.map((s) => s.question) });
    }
    finish();
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', msg: 'chat failed', detail: String(err && err.message).slice(0, 300) }));
    send('error', { message: 'حدث خطأ غير متوقع. حاول مرة أخرى.', retry: true }); finish();
  }
});

module.exports = router;
