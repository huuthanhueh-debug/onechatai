'use strict';
// Claude through the official Anthropic SDK (Messages API, streaming).
const sdk = require('@anthropic-ai/sdk');
const Anthropic = sdk.default || sdk;
const { ProviderError, netCode } = require('./openai-compat');

// Current-generation models: adaptive thinking, effort control, large output caps.
const MODERN = /^claude-(?:fable|mythos)-5|^claude-opus-(?:5|4-[678])|^claude-sonnet-(?:5|4-6)|^claude-haiku-5/;
// Models where a safety decline can be rescued server-side by a fallback model.
const FALLBACK_OK = /^claude-(?:fable-5-[12]|opus-5(?:-5)?$|sonnet-5-5)/;
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

function client(opts) {
  const o = { apiKey: opts.apiKey, maxRetries: 2 };
  if (opts.baseUrl) o.baseURL = opts.baseUrl;
  return new Anthropic(o);
}

function toProviderError(e) {
  if (e instanceof ProviderError) return e;
  if (e instanceof Anthropic.APIUserAbortError) return new ProviderError('aborted', 'aborted');
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) return new ProviderError('auth', e.message, e.status);
  if (e instanceof Anthropic.NotFoundError) return new ProviderError('not_found', e.message, e.status);
  if (e instanceof Anthropic.RateLimitError) return new ProviderError('rate', e.message, e.status);
  if (e instanceof Anthropic.BadRequestError) return new ProviderError(/credit balance|billing/i.test(e.message) ? 'credit' : 'bad_request', e.message, e.status);
  if (e instanceof Anthropic.APIConnectionError) return new ProviderError(netCode(e), e.message);
  if (e instanceof Anthropic.APIError) return new ProviderError(e.status === 402 ? 'credit' : e.status >= 500 ? 'server' : 'http', e.message, e.status);
  if (e && e.name === 'AbortError') return new ProviderError('aborted', 'aborted');
  return new ProviderError('network', (e && e.message) || 'unknown error');
}

// A message with pictures becomes content blocks: the pictures first, then the words.
const toApi = (m) => (m.images && m.images.length
  ? { role: m.role, content: m.images.map((im) => ({ type: 'image', source: { type: 'base64', media_type: im.mime, data: im.data } })).concat(m.content ? [{ type: 'text', text: m.content }] : []) }
  : { role: m.role, content: m.content });

function buildParams(opts) {
  const modern = MODERN.test(opts.model);
  const params = {
    model: opts.model,
    max_tokens: opts.maxTokens > 0 ? opts.maxTokens : (modern ? 64000 : 8192),
    messages: opts.messages.map(toApi),
    cache_control: { type: 'ephemeral' }, // caches the growing conversation prefix between turns
  };
  if (opts.system) params.system = opts.system;
  if (modern) {
    params.thinking = { type: 'adaptive', display: 'summarized' };
    if (opts.effort && opts.effort !== 'auto') params.output_config = { effort: opts.effort };
  }
  return params;
}

async function run(stream, emit) {
  for await (const event of stream) {
    if (event.type !== 'content_block_delta') continue;
    if (event.delta.type === 'text_delta') emit({ type: 'text', text: event.delta.text });
    else if (event.delta.type === 'thinking_delta' && event.delta.thinking) emit({ type: 'thinking', text: event.delta.thinking });
  }
  const final = await stream.finalMessage();
  // Rate-limit headers of this answer, for the "% left" display.
  try {
    const h = stream.response && stream.response.headers;
    if (h && typeof h.forEach === 'function') {
      const kept = {};
      h.forEach((v, k) => { if (/^anthropic-ratelimit-(requests|tokens)-(limit|remaining|reset)$/.test(k)) kept[k] = v; });
      if (Object.keys(kept).length) Object.defineProperty(final, 'onechatLimits', { value: { headers: kept }, enumerable: false });
    }
  } catch (_) { /* headers are a nicety */ }
  return final;
}

async function chat(opts, emit) {
  const c = client(opts);
  const params = buildParams(opts);
  const reqOpts = { signal: opts.signal };
  const useFallback = opts.fallbacks !== false && FALLBACK_OK.test(opts.model);
  let final, emitted = false;
  const tap = (ev) => { emitted = true; emit(ev); };
  try {
    if (useFallback) {
      try {
        final = await run(c.beta.messages.stream(Object.assign({}, params, { betas: [FALLBACK_BETA], fallbacks: 'default' }), reqOpts), tap);
      } catch (e) {
        // The fallback beta is optional. If the request itself was rejected before any
        // output, send it once more without the beta rather than failing the turn.
        if (!(e instanceof Anthropic.BadRequestError) || emitted) throw e;
        final = await run(c.messages.stream(params, reqOpts), tap);
      }
    } else {
      final = await run(c.messages.stream(params, reqOpts), tap);
    }
  } catch (e) { throw toProviderError(e); }

  if (final.stop_reason === 'refusal') emit({ type: 'notice', code: 'refusal', detail: (final.stop_details && final.stop_details.category) || '' });
  else if (final.stop_reason === 'max_tokens') emit({ type: 'notice', code: 'max_tokens' });
  if (final.model && final.model !== opts.model && (final.content || []).some((b) => b.type === 'fallback')) emit({ type: 'notice', code: 'fallback', detail: final.model });
  const u = final.usage || {};
  return {
    model: final.model || opts.model,
    usage: { in: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0), out: u.output_tokens || 0, cacheRead: u.cache_read_input_tokens || 0 },
    limits: final.onechatLimits || null,
  };
}

async function listModels(opts) {
  const c = client(opts);
  const ids = [];
  try { for await (const m of c.models.list()) { ids.push(m.id); if (ids.length >= 100) break; } }
  catch (e) { throw toProviderError(e); }
  return ids;
}

module.exports = { chat, listModels, buildParams, toProviderError, MODERN, FALLBACK_OK };
