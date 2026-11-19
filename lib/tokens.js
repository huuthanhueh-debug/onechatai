'use strict';
// Token estimates (before sending) and cost (after the provider reports real usage).
// The estimate is a heuristic, always shown with "≈": ASCII runs about 4 chars per token,
// accented / CJK characters cost noticeably more.
function estimate(text) {
  if (!text) return 0;
  const s = String(text);
  let ascii = 0, other = 0;
  for (let i = 0; i < s.length; i++) (s.charCodeAt(i) < 128 ? ascii++ : other++);
  return Math.ceil(ascii / 4 + other / 1.6);
}

// USD per million tokens: [input, output, cacheRead]. Only models whose price is known;
// anything else shows tokens without a cost. Override or extend in settings.json -> prices.
const PRICES = {
  'claude-fable-5-2': [8, 40, 0.2],
  'claude-opus-5-5': [4, 20, 0.2],
  'claude-sonnet-5-5': [2, 10, 0.1],
  'claude-haiku-5-5': [0.1, 0.5, 0.01],
};

function cost(model, usage, overrides) {
  const p = (overrides && overrides[model]) || PRICES[model];
  if (!p || !usage) return null;
  const c = ((usage.in || 0) * p[0] + (usage.out || 0) * p[1] + (usage.cacheRead || 0) * (p[2] != null ? p[2] : p[0])) / 1e6;
  return Math.round(c * 1e6) / 1e6;
}

// Keep the newest messages that fit the budget. The latest message is always kept, and the
// result always starts with a user turn. Reports how many were dropped so the UI can say so.
function fitHistory(messages, budgetTokens) {
  const size = (m) => estimate(m.content) + (m.imgTokens || 0); // attached pictures cost tokens too
  const sum = (list) => list.reduce((s, m) => s + size(m), 0);
  if (!budgetTokens || budgetTokens <= 0) return { kept: messages.slice(), dropped: 0, tokens: sum(messages) };
  const kept = [];
  let total = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const t = size(messages[i]);
    if (kept.length && total + t > budgetTokens) break;
    kept.unshift(messages[i]);
    total += t;
  }
  while (kept.length > 1 && kept[0].role !== 'user') { total -= size(kept[0]); kept.shift(); }
  return { kept, dropped: messages.length - kept.length, tokens: total };
}

module.exports = { estimate, cost, fitHistory, PRICES };
