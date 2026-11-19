'use strict';
// Council mode: several different AIs answer the same question on their own, then one of
// them reads the answers side by side and writes the final one. Independent answers catch
// each other's mistakes. The price is one call per member plus the synthesis, and it is
// only as good as the members: it cannot know what none of them knows.
const tokens = require('./tokens');

const err = (code, message) => Object.assign(new Error(message || code), { code });
const clip = (s, n) => (String(s).length > n ? String(s).slice(0, n) + '\n…' : String(s));
// Two doors into the same model family count as one voice.
const FAMILY = { 'claude-cli': 'claude', claude: 'claude' };
const ORDER = ['claude-cli', 'claude', 'gemini', 'deepseek', 'groq', 'openai', 'custom', 'ollama'];

// One member per model family, the AI the user picked first. `skip(id)` drops accounts
// known to be out of credit.
function pickMembers(settings, asked, described, skip) {
  const ready = (described || []).filter((p) => p.ready && p.model && !(skip && skip(p.id)));
  const max = Math.max(2, Math.min(5, Number(settings.council && settings.council.max) || 3));
  const out = [], seen = new Set();
  const add = (p, model) => {
    const fam = FAMILY[p.id] || p.id;
    if (seen.has(fam) || out.length >= max) return;
    seen.add(fam);
    out.push({ provider: p.id, model: model || p.model });
  };
  const first = ready.find((p) => p.id === asked.provider);
  if (first) add(first, asked.model);
  for (const id of ORDER) { const p = ready.find((x) => x.id === id); if (p) add(p); }
  return out;
}

function pickJudge(settings, asked, described, skip) {
  const ready = (described || []).filter((p) => p.ready && p.model && !(skip && skip(p.id)));
  const want = settings.council && settings.council.judge;
  const named = want && want !== 'auto' && ready.find((p) => p.id === want);
  if (named) return { provider: named.id, model: named.model };
  if (ready.some((p) => p.id === asked.provider)) return { provider: asked.provider, model: asked.model };
  for (const id of ORDER) { const p = ready.find((x) => x.id === id); if (p) return { provider: p.id, model: p.model }; }
  return { provider: asked.provider, model: asked.model };
}

const JUDGE_SYSTEM = [
  'You are chairing a panel. Several assistants answered the same REQUEST independently; their answers are labelled A, B, C and so on.',
  'Work out the best possible answer: keep what the answers agree on; at every point where they differ, reason out which one is right instead of taking a majority; fix errors; fill gaps none of them covered.',
  'Then write ONE final answer for the user, in the language of the request and complete on its own. Do not mention the panel, the labels, or that there were several answers.',
  'If a disagreement cannot be settled from what is known, say plainly what remains uncertain instead of guessing.',
].join('\n');

// opts: { chat(req, emit), judgeChat?, members, judge, system, messages, settings, signal, prices }
async function run(opts, emit) {
  const say = emit || (() => {});
  const members = opts.members || [];
  if (members.length < 2) throw err('council_too_small', 'a council needs at least two AIs');
  const usage = { in: 0, out: 0, cacheRead: 0 };
  let cost = 0, costKnown = false;
  const tally = (r, who, system, messages, text) => {
    const u = (r && r.usage) || { in: tokens.estimate(system + messages.map((m) => m.content).join('')), out: tokens.estimate(text), estimated: true };
    usage.in += u.in || 0; usage.out += u.out || 0; usage.cacheRead += u.cacheRead || 0;
    if (u.estimated) usage.estimated = true;
    const c = r && r.cost != null && !r.notionalCost ? r.cost : tokens.cost((r && r.model) || who.model, u, opts.prices);
    if (c != null) { cost += c; costKnown = true; }
  };
  const stopped = () => !!(opts.signal && opts.signal.aborted); // the user pressed Stop
  const aborted = (e) => (e && e.code === 'aborted') || stopped();

  // One slow or hung AI must not hold everyone up: once two have answered, the others get a
  // short grace period and are then left out of this round.
  const graceMs = opts.graceMs != null ? opts.graceMs : 15000;
  const controls = members.map(() => new AbortController());
  const stopAll = () => controls.forEach((c) => c.abort());
  if (opts.signal) { if (opts.signal.aborted) stopAll(); else opts.signal.addEventListener('abort', stopAll, { once: true }); }
  let answered = 0, grace = null;

  const ask = async (who, i) => {
    const t0 = Date.now();
    let text = '';
    say({ type: 'step', node: 'council_ask', provider: who.provider });
    try {
      const r = await opts.chat({ provider: who.provider, model: who.model, system: opts.system, messages: opts.messages, settings: opts.settings, signal: controls[i].signal },
        (ev) => { if (ev.type === 'text') text += ev.text; else if (ev.type === 'notice') say(ev); });
      tally(r, who, opts.system || '', opts.messages, text);
      text = text.trim();
      if (!text) throw err('empty', 'empty answer');
      answered += 1;
      if (answered >= 2 && !grace) grace = setTimeout(stopAll, graceMs);
      say({ type: 'step', node: 'council_done', provider: who.provider, ms: Date.now() - t0 });
      return { provider: who.provider, model: (r && r.model) || who.model, picked: who.model, ok: true, text, ms: Date.now() - t0 };
    } catch (e) {
      if (stopped()) throw err('aborted');
      const code = e.code === 'aborted' ? 'slow' : e.code || 'error'; // cut off by the grace period, not by the user
      say({ type: 'step', node: 'council_fail', provider: who.provider, error: code });
      return { provider: who.provider, model: who.model, ok: false, error: code, ms: Date.now() - t0 };
    }
  };

  let results;
  try { results = await Promise.all(members.map(ask)); } finally { clearTimeout(grace); }
  const good = results.filter((r) => r.ok);
  const trace = { members: results.map((r) => ({ provider: r.provider, model: r.model, ok: r.ok, error: r.error, ms: r.ms, chars: r.text ? r.text.length : 0 })), judge: null };
  if (!good.length) throw err(results[0].error || 'error', 'every council member failed');
  // by = the AI whose words the user reads (as picked in the app); modelUsed = what it reported.
  const done = (answer, by, modelUsed) => ({ answer, by, modelUsed, usage, cost: costKnown ? Math.round(cost * 1e6) / 1e6 : null, trace });
  const solo = () => done(good[0].text, { provider: good[0].provider, model: good[0].picked }, good[0].model);
  if (good.length === 1) { say({ type: 'text', text: good[0].text }); return solo(); }

  const last = opts.messages[opts.messages.length - 1] || {};
  const body = 'REQUEST:\n' + clip(last.content || '', 12000) + '\n\n' + good.map((g, i) => 'ANSWER ' + 'ABCDE'[i] + ':\n' + clip(g.text, 14000)).join('\n\n');
  const question = Object.assign({}, last, { role: 'user', content: body });
  const messages = opts.messages.slice(0, -1).concat([question]);
  const system = [opts.system, JUDGE_SYSTEM].filter(Boolean).join('\n\n');
  say({ type: 'step', node: 'council_judge', provider: opts.judge.provider });
  let text = '';
  try {
    const r = await (opts.judgeChat || opts.chat)({ provider: opts.judge.provider, model: opts.judge.model, system, messages, settings: opts.settings, signal: opts.signal },
      (ev) => { if (ev.type === 'text') text += ev.text; say(ev); });
    tally(r, opts.judge, system, messages, text);
    const by = (r && r.via) || { provider: opts.judge.provider, model: opts.judge.model }; // the chair may have been swapped for one with credit
    const reported = (r && r.model) || by.model;
    trace.judge = { provider: by.provider, model: reported, ok: true };
    if (text.trim()) return done(text.trim(), { provider: by.provider, model: by.model }, reported);
  } catch (e) {
    if (aborted(e)) throw err('aborted');
    trace.judge = { provider: opts.judge.provider, model: opts.judge.model, ok: false, error: e.code || 'error' };
  }
  // The chair failed or said nothing: the first member's own answer still stands.
  say({ type: 'reset' });
  say({ type: 'text', text: good[0].text });
  return solo();
}

module.exports = { run, pickMembers, pickJudge, JUDGE_SYSTEM, ORDER };
