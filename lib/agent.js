'use strict';
// Agent mode. Instead of one prompt -> one answer, the work runs through a small graph:
//
//     draft --> review --(score below the bar, rounds left)--> revise --> review ...
//                  \--(good enough, or out of rounds)--> done
//
// Harness: this file. Feedback: an independent reviewer (ideally a different AI) scores the
// answer and lists concrete problems. Loop: revise until it passes. Self-improving: every
// review that found a real problem leaves one short "lesson", stored per kind of task and
// fed into future drafts of that kind. Nothing here executes code on the machine.
const path = require('path');
const cfg = require('./config');
const tokens = require('./tokens');

const err = (code, message) => Object.assign(new Error(message || code), { code });

// ---- generic graph runner -----------------------------------------------------------------
// graph = { start, nodes: { id: async (state) => nextId | null } }. A node returns the id of
// the node to run next; null ends the run. maxSteps is the guard against an endless loop.
async function runGraph(graph, state, opts) {
  opts = opts || {};
  let id = graph.start, steps = 0;
  state.path = state.path || [];
  while (id) {
    if (opts.signal && opts.signal.aborted) throw err('aborted');
    if (++steps > (opts.maxSteps || 16)) throw err('agent_loop_limit', 'too many steps');
    const node = graph.nodes[id];
    if (!node) throw err('agent_bad_graph', 'unknown node: ' + id);
    state.path.push(id);
    id = await node(state);
  }
  return state;
}

// ---- lessons (the self-improving part) ----------------------------------------------------
const lessonsFile = () => path.join(cfg.dataDir(), 'lessons.json');
const loadLessons = () => Object.assign({ v: 1, tasks: {} }, cfg.readJson(lessonsFile(), {}));
const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

function addLesson(task, text, now) {
  const t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 220);
  if (t.length < 8) return false;
  const d = loadLessons();
  const list = (d.tasks[task] = d.tasks[task] || []);
  const hit = list.find((l) => norm(l.text) === norm(t));
  if (hit) { hit.n += 1; hit.last = now || Date.now(); } else list.push({ text: t, n: 1, last: now || Date.now() });
  list.sort((a, b) => b.n - a.n || b.last - a.last);
  d.tasks[task] = list.slice(0, 50); // kept generously; only the top few are used per draft
  cfg.writeJson(lessonsFile(), d);
  return true;
}
const lessonsFor = (task, k) => ((loadLessons().tasks[task]) || []).slice(0, k || 5).map((l) => l.text);
function removeLesson(task, index) {
  const d = loadLessons();
  const list = d.tasks[task] || [];
  if (!(index >= 0 && index < list.length)) return false;
  list.splice(index, 1);
  if (!list.length) delete d.tasks[task];
  cfg.writeJson(lessonsFile(), d);
  return true;
}

// ---- prompts ------------------------------------------------------------------------------
const REVIEW_SYSTEM = [
  'You are a strict, fair reviewer. Judge the ANSWER that an assistant gave to the REQUEST.',
  'Check: does it do exactly what was asked, is it correct, is anything important missing, is it clear, is it in the language of the request.',
  'Reply with JSON only, no prose and no code fence:',
  '{"score": <0-100>, "issues": ["<one specific problem and how to fix it>", ...], "lesson": "<one short general rule that would have prevented the main problem, or empty>"}',
  'At most 4 issues, most important first. Give 85 or more only if you would send the answer unchanged; then issues may be empty.',
  'Write issues and lesson in the language of the request.',
].join('\n');

function parseReview(text) {
  const raw = String(text || '');
  const a = raw.indexOf('{'), b = raw.lastIndexOf('}');
  if (a >= 0 && b > a) {
    try {
      const j = JSON.parse(raw.slice(a, b + 1));
      const score = Number(j.score);
      if (Number.isFinite(score)) {
        return {
          score: Math.max(0, Math.min(100, Math.round(score))),
          issues: (Array.isArray(j.issues) ? j.issues : []).map((x) => String(x).replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 4),
          lesson: String(j.lesson || '').replace(/\s+/g, ' ').trim().slice(0, 220),
        };
      }
    } catch (_) { /* fall through */ }
  }
  const m = /(\d{1,3})\s*\/\s*100/.exec(raw);
  if (m) return { score: Math.min(100, Number(m[1])), issues: [], lesson: '' };
  return null; // unreadable review: the caller stops looping instead of guessing
}

const clip = (s, n) => (String(s).length > n ? String(s).slice(0, n) + '\n…' : String(s));

// A reviewer different from the worker gives a more independent opinion.
const CRITIC_ORDER = ['claude', 'deepseek', 'gemini', 'groq', 'openai', 'claude-cli', 'anythingllm', 'ollama', 'custom'];
function pickCritic(settings, worker, described) {
  const ready = (described || []).filter((p) => p.ready && p.model);
  const byId = new Map(ready.map((p) => [p.id, p]));
  const want = settings.agent && settings.agent.critic;
  if (want && want !== 'auto' && byId.has(want)) return { provider: want, model: byId.get(want).model };
  for (const id of CRITIC_ORDER) if (id !== worker.provider && byId.has(id)) return { provider: id, model: byId.get(id).model };
  return { provider: worker.provider, model: worker.model };
}

// ---- the improve graph --------------------------------------------------------------------
// opts: { chat(req, emit), worker, critic, system, messages, task, settings, signal,
//         existingAnswer, feedback, maxRounds, passScore, prices }
async function run(opts, emit) {
  const say = emit || (() => {});
  const maxRounds = Math.max(0, Math.min(4, opts.maxRounds != null ? opts.maxRounds : 2));
  const passScore = Math.max(1, Math.min(100, opts.passScore != null ? opts.passScore : 80));
  const usage = { in: 0, out: 0, cacheRead: 0 };
  let cost = 0, costKnown = false;
  const lessons = lessonsFor(opts.task);
  const workerSystem = [opts.system, lessons.length ? 'Lessons learned from earlier reviewed work of this kind. Apply them:\n- ' + lessons.join('\n- ') : ''].filter(Boolean).join('\n\n');
  const request = clip((opts.messages[opts.messages.length - 1] || {}).content || '', 12000);

  const call = async (who, system, messages, stream) => {
    let text = '';
    const r = await opts.chat({ provider: who.provider, model: who.model, system, messages, settings: opts.settings, signal: opts.signal }, (ev) => {
      if (ev.type === 'text') { text += ev.text; if (stream) say(ev); }
      else if (stream && (ev.type === 'thinking' || ev.type === 'notice')) say(ev);
    });
    const u = (r && r.usage) || { in: tokens.estimate(system + messages.map((m) => m.content).join('')), out: tokens.estimate(text), estimated: true };
    usage.in += u.in || 0; usage.out += u.out || 0; usage.cacheRead += u.cacheRead || 0;
    if (u.estimated) usage.estimated = true;
    const c = r && r.cost != null && !r.notionalCost ? r.cost : tokens.cost((r && r.model) || who.model, u, opts.prices);
    if (c != null) { cost += c; costKnown = true; }
    return { text: text.trim(), model: (r && r.model) || who.model };
  };

  const state = { answer: String(opts.existingAnswer || '').trim(), round: 0, steps: [], scores: [], last: null, lesson: '', modelUsed: opts.worker.model };
  const graph = {
    start: state.answer ? 'review' : 'draft',
    nodes: {
      draft: async (s) => {
        say({ type: 'step', node: 'draft', provider: opts.worker.provider, model: opts.worker.model, round: 0 });
        const r = await call(opts.worker, workerSystem, opts.messages, true);
        if (!r.text) throw err('empty', 'the worker returned no answer');
        s.answer = r.text; s.modelUsed = r.model;
        s.steps.push({ node: 'draft', provider: opts.worker.provider, model: r.model });
        // A draft that asks the user a question (an `ask` block) goes straight to them: there is nothing to review yet.
        if (/(^|\n)[ \t]*`{3}ask[ \t]*\n/.test(r.text)) { s.asked = true; return null; }
        return maxRounds > 0 ? 'review' : null;
      },
      review: async (s) => {
        const n = s.round + 1;
        say({ type: 'step', node: 'review', provider: opts.critic.provider, model: opts.critic.model, round: n });
        const body = 'REQUEST:\n' + request + '\n\nANSWER:\n' + clip(s.answer, 16000) + (opts.feedback ? '\n\nTHE USER\'S OWN FEEDBACK ON THIS ANSWER (treat it as an issue to fix):\n' + clip(opts.feedback, 2000) : '');
        let review = null;
        try { review = parseReview((await call(opts.critic, REVIEW_SYSTEM, [{ role: 'user', content: body }], false)).text); }
        catch (e) { if (e.code === 'aborted') throw e; s.steps.push({ node: 'review', provider: opts.critic.provider, model: opts.critic.model, round: n, error: e.code || 'error' }); say({ type: 'review', round: n, score: null, issues: [], error: e.code || 'error' }); return null; }
        if (!review) { s.steps.push({ node: 'review', provider: opts.critic.provider, model: opts.critic.model, round: n, unread: true }); say({ type: 'review', round: n, score: null, issues: [] }); return null; }
        if (opts.feedback && s.round === 0 && !review.issues.length) review.issues.push(clip(opts.feedback, 300)); // the user asked for a change: always act on it
        s.last = review; s.scores.push(review.score);
        if (review.lesson && review.issues.length && !s.lesson) s.lesson = review.lesson;
        s.steps.push({ node: 'review', provider: opts.critic.provider, model: opts.critic.model, round: n, score: review.score, issues: review.issues });
        say({ type: 'review', round: n, score: review.score, issues: review.issues });
        const mustFix = !!opts.feedback && s.round === 0;
        if ((review.score >= passScore && !mustFix) || !review.issues.length || s.round >= maxRounds) return null;
        return 'revise';
      },
      revise: async (s) => {
        s.round += 1;
        say({ type: 'step', node: 'revise', provider: opts.worker.provider, model: opts.worker.model, round: s.round });
        say({ type: 'reset' });
        const ask = 'A reviewer found these problems in your answer:\n- ' + s.last.issues.join('\n- ')
          + '\n\nRewrite the complete answer with every point fixed. Keep what was already right. Output only the improved answer, without any note about what changed.';
        const r = await call(opts.worker, workerSystem, opts.messages.concat([{ role: 'assistant', content: s.answer }, { role: 'user', content: ask }]), true);
        if (r.text) { s.answer = r.text; s.modelUsed = r.model; } // an empty rewrite keeps the previous answer
        s.steps.push({ node: 'revise', provider: opts.worker.provider, model: r.model, round: s.round });
        return 'review';
      },
    },
  };
  await runGraph(graph, state, { signal: opts.signal, maxSteps: 3 + maxRounds * 2 + 2 });

  let lessonSaved = '';
  if (state.lesson && opts.task && addLesson(opts.task, state.lesson)) lessonSaved = state.lesson;
  return {
    answer: state.answer, modelUsed: state.modelUsed, usage, cost: costKnown ? Math.round(cost * 1e6) / 1e6 : null,
    trace: { steps: state.steps, rounds: state.scores.length, revisions: state.round, firstScore: state.scores.length ? state.scores[0] : null,
      finalScore: state.scores.length ? state.scores[state.scores.length - 1] : null, passScore, critic: opts.critic, lessonSaved, lessonsUsed: lessons.length, path: state.path },
  };
}

module.exports = { run, runGraph, parseReview, pickCritic, addLesson, lessonsFor, removeLesson, loadLessons, lessonsFile, REVIEW_SYSTEM };
