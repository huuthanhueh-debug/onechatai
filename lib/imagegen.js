'use strict';
// Picture generation through whichever account can do it: Gemini's image models (native
// API) or OpenAI's images endpoint. The result is stored like any other picture.
const secrets = require('./secrets');
const media = require('./media');
const providers = require('./providers');
const { ProviderError } = providers;

const GEMINI_PREF = [/flash-lite-image/, /flash-image/, /banana/, /image/];
const OPENAI_PREF = [/^gpt-image-1-mini$/, /^gpt-image-\d/, /^chatgpt-image/, /image/];
const pick = (list, prefs, bad) => {
  const ok = (Array.isArray(list) ? list : []).filter((m) => !(bad && bad.test(m)));
  for (const re of prefs) { const hit = ok.find((m) => re.test(m)); if (hit) return hit; }
  return '';
};

function candidates(settings) {
  const out = [];
  const cache = settings.modelCache || {};
  if (secrets.get('gemini')) {
    const base = providers.baseUrlOf(providers.preset('gemini'), settings).replace(/\/+$/, '').replace(/\/openai$/, '');
    out.push({ provider: 'gemini', base, model: pick(cache.gemini, GEMINI_PREF, /preview|tts|embedding/) || 'gemini-2.5-flash-image' });
  }
  if (secrets.get('openai')) {
    out.push({ provider: 'openai', base: providers.baseUrlOf(providers.preset('openai'), settings).replace(/\/+$/, ''), model: pick(cache.openai, OPENAI_PREF) || 'gpt-image-1' });
  }
  return out;
}

function failure(status, text) {
  let msg = String(text || '').replace(/\s+/g, ' ').slice(0, 300);
  try { const j = JSON.parse(text); const e = Array.isArray(j) ? j[0] : j; msg = String((e && e.error && (e.error.message || e.error)) || msg).replace(/\s+/g, ' ').slice(0, 300); } catch (_) { /* keep the raw text */ }
  const code = status === 401 || status === 403 ? 'auth'
    : status === 429 || status === 402 ? (/quota|credit|billing|balance|limit: 0/i.test(msg) ? 'credit' : 'rate')
      : status === 404 ? 'not_found' : status >= 500 ? 'server' : 'bad_request';
  return new ProviderError(code, msg, status);
}

async function post(url, headers, body, signal) {
  let res;
  try { res = await fetch(url, { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, headers), body: JSON.stringify(body), signal }); }
  catch (e) { throw new ProviderError(e && (e.name === 'AbortError' || e.name === 'TimeoutError') ? 'timeout' : 'network', (e && e.message) || 'network'); }
  const text = await res.text();
  if (!res.ok) throw failure(res.status, text);
  try { return JSON.parse(text); } catch (_) { throw new ProviderError('server', 'unreadable answer'); }
}

async function viaGemini(c, prompt, signal) {
  const j = await post(c.base + '/models/' + encodeURIComponent(c.model) + ':generateContent', { 'x-goog-api-key': secrets.get('gemini') },
    { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'] } }, signal);
  const parts = ((((j.candidates || [])[0] || {}).content || {}).parts) || [];
  for (const p of parts) { const d = p.inlineData || p.inline_data; if (d && d.data) return Buffer.from(d.data, 'base64'); }
  throw new ProviderError('empty', 'the model returned no picture');
}

async function viaOpenAI(c, prompt, signal) {
  const j = await post(c.base + '/images/generations', { authorization: 'Bearer ' + secrets.get('openai') }, { model: c.model, prompt, size: '1024x1024', n: 1 }, signal);
  const d = (j.data || [])[0] || {};
  if (d.b64_json) return Buffer.from(d.b64_json, 'base64');
  throw new ProviderError('empty', 'the model returned no picture');
}

// Tries each account that could do it; the last failure is the one reported.
async function generate(prompt, settings, signal) {
  const list = candidates(settings);
  if (!list.length) throw new ProviderError('no_image_ai', 'no account that can make pictures');
  let last;
  for (const c of list) {
    try {
      const buf = await (c.provider === 'gemini' ? viaGemini : viaOpenAI)(c, prompt, signal || AbortSignal.timeout(180000));
      const s = media.save(buf);
      const info = { id: s.id, provider: c.provider, model: c.model };
      media.rememberGenerated(prompt, info);
      return info;
    } catch (e) { last = e; }
  }
  throw last;
}

module.exports = { candidates, generate };
