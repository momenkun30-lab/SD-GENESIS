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
  use_ai: true,          // use the external AI model (only when AI_API_KEY is set on the server)
};

// Official company facts approved by the owner (2026-11-24). Added ONCE automatically; after that the owner manages them
// from the dashboard (edit / delete) and they are never re-added.
const SEED = [
  { category: 'نبذة عن الشركة', question: 'ما هي شركة SD GENESIS؟',
    alt_questions: ['عرفني بالشركة', 'من أنتم؟', 'نبذة عن الشركة', 'ما هي SD GENESIS'],
    keywords: ['الشركة', 'نبذة', 'تعريف', 'من نحن'],
    answer: 'SD GENESIS — إس دي جينيسس للتكنولوجيا الحديثة المحدودة (SD GENESIS FOR MODERN TECHNOLOGY CO. L.T.D) شركة متخصصة في التكنولوجيا: الاختراع والتطوير.\nتأسست في 15 فبراير 2026 على يد المؤسس سعد صديق علي محمد (المعروف بـ سعد صديق).\nرسالتها: دمج التكنولوجيا في كل شيء عبر المشاريع التاريخية والمستقبلية.\nوهي حاليًا في مرحلة تطوير الشركة والتوسع بها نحو العالمية.' },
  { category: 'نبذة عن الشركة', question: 'ما هو الاسم الرسمي للشركة بالعربية؟',
    alt_questions: ['ما اسم الشركة', 'اسم الشركة بالعربي', 'الاسم الكامل للشركة', 'الاسم الرسمي للشركة'],
    keywords: ['الاسم', 'اسم', 'بالعربية', 'الرسمي'],
    answer: 'الاسم الرسمي للشركة بالعربية: إس دي جينيسس للتكنولوجيا الحديثة المحدودة.' },
  { category: 'نبذة عن الشركة', question: 'ما هو اسم الشركة بالإنجليزية؟',
    alt_questions: ['اسم الشركة بالانجليزي', 'الاسم الإنجليزي للشركة', 'What is the company name in English', 'company official name'],
    keywords: ['انجليزي', 'الإنجليزية', 'english', 'name'],
    answer: 'الاسم الرسمي للشركة بالإنجليزية: SD GENESIS FOR MODERN TECHNOLOGY CO. L.T.D' },
  { category: 'تاريخ التأسيس', question: 'متى تأسست شركة SD GENESIS؟',
    alt_questions: ['تاريخ تأسيس الشركة', 'متى تم تأسيس الشركة', 'سنة التأسيس', 'متى بدأت الشركة'],
    keywords: ['تأسست', 'التأسيس', 'تأسيس', 'تاريخ', 'متى'],
    answer: 'تأسست شركة SD GENESIS في 15 فبراير 2026.' },
  { category: 'نبذة عن الشركة', question: 'من هو مؤسس شركة SD GENESIS؟',
    alt_questions: ['من أسس الشركة', 'مؤسس الشركة', 'من صاحب الشركة', 'من هو سعد صديق'],
    keywords: ['مؤسس', 'المؤسس', 'أسس', 'سعد', 'صديق', 'صاحب'],
    answer: 'مؤسس الشركة هو سعد صديق علي محمد (المعروف بـ سعد صديق)، من مواليد 25/12/2007 في القضارف، السودان.' },
  { category: 'الخدمات والمنتجات', question: 'ما هو تخصص الشركة؟',
    alt_questions: ['في ماذا تعمل الشركة', 'مجال الشركة', 'ماذا تفعل الشركة', 'نشاط الشركة'],
    keywords: ['تخصص', 'مجال', 'نشاط', 'تعمل', 'التكنولوجيا', 'اختراع', 'تطوير'],
    answer: 'تتخصص شركة SD GENESIS في التكنولوجيا: الاختراع والتطوير.' },
  { category: 'الرؤية والرسالة', question: 'ما هي رسالة الشركة؟',
    alt_questions: ['ما رؤية الشركة', 'ما هدف الشركة', 'رسالة SD GENESIS', 'ما هي رؤيتكم'],
    keywords: ['رسالة', 'الرسالة', 'رؤية', 'هدف', 'دمج'],
    answer: 'رسالة الشركة: دمج التكنولوجيا في كل شيء عبر المشاريع التاريخية والمستقبلية.' },
  { category: 'نبذة عن الشركة', question: 'ما هي المرحلة الحالية للشركة؟',
    alt_questions: ['أين وصلت الشركة', 'ماذا تفعل الشركة الآن', 'خطط الشركة الحالية', 'هل الشركة تتوسع'],
    keywords: ['المرحلة', 'الحالية', 'الآن', 'التوسع', 'العالمية'],
    answer: 'المرحلة الحالية: تطوير الشركة والتوسع بها نحو العالمية.' },
  { category: 'أخرى', question: 'ما هي الهوية البصرية للشركة؟',
    alt_questions: ['ما ألوان الشركة', 'ألوان SD GENESIS', 'تصميم هوية الشركة', 'ما هو شعار الشركة وألوانه'],
    keywords: ['الهوية', 'البصرية', 'ألوان', 'الألوان', 'الأسود', 'الذهبي'],
    answer: 'الهوية البصرية للشركة: الأسود الداكن (الأوبسيديان) والذهبي المعدني، مع الالتزام بالتناظر والترتيب الهندسي الدقيق.' },
];

const CATEGORIES = [
  'نبذة عن الشركة', 'تاريخ التأسيس', 'الرؤية والرسالة', 'الخدمات والمنتجات', 'معلومات التواصل',
  'الأسئلة الشائعة', 'الأسعار والشروط', 'أخرى',
];

const LIMITS = { question: 300, alt: 20, altLen: 300, keywords: 40, kwLen: 60, answer: 4000, category: 40, maxEntries: 5000, maxUnanswered: 2000 };

// ---- small in-memory cache (per server instance) so a burst of questions does not hit the database each time
const TTL = 20 * 1000;
const cache = { at: 0, index: null, settings: null, count: 0, entries: [], pending: null };

function invalidate() { cache.at = 0; cache.index = null; cache.settings = null; cache.entries = []; cache.pending = null; }

/** add the official facts once (never again after the owner has seen / edited them) */
async function seedOnce(db) {
  if (process.env.AI_NO_SEED === '1') return false;          // tests start from an empty knowledge base
  const st = await db.collection('settings').findOne({ _id: 'ai' });
  if (st && st.seeded_v1) return false;
  const col = db.collection('ai_knowledge');
  for (const e of SEED) {
    if (await col.findOne({ question: e.question })) continue;
    const now = new Date();
    await col.insertOne(Object.assign({ _id: crypto.randomUUID(), created_at: now, updated_at: now, active: true, source: 'seed' }, e));
  }
  await db.collection('settings').updateOne({ _id: 'ai' }, { $set: { seeded_v1: true } }, { upsert: true });
  return true;
}

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
    use_ai: input.use_ai === undefined ? cur.use_ai !== false : !!input.use_ai,
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
    try { await seedOnce(db); } catch (e) { /* never block answers because of seeding */ }
    const [entries, settings] = await Promise.all([
      db.collection('ai_knowledge').find({ active: { $ne: false } }).limit(LIMITS.maxEntries).toArray(),
      getSettings(db),
    ]);
    cache.index = buildIndex(entries);
    cache.settings = settings;
    cache.count = entries.length;
    cache.entries = entries;
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
  DEFAULT_SETTINGS, CATEGORIES, LIMITS, SEED, seedOnce,
  invalidate, load, ask, logUnanswered, getSettings, saveSettings,
  validateEntry, listEntries, createEntry, updateEntry, deleteEntry, importEntries, listUnanswered, deleteUnanswered,
};
