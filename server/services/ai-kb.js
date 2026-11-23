'use strict';
/**
 * Data layer for the assistant's approved knowledge base (MongoDB collections):
 *   ai_knowledge  — approved Q&A entries (added by the owner from the admin panel)
 *   ai_unanswered — questions users asked that had no approved answer (so the owner knows what to add)
 *   settings/_id:'ai' — welcome / fallback messages, confidence threshold, on/off
 *
 * The collection is EMPTY by default. Nothing about the company is pre-filled or invented.
 */
const crypto = require('crypto');
const { buildIndex, search, norm } = require('./kb-search');

const DEFAULT_SETTINGS = {
  enabled: true,
  welcome: 'مرحباً بك في مساعد SD GENESIS. اكتب سؤالك وسأبحث عنه في المعلومات المعتمدة فقط.',
  fallback: 'عذراً، لا تتوفر لدي حالياً معلومات معتمدة كافية للإجابة عن هذا السؤال. يرجى المحاولة لاحقاً.',
  min_confidence: 0.55,
};

const CATEGORIES = [
  'نبذة عن الشركة', 'تاريخ التأسيس', 'الرؤية والرسالة', 'الخدمات والمنتجات', 'معلومات التواصل',
  'الأسئلة الشائعة', 'الأسعار والشروط', 'أخرى',
];

const LIMITS = { question: 300, alt: 20, altLen: 300, keywords: 40, kwLen: 60, answer: 4000, category: 40, maxEntries: 5000, maxUnanswered: 2000 };

// ---- small in-memory cache (per server instance) so a burst of questions does not hit the database each time
const TTL = 20 * 1000;
const cache = { at: 0, index: null, settings: null, count: 0, pending: null };

function invalidate() { cache.at = 0; cache.index = null; cache.settings = null; cache.pending = null; }

function clean(s, max) {
  return String(s == null ? '' : s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max);
}

async function getSettings(db) {
  const doc = await db.collection('settings').findOne({ _id: 'ai' });
  return Object.assign({}, DEFAULT_SETTINGS, doc ? stripId(doc) : {});
}
function stripId(d) { const o = Object.assign({}, d); delete o._id; return o; }

async function saveSettings(db, input) {
  const cur = await getSettings(db);
  const next = {
    enabled: input.enabled === undefined ? cur.enabled : !!input.enabled,
    welcome: input.welcome === undefined ? cur.welcome : clean(input.welcome, 600) || DEFAULT_SETTINGS.welcome,
    fallback: input.fallback === undefined ? cur.fallback : clean(input.fallback, 600) || DEFAULT_SETTINGS.fallback,
    min_confidence: input.min_confidence === undefined ? cur.min_confidence : Math.min(0.9, Math.max(0.3, Number(input.min_confidence) || DEFAULT_SETTINGS.min_confidence)),
  };
  await db.collection('settings').updateOne({ _id: 'ai' }, { $set: Object.assign({ updated_at: new Date() }, next) }, { upsert: true });
  invalidate();
  return next;
}

/** Load (and memoise) the search index + settings. Concurrent callers share one load. */
async function load(db) {
  const now = Date.now();
  if (cache.index && now - cache.at < TTL) return cache;
  if (cache.pending) return cache.pending;
  cache.pending = (async () => {
    const [entries, settings] = await Promise.all([
      db.collection('ai_knowledge').find({ active: { $ne: false } }).limit(LIMITS.maxEntries).toArray(),
      getSettings(db),
    ]);
    cache.index = buildIndex(entries);
    cache.settings = settings;
    cache.count = entries.length;
    cache.at = Date.now();
    cache.pending = null;
    return cache;
  })().catch((e) => { cache.pending = null; throw e; });
  return cache.pending;
}

/**
 * Answer a question strictly from approved entries.
 * @returns {{answered:boolean, answer?:string, matched_question?:string, category?:string, suggestions:Array, settings}}
 */
async function ask(db, message, history) {
  const ctx = await load(db);
  const minConfidence = ctx.settings.min_confidence;
  let r = search(ctx.index, message, { minConfidence });
  // follow-up: a very short question may only make sense together with the previous one in this session
  if (!r.answered && Array.isArray(history) && history.length) {
    const short = norm(message).split(' ').filter(Boolean).length <= 3;
    if (short) {
      const prev = String(history[history.length - 1] || '');
      const r2 = search(ctx.index, prev + ' ' + message, { minConfidence });
      if (r2.answered) r = r2;
    }
  }
  if (r.answered) {
    return { answered: true, answer: r.entry.answer, matched_question: r.entry.question, category: r.entry.category || '', entry_id: r.entry._id, suggestions: [], score: r.score, ctx };
  }
  return { answered: false, suggestions: r.suggestions, score: r.score, ctx };
}

/** Remember what could not be answered (so the owner can add approved answers). Bounded, no personal data stored. */
async function logUnanswered(db, message) {
  const text = clean(message, 300);
  const key = crypto.createHash('sha1').update(norm(text).slice(0, 200)).digest('hex').slice(0, 24);
  if (!norm(text)) return;
  const col = db.collection('ai_unanswered');
  const exists = await col.findOne({ _id: key });
  if (!exists) {
    const n = await col.countDocuments({});
    if (n >= LIMITS.maxUnanswered) return;
    await col.updateOne({ _id: key }, { $setOnInsert: { text, first_at: new Date() }, $set: { last_at: new Date() }, $inc: { count: 1 } }, { upsert: true });
  } else {
    await col.updateOne({ _id: key }, { $set: { last_at: new Date() }, $inc: { count: 1 } });
  }
}

// ------------------------------------------------------------------ admin CRUD + validation
function validateEntry(input, { partial = false } = {}) {
  const errors = [];
  const out = {};
  if (!partial || input.question !== undefined) {
    out.question = clean(input.question, LIMITS.question);
    if (out.question.length < 3) errors.push('السؤال مطلوب (3 أحرف على الأقل)');
  }
  if (!partial || input.answer !== undefined) {
    out.answer = clean(input.answer, LIMITS.answer);
    if (!out.answer) errors.push('الإجابة المعتمدة مطلوبة');
  }
  if (!partial || input.alt_questions !== undefined) {
    const src = Array.isArray(input.alt_questions) ? input.alt_questions : String(input.alt_questions || '').split(/\r?\n/);
    out.alt_questions = src.map((s) => clean(s, LIMITS.altLen)).filter(Boolean).slice(0, LIMITS.alt);
  }
  if (!partial || input.keywords !== undefined) {
    const src = Array.isArray(input.keywords) ? input.keywords : String(input.keywords || '').split(/[,،\n]/);
    out.keywords = src.map((s) => clean(s, LIMITS.kwLen)).filter(Boolean).slice(0, LIMITS.keywords);
  }
  if (!partial || input.category !== undefined) out.category = clean(input.category || 'أخرى', LIMITS.category) || 'أخرى';
  if (!partial || input.active !== undefined) out.active = input.active === undefined ? true : !!input.active;
  return { errors, value: out };
}

async function listEntries(db, { q = '', category = '', limit = 500 } = {}) {
  const filter = {};
  if (category) filter.category = category;
  let docs = await db.collection('ai_knowledge').find(filter).sort({ updated_at: -1 }).limit(Math.min(limit, LIMITS.maxEntries)).toArray();
  if (q) {
    const nq = norm(q);
    docs = docs.filter((d) => norm([d.question, (d.alt_questions || []).join(' '), (d.keywords || []).join(' '), d.answer, d.category].join(' ')).includes(nq));
  }
  return docs;
}

async function createEntry(db, input) {
  const { errors, value } = validateEntry(input);
  if (errors.length) return { errors };
  const total = await db.collection('ai_knowledge').countDocuments({});
  if (total >= LIMITS.maxEntries) return { errors: ['تم الوصول إلى الحد الأقصى لعدد المواد'] };
  const now = new Date();
  const doc = Object.assign({ _id: crypto.randomUUID(), created_at: now, updated_at: now }, value);
  await db.collection('ai_knowledge').insertOne(doc);
  invalidate();
  return { entry: doc };
}

async function updateEntry(db, id, input) {
  const { errors, value } = validateEntry(input, { partial: true });
  if (errors.length) return { errors };
  const r = await db.collection('ai_knowledge').updateOne({ _id: String(id) }, { $set: Object.assign({ updated_at: new Date() }, value) });
  if (!r.matchedCount) return { notFound: true };
  invalidate();
  return { entry: await db.collection('ai_knowledge').findOne({ _id: String(id) }) };
}

async function deleteEntry(db, id) {
  const r = await db.collection('ai_knowledge').deleteOne({ _id: String(id) });
  invalidate();
  return { deleted: r.deletedCount > 0 };
}

async function importEntries(db, list) {
  if (!Array.isArray(list)) return { errors: ['الملف يجب أن يحتوي على مصفوفة من المواد'] };
  if (list.length > 500) return { errors: ['الحد الأقصى 500 مادة في كل استيراد'] };
  let added = 0; const skipped = [];
  for (let i = 0; i < list.length; i++) {
    const r = await createEntry(db, list[i] || {});
    if (r.entry) added++; else skipped.push({ index: i, errors: r.errors });
  }
  return { added, skipped };
}

async function listUnanswered(db) {
  return db.collection('ai_unanswered').find({}).sort({ count: -1, last_at: -1 }).limit(300).toArray();
}
async function deleteUnanswered(db, id) { const r = await db.collection('ai_unanswered').deleteOne({ _id: String(id) }); return { deleted: r.deletedCount > 0 }; }

module.exports = {
  DEFAULT_SETTINGS, CATEGORIES, LIMITS,
  invalidate, load, ask, logUnanswered, getSettings, saveSettings,
  validateEntry, listEntries, createEntry, updateEntry, deleteEntry, importEntries, listUnanswered, deleteUnanswered,
};
