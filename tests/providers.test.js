'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mockOpenAI, mockAnthropic, listen } = require('./helpers');

const cfg = require('../lib/config');
const secrets = require('../lib/secrets');
const oai = require('../lib/providers/openai-compat');
const anthropic = require('../lib/providers/anthropic');
const cli = require('../lib/providers/claude-cli');
const providers = require('../lib/providers');
const stt = require('../lib/stt');

const collect = () => { const ev = []; return { ev, emit: (e) => ev.push(e), text: () => ev.filter((e) => e.type === 'text').map((e) => e.text).join('') }; };
const msgs = [{ role: 'user', content: 'hi' }];

// ---- OpenAI-compatible adapter ------------------------------------------------------------
test('openai-compat: streams text and reasoning, normalizes usage, sends auth and system', async () => {
  const m = await mockOpenAI(() => ({ events: [
    { choices: [{ delta: { reasoning_content: 'thinking…' } }] },
    { choices: [{ delta: { content: 'Xin ' } }] },
    { choices: [{ delta: { content: 'chào' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 5, prompt_cache_hit_tokens: 30 } },
  ] }));
  const c = collect();
  const r = await oai.chat({ baseUrl: m.url + '/v1/', apiKey: 'k-123', model: 'mock', system: 'SYS', messages: msgs, maxTokens: 50, tokenParam: 'max_completion_tokens' }, c.emit);
  assert.equal(c.text(), 'Xin chào');
  assert.equal(c.ev[0].type, 'thinking');
  assert.deepEqual(r.usage, { in: 70, out: 5, cacheRead: 30 });
  const call = m.calls[0];
  assert.equal(call.url, '/v1/chat/completions');
  assert.equal(call.headers.authorization, 'Bearer k-123');
  assert.deepEqual(call.body.messages[0], { role: 'system', content: 'SYS' });
  assert.equal(call.body.max_completion_tokens, 50);
  assert.equal(call.body.stream, true);
  assert.ok(!('max_tokens' in call.body) && !('temperature' in call.body));
  await m.close();
});

test('openai-compat: maps HTTP failures to stable error codes', async () => {
  const cases = [[401, 'auth'], [402, 'credit'], [404, 'not_found'], [429, 'rate'], [500, 'server']];
  for (const [status, code] of cases) {
    const m = await mockOpenAI(() => ({ status, error: 'provider says no' }));
    await assert.rejects(oai.chat({ baseUrl: m.url, apiKey: 'k', model: 'x', messages: msgs }, () => {}), (e) => e.code === code && e.status === status && /provider says no/.test(e.message));
    await m.close();
  }
});

test('openai-compat: retries once without stream_options when a server rejects it', async () => {
  const m = await mockOpenAI((body) => (body.stream_options ? { status: 400, error: 'unknown field stream_options' } : 'fine'));
  const c = collect();
  await oai.chat({ baseUrl: m.url, model: 'x', messages: msgs }, c.emit);
  assert.equal(c.text(), 'fine');
  assert.equal(m.calls.length, 2);
  assert.ok(!('stream_options' in m.calls[1].body));
  assert.ok(!('authorization' in m.calls[1].headers), 'no key means no Authorization header');
  await m.close();
  const key = await mockOpenAI(() => ({ status: 400, error: 'Incorrect API key provided. You can obtain an API key from https://console.x.ai.' }));
  await assert.rejects(oai.chat({ baseUrl: key.url, apiKey: 'wrong', model: 'x', messages: msgs }, () => {}), (e) => e.code === 'auth' && e.status === 400, 'a wrong key reported as 400 is still an auth error');
  await key.close();
  const bad = await mockOpenAI(() => ({ status: 400, error: 'model does not exist' }));
  await assert.rejects(oai.chat({ baseUrl: bad.url, model: 'x', messages: msgs }, () => {}), (e) => e.code === 'bad_request' && /model does not exist/.test(e.message));
  await bad.close();
});

test('openai-compat: handles plain JSON replies, truncation notices and stream errors', async () => {
  const j = await mockOpenAI(() => ({ json: { choices: [{ message: { content: 'whole reply' }, finish_reason: 'length' }], usage: { prompt_tokens: 3, completion_tokens: 2 } } }));
  const c = collect();
  const r = await oai.chat({ baseUrl: j.url, model: 'x', messages: msgs }, c.emit);
  assert.equal(c.text(), 'whole reply');
  assert.deepEqual(c.ev.filter((e) => e.type === 'notice').map((e) => e.code), ['max_tokens']);
  assert.deepEqual(r.usage, { in: 3, out: 2, cacheRead: 0 });
  await j.close();
  const e = await mockOpenAI(() => ({ events: [{ choices: [{ delta: { content: 'par' } }] }, { error: { message: 'upstream exploded' } }] }));
  await assert.rejects(oai.chat({ baseUrl: e.url, model: 'x', messages: msgs }, () => {}), (x) => x.code === 'server' && /exploded/.test(x.message));
  await e.close();
});

test('openai-compat: abort stops the stream; a dead port reports "refused"', async () => {
  const slow = await listen((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'first' } }] }) + '\n\n');
  });
  const ac = new AbortController();
  const c = collect();
  const p = oai.chat({ baseUrl: slow.url, model: 'x', messages: msgs, signal: ac.signal }, (e) => { c.emit(e); ac.abort(); });
  await assert.rejects(p, { code: 'aborted' });
  assert.equal(c.text(), 'first');
  await slow.close();
  await assert.rejects(oai.chat({ baseUrl: slow.url, model: 'x', messages: msgs }, () => {}), { code: 'refused' });
  await assert.rejects(oai.chat({ baseUrl: '', model: 'x', messages: msgs }, () => {}), { code: 'no_base_url' });
});

test('openai-compat: model listing strips the "models/" prefix', async () => {
  const m = await mockOpenAI();
  assert.deepEqual(await oai.listModels({ baseUrl: m.url, apiKey: 'k' }), ['mock-a', 'mock-b']);
  await m.close();
});

// ---- Anthropic SDK adapter ----------------------------------------------------------------
test('anthropic: streams through the SDK with caching, adaptive thinking and usage', async () => {
  const m = await mockAnthropic(() => 'Chào bạn');
  const c = collect();
  const r = await anthropic.chat({ apiKey: 'sk-ant-x', baseUrl: m.url, model: 'claude-haiku-5-5', system: 'SYS', messages: msgs, effort: 'low' }, c.emit);
  assert.equal(c.text(), 'Chào bạn');
  assert.equal(c.ev.find((e) => e.type === 'thinking').text, 'weighing it');
  assert.deepEqual(r.usage, { in: 17, out: 9, cacheRead: 30 });
  const call = m.calls[0];
  assert.match(String(call.headers.authorization || call.headers['x-api-key']), /sk-ant-x$/); // the SDK picks the header
  assert.equal(call.url, '/v1/messages');
  assert.equal(call.body.stream, true);
  assert.deepEqual(call.body.cache_control, { type: 'ephemeral' });
  assert.deepEqual(call.body.thinking, { type: 'adaptive', display: 'summarized' });
  assert.deepEqual(call.body.output_config, { effort: 'low' });
  assert.equal(call.body.fallbacks, undefined, 'Haiku has no server-side fallback');
  await m.close();
});

test('anthropic: opts into refusal fallback where supported, and survives its rejection', async () => {
  const ok = await mockAnthropic(() => 'with fallback');
  const c1 = collect();
  await anthropic.chat({ apiKey: 'k', baseUrl: ok.url, model: 'claude-opus-5-5', messages: msgs }, c1.emit);
  assert.equal(ok.calls[0].body.fallbacks, 'default');
  assert.match(String(ok.calls[0].headers['anthropic-beta']), /server-side-fallback-2026-07-01/);
  await ok.close();

  const picky = await mockAnthropic((body) => (body.fallbacks ? { status: 400, error: 'fallbacks: unknown field' } : 'plain retry'));
  const c2 = collect();
  await anthropic.chat({ apiKey: 'k', baseUrl: picky.url, model: 'claude-opus-5-5', messages: msgs }, c2.emit);
  assert.equal(c2.text(), 'plain retry');
  assert.equal(picky.calls.length, 2);
  assert.equal(picky.calls[1].body.fallbacks, undefined);
  await picky.close();

  const off = await mockAnthropic(() => 'off');
  await anthropic.chat({ apiKey: 'k', baseUrl: off.url, model: 'claude-opus-5-5', messages: msgs, fallbacks: false }, () => {});
  assert.equal(off.calls[0].body.fallbacks, undefined);
  await off.close();
});

test('anthropic: typed SDK errors become stable codes; models can be listed', async () => {
  const bad = await mockAnthropic(() => ({ status: 401, type: 'authentication_error', error: 'invalid x-api-key' }));
  await assert.rejects(anthropic.chat({ apiKey: 'k', baseUrl: bad.url, model: 'claude-haiku-5-5', messages: msgs }, () => {}), (e) => e.code === 'auth' && e.status === 401);
  await bad.close();
  const nf = await mockAnthropic(() => ({ status: 404, type: 'not_found_error', error: 'model: nope' }));
  await assert.rejects(anthropic.chat({ apiKey: 'k', baseUrl: nf.url, model: 'claude-haiku-5-5', messages: msgs }, () => {}), { code: 'not_found' });
  await nf.close();
  const m = await mockAnthropic();
  assert.deepEqual(await anthropic.listModels({ apiKey: 'k', baseUrl: m.url }), ['claude-opus-5-5', 'claude-haiku-5-5']);
  await m.close();
});

// ---- registry -----------------------------------------------------------------------------
test('registry: describes every provider, never leaking a key', async () => {
  secrets.reset();
  await secrets.set('deepseek', 'sk-deepseek-SECRET-1234');
  const list = providers.describe(cfg.loadSettings());
  const ids = list.map((p) => p.id);
  for (const id of ['claude-cli', 'claude', 'deepseek', 'gemini', 'anythingllm', 'groq', 'openai', 'ollama', 'custom']) assert.ok(ids.includes(id), id);
  const by = Object.fromEntries(list.map((p) => [p.id, p]));
  assert.equal(by.deepseek.status, 'ready');
  assert.equal(by.deepseek.keyMask, 'sk-d…1234');
  assert.ok(!JSON.stringify(list).includes('SECRET'));
  assert.equal(by.gemini.status, 'needs_key');
  assert.ok(!ids.includes('grok') && !ids.includes('copilot'), 'Grok and Copilot were removed at the owner request');
  assert.ok(!list.some((p) => p.status === 'web'), 'no provider sends the user to another window by default');
  assert.equal(by.claude.status, 'needs_key');
  assert.equal(by.custom.status, 'needs_url');
  assert.equal(by.ollama.status, 'needs_model');
  assert.deepEqual(['claude-cli', 'deepseek', 'gemini', 'anythingllm'].filter((id) => by[id].main).length, 4);
  assert.equal(by.claude.model, 'claude-opus-5-5');
});

test('registry: resolve explains what is missing; helper prefers a cheap ready model', async () => {
  const s = cfg.loadSettings();
  assert.throws(() => providers.resolve('gemini', s), { code: 'no_key' });
  assert.throws(() => providers.resolve('custom', Object.assign({}, s, { custom: { baseUrl: '' } })), { code: 'no_base_url' });
  assert.throws(() => providers.resolve('grok', s), { code: 'unknown_provider' });
  assert.throws(() => providers.resolve('copilot', s), { code: 'unknown_provider' });
  assert.throws(() => providers.resolve('nope', s), { code: 'unknown_provider' });
  await assert.rejects(providers.chat({ provider: 'ollama', model: '', messages: msgs, settings: s }, () => {}), { code: 'no_model' });
  assert.deepEqual(providers.helper(s), { provider: 'deepseek', model: 'deepseek-flash' });
  await secrets.set('groq', 'gsk_x');
  assert.equal(providers.helper(s).provider, 'groq');
  assert.deepEqual(providers.helper(Object.assign({}, s, { helper: { provider: 'deepseek', model: 'deepseek-v4-pro' } })), { provider: 'deepseek', model: 'deepseek-v4-pro' });
});

test('registry: chat and complete route through a custom base URL', async () => {
  const m = await mockOpenAI(() => 'routed reply');
  const s = cfg.saveSettings({ custom: { baseUrl: m.url }, models: { custom: 'my-model' }, output: { maxTokens: 321 } });
  assert.equal(providers.describe(s).find((p) => p.id === 'custom').status, 'ready');
  const r = await providers.complete({ provider: 'custom', model: 'my-model', system: 'S', user: 'U', settings: s });
  assert.equal(r.text, 'routed reply');
  assert.equal(m.calls[0].body.model, 'my-model');
  assert.equal(m.calls[0].body.max_tokens, 321);
  assert.deepEqual(await providers.listModels('custom', s), ['mock-a', 'mock-b']);
  cfg.saveSettings({ output: { maxTokens: 0 } });
  await m.close();
});

test('registry: picks a usable chat model when the built-in default is not on the live list', () => {
  const live = ['text-embedding-9', 'gemini-9-flash-preview', 'gemini-9-flash-image', 'gemini-9-pro', 'gemini-9-flash-lite', 'imagen-5'];
  assert.equal(providers.pickModel('gemini', live, 'gemini-3.8-flash'), 'gemini-9-pro');
  assert.equal(providers.pickModel('gemini', live.concat('gemini-3.8-flash'), 'gemini-3.8-flash'), 'gemini-3.8-flash', 'a default that still exists is kept');
  assert.equal(providers.pickModel('openai', ['gpt-9-image', 'gpt-9', 'gpt-9-mini'], 'gpt-6.1-sol'), 'gpt-9');
  assert.equal(providers.pickModel('deepseek', ['deepseek-next'], 'deepseek-v4-pro'), 'deepseek-next');
  assert.equal(providers.pickModel('anythingllm', ['my-workspace', 'second'], ''), 'my-workspace');
  assert.equal(providers.pickModel('openai', [], 'gpt-6.1-sol'), 'gpt-6.1-sol');
  assert.equal(providers.pickModel('openai', ['whisper-2', 'tts-9'], 'gpt-x'), 'whisper-2', 'falls back to whatever exists rather than nothing');
});

// ---- speech-to-text fallback --------------------------------------------------------------
test('stt: posts the clip to a Whisper-compatible endpoint with the language hint', async () => {
  const m = await listen((req, res, json, raw) => {
    m.seen = { url: req.url, auth: req.headers.authorization, type: req.headers['content-type'], body: raw.toString('latin1') };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ text: ' xin chào OneChat ' }));
  });
  await secrets.set('groq', 'gsk_test');
  const s = cfg.saveSettings({ baseUrls: { groq: m.url } });
  assert.equal(stt.available(s), true);
  const r = await stt.transcribe(Buffer.from('fake-audio-bytes'), { mime: 'audio/webm;codecs=opus', lang: 'vi-VN', settings: s });
  assert.deepEqual(r, { text: 'xin chào OneChat', via: 'groq' });
  assert.equal(m.seen.url, '/audio/transcriptions');
  assert.equal(m.seen.auth, 'Bearer gsk_test');
  assert.match(m.seen.type, /^multipart\/form-data/);
  assert.match(m.seen.body, /name="model"\r\n\r\nwhisper-large-v3-turbo/);
  assert.match(m.seen.body, /name="language"\r\n\r\nvi/);
  assert.match(m.seen.body, /filename="audio\.webm"/);
  await assert.rejects(stt.transcribe(Buffer.alloc(0), { settings: s }), { code: 'bad_request' });
  await secrets.set('groq', '');
  assert.equal(stt.available(cfg.loadSettings()), false);
  await assert.rejects(stt.transcribe(Buffer.from('x'), { settings: cfg.loadSettings() }), { code: 'no_stt' });
  await m.close();
});

// ---- live: the real Claude Code CLI (opt-in, uses the signed-in Claude plan) ---------------
test('claude-cli LIVE: answers through the installed Claude Code', { skip: process.env.ONECHAT_LIVE !== '1' ? 'set ONECHAT_LIVE=1 to run' : false }, async () => {
  assert.ok(cli.findBin(), 'Claude Code CLI not found');
  const fake = process.env.CLAUDE_CONFIG_DIR; // the other tests point this at a temp folder
  delete process.env.CLAUDE_CONFIG_DIR;
  try {
    const c = collect();
    const r = await cli.chat({ model: 'haiku', system: 'Answer with one word only.', messages: [{ role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' }, { role: 'user', content: 'Reply with exactly: pong' }] }, c.emit);
    console.log('live usage', JSON.stringify(r.usage), 'model', r.model, 'cost', r.cost);
    assert.match(c.text().toLowerCase(), /pong/);
    assert.ok(r.usage.out > 0 && r.model.includes('haiku'));
    assert.ok(r.usage.in + r.usage.cacheRead < 2500, 'answer-only mode keeps the overhead small');
  } finally { process.env.CLAUDE_CONFIG_DIR = fake; }
});

test('claude-cli: the child process never inherits an API key or a host session', () => {
  const env = cli.childEnv({ PATH: 'x', ANTHROPIC_API_KEY: 'sk', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'desktop', CLAUDE_CODE_SESSION_ID: 'abc', ANTHROPIC_BASE_URL: 'http://proxy', CLAUDE_CONFIG_DIR: 'D:/cfg' });
  assert.deepEqual(env, { PATH: 'x', CLAUDE_CONFIG_DIR: 'D:/cfg' });
  assert.deepEqual(cli.childEnv({ ANTHROPIC_BASE_URL: 'http://my-proxy', HOME: 'h' }), { ANTHROPIC_BASE_URL: 'http://my-proxy', HOME: 'h' });
});
