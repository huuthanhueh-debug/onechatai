'use strict';
// Shared test helpers: isolated data folder, a tiny zip writer for office fixtures,
// and mock provider servers. Requiring this file points the app at a fresh temp folder.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), 'onechat-' + (name || 't') + '-'));

process.env.ONECHAT_DATA = tmp('data');
process.env.ONECHAT_SECRETS = 'plain';
if (process.env.ONECHAT_LIVE !== '1') process.env.ONECHAT_NO_CLI = '1'; // tests never spawn the real Claude Code unless asked
process.env.CLAUDE_CONFIG_DIR = tmp('claude');
for (const k of ['ANTHROPIC_API_KEY', 'XAI_API_KEY', 'GROQ_API_KEY', 'DEEPSEEK_API_KEY', 'GEMINI_API_KEY', 'OPENAI_API_KEY', 'ANYTHINGLLM_API_KEY']) delete process.env[k];

function crc32(buf) {
  let c, crc = ~0;
  for (let i = 0; i < buf.length; i++) { c = (crc ^ buf[i]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; crc = (crc >>> 8) ^ c; }
  return ~crc >>> 0;
}

// Minimal zip writer (deflate), enough to build .docx/.xlsx/.pptx fixtures.
function zip(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const data = Buffer.from(content);
    const comp = zlib.deflateRawSync(data);
    const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(data), 14); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc32(data), 16); central.writeUInt32LE(comp.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBuf.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, comp);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  const n = Object.keys(entries).length;
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(n, 8); end.writeUInt16LE(n, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => { const raw = Buffer.concat(chunks); let json = null; try { json = JSON.parse(raw.toString('utf8')); } catch (_) {} handler(req, res, json, raw); });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, url: 'http://127.0.0.1:' + server.address().port, close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }) }));
  });
}

const sse = (res, events) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const e of events) res.write(typeof e === 'string' ? e : 'data: ' + JSON.stringify(e) + '\n\n');
  res.end();
};

// OpenAI-compatible mock. `reply(body, req)` may return a string (the answer) or an object
// { status, error } / { events }. Every request body is recorded in `calls`.
async function mockOpenAI(reply) {
  const calls = [];
  const m = await listen((req, res, body) => {
    calls.push({ url: req.url, method: req.method, headers: req.headers, body });
    if (req.url.endsWith('/models')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ object: 'list', data: [{ id: 'models/mock-a' }, { id: 'mock-b' }] })); }
    const r = reply ? reply(body, req, calls.length) : 'ok';
    if (r && r.status) { res.writeHead(r.status, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: r.error || 'nope' } })); }
    if (r && r.events) return sse(res, r.events.concat(['data: [DONE]\n\n']));
    if (r && r.json) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(r.json)); }
    const text = String(r);
    const half = Math.ceil(text.length / 2);
    return sse(res, [
      { choices: [{ delta: { role: 'assistant', content: text.slice(0, half) } }] },
      { choices: [{ delta: { content: text.slice(half) }, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 100, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 40 } } },
      'data: [DONE]\n\n',
    ]);
  });
  return Object.assign(m, { calls });
}

// Anthropic Messages API mock (streaming). `reply(body, req)` returns text, or { status }.
async function mockAnthropic(reply) {
  const calls = [];
  const m = await listen((req, res, body) => {
    calls.push({ url: req.url, headers: req.headers, body });
    if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ data: [{ id: 'claude-opus-5-5', type: 'model' }, { id: 'claude-haiku-5-5', type: 'model' }], has_more: false, first_id: 'claude-opus-5-5', last_id: 'claude-haiku-5-5' })); }
    const r = reply ? reply(body, req, calls.length) : 'hello';
    if (r && r.status) { res.writeHead(r.status, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ type: 'error', error: { type: r.type || 'invalid_request_error', message: r.error || 'bad' } })); }
    const ev = (type, data) => 'event: ' + type + '\ndata: ' + JSON.stringify(Object.assign({ type }, data)) + '\n\n';
    return sse(res, [
      ev('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 1, cache_read_input_tokens: 30, cache_creation_input_tokens: 5 } } }),
      ev('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }),
      ev('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'weighing it' } }),
      ev('content_block_stop', { index: 0 }),
      ev('content_block_start', { index: 1, content_block: { type: 'text', text: '' } }),
      ev('content_block_delta', { index: 1, delta: { type: 'text_delta', text: String(r) } }),
      ev('content_block_stop', { index: 1 }),
      ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 9 } }),
      ev('message_stop', {}),
    ]);
  });
  return Object.assign(m, { calls });
}

module.exports = { tmp, zip, listen, sse, mockOpenAI, mockAnthropic };
