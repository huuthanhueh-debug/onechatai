'use strict';
// Agent mode: the graph runner, the draft -> review -> revise loop, lessons, and the HTTP flow.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mockOpenAI } = require('./helpers');
const agent = require('../lib/agent');
const cfg = require('../lib/config');

const W = { provider: 'w', model: 'worker-model' }, C = { provider: 'c', model: 'critic-model' };
const msgs = [{ role: 'user', content: 'Viết thư xin nghỉ phép 2 ngày' }];
// A scripted chat(): the worker answers from `drafts`, the reviewer from `reviews`, in order.
function fakeChat(drafts, reviews) {
  const calls = [];
  const chat = async (req, emit) => {
    calls.push(req);
    const text = req.provider === 'c' ? reviews.shift() : drafts.shift();
    if (text instanceof Error) throw text;
    emit({ type: 'text', text });
    return { usage: { in: 10, out: 5, cacheRead: 0 }, model: req.model };
  };
  return { chat, calls };
}
const review = (score, issues, lesson) => JSON.stringify({ score, issues: issues || [], lesson: lesson || '' });
const base = (f, extra) => Object.assign({ chat: f.chat, worker: W, critic: C, system: 'SYS', messages: msgs, task: 'write-' + Math.random().toString(36).slice(2), settings: {} }, extra);

test('graph runner: follows edges, records the path, and refuses to loop forever', async () => {
  const s = await agent.runGraph({ start: 'a', nodes: { a: async (st) => { st.n = 1; return 'b'; }, b: async (st) => { st.n += 1; return null; } } }, {});
  assert.deepEqual([s.n, s.path], [2, ['a', 'b']]);
  await assert.rejects(agent.runGraph({ start: 'a', nodes: { a: async () => 'a' } }, {}, { maxSteps: 5 }), { code: 'agent_loop_limit' });
  await assert.rejects(agent.runGraph({ start: 'x', nodes: {} }, {}), { code: 'agent_bad_graph' });
  const ac = new AbortController(); ac.abort();
  await assert.rejects(agent.runGraph({ start: 'a', nodes: { a: async () => null } }, {}, { signal: ac.signal }), { code: 'aborted' });
});

test('agent: a good first draft is reviewed once and kept', async () => {
  const f = fakeChat(['Bản nháp tốt'], [review(92)]);
  const ev = [];
  const r = await agent.run(base(f), (e) => ev.push(e));
  assert.equal(r.answer, 'Bản nháp tốt');
  assert.deepEqual(r.trace.path, ['draft', 'review']);
  assert.deepEqual([r.trace.rounds, r.trace.revisions, r.trace.firstScore, r.trace.finalScore, r.trace.lessonSaved], [1, 0, 92, 92, '']);
  assert.deepEqual(r.usage, { in: 20, out: 10, cacheRead: 0 });
  assert.deepEqual(ev.filter((e) => e.type === 'step').map((e) => e.node), ['draft', 'review']);
  assert.ok(!ev.some((e) => e.type === 'reset'));
  assert.equal(f.calls[1].system, agent.REVIEW_SYSTEM);
  assert.match(f.calls[1].messages[0].content, /REQUEST:\nViết thư xin nghỉ phép 2 ngày\n\nANSWER:\nBản nháp tốt/);
});

test('agent: a weak draft is revised with the reviewer\'s issues until it passes, and leaves a lesson', async () => {
  const f = fakeChat(['Nháp thiếu ngày', 'Bản sửa có ngày'], [review(55, ['Thiếu ngày nghỉ cụ thể'], 'Thư xin nghỉ luôn ghi rõ ngày bắt đầu và kết thúc'), review(90)]);
  const ev = [];
  const task = 'write-lesson-' + Date.now();
  const r = await agent.run(base(f, { task }), (e) => ev.push(e));
  assert.equal(r.answer, 'Bản sửa có ngày');
  assert.deepEqual(r.trace.path, ['draft', 'review', 'revise', 'review']);
  assert.deepEqual([r.trace.firstScore, r.trace.finalScore, r.trace.revisions], [55, 90, 1]);
  const reviseCall = f.calls[2];
  assert.deepEqual(reviseCall.messages.map((m) => m.role), ['user', 'assistant', 'user']);
  assert.match(reviseCall.messages[2].content, /- Thiếu ngày nghỉ cụ thể/);
  assert.equal(ev.filter((e) => e.type === 'reset').length, 1, 'the UI is told to clear the old draft before the rewrite streams');
  assert.equal(r.trace.lessonSaved, 'Thư xin nghỉ luôn ghi rõ ngày bắt đầu và kết thúc');
  // Self-improving: the next run of the same kind of task starts with that lesson.
  const f2 = fakeChat(['Nháp lần sau'], [review(95)]);
  const r2 = await agent.run(base(f2, { task }));
  assert.match(f2.calls[0].system, /^SYS\n\nLessons learned[\s\S]*- Thư xin nghỉ luôn ghi rõ ngày bắt đầu và kết thúc$/);
  assert.equal(r2.trace.lessonsUsed, 1);
});

test('agent: stops at the round limit, survives unreadable or failing reviews and empty rewrites', async () => {
  const f = fakeChat(['v1', 'v2', 'v3'], [review(40, ['a']), review(50, ['b']), review(60, ['c'])]);
  const r = await agent.run(base(f, { maxRounds: 2 }));
  assert.deepEqual([r.answer, r.trace.revisions, r.trace.rounds, r.trace.finalScore], ['v3', 2, 3, 60]);
  const u = await agent.run(base(fakeChat(['only draft'], ['I think it is fine, no JSON here'])));
  assert.deepEqual([u.answer, u.trace.rounds, u.trace.steps[1].unread], ['only draft', 0, true]);
  const e = await agent.run(base(fakeChat(['kept draft'], [Object.assign(new Error('boom'), { code: 'rate' })])));
  assert.deepEqual([e.answer, e.trace.steps[1].error], ['kept draft', 'rate']);
  const blank = await agent.run(base(fakeChat(['good v1', ''], [review(30, ['x']), review(35, ['y'])]), { maxRounds: 1 }));
  assert.equal(blank.answer, 'good v1', 'an empty rewrite never replaces a real answer');
  await assert.rejects(agent.run(base(fakeChat([''], []))), { code: 'empty' });
  const none = await agent.run(base(fakeChat(['just answer'], []), { maxRounds: 0 }));
  assert.deepEqual(none.trace.path, ['draft']);
});

test('agent: improving an existing answer starts at review and always acts on the user\'s feedback', async () => {
  const f = fakeChat(['Bản viết lại ngắn hơn'], [review(95), review(96)]);
  const r = await agent.run(base(f, { existingAnswer: 'Câu trả lời cũ rất dài', feedback: 'Ngắn lại còn 3 câu' }));
  assert.deepEqual(r.trace.path, ['review', 'revise', 'review']);
  assert.equal(r.answer, 'Bản viết lại ngắn hơn');
  assert.match(f.calls[0].messages[0].content, /ANSWER:\nCâu trả lời cũ rất dài[\s\S]*USER'S OWN FEEDBACK[\s\S]*Ngắn lại còn 3 câu/);
  assert.match(f.calls[1].messages[2].content, /- Ngắn lại còn 3 câu/, 'feedback becomes an issue even when the reviewer found none');
});

test('agent: review parsing, critic choice, lesson bookkeeping', () => {
  assert.deepEqual(agent.parseReview('```json\n{"score": 73.6, "issues": ["a", " ", "b"], "lesson": "L"}\n```'), { score: 74, issues: ['a', 'b'], lesson: 'L' });
  assert.deepEqual(agent.parseReview('Điểm: 80/100, khá ổn'), { score: 80, issues: [], lesson: '' });
  assert.equal(agent.parseReview('{"score": 250}').score, 100);
  assert.equal(agent.parseReview('no verdict'), null);
  const ready = [{ id: 'deepseek', ready: true, model: 'd' }, { id: 'claude', ready: true, model: 'c' }, { id: 'gemini', ready: false, model: 'g' }];
  assert.deepEqual(agent.pickCritic({ agent: { critic: 'auto' } }, { provider: 'deepseek', model: 'd' }, ready), { provider: 'claude', model: 'c' });
  assert.deepEqual(agent.pickCritic({ agent: { critic: 'auto' } }, { provider: 'claude', model: 'c' }, ready), { provider: 'deepseek', model: 'd' });
  assert.deepEqual(agent.pickCritic({ agent: { critic: 'deepseek' } }, { provider: 'deepseek', model: 'd' }, ready), { provider: 'deepseek', model: 'd' });
  assert.deepEqual(agent.pickCritic({ agent: { critic: 'gemini' } }, { provider: 'x', model: 'm' }, [ready[2]]), { provider: 'x', model: 'm' }, 'falls back to the worker when nothing else is ready');
  const t = 'bookkeeping-' + Date.now();
  assert.equal(agent.addLesson(t, 'Luôn nêu nguồn số liệu'), true);
  assert.equal(agent.addLesson(t, '  luôn nêu nguồn số liệu. '), true, 'same lesson again only raises its count');
  assert.equal(agent.addLesson(t, 'ngắn'), false);
  assert.deepEqual(agent.loadLessons().tasks[t].map((l) => [l.text, l.n]), [['Luôn nêu nguồn số liệu', 2]]);
  for (let i = 0; i < 15; i++) agent.addLesson(t, 'Bài học số ' + i + ' đủ dài');
  assert.equal(agent.loadLessons().tasks[t].length, 16, 'lessons are kept, not pruned early');
  assert.equal(agent.lessonsFor(t)[0], 'Luôn nêu nguồn số liệu');
  assert.equal(agent.removeLesson(t, 0), true);
  assert.equal(agent.removeLesson(t, 99), false);
  assert.notEqual(agent.lessonsFor(t)[0], 'Luôn nêu nguồn số liệu');
});

test('keeping everything: turn journal, daily backups, and habits that are never pruned', () => {
  const fs = require('fs'), path = require('path');
  const store = require('../lib/store'), router = require('../lib/router');
  const before = store.readJournal(1000).length;
  store.journal({ conv: 'c1', task: 'write', provider: 'deepseek', model: 'm', prompt: 'Viết thư', ok: true });
  store.journal({ conv: 'c1', task: 'write', provider: 'deepseek', model: 'm', ok: false, error: 'rate' });
  const log = store.readJournal(1000);
  assert.equal(log.length, before + 2);
  assert.deepEqual([log[log.length - 2].prompt, log[log.length - 1].error], ['Viết thư', 'rate']);
  assert.match(log[log.length - 1].at, /^\d{4}-\d{2}-\d{2}T/);

  const c = store.create({ provider: 'deepseek', model: 'm' });
  c.messages.push({ id: 'x', role: 'user', text: 'giữ lại nhé', ts: 1 });
  store.save(c);
  cfg.saveSettings({ lang: 'vi' });
  const day = Date.UTC(2026, 10, 13);
  const b = store.backup(day);
  assert.ok(b.copied >= 3 && b.dest.endsWith('2026-11-13'));
  for (const f of ['settings.json', 'history.jsonl', path.join('conversations', c.id + '.json')]) assert.ok(fs.existsSync(path.join(b.dest, f)), f);
  assert.match(fs.readFileSync(path.join(b.dest, 'conversations', c.id + '.json'), 'utf8'), /giữ lại nhé/);
  for (let i = 1; i <= 16; i++) store.backup(day + i * 86400000);
  const kept = fs.readdirSync(path.join(cfg.dataDir(), 'backups')).sort();
  assert.equal(kept.length, 17, 'no daily copy is ever deleted');
  assert.deepEqual([kept[0], kept[kept.length - 1]], ['2026-11-13', '2026-11-29']);
  assert.match(fs.readFileSync(path.join(cfg.dataDir(), 'backups', '2026-11-13', 'conversations', c.id + '.json'), 'utf8'), /giữ lại nhé/, 'the oldest copy is still readable');
  assert.ok(store.get(c.id), 'live data is untouched by backups');

  const t = 'keep-' + Date.now();
  for (let i = 0; i < 200; i += 50) router.record({ task: t, provider: 'p', model: 'm', usage: { in: 1, out: 1 }, now: day - i * 86400000 });
  const days = Object.keys(router.load().days);
  assert.ok(days.includes('2026-11-13') && days.includes(new Date(day - 150 * 86400000).toISOString().slice(0, 10)), 'usage from 150 days ago is still there');
});

test('agent over HTTP: draft, review, rewrite are streamed and saved; a failed improve keeps the old answer', async () => {
  const { start } = require('../server');
  const script = [];
  const mock = await mockOpenAI((body) => { const next = script.shift(); return next == null ? 'fallback' : next; });
  cfg.saveSettings({ custom: { baseUrl: mock.url }, models: { custom: 'mock-model' }, provider: 'custom', agent: { maxRounds: 2, passScore: 80, critic: 'auto' }, promptgate: { mode: 'off' } });
  const app = await start({ port: 0, quiet: true });
  const post = async (body) => {
    const res = await fetch(app.url + 'api/chat', { method: 'POST', headers: { 'x-onechat-token': app.token, 'content-type': 'application/json' }, body: JSON.stringify(Object.assign({ provider: 'custom', model: 'mock-model' }, body)) });
    const events = (await res.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l));
    return { events, done: events.find((e) => e.type === 'done'), error: events.find((e) => e.type === 'error'), meta: events.find((e) => e.type === 'meta') };
  };
  try {
    script.push('Nháp đầu', review(50, ['Thiếu lời chào'], 'Email luôn mở đầu bằng lời chào'), 'Bản đã sửa', review(88));
    const r = await post({ text: 'Viết email báo giá phòng cho khách đoàn', agent: true });
    assert.equal(r.meta.agent, true);
    assert.equal(r.done.message.text, 'Bản đã sửa');
    assert.deepEqual([r.done.message.agent.firstScore, r.done.message.agent.finalScore, r.done.message.agent.revisions], [50, 88, 1]);
    assert.deepEqual(r.done.message.usage, { in: 240, out: 28, cacheRead: 160 }, 'usage is the sum of all four calls');
    assert.deepEqual(r.events.filter((e) => e.type === 'step').map((e) => e.node), ['draft', 'review', 'revise', 'review']);
    assert.equal(r.events.filter((e) => e.type === 'reset').length, 1);
    const convId = r.meta.convId;
    const H = { 'x-onechat-token': app.token };
    const lessons = await (await fetch(app.url + 'api/agent/lessons', { headers: H })).json();
    const task = r.meta.task;
    assert.equal(lessons.tasks[task][0].text, 'Email luôn mở đầu bằng lời chào');
    const usage = await (await fetch(app.url + 'api/usage', { headers: H })).json();
    assert.equal(usage.tasks.find((t) => t.task === task).rows[0].avg, 50, 'the first-draft score feeds the habit table');

    script.push(review(70, ['Quá dài']), 'Bản ngắn gọn', review(93));
    const imp = await post({ convId, improve: true, feedback: 'ngắn hơn' });
    assert.equal(imp.done.message.text, 'Bản ngắn gọn');
    assert.deepEqual(imp.done.message.agent.path, ['review', 'revise', 'review']);
    let saved = await (await fetch(app.url + 'api/conversations/' + convId, { headers: H })).json();
    assert.deepEqual(saved.messages.map((m) => [m.role, m.text]), [['user', 'Viết email báo giá phòng cho khách đoàn'], ['assistant', 'Bản ngắn gọn']]);

    script.push(review(40, ['Sai giá']), { status: 500, error: 'down' }, { status: 500, error: 'down' });
    const bad = await post({ convId, improve: true });
    assert.equal(bad.error.code, 'server');
    saved = await (await fetch(app.url + 'api/conversations/' + convId, { headers: H })).json();
    assert.equal(saved.messages[saved.messages.length - 1].text, 'Bản ngắn gọn', 'the answer the user had is still there');
    assert.equal((await fetch(app.url + 'api/agent/lessons?task=' + encodeURIComponent(task) + '&i=0', { method: 'DELETE', headers: H })).status, 200);
  } finally { await app.close(); await mock.close(); }
});

test('out of credit: the turn moves to the next ready AI, remembers it, and says so', async () => {
  const { start } = require('../server');
  const broke = await mockOpenAI(() => ({ status: 429, error: 'You exceeded your current quota, please check your plan and billing details.' }));
  const good = await mockOpenAI(() => 'Trả lời từ AI còn credit');
  cfg.saveSettings({ custom: { baseUrl: broke.url }, baseUrls: { deepseek: good.url }, models: { custom: 'mock-model', deepseek: 'ds-model' }, provider: 'custom', promptgate: { mode: 'off' } });
  const app = await start({ port: 0, quiet: true, backups: false });
  const H = { 'x-onechat-token': app.token, 'content-type': 'application/json' };
  const setKey = (provider, key) => fetch(app.url + 'api/keys', { method: 'POST', headers: H, body: JSON.stringify({ provider, key }) });
  const post = async (body) => {
    const res = await fetch(app.url + 'api/chat', { method: 'POST', headers: H, body: JSON.stringify(Object.assign({ provider: 'custom', model: 'mock-model' }, body)) });
    const events = (await res.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l));
    return { events, done: events.find((e) => e.type === 'done'), error: events.find((e) => e.type === 'error') };
  };
  const line = [{ code: 'switched', detail: 'Custom → DeepSeek' }];
  try {
    await setKey('deepseek', 'test-key-0000');
    const a = await post({ text: 'Xin chào' });
    assert.equal(a.done.message.text, 'Trả lời từ AI còn credit');
    assert.deepEqual([a.done.message.provider, a.done.message.model, a.done.message.notices], ['deepseek', 'ds-model', line]);
    assert.deepEqual([broke.calls.length, good.calls.length], [1, 1], 'the empty account is asked once, then the next AI answers');
    assert.equal(good.calls[0].body.messages[good.calls[0].body.messages.length - 1].content, 'Xin chào', 'the same question goes to the other AI');

    const b = await post({ text: 'Câu thứ hai' });
    assert.deepEqual([b.done.message.provider, b.done.message.notices, broke.calls.length], ['deepseek', line, 1], 'a known-empty account is skipped without asking again');

    const ag = await post({ text: 'Viết lời cảm ơn khách', agent: true });
    assert.deepEqual([ag.done.message.provider, ag.done.message.text, ag.done.message.notices], ['deepseek', 'Trả lời từ AI còn credit', line], 'agent mode switches too, with one notice');

    await setKey('custom', 'new-key');
    await post({ text: 'Đã nạp tiền chưa' });
    assert.equal(broke.calls.length, 2, 'saving a key makes the app try that account again');

    await setKey('deepseek', '');
    await setKey('custom', 'new-key');
    const none = await post({ text: 'Không còn AI nào khác' });
    assert.equal(none.error.code, 'credit', 'with nowhere to go the real reason is reported');
  } finally { await app.close(); await good.close(); await broke.close(); }
});

test('overloaded or rate-limited AI: the turn moves on, the AI is skipped for a while, and it is not shown as out of credit', async () => {
  const { start } = require('../server');
  let mode = 500;
  const down = await mockOpenAI(() => (mode >= 500 ? { status: mode, error: 'This model is currently experiencing high demand.' } : mode === 429 ? { status: 429, error: 'Rate limit reached for this model, try again in 20s' } : 'Hết quá tải rồi'));
  const good = await mockOpenAI(() => 'Trả lời từ AI đang rảnh');
  cfg.saveSettings({ custom: { baseUrl: down.url }, baseUrls: { deepseek: good.url }, models: { custom: 'mock-model', deepseek: 'ds-model' }, provider: 'custom', promptgate: { mode: 'off' } });
  const app = await start({ port: 0, quiet: true, backups: false });
  const H = { 'x-onechat-token': app.token, 'content-type': 'application/json' };
  const setKey = (provider, key) => fetch(app.url + 'api/keys', { method: 'POST', headers: H, body: JSON.stringify({ provider, key }) });
  const post = async (body) => {
    const res = await fetch(app.url + 'api/chat', { method: 'POST', headers: H, body: JSON.stringify(Object.assign({ provider: 'custom', model: 'mock-model' }, body)) });
    const events = (await res.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l));
    return { done: events.find((e) => e.type === 'done'), error: events.find((e) => e.type === 'error') };
  };
  const line = [{ code: 'switched_busy', detail: 'Custom → DeepSeek' }];
  try {
    await setKey('deepseek', 'test-key-0000');
    await setKey('custom', 'k'); // start clean: an earlier test left this account marked "out of credit"
    const a = await post({ text: 'Xin chào' });
    assert.deepEqual([a.done.message.text, a.done.message.provider, a.done.message.notices], ['Trả lời từ AI đang rảnh', 'deepseek', line]);
    assert.equal(down.calls.length, 1);
    const b = await post({ text: 'Câu thứ hai' });
    assert.deepEqual([b.done.message.provider, b.done.message.notices, down.calls.length], ['deepseek', line, 1], 'the busy AI is not waited on again for the next message');
    const usage = await (await fetch(app.url + 'api/usage', { headers: H })).json();
    assert.notEqual((usage.quota.custom || {}).kind, 'spent', 'busy is not "out of credit": no 0% badge');

    mode = 429;
    await setKey('custom', 'k'); // saving a key clears the mark
    const c = await post({ text: 'Bị giới hạn tốc độ' });
    assert.deepEqual([c.done.message.provider, c.done.message.notices, down.calls.length], ['deepseek', line, 2], 'a rate limit switches too');

    mode = 0;
    await setKey('custom', 'k');
    const d = await post({ text: 'Đã rảnh chưa' });
    assert.deepEqual([d.done.message.text, d.done.message.provider, d.done.message.notices], ['Hết quá tải rồi', 'custom', []], 'once it answers again it is used as chosen');

    mode = 503;
    await setKey('custom', 'k');
    const e = await post({ text: 'Quá tải kiểu 503' });
    assert.deepEqual([e.done.message.provider, down.calls.length], ['deepseek', 4], 'with another AI in line, a 503 is not retried: the turn moves on at once');

    // A local AI app that is not open (nothing listens on its port) is skipped the same way.
    const closed = require('http').createServer();
    await new Promise((r) => closed.listen(0, '127.0.0.1', r));
    const deadUrl = 'http://127.0.0.1:' + closed.address().port;
    await new Promise((r) => closed.close(r));
    cfg.saveSettings({ custom: { baseUrl: deadUrl } });
    await setKey('custom', 'k');
    const f = await post({ text: 'App cục bộ đang tắt' });
    assert.deepEqual([f.done.message.provider, f.done.message.notices], ['deepseek', line], 'an AI app that is not running is switched away from');
    cfg.saveSettings({ custom: { baseUrl: down.url } });
    await setKey('custom', 'k');

    mode = 500;
    await setKey('deepseek', '');
    const none = await post({ text: 'Không còn AI nào khác' });
    assert.equal(none.error.code, 'server', 'with nowhere to go the real error is reported');
  } finally { await app.close(); await good.close(); await down.close(); }
});
