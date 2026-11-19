'use strict';
// Streaming chat for every provider that speaks the OpenAI chat-completions dialect:
// Groq, DeepSeek, Gemini (compat endpoint), AnythingLLM, OpenAI, Ollama, custom URLs.
// Emits { type: 'text' | 'thinking' | 'notice' } events and returns normalized usage.

class ProviderError extends Error {
  constructor(code, message, status) { super(message || code); this.name = 'ProviderError'; this.code = code; this.status = status || 0; }
}

function netCode(e) {
  if (e && (e.name === 'AbortError' || e.name === 'TimeoutError')) return 'aborted';
  const c = String((e && e.cause && e.cause.code) || (e && e.code) || '');
  if (/SELF_SIGNED|UNABLE_TO_VERIFY|CERT_|DEPTH_ZERO/.test(c)) return 'tls';
  if (c === 'ECONNREFUSED') return 'refused';
  return 'network';
}

function httpCode(status) {
  if (status === 401 || status === 403) return 'auth';
  if (status === 402) return 'credit';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate';
  if (status === 400 || status === 422) return 'bad_request';
  if (status >= 500) return 'server';
  return 'http';
}

// Some providers answer a wrong key with 400 instead of 401; the message gives it away.
// And an empty wallet often arrives as 429, which is not something waiting will fix.
const codeFor = (status, message) => {
  const m = String(message || '');
  if (status === 400 && /api[ _-]?key|unauthori[sz]ed|authenticat/i.test(m)) return 'auth';
  if ((status === 429 || status === 403) && /credit|billing|balance|insufficient|quota/i.test(m)) return 'credit';
  return httpCode(status);
};
const BUSY = new Set([502, 503, 529]); // overloaded right now: worth one more try

async function errorMessage(res) {
  let text = '';
  try { text = (await res.text()).slice(0, 2000); } catch (_) {}
  try {
    const j = JSON.parse(text);
    const e = Array.isArray(j) ? j[0] : j;
    const m = (e && e.error && (e.error.message || (typeof e.error === 'string' && e.error))) || (e && e.message) || '';
    if (m) return String(m).slice(0, 500);
  } catch (_) {}
  return text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
}

// One retry for connection-level failures: on this kind of machine an antivirus TLS proxy
// drops a share of fresh connections, and a second attempt usually goes through.
async function doFetch(url, init) {
  for (let attempt = 0; ; attempt++) {
    try { return await fetch(url, init); }
    catch (e) {
      const code = netCode(e);
      if (code === 'aborted') throw new ProviderError('aborted', 'aborted');
      if (attempt >= 1) throw new ProviderError(code, (e.cause && e.cause.message) || e.message);
      await new Promise((r) => setTimeout(r, 400));
    }
  }
}

function headersFor(opts) {
  const h = Object.assign({ 'content-type': 'application/json' }, opts.headers || {});
  if (opts.apiKey) h.authorization = 'Bearer ' + opts.apiKey;
  return h;
}

function usageOf(u) {
  if (!u) return null;
  const cached = (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || u.prompt_cache_hit_tokens || 0;
  const prompt = u.prompt_tokens || u.input_tokens || 0;
  return { in: Math.max(0, prompt - cached), out: u.completion_tokens || u.output_tokens || 0, cacheRead: cached };
}

async function chat(opts, emit) {
  const base = String(opts.baseUrl || '').replace(/\/+$/, '');
  if (!base) throw new ProviderError('no_base_url', 'base URL missing');
  const url = base + '/chat/completions';
  // A message with pictures becomes a list of parts: the words, then each picture as a data URL.
  const toApi = (m) => (m.images && m.images.length
    ? { role: m.role, content: (m.content ? [{ type: 'text', text: m.content }] : []).concat(m.images.map((im) => ({ type: 'image_url', image_url: { url: 'data:' + im.mime + ';base64,' + im.data } }))) }
    : { role: m.role, content: m.content });
  const messages = (opts.system ? [{ role: 'system', content: opts.system }] : []).concat(opts.messages.map(toApi));
  const body = Object.assign({ model: opts.model, messages, stream: true, stream_options: { include_usage: true } }, opts.extraBody || {});
  if (opts.maxTokens > 0) body[opts.tokenParam || 'max_tokens'] = opts.maxTokens;
  // A provider that accepts the request and then says nothing must not hang the chat forever:
  // give up if no response has started within the limit (the user's own Stop still works).
  const send = async () => {
    const ctl = new AbortController();
    const limit = opts.firstByteMs || 60000;
    let timedOut = false;
    if (opts.signal) { if (opts.signal.aborted) ctl.abort(); else opts.signal.addEventListener('abort', () => ctl.abort(), { once: true }); }
    const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, limit);
    try { return await doFetch(url, { method: 'POST', headers: headersFor(opts), body: JSON.stringify(body), signal: ctl.signal }); }
    catch (e) { if (timedOut) throw new ProviderError('timeout', 'no answer within ' + Math.round(limit / 1000) + 's'); throw e; }
    finally { clearTimeout(timer); }
  };
  const post = async () => {
    const first = await send();
    if (!BUSY.has(first.status) || opts.noBusyRetry) return first; // the caller has another AI to go to
    await new Promise((r) => setTimeout(r, opts.retryDelayMs != null ? opts.retryDelayMs : 1500));
    return send();
  };

  let res = await post();
  if (res.status === 400 || res.status === 422) {
    // Some servers reject stream_options; retry once without it before reporting the error.
    const first = await errorMessage(res);
    delete body.stream_options;
    res = await post();
    if (!res.ok) { const msg = (await errorMessage(res)) || first; throw new ProviderError(codeFor(res.status, msg), msg, res.status); }
  } else if (!res.ok) {
    const msg = await errorMessage(res);
    throw new ProviderError(codeFor(res.status, msg), msg, res.status);
  }

  // Servers that report their rate limits do it in these headers; kept for the "% left" display.
  let limits = null;
  res.headers.forEach((v, k) => { if (/^x-ratelimit-/.test(k)) { limits = limits || { headers: {} }; limits.headers[k] = v; } });

  let usage = null, gotAny = false, finish = '';
  // Some models (local ones especially) write their reasoning inline as <think>…</think>.
  // Route that part to the thinking stream so the answer shows only the answer.
  let inThink = false, pend = '';
  const out = (s) => {
    if (!s) return;
    if (inThink) emit({ type: 'thinking', text: s });
    else if (gotAny || s.trim()) { emit({ type: 'text', text: gotAny ? s : s.replace(/^\s+/, '') }); gotAny = true; }
  };
  const feed = (chunk) => {
    pend += chunk;
    for (;;) {
      const tag = inThink ? '</think>' : '<think>';
      const i = pend.indexOf(tag);
      if (i >= 0) { out(pend.slice(0, i)); pend = pend.slice(i + tag.length); inThink = !inThink; continue; }
      let keep = 0; // hold back a tag that may be split across two chunks
      for (let k = Math.min(tag.length - 1, pend.length); k > 0; k--) if (tag.startsWith(pend.slice(-k))) { keep = k; break; }
      out(pend.slice(0, pend.length - keep));
      pend = pend.slice(pend.length - keep);
      return;
    }
  };
  const handleJson = (j) => {
    if (j.error) throw new ProviderError('server', String(j.error.message || j.error).slice(0, 500));
    const u = j.usage || (j.x_groq && j.x_groq.usage);
    if (u) usage = usageOf(u);
    const choice = j.choices && j.choices[0];
    if (!choice) return;
    const d = choice.delta || choice.message || {};
    const think = d.reasoning_content || d.reasoning;
    if (typeof think === 'string' && think) emit({ type: 'thinking', text: think });
    if (typeof d.content === 'string' && d.content) feed(d.content);
    if (choice.finish_reason) finish = choice.finish_reason;
  };

  const ctype = String(res.headers.get('content-type') || '');
  if (ctype.includes('application/json')) {
    handleJson(await res.json()); // server ignored stream:true
  } else {
    const dec = new TextDecoder();
    let buf = '';
    const line = (raw) => {
      const l = raw.replace(/\r$/, '');
      if (!l.startsWith('data:')) return;
      const payload = l.slice(5).trim();
      if (!payload || payload === '[DONE]') return;
      let j;
      try { j = JSON.parse(payload); } catch (_) { return; }
      handleJson(j);
    };
    try {
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) { line(buf.slice(0, i)); buf = buf.slice(i + 1); }
      }
      if (buf) line(buf);
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      const code = netCode(e);
      throw new ProviderError(code === 'aborted' ? 'aborted' : 'interrupted', e.message);
    }
  }
  if (pend) { const rest = pend; pend = ''; out(rest); } // whatever was held back as a possible tag
  if (finish === 'length') emit({ type: 'notice', code: 'max_tokens' });
  if (finish === 'content_filter') emit({ type: 'notice', code: 'filtered' });
  if (!gotAny && !finish) emit({ type: 'notice', code: 'empty' });
  return { usage, model: opts.model, limits };
}

async function listModels(opts) {
  const base = String(opts.baseUrl || '').replace(/\/+$/, '');
  if (!base) throw new ProviderError('no_base_url', 'base URL missing');
  const res = await doFetch(base + '/models', { headers: headersFor(opts), signal: opts.signal || AbortSignal.timeout(15000) });
  if (!res.ok) { const msg = await errorMessage(res); throw new ProviderError(codeFor(res.status, msg), msg, res.status); }
  const j = await res.json();
  const arr = Array.isArray(j) ? j : (j.data || j.models || []);
  const ids = arr.map((m) => String((m && (m.id || m.name)) || '').replace(/^models\//, '')).filter(Boolean);
  return [...new Set(ids)];
}

module.exports = { chat, listModels, ProviderError, netCode, httpCode, usageOf };
