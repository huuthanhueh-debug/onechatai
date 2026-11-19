'use strict';
// Remembers which AI the user picks for which kind of task, and recommends it next time.
// Task kinds come from PromptGate's classifier when it is available, with two extra kinds
// (translate, summarize) that matter for model choice; a small regex fallback covers the rest.
const path = require('path');
const cfg = require('./config');

const TASKS = ['translate', 'summarize', 'question', 'edit', 'build', 'debug', 'analyze', 'write', 'review', 'ops', 'general'];

// Unicode-aware word boundaries (JS \b is ASCII-only and breaks on Vietnamese letters).
const W = (alts) => new RegExp('(?<![\\p{L}\\p{N}_])(?:' + alts + ')(?![\\p{L}\\p{N}_])', 'iu');
const RE = {
  translate: W('dịch|phiên dịch|translate|translation|chuyển (?:sang|qua) tiếng|sang tiếng (?:anh|việt|nhật|trung|hàn|pháp)|(?:into|to) (?:english|vietnamese|japanese|chinese|korean|french)'),
  summarize: W('tóm tắt|tóm lược|tổng hợp lại|rút gọn|summari[sz]e|summary of|tl;?dr|key points'),
  debug: W('lỗi|bug|error|exception|traceback|crash|không chạy|bị treo|sửa lỗi|debug|fix'),
  build: W('code|function|script|api|app|component|implement|build|create|tạo|xây dựng|lập trình|viết (?:code|hàm|script)'),
  analyze: W('phân tích|so sánh|đánh giá|analy[sz]e|compare|evaluate|assess'),
  write: W('viết|soạn|email|bài viết|caption|draft|write|compose'),
  review: W('review|rà soát|góp ý|nhận xét|feedback on'),
  question: W('tại sao|vì sao|là gì|như thế nào|có nên|bao nhiêu|what|why|how|when|where|who|which'),
};

function classify(text, pgType) {
  const t = String(text || '').trim();
  const head = t.split(/\s+/).slice(0, 14).join(' ');
  if (RE.translate.test(head)) return 'translate';
  if (RE.summarize.test(head)) return 'summarize';
  if (pgType && TASKS.includes(pgType)) return pgType;
  for (const k of ['debug', 'build', 'analyze', 'review', 'write']) if (RE[k].test(t)) return k;
  if (/\?\s*$/.test(t) || RE.question.test(head)) return 'question';
  return 'general';
}

const file = () => path.join(cfg.dataDir(), 'usage.json');
const empty = () => ({ v: 1, tasks: {}, totals: {}, days: {}, months: {} });
const load = () => Object.assign(empty(), cfg.readJson(file(), {}));
const keyOf = (provider, model) => provider + '|' + (model || '');
const splitKey = (k) => { const i = k.indexOf('|'); return { provider: k.slice(0, i), model: k.slice(i + 1) }; };
const today = (now) => new Date(now).toISOString().slice(0, 10);

function record({ task, provider, model, usage, cost, now, score }) {
  const ts = now || Date.now();
  const d = load();
  const k = keyOf(provider, model);
  const t = (d.tasks[task] = d.tasks[task] || {});
  const e = (t[k] = t[k] || { n: 0, last: 0, up: 0, down: 0 });
  e.n += 1; e.last = ts;
  if (typeof score === 'number') { e.q = (e.q || 0) + score; e.qn = (e.qn || 0) + 1; } // reviewer's score of the first draft
  const add = (o) => { o.n = (o.n || 0) + 1; o.in = (o.in || 0) + ((usage && usage.in) || 0); o.out = (o.out || 0) + ((usage && usage.out) || 0); o.cost = Math.round(((o.cost || 0) + (cost || 0)) * 1e6) / 1e6; };
  add((d.totals[k] = d.totals[k] || {}));
  add((d.days[today(ts)] = d.days[today(ts)] || {}));
  // Per AI per month: what a self-set monthly allowance is measured against.
  const mo = (d.months[today(ts).slice(0, 7)] = d.months[today(ts).slice(0, 7)] || {});
  add((mo[provider] = mo[provider] || {}));
  cfg.writeJson(file(), d);
  return d;
}

function vote({ task, provider, model, value }) {
  const d = load();
  const t = (d.tasks[task] = d.tasks[task] || {});
  const e = (t[keyOf(provider, model)] = t[keyOf(provider, model)] || { n: 0, last: Date.now(), up: 0, down: 0 });
  if (value > 0) e.up += 1; else if (value < 0) e.down += 1;
  cfg.writeJson(file(), d);
  return d;
}

const STALE_MS = 60 * 24 * 3600 * 1000;
const weight = (e, now) => (e.n * (now - e.last > STALE_MS ? 0.5 : 1)) + 2 * (e.up || 0) - 3 * (e.down || 0);

// A pin always wins. Otherwise recommend the habit only when it is clear: used at least
// twice for this kind of task and carrying at least half of that task's weight.
function recommend(task, opts) {
  opts = opts || {};
  const now = opts.now || Date.now();
  const ok = (provider) => !opts.available || opts.available.includes(provider);
  const pin = opts.pins && opts.pins[task];
  if (pin) { const p = splitKey(pin); if (ok(p.provider)) return Object.assign(p, { reason: 'pin', n: 0, share: 1 }); }
  const d = opts.data || load();
  const entries = Object.entries(d.tasks[task] || {}).map(([k, e]) => ({ k, e, w: weight(e, now) })).filter((x) => x.w > 0 && ok(splitKey(x.k).provider));
  if (!entries.length) return null;
  const total = entries.reduce((s, x) => s + x.w, 0);
  entries.sort((a, b) => b.w - a.w || b.e.last - a.e.last);
  const top = entries[0];
  if (top.e.n < 2 || top.w / total < 0.5) return null;
  return Object.assign(splitKey(top.k), { reason: 'habit', n: top.e.n, share: Math.round((top.w / total) * 100) / 100 });
}

function summary(opts) {
  const d = load();
  const now = Date.now();
  const tasks = TASKS.map((task) => {
    const rows = Object.entries(d.tasks[task] || {}).map(([k, e]) => Object.assign(splitKey(k), { n: e.n, up: e.up || 0, down: e.down || 0, last: e.last, w: weight(e, now), avg: e.qn ? Math.round(e.q / e.qn) : null })).sort((a, b) => b.w - a.w);
    return { task, rows, total: rows.reduce((s, r) => s + r.n, 0), pin: (opts && opts.pins && opts.pins[task]) || '' };
  });
  const totals = Object.entries(d.totals).map(([k, o]) => Object.assign(splitKey(k), o)).sort((a, b) => (b.n || 0) - (a.n || 0));
  return { tasks, totals, today: d.days[today(now)] || { n: 0, in: 0, out: 0, cost: 0 }, days: d.days, month: (d.months || {})[today(now).slice(0, 7)] || {} };
}

module.exports = { TASKS, classify, record, vote, recommend, summary, load, keyOf, splitKey, file };
