'use strict';
const rateLimit = require('express-rate-limit');

// NOTE: express-rate-limit keeps its counters in memory of each server instance. On Vercel (serverless) every
// instance counts separately, so these limits are a safety net per instance, not a global quota. For a global,
// hard limit put Vercel Firewall / Rate Limiting rules (or an Upstash Redis store) in front — see PERFORMANCE.md.
function make(windowMs, max, message) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: message },
  });
}

module.exports = {
  // whole API (kept generous: a page load makes several calls)
  apiLimiter: make(60 * 1000, 300, 'طلبات كثيرة جدًا، حاول بعد قليل'),
  // brute-force protection for the admin login
  loginLimiter: make(15 * 60 * 1000, 20, 'محاولات دخول كثيرة، حاول بعد 15 دقيقة'),
  // assistant questions: each costs a search + maybe a DB write
  askLimiter: make(60 * 1000, 20, 'أرسلت أسئلة كثيرة بسرعة، انتظر قليلًا ثم حاول مجددًا'),
  // direct downloads / selections
  actionLimiter: make(60 * 1000, 60, 'طلبات كثيرة جدًا، حاول بعد قليل'),
};
