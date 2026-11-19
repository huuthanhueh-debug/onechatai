'use strict';
// End-to-end tests of the HTTP API against a mock AI provider: security gates, a full chat
// turn with files + memory, persistence, regenerate, compaction, habits, notes.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { tmp, zip, mockOpenAI } = require('./helpers');

const { start } = require('../server');
const cfg = require('../lib/config');

let app, mock, H;
const state = { reply: null };

const call = async (p, opts) => {
  opts = opts || {};
  const res = await fetch(app.url + p.replace(/^\//, ''), {
    method: opts.method || (opts.body !== undefined ? 'POST' : 'GET'),
    headers: Object.assign({}, opts.noToken ? {} : H, opts.body !== undefined ? { 'content-type': 'application/json' } : {}, opts.headers || {}),
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}
  return { status: res.status, json, text, headers: res.headers };
};
const chat = async (body) => {
  const r = await call('/api/chat', { body: Object.assign({ provider: 'custom', model: 'mock-model' }, body) });
  const events = r.text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
  const by = (t) => events.filter((e) => e.type === t);
  return { status: r.status, json: r.json, events, meta: by('meta')[0], done: by('done')[0], error: by('error')[0], text: by('text').map((e) => e.text).join('') };
};
const lastUpstream = () => mock.calls.filter((c) => c.url.endsWith('/chat/completions')).pop().body;
const rawGet = (pathname, headers) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port: app.port, path: pathname, method: 'GET', headers }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
  req.on('error', reject); req.end();
});

before(async () => {
  mock = await mockOpenAI((body) => (state.reply ? state.reply(body) : 'Trả lời từ AI giả'));
  cfg.saveSettings({ custom: { baseUrl: mock.url }, models: { custom: 'mock-model' }, provider: 'custom', promptgate: { rewrite: 'rules' }, helper: { provider: 'custom', model: 'mock-model' } });
  const dir = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'D--SERVER-TEST', 'memory');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'opshub-app.md'), '---\nname: opshub-app\ndescription: "Opshub hotel platform: deploy on Render, accounts"\nmetadata:\n  type: project\n---\n\nDeploy bằng Render. password: TopSecret99 cho tài khoản admin.\n');
  for (let i = 0; i < 6; i++) fs.writeFileSync(path.join(dir, 'note-' + i + '.md'), `---\nname: note-${i}\ndescription: "Ghi chú chung số ${i}"\n---\n\nNội dung ${i}\n`);
  app = await start({ port: 0 });
  H = { 'x-onechat-token': app.token };
});
after(async () => { await app.close(); await mock.close(); });

test('security: token, Host and Origin are all enforced; ping is open', async () => {
  assert.equal((await call('/api/ping', { noToken: true })).json.app, 'onechat');
  assert.equal((await call('/api/state', { noToken: true })).status, 401);
  assert.equal((await call('/api/state', { noToken: true, headers: { 'x-onechat-token': 'f'.repeat(48) } })).status, 401);
  assert.equal((await call('/api/state', { headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await call('/api/state', { headers: { origin: 'http://127.0.0.1:' + app.port } })).status, 200);
  assert.equal(await rawGet('/api/state', { host: 'evil.example', 'x-onechat-token': app.token }), 403, 'DNS-rebinding style Host is refused');
  assert.equal(await rawGet('/', { host: 'evil.example' }), 403);
  assert.equal((await call('/../package.json', { noToken: true })).status, 404);
  assert.equal((await call('/lib/config.js', { noToken: true })).status, 404);
});

test('page: served with the token, a strict CSP and no inline script', async () => {
  const r = await call('/', { noToken: true });
  assert.equal(r.status, 200);
  assert.ok(r.text.includes('content="' + app.token + '"'));
  const csp = r.headers.get('content-security-policy');
  assert.match(csp, /script-src 'self'/);
  assert.ok(!/script-src[^;]*unsafe-inline/.test(csp));
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/.test(r.text), 'no inline <script>');
  assert.ok(!/\son\w+="/.test(r.text), 'no inline event handlers');
  for (const f of ['/app.js', '/app.css', '/i18n.js', '/md.js']) assert.equal((await call(f, { noToken: true })).status, 200, f);
});

test('settings and keys: saved, masked, and the key never comes back', async () => {
  const s = await call('/api/settings', { body: { lang: 'en', bogus: 1, output: { concise: true } } });
  assert.equal(s.json.settings.lang, 'en');
  assert.equal(s.json.settings.bogus, undefined);
  const k = await call('/api/keys', { body: { provider: 'deepseek', key: 'sk-live-DO-NOT-LEAK-9876' } });
  const d = k.json.providers.find((p) => p.id === 'deepseek');
  assert.deepEqual([d.hasKey, d.status, d.keyMask], [true, 'ready', 'sk-l…9876']);
  assert.ok(!k.text.includes('DO-NOT-LEAK'));
  assert.ok(!(await call('/api/state')).text.includes('DO-NOT-LEAK'));
  assert.ok(!fs.readFileSync(path.join(cfg.dataDir(), 'settings.json'), 'utf8').includes('DO-NOT-LEAK'));
  assert.equal((await call('/api/keys', { body: { provider: 'nope', key: 'x' } })).status, 400);
  await call('/api/keys', { body: { provider: 'deepseek', key: '' } });
  await call('/api/settings', { body: { lang: 'vi', output: { concise: false } } });
});

let convId = '';
test('chat: a full turn with a file and memory reaches the AI and is saved', async () => {
  const dir = tmp('chat');
  fs.writeFileSync(path.join(dir, 'ke-hoach.txt'), 'Kế hoạch quý 4: tăng công suất phòng lên 82%.');
  fs.writeFileSync(path.join(dir, 'bang.xlsx'), zip({ 'xl/sharedStrings.xml': '<sst><si><t>Công suất</t></si></sst>', 'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>82</v></c></row></sheetData></worksheet>' }));
  const an = await call('/api/analyze', { body: { text: 'Opshub báo lỗi TypeError khi đăng nhập, tìm nguyên nhân giúp' } });
  assert.equal(an.json.memory[0].name, 'opshub-app');
  assert.equal(an.json.task, 'debug');
  assert.ok(an.json.pg && typeof an.json.pg.score === 'number');
  const memId = an.json.memory[0].id;

  const r = await chat({ text: 'Opshub báo lỗi TypeError khi đăng nhập, tìm nguyên nhân giúp', files: [path.join(dir, 'ke-hoach.txt'), path.join(dir, 'bang.xlsx'), path.join(dir, 'khong-co.txt')], inline: [{ name: 'ghi-chu.md', data: Buffer.from('# Ghi chú kéo thả').toString('base64') }], memoryIds: [memId] });
  assert.equal(r.status, 200);
  assert.equal(r.text, 'Trả lời từ AI giả');
  assert.equal(r.meta.task, 'debug');
  assert.deepEqual(r.meta.userMessage.ctx.files.map((f) => f.name), ['ke-hoach.txt', 'bang.xlsx', 'ghi-chu.md']);
  assert.deepEqual(r.meta.userMessage.ctx.fileErrors.map((e) => e.code), ['not_found']);
  assert.equal(r.meta.userMessage.ctx.memory[0].name, 'opshub-app');
  assert.ok(r.meta.userMessage.ctx.masked >= 1);
  assert.equal(r.meta.userMessage.ctx.filesText, undefined, 'attachment text is not echoed back to the UI');
  assert.deepEqual(r.done.message.usage, { in: 60, out: 7, cacheRead: 40 });
  convId = r.meta.convId;

  const up = lastUpstream();
  assert.equal(up.model, 'mock-model');
  assert.equal(up.messages[0].role, 'system');
  assert.match(up.messages[0].content, /reference material supplied by the app/);
  const user = up.messages[up.messages.length - 1].content;
  assert.match(user, /<memory note=[\s\S]*## opshub-app \(project\)/);
  assert.ok(!user.includes('TopSecret99'), 'memory secrets are masked before leaving the machine');
  assert.match(user, /<file name="ke-hoach\.txt" path="[^"]+">\nKế hoạch quý 4/);
  assert.match(user, /<file name="bang\.xlsx"[^>]*>\n--- Sheet: 1 ---\nCông suất\t82/);
  assert.match(user, /<file name="ghi-chu\.md">\n# Ghi chú kéo thả/);
  assert.ok(user.trim().endsWith('tìm nguyên nhân giúp'));

  const saved = (await call('/api/conversations/' + convId)).json;
  assert.deepEqual(saved.messages.map((m) => m.role), ['user', 'assistant']);
  assert.equal(saved.messages[1].provider, 'custom');
  assert.ok(saved.tokens > 0 && saved.title.startsWith('Opshub báo lỗi'));
  const list = (await call('/api/conversations')).json.conversations;
  assert.equal(list[0].id, convId);
  assert.equal(list[0].count, 2);
});

test('chat: follow-up keeps history, does not re-attach memory, and learns the habit', async () => {
  const an = await call('/api/analyze', { body: { text: 'Opshub trên Render còn lỗi gì nữa không?', convId } });
  assert.equal(an.json.memory.length, 0, 'already attached in this conversation');
  const r = await chat({ convId, text: 'Sửa lỗi TypeError đó thế nào?' });
  assert.equal(r.status, 200);
  const up = lastUpstream();
  assert.deepEqual(up.messages.map((m) => m.role), ['system', 'user', 'assistant', 'user']);
  assert.match(up.messages[1].content, /<file name="ke-hoach\.txt"/, 'earlier attachment stays in the history');
  const usage = (await call('/api/usage')).json;
  const debug = usage.tasks.find((t) => t.task === 'debug');
  assert.equal(debug.rows[0].provider + '|' + debug.rows[0].n, 'custom|2');
  assert.equal(usage.today.n, 2);
  const rec = (await call('/api/analyze', { body: { text: 'App bị lỗi TypeError khi mở' } })).json.recommend;
  assert.deepEqual([rec.provider, rec.model, rec.reason], ['custom', 'mock-model', 'habit']);
});

test('chat: auto mode routes by habit; regenerate replaces the last answer', async () => {
  const r = await chat({ convId, provider: 'auto', model: '', text: 'Lại lỗi TypeError khi lưu, fix giúp' });
  assert.deepEqual([r.meta.provider, r.meta.model, r.meta.routed.reason], ['custom', 'mock-model', 'habit']);
  state.reply = () => 'Câu trả lời mới';
  const g = await chat({ convId, regenerate: true });
  state.reply = null;
  assert.equal(g.text, 'Câu trả lời mới');
  const saved = (await call('/api/conversations/' + convId)).json;
  assert.deepEqual(saved.messages.map((m) => m.role), ['user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
  assert.equal(saved.messages[5].text, 'Câu trả lời mới');
  const msg = saved.messages[5];
  assert.equal((await call('/api/chat/feedback', { body: { convId, messageId: msg.id, value: 1 } })).json.vote, 1);
  assert.equal((await call('/api/chat/feedback', { body: { convId, messageId: 'nope', value: 1 } })).status, 404);
});

test('chat: provider failures surface as codes; nothing is sent without a key', async () => {
  state.reply = () => ({ status: 401, error: 'bad key' });
  const r = await chat({ text: 'một câu hỏi bất kỳ để thử lỗi' });
  state.reply = null;
  assert.equal(r.error.code, 'auth');
  assert.match(r.error.message, /bad key/);
  const saved = (await call('/api/conversations/' + r.meta.convId)).json;
  assert.deepEqual(saved.messages.map((m) => m.role), ['user'], 'the question is kept so it can be retried');
  const before = mock.calls.length;
  const nokey = await chat({ provider: 'gemini', model: 'gemini-3.8-flash', text: 'xin chào Gemini' });
  assert.equal(nokey.status, 502);
  assert.equal(nokey.json.error, 'no_key');
  assert.equal(mock.calls.length, before);
  assert.equal((await chat({ text: '   ' })).json.error, 'empty');
  assert.equal((await chat({ provider: 'made-up', text: 'x y z' })).json.error, 'unknown_provider');
  assert.equal((await chat({ convId: 'zzzzzzzzzzzz', text: 'x y z' })).status, 404);
});

test('promptgate: weak prompts get click-ready rewrites; // and acks are left alone', async () => {
  const an = (await call('/api/analyze', { body: { text: 'làm ơn sửa giúp mình cái này với nhé' } })).json;
  assert.equal(an.pg.weak, true);
  const v = (await call('/api/promptgate/variants', { body: { text: 'làm ơn sửa giúp mình cái này với nhé' } })).json;
  assert.ok(v.options.length >= 2 && v.via === 'rules' && typeof v.score === 'number');
  assert.ok(v.options.every((o) => !o.text.includes('⟨')));
  assert.equal((await call('/api/analyze', { body: { text: 'ok' } })).json.pg, null);
  assert.equal((await call('/api/analyze', { body: { text: '// làm ơn sửa giúp mình cái này với nhé' } })).json.pg, null);
  await call('/api/settings', { body: { promptgate: { mode: 'off' } } });
  assert.equal((await call('/api/analyze', { body: { text: 'làm ơn sửa giúp mình cái này với nhé' } })).json.pg, null);
  await call('/api/settings', { body: { promptgate: { mode: 'suggest', rewrite: 'auto' } } });
  state.reply = () => '<<<A>>>\nSửa lỗi đăng nhập.\n<<<B>>>\nMục tiêu: sửa lỗi đăng nhập ở trang chủ.\n<<<C>>>\nMục tiêu: sửa lỗi đăng nhập, nêu ca biên, tự kiểm tra.';
  const llm = (await call('/api/promptgate/variants', { body: { text: 'làm ơn sửa giúp mình cái này với nhé', llm: true } })).json;
  state.reply = null;
  assert.equal(llm.via, 'llm');
  assert.deepEqual(llm.options.map((o) => o.key), ['A', 'B', 'C']);
  assert.match(lastUpstream().messages[0].content, /PromptGate/);
  state.reply = () => 'I refuse to follow the format';
  const fb = (await call('/api/promptgate/variants', { body: { text: 'làm ơn sửa giúp mình cái này với nhé', llm: true } })).json;
  state.reply = null;
  assert.equal(fb.via, 'rules');
  assert.equal(fb.llmFailed, true);
});

test('compaction: older turns become a summary that travels in the system prompt', async () => {
  for (let i = 0; i < 2; i++) await chat({ convId, text: 'Vẫn còn lỗi TypeError số ' + i + ' ở trang đăng nhập' });
  state.reply = () => 'TÓM TẮT: người dùng sửa lỗi deploy Opshub.';
  const c = (await call('/api/conversations/' + convId + '/compact', { body: {} })).json;
  state.reply = null;
  assert.equal(c.skipped, false);
  assert.ok(c.conversation.summaryUpTo >= 2);
  assert.match(c.conversation.summary, /TÓM TẮT/);
  await chat({ convId, text: 'Tiếp tục từ chỗ đó nhé bạn' });
  const up = lastUpstream();
  assert.match(up.messages[0].content, /Summary of the earlier part[\s\S]*TÓM TẮT/);
  assert.equal(up.messages[1].role, 'user');
  assert.ok(up.messages.length < 9, 'old turns are no longer resent: ' + up.messages.length);
  const fresh = (await chat({ text: 'cuộc trò chuyện mới rất ngắn' })).meta.convId;
  assert.equal((await call('/api/conversations/' + fresh + '/compact', { body: {} })).json.skipped, true);
});

test('files and memory APIs: browse, search, notes, rename, delete', async () => {
  const dir = tmp('api');
  fs.mkdirSync(path.join(dir, 'Hợp đồng'));
  fs.writeFileSync(path.join(dir, 'Hợp đồng', 'thuê nhà.txt'), 'x');
  const ls = (await call('/api/fs/list?path=' + encodeURIComponent(dir))).json;
  assert.deepEqual(ls.items.map((i) => [i.name, i.dir]), [['Hợp đồng', true]]);
  assert.equal((await call('/api/fs/list?path=' + encodeURIComponent(path.join(dir, 'missing')))).status, 404);
  assert.deepEqual((await call('/api/fs/search?q=thue%20nha&path=' + encodeURIComponent(dir))).json.results.map((r) => r.name), ['thuê nhà.txt']);
  assert.ok((await call('/api/fs/roots')).json.roots.length > 0);

  const note = (await call('/api/memory/note', { body: { title: 'Giá phòng 2027', text: 'Deluxe 2,4 triệu. token: abcdef123456' } })).json;
  const items = (await call('/api/memory')).json.items;
  assert.ok(items.find((i) => i.id === note.id && i.sourceKind === 'notes'));
  assert.ok(items.find((i) => i.name === 'opshub-app' && i.sourceKind === 'claude'));
  assert.ok(items.every((i) => !('body' in i)));
  const pv = (await call('/api/memory/item?id=' + note.id)).json;
  assert.ok(pv.body.includes('Deluxe') && !pv.body.includes('abcdef123456') && pv.masked === 1);
  assert.equal((await call('/api/memory/note', { body: { title: 'x', text: '' } })).status, 400);
  assert.equal((await call('/api/memory/note?id=' + note.id, { method: 'DELETE' })).json.ok, true);

  const exp = (await call('/api/memory/export')).json;
  assert.ok(exp.count >= 7 && /^onechat-memory-.*\.md$/.test(exp.filename));
  assert.ok(exp.text.includes('name: opshub-app') && !exp.text.includes('TopSecret99'), 'exports are masked');
  assert.deepEqual((await call('/api/memory/import', { body: { files: [{ name: exp.filename, text: exp.text }] } })).json, { ok: true, added: 0, skipped: exp.count, names: [] });
  const imp = (await call('/api/memory/import', { body: { files: [{ name: 'Thói quen.md', text: 'Tôi uống cà phê lúc 7 giờ.' }, { name: 'x.json', text: '{bad' }] } }));
  assert.equal(imp.status, 400, 'a broken file fails the whole import instead of half-importing silently');
  const one = (await call('/api/memory/import', { body: { files: [{ name: 'Thói quen.md', text: 'Tôi uống cà phê lúc 7 giờ.' }] } })).json;
  assert.deepEqual([one.added, one.skipped], [1, 0]);
  assert.ok((await call('/api/memory')).json.items.some((i) => i.name === 'thoi-quen' && i.sourceKind === 'notes'));

  assert.equal((await call('/api/conversations/' + convId + '/rename', { body: { title: 'Tên mới' } })).json.title, 'Tên mới');
  assert.equal((await call('/api/conversations/' + convId, { method: 'DELETE' })).json.ok, true);
  assert.equal((await call('/api/conversations/' + convId)).status, 404);
  assert.equal((await call('/api/conversations/..%2F..%2Fsettings')).status, 404);
});
