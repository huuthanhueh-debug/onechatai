'use strict';
// How much of each AI's allowance is left, taken from what the provider itself reports:
//   - Claude Code: the plan's 5-hour and weekly windows (sent along with every answer)
//   - Claude API, Groq and other OpenAI-style servers: rate-limit headers (short windows)
//   - DeepSeek: the account balance endpoint
//   - any provider: the moment it answered "out of credit"
// Where a provider reports nothing, the only honest figure is the user's own monthly
// allowance measured against what OneChat has counted. Nothing here is guessed.
const path = require('path');
const cfg = require('./config');

const file = () => path.join(cfg.dataDir(), 'quota.json');
const load = () => Object.assign({ v: 1, providers: {} }, cfg.readJson(file(), {}));
const save = (d) => { try { cfg.writeJson(file(), d); } catch (_) { /* a status file must never break a chat */ } };
const slot = (d, id) => (d.providers[id] = d.providers[id] || {});
const frac = (remaining, limit) => (limit > 0 && remaining >= 0 ? Math.max(0, Math.min(1, remaining / limit)) : null);

// "1m26.4s", "674ms", "2h3m", "12" (seconds) -> milliseconds
function duration(s) {
  const str = String(s || '').trim();
  if (!str) return 0;
  if (/^\d+(\.\d+)?$/.test(str)) return Math.round(Number(str) * 1000);
  let ms = 0;
  for (const m of str.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) ms += Number(m[1]) * ({ ms: 1, s: 1000, m: 60000, h: 3600000 })[m[2]];
  return Math.round(ms);
}

// What an adapter passed along -> windows: { id, remaining 0..1, resetsAt (ms, 0 = unknown) }.
function windowsFrom(limits, now) {
  const out = [];
  if (!limits) return out;
  if (limits.cli) {
    const u = limits.cli.unifiedWindows || {};
    for (const id of ['five_hour', 'seven_day']) {
      const w = u[id];
      if (w && typeof w.utilization === 'number') out.push({ id, remaining: Math.max(0, Math.min(1, 1 - w.utilization)), resetsAt: w.resetsAt ? w.resetsAt * 1000 : 0 });
    }
  }
  const h = limits.headers;
  if (h) {
    const num = (k) => (h[k] == null || h[k] === '' ? NaN : Number(h[k]));
    const reset = (k) => { const v = h[k]; if (!v) return 0; return /^\d{4}-\d\d-\d\d/.test(v) ? (Date.parse(v) || 0) : now + duration(v); };
    for (const id of ['requests', 'tokens']) {
      for (const [pre, sep] of [['anthropic-ratelimit-' + id + '-', ''], ['x-ratelimit-', '-' + id]]) {
        const key = (what) => (sep ? pre + what + sep : pre + what);
        const f = frac(num(key('remaining')), num(key('limit')));
        if (f != null) { out.push({ id, remaining: f, resetsAt: reset(key('reset')) }); break; }
      }
    }
  }
  return out;
}

// A call that worked: the account is usable, and here is what it reported about its limits.
function note(provider, limits, now) {
  const ts = now || Date.now();
  const d = load();
  const s = slot(d, provider);
  delete s.spentAt; delete s.spentMsg; // it answered, so it is not out of credit
  const w = windowsFrom(limits, ts);
  if (w.length) { s.windows = w; s.kind = limits.cli ? 'plan' : 'rate'; s.at = ts; }
  save(d);
}
function spent(provider, message, now) {
  const d = load();
  const s = slot(d, provider);
  s.spentAt = now || Date.now();
  s.spentMsg = String(message || '').slice(0, 200);
  save(d);
}
function setBalance(provider, amount, currency, now) {
  if (!Number.isFinite(Number(amount))) return;
  const d = load();
  slot(d, provider).balance = { amount: Number(amount), currency: String(currency || 'USD'), at: now || Date.now() };
  save(d);
}
// A new key was saved: whatever the old key ran out of no longer applies.
function clear(provider) {
  const d = load();
  if (!d.providers[provider]) return;
  delete d.providers[provider].spentAt; delete d.providers[provider].spentMsg; delete d.providers[provider].balance;
  save(d);
}

// Said "out of credit" within the last maxAgeMs and has not worked since.
function isSpent(provider, maxAgeMs) {
  const s = load().providers[provider];
  return !!(s && s.spentAt && Date.now() - s.spentAt < (maxAgeMs || Infinity));
}

// What the UI shows per AI. pct stays null when there is no real or user-set figure.
// monthUsage: { providerId: { in, out } } counted by OneChat for the current month.
function view(settings, monthUsage, now) {
  const ts = now || Date.now();
  const d = load();
  const budgets = (settings && settings.budgets) || {};
  const out = {};
  for (const id of new Set(Object.keys(d.providers).concat(Object.keys(budgets)))) {
    const s = d.providers[id] || {};
    const v = { kind: 'unknown', pct: null, lines: [] };
    // Past its reset time a rate limit is full again (that is what "reset" means). A plan
    // window that has reset is dropped instead: other apps share the plan, so wait for a fresh report.
    const live = (s.windows || []).map((w) => (!w.resetsAt || w.resetsAt > ts ? w : s.kind === 'plan' ? null : { id: w.id, remaining: 1, resetsAt: 0 })).filter(Boolean);
    const budget = Number(budgets[id]) > 0 ? Number(budgets[id]) : 0; // million tokens per month
    for (const w of live) v.lines.push({ type: (s.kind === 'plan' ? 'plan_' : 'rate_') + w.id, pct: Math.round(w.remaining * 100), resetsAt: w.resetsAt || 0, at: s.at || 0 });
    if (s.balance) v.lines.push({ type: 'balance', amount: s.balance.amount, currency: s.balance.currency, at: s.balance.at || 0 });
    let budgetPct = null;
    if (budget) {
      const used = monthUsage && monthUsage[id] ? (monthUsage[id].in || 0) + (monthUsage[id].out || 0) : 0;
      budgetPct = Math.max(0, Math.round((1 - used / (budget * 1e6)) * 100));
      v.lines.push({ type: 'budget', pct: budgetPct, used: Math.round(used / 1e4) / 100, budget });
    }
    const least = live.length ? Math.round(Math.min(...live.map((w) => w.remaining)) * 100) : null;
    if (s.spentAt) { v.kind = 'spent'; v.pct = 0; v.lines.unshift({ type: 'spent', at: s.spentAt }); }
    else if (least != null && s.kind === 'plan') { v.kind = 'plan'; v.pct = least; }
    else if (budget) { v.kind = 'budget'; v.pct = budgetPct; }
    else if (least != null) { v.kind = 'rate'; v.pct = least; }
    else if (s.balance) { v.kind = 'balance'; v.amount = s.balance.amount; v.currency = s.balance.currency; }
    if (v.kind !== 'unknown' || v.lines.length) out[id] = v;
  }
  return out;
}

// DeepSeek is the one provider here with a balance endpoint. Asked at most once a minute,
// and only at DeepSeek's own address (never at a custom or test URL).
let lastBalanceAt = 0;
async function refreshDeepseek(key, baseUrl, force) {
  if (!key || !/^https:\/\/api\.deepseek\.com(\/|$)/.test(String(baseUrl || ''))) return false;
  if (!force && Date.now() - lastBalanceAt < 60000) return false;
  lastBalanceAt = Date.now();
  try {
    const res = await fetch('https://api.deepseek.com/user/balance', { headers: { authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) return false;
    const j = await res.json();
    const list = Array.isArray(j.balance_infos) ? j.balance_infos : [];
    const b = list.find((x) => x.currency === 'USD') || list[0];
    if (!b) return false;
    setBalance('deepseek', b.total_balance, b.currency);
    return true;
  } catch (_) { return false; }
}

module.exports = { duration, windowsFrom, note, spent, isSpent, setBalance, clear, view, refreshDeepseek, load, file };
