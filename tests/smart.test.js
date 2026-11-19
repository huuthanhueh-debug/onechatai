'use strict';
// Pictures in chat, "% left" per AI, council mode, things built from answers, launchers.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { mockOpenAI, mockAnthropic, listen, tmp } = require('./helpers');
const cfg = require('../lib/config');
const media = require('../lib/media');
const files = require('../lib/files');
const quota = require('../lib/quota');
const council = require('../lib/council');
const studio = require('../lib/studio');
const tokens = require('../lib/tokens');
const router = require('../lib/router');
const store = require('../lib/store');
const secrets = require('../lib/secrets');
const providers = require('../lib/providers');
const cli = require('../lib/providers/claude-cli');
const imagegen = require('../lib/imagegen');
const Studio = require('../public/studio.js');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
// The same picture with one extra byte after the end marker: still a PNG, but a different file.
const png = (n) => Buffer.concat([PNG, Buffer.from([n])]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.alloc(14), Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x0a, 0x00, 0x14, 0x03]), Buffer.alloc(12)]);
const ROOT = path.join(__dirname, '..');

test('media: pictures are recognised by their bytes, stored once, and read back', () => {
  assert.deepEqual([media.sniff(PNG), media.sniff(JPG), media.sniff(Buffer.from('GIF89a' + 'x'.repeat(10))), media.sniff(Buffer.from('<svg xmlns="x"></svg>')), media.sniff(Buffer.from([1, 2]))], ['png', 'jpg', 'gif', null, null]);
  assert.deepEqual([media.size(PNG), media.size(JPG)], [{ w: 1, h: 1 }, { w: 20, h: 10 }]);
  const a = media.save(PNG), b = media.save(PNG);
  assert.equal(a.id, b.id, 'the same picture is one file');
  assert.match(a.id, /^[a-f0-9]{24}\.png$/);
  assert.deepEqual([a.mime, a.bytes, a.w, a.h], ['image/png', PNG.length, 1, 1]);
  assert.ok(media.read(a.id).equals(PNG));
  assert.throws(() => media.save(Buffer.from('not a picture at all')), { code: 'bad_image' });
  assert.throws(() => media.read('../settings.json'), { code: 'bad_id' });
  assert.throws(() => media.read('0'.repeat(24) + '.png'), { code: 'not_found' });
  assert.equal(media.getCaption(a.id), '');
  media.setCaption(a.id, 'một điểm ảnh');
  assert.equal(media.getCaption(a.id), 'một điểm ảnh');
  assert.equal(media.findGenerated('a cat'), null);
  media.rememberGenerated('a cat', { id: a.id, provider: 'gemini', model: 'm' });
  assert.equal(media.findGenerated('  a cat ').id, a.id, 'the same prompt finds the picture made before');
  assert.deepEqual([media.tokensFor(1568, 1568) <= 1700, media.tokensFor(0, 0), media.tokensFor(640, 360)], [true, 1100, 308]);
  assert.ok(media.isImageName('Ảnh chụp.JPG') && !media.isImageName('a.pdf'));
});

test('files: attached pictures come back as pictures, never as "binary, unreadable"', async () => {
  const dir = tmp('pics');
  fs.writeFileSync(path.join(dir, 'chart.png'), PNG);
  fs.writeFileSync(path.join(dir, 'note.txt'), 'xin chào');
  assert.equal(files.kindOf('photo.jpeg'), 'image');
  const got = await files.collect({ paths: [path.join(dir, 'chart.png'), path.join(dir, 'note.txt'), path.join(dir, 'gone.png')], inline: [{ name: 'pasted.png', data: PNG.toString('base64'), type: 'image/png', w: 640, h: 360 }, { name: 'clip', data: JPG.toString('base64'), type: 'image/jpeg' }] });
  assert.deepEqual(got.images.map((i) => i.name), ['chart.png', 'pasted.png', 'clip']);
  assert.ok(got.images[0].buf.equals(PNG) && got.images[1].w === 640);
  assert.deepEqual(got.files.map((f) => f.name), ['note.txt']);
  assert.deepEqual(got.errors.map((e) => [e.name, e.code]), [['gone.png', 'not_found']]);
  await assert.rejects(files.extract('photo.jpg', PNG), { code: 'binary' }, 'a picture is still not text');
});

test('history budget counts the pictures a message carries', () => {
  const msgs = [{ role: 'user', content: 'cũ', images: [{ id: 'x' }], imgTokens: 1500 }, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'mới' }];
  assert.equal(tokens.fitHistory(msgs, 0).tokens > 1500, true);
  assert.deepEqual(tokens.fitHistory(msgs, 400).kept.map((m) => m.content), ['mới'], 'an old picture is dropped before the budget is blown');
});

test('providers: an AI that can see gets the picture; one that cannot gets a description from one that can', async () => {
  await secrets.load();
  const eye = await mockOpenAI((body) => (JSON.stringify(body.messages).includes('Describe this picture') ? 'Chữ lớn: ONECHAT 4721' : 'Tôi thấy ảnh'));
  const blind = await mockOpenAI(() => 'Số trong ảnh là 4721');
  const claude = await mockAnthropic(() => 'ảnh có một điểm');
  await secrets.set('gemini', 'k-gemini');
  cfg.saveSettings({ baseUrls: { gemini: eye.url }, custom: { baseUrl: blind.url }, models: { gemini: 'gemini-test', custom: 'text-only' }, vision: { bridge: true } });
  const settings = () => cfg.loadSettings();
  const pic = media.save(png(1));
  const ask = async (provider, model, img, extra) => {
    const events = [];
    let text = '';
    await providers.chat(Object.assign({ provider, model, system: 'S', messages: [{ role: 'user', content: 'Số nào trong ảnh?', images: [{ id: img.id, name: 'so.png' }], imgTokens: 300 }], settings: settings() }, extra), (ev) => { events.push(ev); if (ev.type === 'text') text += ev.text; });
    return { text, notices: events.filter((e) => e.type === 'notice') };
  };
  try {
    assert.deepEqual([providers.sees(providers.preset('gemini'), 'gemini-test'), providers.sees(providers.preset('deepseek'), 'deepseek-v4-pro'), providers.sees(providers.preset('claude-cli'), 'opus'), providers.sees(providers.preset('groq'), 'openai/gpt-oss-20b'), providers.sees(providers.preset('groq'), 'qwen/qwen3.8-27b')], [true, false, true, false, true]);
    assert.equal(providers.describe(settings()).find((p) => p.id === 'custom').vision, false);

    const a = await ask('gemini', 'gemini-test', pic);
    assert.equal(a.text, 'Tôi thấy ảnh');
    const sent = eye.calls[eye.calls.length - 1].body.messages[1];
    assert.deepEqual([sent.content[0], sent.content[1].type, Object.keys(sent).sort()], [{ type: 'text', text: 'Số nào trong ảnh?' }, 'image_url', ['content', 'role']], 'only role and content travel');
    assert.equal(sent.content[1].image_url.url, 'data:image/png;base64,' + png(1).toString('base64'));
    assert.deepEqual(a.notices, []);

    const before = eye.calls.length;
    const b = await ask('custom', 'text-only', pic);
    assert.equal(b.text, 'Số trong ảnh là 4721');
    assert.deepEqual(b.notices, [{ type: 'notice', code: 'vision_bridge', detail: 'Gemini' }], 'the user is told another AI read the picture');
    assert.equal(eye.calls.length, before + 1);
    assert.equal(eye.calls[before].body.model, 'gemini-3.5-flash-lite', 'the cheap vision model does the describing');
    const got = blind.calls[blind.calls.length - 1].body.messages[1].content;
    assert.equal(got, '<image name="so.png" described-by="another assistant">\nChữ lớn: ONECHAT 4721\n</image>\n\nSố nào trong ảnh?');

    const c = await ask('custom', 'text-only', pic);
    assert.deepEqual([eye.calls.length, c.notices.length], [before + 1, 0], 'a picture is described once, then the description is reused');

    cfg.saveSettings({ vision: { bridge: false } });
    const d = await ask('custom', 'text-only', media.save(png(2)));
    assert.deepEqual(d.notices.map((n) => n.code), ['no_vision']);
    assert.match(blind.calls[blind.calls.length - 1].body.messages[1].content, /could not be read/);
    assert.equal(eye.calls.length, before + 1, 'with the bridge off the picture goes nowhere else');

    await secrets.set('claude', 'k-claude');
    cfg.saveSettings({ baseUrls: { claude: claude.url }, vision: { bridge: true } });
    await ask('claude', 'claude-haiku-5-5', pic);
    const blocks = claude.calls[claude.calls.length - 1].body.messages[0].content;
    assert.deepEqual([blocks[0].type, blocks[0].source.media_type, blocks[0].source.data, blocks[1]], ['image', 'image/png', png(1).toString('base64'), { type: 'text', text: 'Số nào trong ảnh?' }]);
  } finally { await secrets.set('claude', ''); await eye.close(); await blind.close(); await claude.close(); }
});

test('claude-cli: pictures go in as one structured message and the plan limits come back', () => {
  const st = { gotDelta: false, result: null, model: '' };
  cli.handleEvent({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.37, resetsAt: 1794576000 }, seven_day: { utilization: 0.5, resetsAt: 1794772800 } } } }, st, () => {});
  cli.handleEvent({ type: 'result', is_error: false, usage: { input_tokens: 1, output_tokens: 1 } }, st, () => {});
  const r = cli.finish(st, 0, '');
  assert.equal(r.limits.cli.unifiedWindows.five_hour.utilization, 0.37);
  assert.match(cli.flatten([{ role: 'user', content: 'xem', images: [{ name: 'a.png' }] }, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'tiếp' }]), /\(attached pictures: a\.png\)/);
});

test('quota: only what the provider reports, turned into "% left"', () => {
  const now = Date.UTC(2026, 10, 13, 8, 0, 0);
  assert.deepEqual([quota.duration('1m26.4s'), quota.duration('674ms'), quota.duration('2h3m'), quota.duration('12'), quota.duration('')], [86400, 674, 7380000, 12000, 0]);
  const plan = quota.windowsFrom({ cli: { unifiedWindows: { five_hour: { utilization: 0.37, resetsAt: 1794576000 }, seven_day: { utilization: 0.5, resetsAt: 1794772800 } } } }, now);
  assert.deepEqual(plan.map((w) => [w.id, Math.round(w.remaining * 100), w.resetsAt]), [['five_hour', 63, 1794576000000], ['seven_day', 50, 1794772800000]]);
  const groq = quota.windowsFrom({ headers: { 'x-ratelimit-limit-requests': '1000', 'x-ratelimit-remaining-requests': '999', 'x-ratelimit-reset-requests': '1m26.4s', 'x-ratelimit-limit-tokens': '8000', 'x-ratelimit-remaining-tokens': '2000', 'x-ratelimit-reset-tokens': '674ms' } }, now);
  assert.deepEqual(groq.map((w) => [w.id, w.remaining, w.resetsAt - now]), [['requests', 0.999, 86400], ['tokens', 0.25, 674]]);
  const ant = quota.windowsFrom({ headers: { 'anthropic-ratelimit-requests-limit': '4000', 'anthropic-ratelimit-requests-remaining': '3000', 'anthropic-ratelimit-requests-reset': '2026-11-13T09:00:10Z' } }, now);
  assert.deepEqual(ant, [{ id: 'requests', remaining: 0.75, resetsAt: Date.parse('2026-11-13T09:00:10Z') }]);
  assert.deepEqual(quota.windowsFrom(null, now), []);

  const far = Date.now() + 3600 * 1000;
  quota.note('claude-cli', { cli: { unifiedWindows: { five_hour: { utilization: 0.37, resetsAt: far / 1000 }, seven_day: { utilization: 0.5, resetsAt: far / 1000 } } } });
  quota.note('groq', { headers: { 'x-ratelimit-limit-tokens': '8000', 'x-ratelimit-remaining-tokens': '2000', 'x-ratelimit-reset-tokens': '50m' } });
  quota.note('gemini', null);
  quota.setBalance('deepseek', '4.34', 'USD');
  quota.spent('openai', 'You have no credits remaining');
  let v = quota.view({ budgets: { gemini: 2 } }, { gemini: { in: 300000, out: 200000 } });
  assert.deepEqual([v['claude-cli'].kind, v['claude-cli'].pct, v['claude-cli'].lines.map((l) => [l.type, l.pct])], ['plan', 50, [['plan_five_hour', 63], ['plan_seven_day', 50]]], 'the tighter window is the headline');
  assert.deepEqual([v.groq.kind, v.groq.pct], ['rate', 25]);
  assert.deepEqual([v.deepseek.kind, v.deepseek.pct, v.deepseek.amount], ['balance', null, 4.34], 'a balance is shown as money, not turned into a made-up percentage');
  assert.deepEqual([v.openai.kind, v.openai.pct, v.openai.lines[0].type], ['spent', 0, 'spent']);
  assert.deepEqual([v.gemini.kind, v.gemini.pct, v.gemini.lines[0]], ['budget', 75, { type: 'budget', pct: 75, used: 0.5, budget: 2 }], 'a self-set allowance is measured against what the app counted');
  assert.equal(quota.view({}, {}).gemini, undefined, 'no report and no allowance: no figure at all');
  assert.equal(quota.isSpent('openai', 60000), true);
  quota.note('openai', null);
  assert.equal(quota.isSpent('openai', 60000), false, 'a call that works ends "out of credit"');
  quota.spent('openai', 'again'); quota.clear('openai');
  v = quota.view({}, {});
  assert.equal(v.openai, undefined, 'saving a new key wipes the old key\'s state');
  assert.equal(quota.view({}, {}, far + 1000)['claude-cli'], undefined, 'a plan window that has reset is no longer shown');
  assert.deepEqual([quota.view({}, {}, far + 1000).groq.kind, quota.view({}, {}, far + 1000).groq.pct], ['rate', 100], 'a rate limit past its reset time is full again');
});

test('usage is also counted per AI per month', () => {
  const now = Date.UTC(2026, 10, 13);
  router.record({ task: 'q-month', provider: 'gemini', model: 'm', usage: { in: 100, out: 40 }, now });
  router.record({ task: 'q-month', provider: 'gemini', model: 'm2', usage: { in: 10, out: 5 }, now });
  const d = router.load();
  assert.deepEqual([d.months['2026-11'].gemini.n, d.months['2026-11'].gemini.in, d.months['2026-11'].gemini.out], [2, 110, 45]);
});

test('council: one voice per model family; answers are compared and one final answer is written', async () => {
  const ready = [['claude-cli', 'opus'], ['claude', 'claude-opus-5-5'], ['gemini', 'g'], ['deepseek', 'd'], ['groq', 'q'], ['anythingllm', 'ws']].map(([id, model]) => ({ id, model, ready: true }));
  assert.deepEqual(council.pickMembers({ council: { max: 3 } }, { provider: 'deepseek', model: 'd2' }, ready).map((m) => m.provider + ':' + m.model), ['deepseek:d2', 'claude-cli:opus', 'gemini:g'], 'the asked AI first, Claude counted once');
  assert.deepEqual(council.pickMembers({ council: { max: 5 } }, { provider: 'claude', model: 'c' }, ready, (id) => id === 'gemini').map((m) => m.provider), ['claude', 'deepseek', 'groq'], 'accounts out of credit are left out');
  assert.deepEqual(council.pickMembers({}, { provider: 'x', model: '' }, [ready[2]]).length, 1);
  assert.deepEqual(council.pickJudge({ council: { judge: 'auto' } }, { provider: 'deepseek', model: 'd2' }, ready), { provider: 'deepseek', model: 'd2' });
  assert.deepEqual(council.pickJudge({ council: { judge: 'gemini' } }, { provider: 'deepseek', model: 'd2' }, ready), { provider: 'gemini', model: 'g' });

  const members = [{ provider: 'a', model: 'ma' }, { provider: 'b', model: 'mb' }, { provider: 'c', model: 'mc' }];
  const judge = { provider: 'a', model: 'ma' };
  const calls = [];
  const chatOf = (answers) => async (req, emit) => {
    calls.push(req);
    const isJudge = /chairing a panel/.test(req.system);
    const out = isJudge ? answers.judge : answers[req.provider];
    if (out instanceof Error) throw out;
    emit({ type: 'text', text: out });
    return { usage: { in: 10, out: 5, cacheRead: 0 }, model: req.model + '-real' };
  };
  const base = { members, judge, system: 'SYS', messages: [{ role: 'user', content: 'cũ' }, { role: 'assistant', content: 'ừ' }, { role: 'user', content: '2 + 2 = ?', images: [{ id: 'p', name: 'p.png' }] }], settings: {} };

  let ev = [];
  let r = await council.run(Object.assign({ chat: chatOf({ a: 'Bằng 4', b: 'Bằng 5', c: Object.assign(new Error('x'), { code: 'rate' }), judge: 'Đáp án: 4' }) }, base), (e) => ev.push(e));
  assert.equal(r.answer, 'Đáp án: 4');
  assert.deepEqual([r.by, r.modelUsed], [{ provider: 'a', model: 'ma' }, 'ma-real']);
  assert.deepEqual(r.trace.members.map((m) => [m.provider, m.ok, m.error]), [['a', true, undefined], ['b', true, undefined], ['c', false, 'rate']], 'one member failing does not sink the council');
  assert.deepEqual(r.usage, { in: 30, out: 15, cacheRead: 0 }, 'two answers plus the synthesis');
  const jc = calls[calls.length - 1];
  assert.match(jc.system, /^SYS\n\nYou are chairing a panel/);
  assert.deepEqual(jc.messages.slice(0, 2), base.messages.slice(0, 2), 'the chair sees the earlier conversation');
  assert.equal(jc.messages[2].content, 'REQUEST:\n2 + 2 = ?\n\nANSWER A:\nBằng 4\n\nANSWER B:\nBằng 5');
  assert.deepEqual(jc.messages[2].images, [{ id: 'p', name: 'p.png' }], 'and the attached picture');
  assert.deepEqual(ev.filter((e) => e.type === 'step').map((e) => e.node + ':' + e.provider).sort(), ['council_ask:a', 'council_ask:b', 'council_ask:c', 'council_done:a', 'council_done:b', 'council_fail:c', 'council_judge:a']);
  assert.equal(ev.filter((e) => e.type === 'text').map((e) => e.text).join(''), 'Đáp án: 4', 'only the final answer is streamed');

  ev = [];
  r = await council.run(Object.assign({ chat: chatOf({ a: new Error('down'), b: 'Chỉ còn tôi', c: new Error('down') }) }, base), (e) => ev.push(e));
  assert.deepEqual([r.answer, r.by, r.trace.judge], ['Chỉ còn tôi', { provider: 'b', model: 'mb' }, null], 'a single survivor answers without a synthesis call');

  ev = [];
  r = await council.run(Object.assign({ chat: chatOf({ a: 'A nói', b: 'B nói', c: 'C nói', judge: Object.assign(new Error('x'), { code: 'server' }) }) }, base), (e) => ev.push(e));
  assert.deepEqual([r.answer, r.trace.judge.ok, r.trace.judge.error, ev.some((e) => e.type === 'reset')], ['A nói', false, 'server', true], 'if the chair fails, the first member\'s answer stands');

  // A member that hangs is left out once two others have answered and the grace period is over.
  const hung = chatOf({ a: 'A xong', b: 'B xong', judge: 'Bản cuối' });
  const t0 = Date.now();
  r = await council.run(Object.assign({ graceMs: 40, chat: (req, emit) => (req.provider === 'c' && !/chairing/.test(req.system)
    ? new Promise((_, reject) => req.signal.addEventListener('abort', () => reject(Object.assign(new Error('cut'), { code: 'aborted' }))))
    : hung(req, emit)) }, base));
  assert.deepEqual([r.answer, r.trace.members.map((m) => m.ok ? 'ok' : m.error), Date.now() - t0 < 3000], ['Bản cuối', ['ok', 'ok', 'slow'], true]);

  await assert.rejects(council.run(Object.assign({ chat: chatOf({ a: Object.assign(new Error('x'), { code: 'credit' }), b: new Error('y'), c: new Error('z') }) }, base)), { code: 'credit' });
  await assert.rejects(council.run(Object.assign({}, base, { members: [members[0]], chat: chatOf({}) })), { code: 'council_too_small' });
  const ac = new AbortController(); ac.abort();
  await assert.rejects(council.run(Object.assign({ chat: async () => { throw Object.assign(new Error('stop'), { code: 'aborted' }); }, signal: ac.signal }, base)), { code: 'aborted' });
});

test('studio: the right instruction joins the prompt only when the request needs it', () => {
  const d = (s) => studio.detect(s).join(',');
  assert.equal(d('Thời tiết Đà Nẵng hôm nay thế nào?'), '');
  assert.equal(d('Vẽ mindmap về kế hoạch khai trương khách sạn'), 'mindmap');
  assert.equal(d('Vẽ biểu đồ từ số liệu sau: T1 120, T2 150'), 'chart');
  assert.equal(d('Vẽ hình minh hoạ: quy trình check-in'), 'draw');
  assert.equal(d('Dựng video trình chiếu về lịch sử cà phê'), 'video');
  assert.equal(d('Phân tích tài chính: doanh thu 815 triệu, chi phí 600 triệu'), 'finance');
  assert.equal(d('Lập kế hoạch marketing cho quán cà phê mới'), 'marketing');
  assert.equal(d('Draw a mind map of the launch plan'), 'mindmap');
  assert.equal(d('Draw an illustration of a coffee cup'), 'draw');
  assert.equal(d('Financial analysis: revenue 815, cost 600'), 'finance');
  assert.equal(studio.hints('Chào bạn', {}), '');
  assert.match(studio.hints('Vẽ mindmap về X', {}), /^MIND MAP: .*`mindmap`/);
  assert.match(studio.hints('Phân tích tài chính quý 3', {}), /^FINANCE: [\s\S]*\nCHART: .*`chart`/, 'finance work can always answer with a chart');
  assert.ok(!/`image`/.test(studio.hints('Vẽ hình minh hoạ con mèo', { image: false })) && /`svg`/.test(studio.hints('Vẽ hình minh hoạ con mèo', { image: false })));
  assert.match(studio.hints('Vẽ hình minh hoạ con mèo', { image: true }), /`image`/, 'picture generation is offered only when an account can do it');
  assert.ok(studio.hints('Dựng video về cà phê', {}).length < 500, 'a hint stays small');
});

test('studio window code: outlines, charts and videos are parsed and laid out', () => {
  const tree = Studio.parseOutline('Khai trương\n  Nhân sự\n    Tuyển lễ tân\n    Đào tạo\n  Marketing\n    - Fanpage\n');
  assert.deepEqual([tree.text, tree.children.map((c) => c.text), tree.children[0].children.map((c) => c.text), tree.children[1].children[0].text], ['Khai trương', ['Nhân sự', 'Marketing'], ['Tuyển lễ tân', 'Đào tạo'], 'Fanpage']);
  assert.equal(Studio.parseOutline('# A\n## B\n### C\n## D').children.length, 2, 'markdown headings work as an outline too');
  assert.equal(Studio.parseOutline('- một\n- hai').text, '◎', 'several top-level lines get a hub');
  assert.equal(Studio.parseOutline('   \n'), null);
  const L = Studio.layoutTree(tree);
  const by = Object.fromEntries(L.nodes.map((n) => [n.text, n]));
  assert.equal(L.height, 24 + 3 * 40, 'one row per leaf');
  assert.ok(by['Khai trương'].x < by['Nhân sự'].x && by['Nhân sự'].x < by['Đào tạo'].x, 'deeper levels sit further right');
  assert.equal(by['Nhân sự'].row, 0.5, 'a parent sits midway between its children');
  assert.ok(by['Nhân sự'].x + by['Nhân sự'].w < by['Đào tạo'].x, 'columns do not overlap');
  assert.deepEqual(Studio.wrap('một hai ba bốn năm sáu bảy tám chín mười mười một', 20), ['một hai ba bốn năm', 'sáu bảy tám chín mư…']);

  const c = Studio.parseChart('{"type":"line","title":"Doanh thu","unit":"triệu","labels":["T1","T2","T3"],"series":[{"name":"2026","data":[120,150,"180"]},{"name":"thiếu","data":[1,2]},{"name":"sai","data":[1,"x",3]}]}');
  assert.deepEqual([c.type, c.labels.length, c.series.map((s) => s.name), c.series[0].data], ['line', 3, ['2026'], [120, 150, 180]], 'a series that does not match the labels is dropped, never padded');
  assert.equal(Studio.parseChart('{"labels":["a"],"series":[]}'), null);
  assert.equal(Studio.parseChart('not json'), null);
  assert.equal(Studio.parseChart('{"type":"weird","labels":["a"],"data":[5]}').type, 'bar');
  assert.deepEqual(Studio.niceTicks(0, 815, 5).ticks, [0, 200, 400, 600, 800, 1000]);
  assert.deepEqual(Studio.niceTicks(-120, 340, 5).ticks, [-200, -100, 0, 100, 200, 300, 400]);
  assert.deepEqual(Studio.niceTicks(0, 0.9, 5).ticks, [0, 0.2, 0.4, 0.6, 0.8, 1]);
  assert.deepEqual(Studio.niceTicks(5, 5, 5).ticks.length > 1, true);

  const v = Studio.parseVideo('{"title":"Cà phê","scenes":[{"title":"Mở đầu","text":"Hạt cà phê","emoji":"☕","color":"#7b4a2d","seconds":3},{"title":"","text":""},{"title":"Kết","seconds":99,"color":"red"}]}');
  assert.deepEqual([v.scenes.length, v.total, v.scenes[1].seconds, /^#[0-9a-f]{6}$/i.test(v.scenes[1].color)], [2, 23, 20, true], 'empty scenes go, durations and colours are kept sane');
  assert.equal(Studio.parseVideo('{"scenes":[]}'), null);
  assert.deepEqual([Studio.fit(4000, 3000, 1568), Studio.fit(800, 600, 1568)], [{ w: 1568, h: 1176 }, { w: 800, h: 600 }]);
  assert.equal(Studio.fileName('Kế hoạch Đà Nẵng 2026!'), 'ke-hoach-da-nang-2026');
});

test('picture generation: uses the account that can, remembers the result, reports a refused account as such', async () => {
  await secrets.load();
  let mode = 'ok';
  const g = await listen((req, res, body) => {
    g.calls.push({ url: req.url, key: req.headers['x-goog-api-key'], body });
    if (mode === 'quota') { res.writeHead(429, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { code: 429, message: 'You exceeded your current quota. Quota exceeded for metric: free_tier_requests, limit: 0' } })); }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'đây' }, { inlineData: { mimeType: 'image/png', data: png(7).toString('base64') } }] } }] }));
  });
  g.calls = [];
  await secrets.set('gemini', 'k-gemini');
  await secrets.set('openai', '');
  cfg.saveSettings({ baseUrls: { gemini: g.url + '/openai' }, modelCache: { gemini: ['gemini-4-hydrogen', 'gemini-3-pro-image-preview', 'gemini-3.1-flash-lite-image', 'gemini-2.5-flash-image'] } });
  try {
    assert.deepEqual(imagegen.candidates(cfg.loadSettings()).map((c) => [c.provider, c.model, c.base]), [['gemini', 'gemini-3.1-flash-lite-image', g.url]]);
    const r = await imagegen.generate('a blue coffee cup', cfg.loadSettings());
    assert.deepEqual([r.provider, r.model], ['gemini', 'gemini-3.1-flash-lite-image']);
    assert.ok(media.read(r.id).equals(png(7)));
    assert.deepEqual([g.calls[0].url, g.calls[0].key, g.calls[0].body.contents[0].parts[0].text, g.calls[0].body.generationConfig.responseModalities], ['/models/gemini-3.1-flash-lite-image:generateContent', 'k-gemini', 'a blue coffee cup', ['TEXT', 'IMAGE']]);
    assert.equal(media.findGenerated('a blue coffee cup').id, r.id);
    mode = 'quota';
    await assert.rejects(imagegen.generate('another one', cfg.loadSettings()), { code: 'credit', status: 429 });
    await secrets.set('gemini', '');
    await assert.rejects(imagegen.generate('x', cfg.loadSettings()), { code: 'no_image_ai' });
  } finally { await g.close(); }
});

test('over HTTP: a pasted picture reaches the AI, is kept, and the council, limits and build hints work end to end', async () => {
  const { start } = require('../server');
  await secrets.load();
  const eye = await mockOpenAI((body) => (/chairing a panel/.test(JSON.stringify(body.messages[0])) ? 'Kết luận của hội đồng' : 'Gemini thấy số 4721'));
  const other = await mockOpenAI(() => 'Custom trả lời');
  await secrets.set('gemini', 'k-gemini');
  cfg.saveSettings({ baseUrls: { gemini: eye.url }, custom: { baseUrl: other.url }, models: { gemini: 'gemini-test', custom: 'text-only' }, provider: 'gemini', promptgate: { mode: 'off' }, vision: { bridge: true }, council: { enabled: false, max: 3, judge: 'auto' }, budgets: { gemini: 1 } });
  const app = await start({ port: 0, quiet: true, backups: false });
  const H = { 'x-onechat-token': app.token, 'content-type': 'application/json' };
  const get = (p) => fetch(app.url + p, { headers: H });
  const post = async (body) => {
    const res = await fetch(app.url + 'api/chat', { method: 'POST', headers: H, body: JSON.stringify(Object.assign({ provider: 'gemini', model: 'gemini-test' }, body)) });
    const events = (await res.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l));
    return { events, done: events.find((e) => e.type === 'done'), error: events.find((e) => e.type === 'error'), meta: events.find((e) => e.type === 'meta') };
  };
  try {
    const shot = png(9);
    const a = await post({ text: 'Số nào trong ảnh?', inline: [{ name: 'chup-man-hinh.png', data: shot.toString('base64'), type: 'image/png', w: 640, h: 360 }, { name: 'gia.png', data: Buffer.from('not a picture').toString('base64'), type: 'image/png' }] });
    assert.equal(a.done.message.text, 'Gemini thấy số 4721');
    const pics = a.meta.userMessage.ctx.images;
    assert.deepEqual([pics.length, pics[0].name, pics[0].mime, pics[0].w, pics[0].tokens], [1, 'chup-man-hinh.png', 'image/png', 1, 85]);
    assert.deepEqual(a.meta.userMessage.ctx.fileErrors, [{ name: 'gia.png', code: 'bad_image' }], 'a file that only claims to be a picture is reported, not sent');
    assert.equal(eye.calls[eye.calls.length - 1].body.messages[1].content[1].image_url.url, 'data:image/png;base64,' + shot.toString('base64'));

    const file = await get('api/media/' + pics[0].id);
    assert.deepEqual([file.status, file.headers.get('content-type')], [200, 'image/png']);
    assert.ok(Buffer.from(await file.arrayBuffer()).equals(shot));
    assert.equal((await get('api/media/' + encodeURIComponent('..\\secrets.json'))).status, 400);
    assert.equal((await fetch(app.url + 'api/media/' + pics[0].id)).status, 401, 'pictures need the session token like everything else');

    const b = await post({ convId: a.meta.convId, text: 'Còn gì nữa không?' });
    assert.equal(b.done.message.text, 'Gemini thấy số 4721');
    const turn = eye.calls[eye.calls.length - 1].body.messages;
    assert.equal(turn[1].content[1].type, 'image_url', 'a follow-up question still has the picture');

    const dir = tmp('raw');
    fs.writeFileSync(path.join(dir, 'anh.png'), shot);
    fs.writeFileSync(path.join(dir, 'bi-mat.txt'), 'x');
    const raw = await get('api/fs/raw?path=' + encodeURIComponent(path.join(dir, 'anh.png')));
    assert.ok(raw.status === 200 && Buffer.from(await raw.arrayBuffer()).equals(shot));
    assert.equal((await get('api/fs/raw?path=' + encodeURIComponent(path.join(dir, 'bi-mat.txt')))).status, 415, 'only picture files are served raw');

    const c = await post({ text: 'Thủ đô của Úc là gì?', council: true });
    assert.equal(c.meta.council, true);
    assert.equal(c.done.message.text, 'Kết luận của hội đồng');
    assert.deepEqual([c.done.message.council.members.map((m) => [m.provider, m.ok]), c.done.message.council.judge.provider, c.done.message.provider], [[['gemini', true], ['custom', true]], 'gemini', 'gemini']);
    assert.deepEqual(c.done.message.usage, { in: 180, out: 21, cacheRead: 120 }, 'usage is the sum of both answers and the synthesis');
    assert.equal(c.events.filter((e) => e.type === 'text').map((e) => e.text).join(''), 'Kết luận của hội đồng');

    const m = await post({ text: 'Vẽ mindmap về kế hoạch khai trương' });
    assert.match(eye.calls[eye.calls.length - 1].body.messages[0].content, /MIND MAP: /, 'the build instruction rides in the system prompt');
    assert.ok(m.done);
    await post({ text: 'Xin chào' });
    assert.ok(!/MIND MAP|CHART|DRAWING/.test(eye.calls[eye.calls.length - 1].body.messages[0].content), 'an ordinary question carries no build instructions');

    const usage = await (await get('api/usage')).json();
    assert.deepEqual([usage.quota.gemini.kind, usage.quota.gemini.pct < 100, usage.quota.gemini.lines[0].type], ['budget', false, 'budget']);
    assert.ok(Object.values(usage.month).some((x) => x.n >= 1));
    const state = await (await get('api/state')).json();
    assert.deepEqual([state.visionHelper, state.providers.find((p) => p.id === 'gemini').vision, typeof state.imageAI], ['gemini', true, 'boolean']);
    const look = await (await fetch(app.url + 'api/media/generate', { method: 'POST', headers: H, body: JSON.stringify({ prompt: 'never made before', lookup: true }) })).json();
    assert.equal(look.id, null);

    const bk = store.backup(Date.UTC(2031, 0, 2));
    assert.ok(fs.existsSync(path.join(bk.dest, 'media', pics[0].id)), 'pictures are part of the daily copy');
    assert.equal(fs.statSync(path.join(bk.dest, 'media', pics[0].id)).nlink >= 2, true, 'as a hard link, so each day does not store them again');
  } finally { await app.close(); await eye.close(); await other.close(); }
});

test('launchers open the desktop app, whose taskbar button carries the OneChat icon', () => {
  const cmd = fs.readFileSync(path.join(ROOT, 'OneChat.cmd'), 'utf8');
  assert.ok(cmd.indexOf('electron.exe') > 0 && cmd.indexOf('electron.exe') < cmd.indexOf('server.js --open'), 'the app window comes first; the browser window is the fallback');
  assert.ok(!/\r?\n/.test(cmd.replace(/\r\n/g, '')), 'Windows line endings');
  const vbs = fs.readFileSync(path.join(ROOT, 'OneChat.vbs'), 'utf8');
  assert.ok(vbs.indexOf('electron.exe') > 0 && vbs.indexOf('electron.exe') < vbs.indexOf('run-hidden.cmd'));
  const main = fs.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf8');
  assert.match(main, /setAppDetails\(\{ appId: 'OneChat', appIconPath: ICO/);
  const ico = fs.readFileSync(path.join(ROOT, 'public', 'icon.ico'));
  const sizes = Array.from({ length: ico.readUInt16LE(4) }, (_, i) => ico[6 + 16 * i] || 256);
  for (const s of [16, 24, 32, 48, 256]) assert.ok(sizes.includes(s), 'icon size ' + s);
});
