'use strict';
/**
 * Internal knowledge-base search engine for the SD GENESIS assistant.
 *
 * HARD RULES (by design):
 *  - It NEVER generates text. It can only return the `answer` string of an approved entry, verbatim.
 *  - If no approved entry matches with enough confidence, it returns `answered:false` — the caller shows the
 *    "no approved information" message instead of inventing something.
 *  - No external AI / API is used anywhere. Everything is local string matching (Arabic-aware).
 */

const DIAC = /[ً-ٰٟـ]/g; // tashkeel + tatweel
const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';

function norm(input) {
  return String(input == null ? '' : input)
    .toLowerCase()
    .replace(DIAC, '')
    .replace(/[إأآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[٠-٩]/g, (d) => String(AR_DIGITS.indexOf(d)))
    .replace(/[^ء-يa-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const PREFIXES = ['وال', 'بال', 'كال', 'فال', 'ال', 'لل'];
const SUFFIXES = ['ات', 'ون', 'ين', 'ان', 'ها', 'هم', 'كم', 'نا', 'ه', 'ي'];

function stem(tok) {
  if (/^[a-z0-9]+$/.test(tok)) {
    if (tok.length > 4 && tok.endsWith('s') && !/(ss|is|us|os)$/.test(tok)) return tok.slice(0, -1);
    return tok;
  }
  let t = tok;
  for (const p of PREFIXES) {
    if (t.startsWith(p) && t.length - p.length >= 2) { t = t.slice(p.length); break; }
  }
  for (let pass = 0; pass < 2; pass++) { // up to two suffixes: تقدمونها -> تقدمون -> تقدم
    let cut = false;
    for (const s of SUFFIXES) {
      if (t.endsWith(s) && t.length - s.length >= 3) { t = t.slice(0, -s.length); cut = true; break; }
    }
    if (!cut) break;
  }
  return t;
}

const STOP_RAW = [
  'ما', 'ماذا', 'هي', 'هو', 'هم', 'من', 'في', 'على', 'الى', 'إلى', 'عن', 'هل', 'كيف', 'لماذا', 'متى', 'اين', 'أين', 'كم',
  'هذا', 'هذه', 'ذلك', 'تلك', 'التي', 'الذي', 'الذين', 'هناك', 'يا', 'او', 'أو', 'ان', 'أن', 'إن', 'لي', 'لنا', 'عند', 'مع', 'انا',
  'أنا', 'انت', 'أنت', 'نحن', 'لدي', 'اريد', 'أريد', 'ممكن', 'لو', 'ثم', 'قد', 'كان', 'يكون', 'تكون', 'بعد', 'قبل', 'له', 'لها',
  'لهم', 'به', 'بها', 'فيه', 'فيها', 'منه', 'منها', 'ايضا', 'أيضا', 'لا', 'نعم', 'و', 'ب', 'ل', 'ك', 'ف',
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'of', 'what', 'who', 'how', 'do', 'does', 'to', 'in', 'on', 'for', 'and', 'or',
  'me', 'i', 'you', 'it', 'about', 'can', 'tell', 'please',
];
const STOP = new Set(STOP_RAW.map((w) => norm(w)).filter(Boolean));

/** tokens used for matching: normalised, stop-words removed, light-stemmed, de-duplicated */
function tokens(text) {
  const out = [];
  const seen = new Set();
  for (const raw of norm(text).split(' ')) {
    if (!raw || STOP.has(raw)) continue;
    if (raw.length < 2 && !/^[0-9]$/.test(raw)) continue;
    const s = stem(raw);
    if (!s || STOP.has(s) || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/** Build a searchable index from approved entries (active ones only). */
function buildIndex(entries) {
  const docs = [];
  const df = new Map();
  for (const e of entries || []) {
    if (!e || e.active === false) continue;
    const qs = [e.question].concat(Array.isArray(e.alt_questions) ? e.alt_questions : []).filter(Boolean);
    const qSets = qs.map((q) => ({ raw: q, norm: norm(q), toks: tokens(q) }));
    const kw = new Set();
    for (const k of Array.isArray(e.keywords) ? e.keywords : []) tokens(k).forEach((t) => kw.add(t));
    const ans = new Set(tokens(e.answer || ''));
    const cat = new Set(tokens(e.category || ''));
    const all = new Set();
    qSets.forEach((q) => q.toks.forEach((t) => all.add(t)));
    kw.forEach((t) => all.add(t));
    ans.forEach((t) => all.add(t));
    cat.forEach((t) => all.add(t));
    all.forEach((t) => df.set(t, (df.get(t) || 0) + 1));
    const vocab = new Set(kw); qSets.forEach((q) => q.toks.forEach((t) => vocab.add(t)));
    docs.push({ entry: e, qSets, kw, ans, cat, vocab: Array.from(vocab) });
  }
  return { docs, df, n: docs.length };
}

function idf(index, t) {
  const d = index.df.get(t) || 0;
  if (!d) return 0.7 * Math.log(1 + (index.n + 1) / 1.5); // a word nowhere in the KB still counts against the match, a bit less than a rare one
  return Math.log(1 + (index.n + 1) / (d + 0.5));
}

/** true when a and b differ by at most one letter (insert / delete / replace) -- catches typos like موساس / مؤسس */
function near1(a, b) {
  if (a === b) return true;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 1 || Math.min(la, lb) < 4) return false;
  let i = 0, j = 0, edits = 0;
  while (i < la && j < lb) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (la > lb) i++; else if (lb > la) j++; else { i++; j++; }
  }
  return edits + (la - i) + (lb - j) <= 1;
}

/** Score one document against the query tokens. Returns 0..1 */
function scoreDoc(index, doc, qTokens, qNorm) {
  if (!qTokens.length) return 0;
  let total = 0;
  let matched = 0;
  let strong = 0;
  for (const t of qTokens) {
    const w = idf(index, t);
    total += w;
    let hit = 0;
    if (doc.kw.has(t)) hit = 1;
    if (!hit) for (const q of doc.qSets) { if (q.toks.indexOf(t) !== -1) { hit = 0.92; break; } }
    if (!hit && t.length >= 4) for (const v of doc.vocab) { if (near1(t, v)) { hit = 0.88; break; } }   // spelling mistake
    if (!hit && doc.cat.has(t)) hit = 0.3;
    if (!hit && doc.ans.has(t)) hit = 0.3;
    if (hit >= 0.85) strong++;
    matched += w * hit;
  }
  const coverage = total ? matched / total : 0;

  // how much of the stored question is covered by what the user typed (stops a broad query matching a narrow entry)
  let qCov = 0;
  const qSet = new Set(qTokens);
  for (const q of doc.qSets) {
    if (!q.toks.length) continue;
    let inter = 0;
    for (const t of q.toks) if (qSet.has(t)) inter++;
    qCov = Math.max(qCov, inter / q.toks.length);
    if (q.norm && q.norm === qNorm) return 1; // exact question
  }
  if (!strong) return Math.min(coverage * 0.5, 0.45); // only weak (answer/category) hits can never reach an answer
  return Math.min(1, coverage * 0.65 + qCov * 0.35);
}

/**
 * search(index, query, { minConfidence })
 * @returns {{ answered:boolean, entry?:object, score:number, suggestions:Array<{id,question,score}> }}
 */
function search(index, query, opts) {
  const minConfidence = opts && typeof opts.minConfidence === 'number' ? opts.minConfidence : 0.55;
  const qNorm = norm(query);
  const qTokens = tokens(query);
  const result = { answered: false, score: 0, suggestions: [] };
  if (!index || !index.n || !qTokens.length) return result;

  const scored = index.docs
    .map((d) => ({ d, s: scoreDoc(index, d, qTokens, qNorm) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s);
  if (!scored.length) return result;

  const best = scored[0];
  result.score = Math.round(best.s * 1000) / 1000;
  if (best.s >= minConfidence) {
    result.answered = true;
    result.entry = best.d.entry;
    return result;
  }
  // close-but-not-sure: offer the approved questions (never an invented answer)
  result.suggestions = scored
    .filter((x) => x.s >= Math.min(0.3, minConfidence - 0.1))
    .slice(0, 3)
    .map((x) => ({ id: x.d.entry._id, question: x.d.entry.question, score: Math.round(x.s * 1000) / 1000 }));
  return result;
}

module.exports = { norm, stem, tokens, buildIndex, search, STOP };
