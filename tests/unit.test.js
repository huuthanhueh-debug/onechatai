'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmp, zip } = require('./helpers');

const cfg = require('../lib/config');
const secrets = require('../lib/secrets');
const tokens = require('../lib/tokens');
const memory = require('../lib/memory');
const router = require('../lib/router');
const files = require('../lib/files');
const pg = require('../lib/promptgate');
const cli = require('../lib/providers/claude-cli');
const anthropic = require('../lib/providers/anthropic');
const MD = require('../public/md.js');
const I18N = require('../public/i18n.js');

// ---- tokens -------------------------------------------------------------------------------
test('tokens: estimate grows with text and weighs accented text higher', () => {
  assert.equal(tokens.estimate(''), 0);
  assert.equal(tokens.estimate('abcdefgh'), 2);
  assert.ok(tokens.estimate('ưởng ượng ửa') > tokens.estimate('uong uong ua'));
});

test('tokens: fitHistory keeps the newest turns, never drops the last, starts with user', () => {
  const msgs = [];
  for (let i = 0; i < 10; i++) msgs.push({ role: i % 2 ? 'assistant' : 'user', content: 'x'.repeat(400) });
  msgs.push({ role: 'user', content: 'y'.repeat(400) });
  const fit = tokens.fitHistory(msgs, 350);
  assert.equal(fit.kept[fit.kept.length - 1].content[0], 'y');
  assert.equal(fit.kept[0].role, 'user');
  assert.equal(fit.kept.length + fit.dropped, msgs.length);
  assert.ok(fit.dropped > 0);
  assert.equal(tokens.fitHistory(msgs, 0).dropped, 0);
  assert.equal(tokens.fitHistory([{ role: 'user', content: 'z'.repeat(9000) }], 10).kept.length, 1);
});

test('tokens: cost uses the price table and is null for unknown models', () => {
  assert.equal(tokens.cost('claude-opus-5-5', { in: 1e6, out: 1e6, cacheRead: 1e6 }), 24.2);
  assert.equal(tokens.cost('mystery-model', { in: 10, out: 10 }), null);
  assert.equal(tokens.cost('mystery-model', { in: 1e6, out: 0 }, { 'mystery-model': [1, 2] }), 1);
});

// ---- config + secrets ---------------------------------------------------------------------
test('config: settings round-trip, unknown keys and bad values are ignored', () => {
  const s = cfg.saveSettings({ lang: 'en', port: 80, evil: 1, promptgate: { below: 60 }, __proto__: { x: 1 } });
  assert.equal(s.lang, 'en');
  assert.equal(s.port, cfg.DEFAULTS.port);
  assert.equal(s.evil, undefined);
  assert.equal(s.promptgate.below, 60);
  assert.equal(s.promptgate.mode, 'suggest');
  assert.equal(cfg.loadSettings().lang, 'en');
  assert.equal(cfg.saveSettings({ lang: 'xx' }).lang, 'en');
  cfg.saveSettings({ lang: 'vi' });
});

test('secrets: plain mode round-trip, masking, removal', async () => {
  secrets.reset();
  await secrets.set('groq', '  xai-abcdefghijklmnop  ');
  assert.equal(secrets.get('groq'), 'xai-abcdefghijklmnop');
  assert.equal(secrets.mask(secrets.get('groq')), 'xai-…mnop');
  secrets.reset();
  await secrets.load();
  assert.equal(secrets.get('groq'), 'xai-abcdefghijklmnop');
  assert.equal(secrets.source('groq'), 'stored');
  await secrets.set('groq', '');
  assert.equal(secrets.get('groq'), '');
});

test('secrets: keys are AES-encrypted at rest with a key kept apart; a damaged file never crashes', async () => {
  const keep = { data: process.env.ONECHAT_DATA, mode: process.env.ONECHAT_SECRETS };
  process.env.ONECHAT_DATA = tmp('aes');
  delete process.env.ONECHAT_SECRETS;
  try {
    secrets.reset();
    await secrets.set('claude', 'sk-ant-test-0123456789');
    const raw = fs.readFileSync(secrets.file(), 'utf8');
    const j = JSON.parse(raw);
    assert.deepEqual([j.v, j.mode], [2, 'aes']);
    assert.ok(!raw.includes('sk-ant-test') && !Buffer.from(j.data, 'base64').toString('utf8').includes('sk-ant-test'));
    assert.equal(fs.readFileSync(secrets.keyFile()).length, 32);
    assert.notEqual(path.resolve(secrets.keyFile()), path.resolve(secrets.file()));
    secrets.reset();
    await secrets.load();
    assert.equal(secrets.get('claude'), 'sk-ant-test-0123456789');
    assert.equal(secrets.getMode(), 'aes');
    await secrets.set('groq', 'xai-second');
    assert.notEqual(JSON.parse(fs.readFileSync(secrets.file(), 'utf8')).iv, j.iv, 'a fresh IV for every save');
    // Tampered data, a lost key file, or an old DPAPI file: start empty, keep the old file, never throw.
    for (const broken of [Object.assign({}, j, { data: Buffer.from('garbage').toString('base64') }), { v: 1, mode: 'dpapi', data: 'AQAAANCMnd8=' }]) {
      fs.writeFileSync(secrets.file(), JSON.stringify(broken));
      secrets.reset();
      await secrets.load();
      assert.equal(secrets.get('claude'), '');
      assert.ok(fs.existsSync(secrets.file() + '.unreadable'));
    }
    await secrets.set('claude', 'sk-ant-again');
    secrets.reset(); await secrets.load();
    assert.equal(secrets.get('claude'), 'sk-ant-again', 'usable again after a damaged file');
  } finally {
    process.env.ONECHAT_DATA = keep.data; process.env.ONECHAT_SECRETS = keep.mode; secrets.reset();
  }
});

test('server process never launches PowerShell (antivirus kills a network listener that does)', () => {
  const root = path.join(__dirname, '..');
  const files = ['server.js'].concat(fs.readdirSync(path.join(root, 'lib')).filter((f) => f.endsWith('.js')).map((f) => 'lib/' + f), fs.readdirSync(path.join(root, 'lib', 'providers')).map((f) => 'lib/providers/' + f));
  for (const f of files) {
    const src = fs.readFileSync(path.join(root, f), 'utf8').split(String.fromCharCode(10)).filter((l) => !l.trim().startsWith('//')).join(String.fromCharCode(10));
    assert.ok(!/powershell|wscript|cscript/i.test(src), f + ' must not reference a script host');
  }
  assert.ok(!fs.readFileSync(path.join(root, 'lib', 'secrets.js'), 'utf8').includes('child_process'));
});

// ---- memory -------------------------------------------------------------------------------
function seedMemory() {
  const dir = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'D--WORK-DEMO', 'memory');
  fs.mkdirSync(dir, { recursive: true });
  const w = (name, desc, type, body) => fs.writeFileSync(path.join(dir, name + '.md'), `---\nname: ${name}\ndescription: "${desc}"\nmetadata:\n  type: ${type}\n---\n\n${body}\n`);
  fs.writeFileSync(path.join(dir, 'MEMORY.md'), '- [Hotel app](hotel-app.md)\n');
  w('hotel-app', 'HRM web app cho khách sạn Sunrise: stack, cách chạy', 'project', 'Chạy bằng npm start ở cổng 3000. Mật khẩu: Sup3rSecret! và api_key=sk-abcdefghijklmnopqrstu để gọi dịch vụ.\npostgres://admin:hunter2@db.example.com/app');
  w('gumroad-store', 'Cửa hàng Gumroad bán template khách sạn', 'project', 'Đăng 10 sản phẩm mỗi ngày. ' + 'Chi tiết quy trình đăng bài. '.repeat(120));
  w('feedback-buttons', 'User thích nút bấm thay vì gõ lại', 'feedback', 'Luôn đưa lựa chọn có sẵn để bấm.');
  w('kaspersky-tls', 'Kaspersky chặn TLS của Node trên máy này', 'project', 'Dùng node --use-system-ca.');
  for (let i = 0; i < 8; i++) w('filler-' + i, 'Ghi chú số ' + i + ' về dự án nội bộ', 'project', 'Nội dung chung về công việc hằng ngày số ' + i);
  return dir;
}

test('memory: frontmatter parser handles quotes and nested metadata', () => {
  const r = memory.parseFrontmatter('---\nname: a-b\ndescription: "He said \\"hi\\": ok"\nmetadata:\n  type: feedback\n  node_type: memory\n---\n\nBody **here**\n');
  assert.equal(r.meta.name, 'a-b');
  assert.equal(r.meta.description, 'He said "hi": ok');
  assert.equal(r.meta['metadata.type'], 'feedback');
  assert.equal(r.body, 'Body **here**');
  assert.equal(memory.parseFrontmatter('no front matter').body, 'no front matter');
});

test('memory: discovers Claude memory folders and never lists MEMORY.md as an entry', () => {
  seedMemory();
  const srcs = memory.sources(cfg.loadSettings());
  assert.ok(srcs.some((s) => s.kind === 'claude' && s.label === 'WORK-DEMO' && s.enabled));
  const items = memory.loadItems(cfg.loadSettings());
  assert.ok(items.find((i) => i.name === 'hotel-app' && i.type === 'project'));
  assert.ok(!items.some((i) => /MEMORY/i.test(i.name)));
});

test('memory: selects entries relevant to the prompt and nothing for small talk', () => {
  const items = memory.loadItems(cfg.loadSettings());
  const hit = memory.select('Kaspersky làm Node báo lỗi TLS, sửa sao?', items, {});
  assert.equal(hit[0].name, 'kaspersky-tls');
  assert.equal(memory.select('xin chào, hôm nay thế nào?', items, {}).length, 0);
  assert.equal(memory.select('tóm tắt giúp đoạn văn này', items, {}).length, 0);
  const noAccent = memory.select('cua hang gumroad ban template', items, {});
  assert.equal(noAccent[0].name, 'gumroad-store');
});

test('memory: pinned entries always attach; disabled sources never do; budget is respected', () => {
  const items = memory.loadItems(cfg.loadSettings());
  const fb = items.find((i) => i.name === 'feedback-buttons');
  const picked = memory.select('xin chào', items, { pinned: [fb.id] });
  assert.deepEqual(picked.map((p) => p.reason), ['pinned']);
  const big = memory.select('gumroad cửa hàng template', items, { budgetTokens: 300 });
  assert.ok(big[0].truncated && big[0].tokens <= 300);
  const off = items.map((i) => Object.assign({}, i, { enabled: false }));
  assert.equal(memory.select('Kaspersky TLS Node', off, {}).length, 0);
});

test('memory: redaction masks passwords, keys and connection strings', () => {
  const r = memory.redact('Mật khẩu: Sup3rSecret! và api_key=sk-abcdefghijklmnopqrstu\npostgres://admin:hunter2@db.example.com/app\ntoken: ghp_abcdefghijklmnopqrstuvwx\nGiá: 19 USD');
  for (const leak of ['Sup3rSecret', 'sk-abcdefghijklmnopqrstu', 'hunter2', 'ghp_abcdefghijklmnopqrstuvwx']) assert.ok(!r.text.includes(leak), leak);
  assert.ok(r.text.includes('Giá: 19 USD') && r.text.includes('db.example.com'));
  assert.ok(r.count >= 4);
  assert.equal(memory.redact('Không có gì nhạy cảm ở đây.').count, 0);
});

test('memory: render wraps entries, reports masking, and honours per-entry limits', () => {
  const items = memory.loadItems(cfg.loadSettings());
  const hotel = items.find((i) => i.name === 'hotel-app');
  const gum = items.find((i) => i.name === 'gumroad-store');
  const out = memory.render([hotel.id, gum.id, 'missing-id'], items, { limits: { [gum.id]: 100 } });
  assert.match(out.text, /^<memory note=/);
  assert.ok(out.text.includes('## hotel-app (project)') && !out.text.includes('Sup3rSecret'));
  assert.ok(out.masked >= 2);
  assert.equal(out.used.length, 2);
  assert.ok(out.used[1].truncated);
  assert.equal(memory.render([], items).text, '');
});

test('memory: notes are saved in the app folder, listed, and deletable', () => {
  const n = memory.saveNote({ title: 'Giờ nhận phòng mới', text: 'Nhận phòng từ 14:00.' });
  assert.ok(n.file.startsWith(memory.notesDir()));
  const again = memory.saveNote({ title: 'Giờ nhận phòng mới', text: 'Bản 2' });
  assert.notEqual(again.file, n.file);
  const items = memory.loadItems(cfg.loadSettings());
  const it = items.find((i) => i.id === n.id);
  assert.equal(it.sourceKind, 'notes');
  assert.equal(it.description, 'Giờ nhận phòng mới');
  assert.throws(() => memory.saveNote({ title: 'x', text: '  ' }), { code: 'empty' });
  assert.equal(memory.deleteNote(n.id), true);
  assert.equal(memory.deleteNote(n.id), false);
});

test('memory: export bundle masks secrets and re-imports without duplicates', () => {
  const settings = cfg.loadSettings();
  const items = memory.loadItems(settings);
  const out = memory.exportBundle(items);
  assert.equal(out.count, items.length);
  assert.match(out.filename, /^onechat-memory-\d{4}-\d{2}-\d{2}\.md$/);
  assert.ok(out.masked >= 2 && !out.text.includes('Sup3rSecret') && !out.text.includes('hunter2'));
  assert.ok(memory.exportBundle(items, { masked: false }).text.includes('Sup3rSecret'), 'raw export is opt-in');
  const parsed = memory.parseBundle('export.md', out.text);
  assert.equal(parsed.length, items.length);
  const hotel = parsed.find((e) => e.name === 'hotel-app');
  assert.deepEqual([hotel.type, hotel.description], ['project', 'HRM web app cho khách sạn Sunrise: stack, cách chạy']);
  // Everything in the bundle already exists on this machine: nothing may be added twice.
  assert.deepEqual(memory.importEntries(parsed, settings), { added: 0, skipped: items.length, names: [] });
  const fresh = memory.importEntries(memory.parseBundle('export.md', out.text + '\n<!-- onechat-memory:entry -->\n---\nname: from-other-pc\ndescription: "Ghi chú từ máy khác"\nmetadata:\n  type: user\n---\n\nTôi thích trả lời ngắn gọn.\n'), settings);
  assert.deepEqual([fresh.added, fresh.skipped, fresh.names], [1, items.length, ['from-other-pc']]);
  const saved = memory.loadItems(settings).find((i) => i.name === 'from-other-pc');
  assert.deepEqual([saved.sourceKind, saved.type, saved.description, saved.body], ['notes', 'user', 'Ghi chú từ máy khác', 'Tôi thích trả lời ngắn gọn.']);
  assert.equal(memory.deleteNote(saved.id), true);
});

test('memory: imports plain notes and JSON, rejects broken JSON', () => {
  assert.deepEqual(memory.parseBundle('Sở thích.txt', 'Chỉ một dòng ghi chú'), [{ name: 'Sở thích', description: '', type: 'note', body: 'Chỉ một dòng ghi chú' }]);
  const j = memory.parseBundle('m.json', JSON.stringify({ memories: ['thích cà phê sữa', { title: 'Giờ làm', content: '8h đến 17h', type: 'user' }, { title: 'rỗng' }] }));
  assert.deepEqual(j.map((e) => [e.name, e.type, e.body]), [['m-1', 'note', 'thích cà phê sữa'], ['Giờ làm', 'user', '8h đến 17h']]);
  assert.throws(() => memory.parseBundle('m.json', '{nope'), { code: 'bad_document' });
  assert.deepEqual(memory.parseBundle('empty.md', '   '), []);
});

// ---- router -------------------------------------------------------------------------------
test('router: classifies Vietnamese and English prompts', () => {
  assert.equal(router.classify('Dịch đoạn này sang tiếng Anh giúp tôi'), 'translate');
  assert.equal(router.classify('Translate this email into Vietnamese'), 'translate');
  assert.equal(router.classify('Tóm tắt báo cáo doanh thu tháng 10'), 'summarize');
  assert.equal(router.classify('App bị lỗi TypeError khi bấm nút lưu'), 'debug');
  assert.equal(router.classify('Why is the sky blue?'), 'question');
  assert.equal(router.classify('lorem ipsum dolor'), 'general');
  assert.equal(router.classify('whatever text', 'write'), 'write');
  assert.equal(router.classify('dịch bài này', 'write'), 'translate');
});

test('router: learns the habit, respects pins, votes and availability', () => {
  const now = Date.now();
  assert.equal(router.recommend('write', { now }), null);
  router.record({ task: 'write', provider: 'deepseek', model: 'deepseek-flash', usage: { in: 100, out: 50 }, cost: 0.001, now });
  assert.equal(router.recommend('write', { now }), null, 'one use is not yet a habit');
  router.record({ task: 'write', provider: 'deepseek', model: 'deepseek-flash', usage: { in: 100, out: 50 }, now });
  router.record({ task: 'write', provider: 'groq', model: 'groq-model', usage: { in: 10, out: 5 }, now });
  const rec = router.recommend('write', { now });
  assert.deepEqual([rec.provider, rec.model, rec.reason, rec.n], ['deepseek', 'deepseek-flash', 'habit', 2]);
  assert.equal(router.recommend('write', { now, available: ['groq'] }), null, 'groq alone has a single use');
  const pin = router.recommend('write', { now, pins: { write: 'gemini|gemini-3.8-flash' } });
  assert.deepEqual([pin.provider, pin.reason], ['gemini', 'pin']);
  assert.equal(router.recommend('write', { now, pins: { write: 'gemini|x' }, available: ['deepseek', 'groq'] }).provider, 'deepseek');
  router.vote({ task: 'write', provider: 'deepseek', model: 'deepseek-flash', value: -1 });
  assert.equal(router.recommend('write', { now }), null, 'a thumbs-down removes the clear majority');
  const sum = router.summary({});
  assert.equal(sum.tasks.find((t) => t.task === 'write').total, 3);
  assert.equal(sum.today.n, 3);
  assert.equal(sum.totals[0].provider, 'deepseek');
});

// ---- files --------------------------------------------------------------------------------
const xmlDoc = '<w:document><w:body><w:p><w:r><w:t>Báo cáo &amp; kế hoạch</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Phòng</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t xml:space="preserve">Giá </w:t></w:r><w:r><w:t>2tr</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>';
const xlsxParts = {
  'xl/workbook.xml': '<workbook><sheets><sheet name="Doanh thu" sheetId="1" r:id="rId1"/></sheets></workbook>',
  'xl/sharedStrings.xml': '<sst><si><t>Tháng</t></si><si><r><t>Doanh </t></r><r><t>thu</t></r></si></sst>',
  'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2"><v>10</v></c><c r="C2" t="inlineStr"><is><t>ghi chú</t></is></c></row></sheetData></worksheet>',
};

test('files: lists folders first and flags binary and sensitive files', () => {
  const dir = tmp('fs');
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'b.txt'), 'hello');
  fs.writeFileSync(path.join(dir, 'a.png'), Buffer.from([1, 2, 3]));
  fs.writeFileSync(path.join(dir, '.env'), 'KEY=1');
  const r = files.list(dir);
  assert.equal(r.items[0].name, 'sub');
  assert.equal(r.items.find((i) => i.name === 'a.png').kind, 'image');
  assert.equal(r.items.find((i) => i.name === '.env').sensitive, true);
  assert.equal(r.parent, path.dirname(dir));
  assert.throws(() => files.list(path.join(dir, 'nope')), { code: 'not_found' });
});

test('files: reads text (BOM, UTF-16), rejects binary, reports truncation', async () => {
  const dir = tmp('fs');
  fs.writeFileSync(path.join(dir, 'vi.txt'), '\uFEFFXin chào\r\nthế giới');
  fs.writeFileSync(path.join(dir, 'u16.txt'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Tiếng Việt', 'utf16le')]));
  fs.writeFileSync(path.join(dir, 'blob.dat'), Buffer.from([65, 0, 66, 0, 0, 1]));
  fs.writeFileSync(path.join(dir, 'long.md'), 'x'.repeat(5000));
  assert.equal((await files.readFile(path.join(dir, 'vi.txt'))).text, 'Xin chào\nthế giới');
  assert.equal((await files.readFile(path.join(dir, 'u16.txt'))).text, 'Tiếng Việt');
  await assert.rejects(files.readFile(path.join(dir, 'blob.dat')), { code: 'binary' });
  await assert.rejects(files.readFile(path.join(dir, 'missing.txt')), { code: 'not_found' });
  const long = await files.readFile(path.join(dir, 'long.md'), 1000);
  assert.ok(long.truncated && long.chars === 5000 && long.text.length < 1010);
});

test('files: extracts text from .docx, .xlsx and .pptx', async () => {
  const docx = await files.extract('a.docx', zip({ 'word/document.xml': xmlDoc }));
  assert.equal(docx.text, 'Báo cáo & kế hoạch\nPhòng | Giá 2tr');
  const xlsx = await files.extract('a.xlsx', zip(xlsxParts));
  assert.equal(xlsx.text, '--- Sheet: Doanh thu ---\nTháng\tDoanh thu\n10\t\tghi chú');
  const pptx = await files.extract('a.pptx', zip({ 'ppt/slides/slide2.xml': '<a:p><a:r><a:t>Hai</a:t></a:r></a:p>', 'ppt/slides/slide1.xml': '<a:p><a:r><a:t>Một</a:t></a:r></a:p><a:p><a:r><a:t>dòng 2</a:t></a:r></a:p>' }));
  assert.equal(pptx.text, '--- Slide 1 ---\nMột\ndòng 2\n\n--- Slide 2 ---\nHai');
  await assert.rejects(files.extract('bad.docx', Buffer.from('not a zip at all, definitely')), { code: 'bad_document' });
  await assert.rejects(files.extract('photo.jpg', Buffer.from([1, 2])), { code: 'binary' });
});

test('files: reads a real PDF when pdf-parse is installed', async (t) => {
  try { require('pdf-parse'); } catch (_) { return t.skip('pdf-parse not installed'); }
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>'];
  const stream = 'BT /F1 18 Tf 20 100 Td (Hello OneChat PDF) Tj ET';
  objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let pdf = '%PDF-1.4\n';
  const offs = [];
  objs.forEach((o, i) => { offs.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('') + `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  const r = await files.extract('a.pdf', Buffer.from(pdf, 'latin1'));
  assert.match(r.text, /Hello OneChat PDF/);
});

test('files: collect enforces per-file and total limits and reports every problem', async () => {
  const dir = tmp('fs');
  fs.writeFileSync(path.join(dir, 'one.txt'), 'a'.repeat(300));
  fs.writeFileSync(path.join(dir, 'two.txt'), 'b'.repeat(300));
  fs.writeFileSync(path.join(dir, 'three.txt'), 'c'.repeat(300));
  fs.mkdirSync(path.join(dir, 'proj', 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'proj', 'src', 'main.js'), '1');
  const got = await files.collect({ paths: [path.join(dir, 'one.txt'), path.join(dir, 'two.txt'), path.join(dir, 'three.txt'), path.join(dir, 'gone.txt')], inline: [{ name: '../evil.txt', data: Buffer.from('inline!').toString('base64') }], perFileChars: 200, totalChars: 350 });
  assert.deepEqual(got.files.map((f) => f.name), ['one.txt', 'two.txt']);
  assert.ok(got.files.every((f) => f.truncated));
  assert.deepEqual(got.errors.map((e) => e.code).sort(), ['not_found', 'over_budget', 'over_budget']);
  const ok = await files.collect({ paths: [path.join(dir, 'proj')], inline: [{ name: '../evil.txt', data: Buffer.from('inline!').toString('base64') }] });
  assert.equal(ok.files[0].kind, 'tree');
  assert.match(ok.files[0].text, /src\/\n {2}main\.js/);
  assert.equal(ok.files[1].name, 'evil.txt');
  const text = files.render(ok.files);
  assert.match(text, /<folder path="[^"]+proj">/);
  assert.match(text, /<file name="evil\.txt">\ninline!\n<\/file>/);
});

test('files: search is accent-insensitive and bounded to the given folders', () => {
  const dir = tmp('fs');
  fs.mkdirSync(path.join(dir, 'Báo cáo'));
  fs.writeFileSync(path.join(dir, 'Báo cáo', 'Kế hoạch 2026.docx'), 'x');
  fs.mkdirSync(path.join(dir, 'node_modules'));
  fs.writeFileSync(path.join(dir, 'node_modules', 'ke hoach.js'), 'x');
  const r = files.search([dir], 'ke hoach');
  assert.deepEqual(r.map((x) => x.name), ['Kế hoạch 2026.docx']);
  assert.deepEqual(files.search([dir], ''), []);
  assert.deepEqual(files.search([], 'ke'), []);
});

// ---- promptgate ---------------------------------------------------------------------------
test('promptgate: engine loads and scores weak and strong prompts apart', () => {
  assert.equal(pg.available(), true);
  const weak = pg.score('làm ơn sửa giúp mình cái này với nhé');
  const strong = pg.score('Sửa lỗi TypeError ở `src/app.js` dòng 42: chỉ đổi hàm loadUser, giữ nguyên API. Đầu ra: diff ngắn gọn. Hoàn thành khi test pass.');
  assert.ok(weak.score < 50, 'weak=' + weak.score);
  assert.ok(strong.score > 70, 'strong=' + strong.score);
  assert.ok(weak.missing.length > 0 && weak.typeLabel && weak.tip);
  assert.equal(weak.lang, 'vi');
  assert.equal(pg.skip('ok'), true);
  assert.equal(pg.skip('// gửi thẳng câu này đi nhé bạn'), true);
  assert.equal(pg.skip('viết giúp tôi một email xin nghỉ phép'), false);
});

test('promptgate: rule-based A/B/C never contain placeholders and A drops filler', () => {
  const text = 'làm ơn viết giúp mình cái email xin nghỉ phép nhé';
  const v = pg.variantsByRules(text, pg.score(text));
  assert.ok(v.options.length >= 2);
  assert.equal(v.via, 'rules');
  for (const o of v.options) { assert.ok(!o.text.includes('⟨'), o.text); assert.ok(o.text.trim().length > 0); assert.match(o.label, /^[ABC] · /); }
  const a = v.options.find((o) => o.key === 'A');
  assert.ok(a.text.length < text.length && !/làm ơn/i.test(a.text));
  assert.ok(v.options.some((o) => o.key === v.recommended));
  assert.ok(new Set(v.options.map((o) => o.text)).size === v.options.length);
});

test('promptgate: LLM prompt and parser round-trip', () => {
  const s = pg.score('write an email about the late delivery');
  const p = pg.llmPrompt('write an email about the late delivery', s, 'Customer: ACME');
  assert.match(p.system, /<<<A>>>/);
  assert.match(p.system, /Customer: ACME/);
  assert.equal(s.lang, 'en');
  const parsed = pg.parseVariants('<<<A>>>\nShort one\n<<<B>>>\n(version B)\nGoal: write…\n<<<C>>>\nDeep one', s);
  assert.deepEqual(parsed.options.map((o) => [o.key, o.text]), [['A', 'Short one'], ['B', 'Goal: write…'], ['C', 'Deep one']]);
  assert.equal(parsed.options[0].label, 'A · Lean');
  assert.equal(pg.parseVariants('sorry, I cannot', s), null);
  assert.equal(pg.parseVariants('<<<A>>>\nfill ⟨this⟩\n<<<B>>>\nok', s), null);
});

// ---- markdown renderer (XSS safety) -------------------------------------------------------
test('markdown: escapes HTML and only links http(s)', () => {
  const html = MD.render('<script>alert(1)</script> <img src=x onerror=alert(1)>\n\n[ok](https://example.com/a?b=1&c=2) [bad](javascript:alert(1)) [x](data:text/html,1)\n\n`<b>code</b>`');
  // No tag may come from the input: every "<" in it must arrive escaped.
  assert.ok(!/<script|<img|href="javascript|href="data/i.test(html), html);
  assert.deepEqual([...new Set(html.match(/<\/?[a-z]+/g))].sort(), ['</a', '</code', '</p', '<a', '<code', '<p']);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /<a href="https:\/\/example\.com\/a\?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">ok<\/a>/);
  assert.match(html, /<code>&lt;b&gt;code&lt;\/b&gt;<\/code>/);
  assert.ok(!MD.render('[t](https://a.b/"onmouseover="x)').includes('"onmouseover="'));
});

test('markdown: renders code blocks, lists, tables, headings', () => {
  const html = MD.render('# Tiêu đề\n\n1. một\n2. hai\n   - con\n\n```js\nconst a = "<x>";\n```\n\n| A | B |\n|---|---|\n| 1 | **2** |\n\n> trích\n\nvăn **đậm** và *nghiêng*');
  assert.match(html, /<h2>Tiêu đề<\/h2>/);
  assert.match(html, /<ol><li>một<\/li><li>hai<ul><li>con<\/li><\/ul><\/li><\/ol>/);
  assert.match(html, /<pre><code>const a = &quot;&lt;x&gt;&quot;;<\/code><\/pre>/);
  assert.match(html, /<th>A<\/th><th>B<\/th>/);
  assert.match(html, /<td>1<\/td><td><strong>2<\/strong><\/td>/);
  assert.match(html, /<blockquote>trích<\/blockquote>/);
  assert.match(html, /<strong>đậm<\/strong> và <em>nghiêng<\/em>/);
  assert.match(MD.render('```\nunclosed while streaming'), /<pre><code>unclosed while streaming<\/code><\/pre>/);
  assert.ok(!MD.render('a \u00011\u0001 b').includes('undefined'));
});

// ---- i18n completeness --------------------------------------------------------------------
test('i18n: Vietnamese and English hold exactly the same keys, none empty', () => {
  assert.deepEqual(Object.keys(I18N.vi).sort(), Object.keys(I18N.en).sort());
  for (const lang of ['vi', 'en']) for (const [k, v] of Object.entries(I18N[lang])) assert.ok(typeof v === 'string' && v.trim(), lang + '.' + k);
  for (const k of Object.keys(I18N.vi)) {
    const ph = (s) => (s.match(/\{\w+\}/g) || []).sort().join();
    assert.equal(ph(I18N.vi[k]), ph(I18N.en[k]), 'placeholders differ in ' + k);
  }
});

test('i18n: every key the page and the script use is defined', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8') + '\n' + fs.readFileSync(path.join(__dirname, '..', 'public', 'studio.js'), 'utf8');
  const used = new Set();
  for (const m of html.matchAll(/data-i18n(?:-ph|-title)?="([\w]+)"/g)) used.add(m[1]);
  for (const m of js.matchAll(/\bt\('([\w]+)'/g)) used.add(m[1]);
  const prefixes = new Set();
  for (const m of js.matchAll(/\bt\('([a-z]+_)' \+/g)) prefixes.add(m[1]);
  assert.ok(used.size > 150, 'found ' + used.size + ' keys');
  for (const k of used) if (!prefixes.has(k)) assert.ok(k in I18N.vi, 'missing key: ' + k);
  const dynamic = {
    st_: ['ready', 'needs_key', 'needs_url', 'missing_cli', 'needs_model'],
    hint_: ['needs_key', 'needs_url', 'missing_cli', 'needs_model', 'copilot'],
    task_: router.TASKS,
    ferr_: ['not_found', 'no_access', 'read_failed', 'binary', 'too_large', 'bad_document', 'pdf_unsupported', 'over_budget', 'bad_image'],
    notice_: ['max_tokens', 'filtered', 'empty', 'refusal', 'fallback', 'switched', 'switched_busy', 'operator_auto', 'vision_bridge', 'no_vision', 'council_small'],
    step_: ['draft', 'review', 'revise', 'council_ask', 'council_done', 'council_fail', 'council_judge', 'op_think'],
    tool_: ['browser_search', 'browser_open', 'browser_read', 'browser_click', 'browser_type', 'browser_back', 'browser_screenshot', 'file_write', 'file_read', 'file_list', 'ask_user', 'wait_for_user', 'computer_open', 'run_command', 'invalid'],
    q_: ['plan_five_hour', 'plan_seven_day', 'rate_requests', 'rate_tokens', 'balance', 'budget', 'spent', 'unknown'],
    studio_: ['mindmap', 'chart', 'draw', 'video', 'finance', 'marketing', 'mindmap_start', 'chart_start', 'draw_start', 'video_start', 'finance_start', 'marketing_start'],
    root_: ['home', 'desktop', 'documents', 'downloads'],
    err_: ['error', 'auth', 'credit', 'rate', 'not_found', 'bad_request', 'server', 'network', 'tls', 'refused', 'no_key', 'no_base_url', 'no_model', 'cli_missing', 'cli_error', 'interrupted', 'aborted', 'unknown_provider', 'http', 'no_stt', 'empty', 'no_conversation', 'nothing_to_regenerate', 'bad_token', 'too_large', 'empty_summary', 'server_down', 'timeout', 'no_image_ai', 'slow'],
  };
  for (const [p, list] of Object.entries(dynamic)) for (const s of list) assert.ok((p + s) in I18N.vi, 'missing key: ' + p + s);
});

// ---- Claude adapters (no network) ---------------------------------------------------------
test('claude-cli: parses stream-json events and maps the result to usage', () => {
  const out = [];
  const st = { gotDelta: false, result: null, model: '' };
  const emit = (e) => out.push(e);
  cli.handleEvent({ type: 'system', subtype: 'init', model: 'claude-haiku-5-5' }, st, emit);
  cli.handleEvent({ type: 'system', subtype: 'api_retry', attempt: 1 }, st, emit);
  cli.handleEvent({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hmm' } } }, st, emit);
  cli.handleEvent({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'po' } } }, st, emit);
  cli.handleEvent({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ng' } } }, st, emit);
  cli.handleEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'pong' }] } }, st, emit);
  cli.handleEvent({ type: 'result', is_error: false, total_cost_usd: 0.0002, usage: { input_tokens: 2, cache_creation_input_tokens: 900, cache_read_input_tokens: 50, output_tokens: 4 } }, st, emit);
  assert.deepEqual(out.filter((e) => e.type === 'text').map((e) => e.text).join(''), 'pong');
  assert.equal(out.filter((e) => e.type === 'thinking').length, 1);
  const r = cli.finish(st, 0, '');
  assert.deepEqual(r.usage, { in: 902, out: 4, cacheRead: 50 });
  assert.equal(r.model, 'claude-haiku-5-5');
  assert.equal(r.notionalCost, true);
});

test('claude-cli: falls back to whole messages, and reports login and crash errors', () => {
  const out = [];
  const st = { gotDelta: false, result: null, model: '' };
  cli.handleEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'whole' }] } }, st, (e) => out.push(e));
  assert.equal(out[0].text, 'whole');
  assert.throws(() => cli.finish({ result: { is_error: true, result: 'Invalid API key · Please run /login' } }, 1, ''), { code: 'auth' });
  assert.throws(() => cli.finish({ result: null }, 1, 'boom: segfault'), { code: 'cli_error' });
  assert.equal(cli.flatten([{ role: 'user', content: 'one' }]), 'one');
  const flat = cli.flatten([{ role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' }, { role: 'user', content: 'q2' }]);
  assert.match(flat, /<conversation_so_far>\n\[user\]\nq1\n\n\[assistant\]\na1\n<\/conversation_so_far>[\s\S]*q2$/);
});

test('anthropic: request parameters follow the model generation', () => {
  const modern = anthropic.buildParams({ model: 'claude-opus-5-5', messages: [], system: 'S', effort: 'low', maxTokens: 0 });
  assert.deepEqual(modern.thinking, { type: 'adaptive', display: 'summarized' });
  assert.deepEqual(modern.output_config, { effort: 'low' });
  assert.equal(modern.max_tokens, 64000);
  assert.deepEqual(modern.cache_control, { type: 'ephemeral' });
  assert.equal(modern.system, 'S');
  assert.ok(!('temperature' in modern) && !('budget_tokens' in (modern.thinking || {})));
  const old = anthropic.buildParams({ model: 'claude-haiku-4-5', messages: [], effort: 'high', maxTokens: 500 });
  assert.equal(old.thinking, undefined);
  assert.equal(old.output_config, undefined);
  assert.equal(old.max_tokens, 500);
  assert.equal(anthropic.buildParams({ model: 'claude-haiku-5-5', messages: [], effort: 'auto' }).output_config, undefined);
  assert.ok(anthropic.FALLBACK_OK.test('claude-fable-5-2') && anthropic.FALLBACK_OK.test('claude-sonnet-5-5') && !anthropic.FALLBACK_OK.test('claude-haiku-5-5'));
});
