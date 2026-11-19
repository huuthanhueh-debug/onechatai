'use strict';
// Provider registry: what each AI is, whether it is ready to use, and one chat() entry point.
const secrets = require('../secrets');
const oai = require('./openai-compat');
const anthropic = require('./anthropic');
const cli = require('./claude-cli');
const media = require('../media');
const quota = require('../quota');
const { ProviderError } = oai;

// main: shown as a pill even before it is configured (the six the app is built around).
// Model lists are starting points only; "refresh models" replaces them with the live list.
const PRESETS = [
  { id: 'claude-cli', label: 'Claude', sub: 'Claude Code', kind: 'claude-cli', main: true, needsKey: false,
    models: ['opus', 'sonnet', 'haiku', 'fable'], defaultModel: 'opus', helperModel: 'haiku', web: 'https://claude.ai/new' },
  { id: 'claude', label: 'Claude API', kind: 'anthropic', needsKey: true,
    models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-2'], defaultModel: 'claude-opus-5-5', helperModel: 'claude-haiku-5-5',
    web: 'https://claude.ai/new', keyUrl: 'https://platform.claude.com/settings/keys' },
  { id: 'deepseek', label: 'DeepSeek', kind: 'openai', main: true, needsKey: true, baseUrl: 'https://api.deepseek.com',
    models: ['deepseek-v4-pro', 'deepseek-flash'], defaultModel: 'deepseek-v4-pro', helperModel: 'deepseek-flash', web: 'https://chat.deepseek.com/', keyUrl: 'https://platform.deepseek.com/api_keys' },
  { id: 'gemini', label: 'Gemini', kind: 'openai', main: true, needsKey: true, baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    models: ['gemini-4-hydrogen', 'gemini-3.8-flash', 'gemini-flash-latest', 'gemini-3.5-flash-lite'], defaultModel: 'gemini-4-hydrogen', helperModel: 'gemini-3.5-flash-lite',
    web: 'https://gemini.google.com/app', keyUrl: 'https://aistudio.google.com/apikey' },
  { id: 'anythingllm', label: 'AnythingLLM', kind: 'openai', main: true, needsKey: true, local: true, baseUrl: 'http://localhost:3001/api/v1/openai',
    models: [], defaultModel: '', web: '' },
  { id: 'groq', label: 'Groq', kind: 'openai', needsKey: true, baseUrl: 'https://api.groq.com/openai/v1', tokenParam: 'max_completion_tokens',
    models: ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'llama-3.1-8b-instant'], defaultModel: 'llama-3.3-70b-versatile', helperModel: 'llama-3.1-8b-instant',
    web: 'https://chat.groq.com/', keyUrl: 'https://console.groq.com/keys' },
  { id: 'openai', label: 'OpenAI', kind: 'openai', needsKey: true, baseUrl: 'https://api.openai.com/v1', tokenParam: 'max_completion_tokens',
    models: ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna'], defaultModel: 'gpt-6.1-sol', helperModel: 'gpt-6-luna', web: 'https://chatgpt.com/', keyUrl: 'https://platform.openai.com/api-keys' },
  { id: 'ollama', label: 'Ollama', kind: 'openai', needsKey: false, local: true, baseUrl: 'http://localhost:11434/v1', models: [], defaultModel: '', web: '' },
  { id: 'custom', label: 'Custom', kind: 'openai', needsKey: false, needsBaseUrl: true, baseUrl: '', models: [], defaultModel: '', web: '' },
];
const byId = new Map(PRESETS.map((p) => [p.id, p]));
const preset = (id) => byId.get(id) || null;

function baseUrlOf(p, settings) {
  const over = settings.baseUrls && settings.baseUrls[p.id];
  if (typeof over === 'string' && over.trim()) return over.trim();
  if (p.id === 'custom') return String((settings.custom && settings.custom.baseUrl) || '').trim();
  return p.baseUrl || '';
}

function statusOf(p, settings) {
  if (p.kind === 'claude-cli') return cli.findBin() ? 'ready' : 'missing_cli';
  const key = secrets.get(p.id);
  if (p.kind === 'anthropic') return key ? 'ready' : 'needs_key';
  if (!baseUrlOf(p, settings)) return 'needs_url';
  if (p.needsKey && !key) return 'needs_key';
  // Local / self-hosted endpoints have no built-in model list: ready once a model is known.
  if (!modelsOf(p, settings).model) return 'needs_model';
  return 'ready';
}

function modelsOf(p, settings) {
  const cached = settings.modelCache && settings.modelCache[p.id];
  const list = Array.isArray(cached) && cached.length ? cached : p.models;
  const last = settings.models && settings.models[p.id];
  return { models: list, model: last || p.defaultModel || list[0] || '' };
}

// What the UI needs to draw a provider. Keys are only ever reported masked.
function describe(settings) {
  return PRESETS.map((p) => {
    const key = secrets.get(p.id);
    const m = modelsOf(p, settings);
    const status = statusOf(p, settings);
    return {
      id: p.id, label: p.id === 'custom' ? ((settings.custom && settings.custom.label) || 'Custom') : p.label, sub: p.sub || '',
      kind: p.kind, main: !!p.main, local: !!p.local, needsKey: !!p.needsKey, needsBaseUrl: !!p.needsBaseUrl,
      status, ready: status === 'ready', hasKey: !!key, keyMask: secrets.mask(key), keySource: secrets.source(p.id),
      baseUrl: baseUrlOf(p, settings), defaultBaseUrl: p.baseUrl || '', models: m.models, model: m.model,
      vision: sees(p, m.model), web: p.web || '', keyUrl: p.keyUrl || '',
    };
  });
}

function resolve(id, settings) {
  const p = preset(id);
  if (!p) throw new ProviderError('unknown_provider', id);
  const status = statusOf(p, settings);
  if (status === 'missing_cli') throw new ProviderError('cli_missing', 'Claude Code CLI not found');
  if (status === 'needs_key') throw new ProviderError('no_key', p.label);
  if (status === 'needs_url') throw new ProviderError('no_base_url', p.label);
  // 'needs_model' still resolves: listing models is how a model becomes known.
  return { preset: p, apiKey: secrets.get(p.id), baseUrl: baseUrlOf(p, settings) };
}

// ---- pictures -------------------------------------------------------------------------------
// Which AIs take a picture as a picture (checked with real calls for the ones built in).
// Everything else gets a description written by an AI that can see.
function sees(p, model) {
  const m = String(model || '').toLowerCase();
  if (p.kind === 'anthropic' || p.kind === 'claude-cli') return true;
  if (p.id === 'gemini') return !/embedding|tts|lyria|aqa|transcribe/.test(m);
  if (p.id === 'openai') return /^(gpt-[4-9]|o\d|chatgpt|chat-latest)/.test(m) && !/audio|realtime|tts|transcribe|search|embedding|codex/.test(m);
  if (p.id === 'groq') return /qwen|vision|llama-4|scout|maverick/.test(m);
  return false;
}

const DESCRIBE = 'Describe this picture for an assistant that cannot see it and must answer questions about it. First transcribe ALL visible text exactly as written (keep its language, numbers and table layout). Then describe what is shown: layout, charts and their values, objects, people (do not identify anyone), colours. Plain text, no preamble.';
const VISION_ORDER = ['gemini', 'claude', 'claude-cli', 'groq', 'openai'];
function visionHelpers(settings, except) {
  const out = [];
  for (const id of VISION_ORDER) {
    if (id === except) continue;
    const p = preset(id);
    if (statusOf(p, settings) !== 'ready') continue;
    const all = modelsOf(p, settings);
    const model = id === 'groq' ? all.models.find((m) => sees(p, m)) : (p.helperModel || all.model);
    if (model && sees(p, model)) out.push({ provider: id, model });
  }
  return out;
}

// What is in a picture, written once by an AI that can see and kept next to the picture.
async function captionFor(img, settings, signal, except) {
  const cached = media.getCaption(img.id);
  if (cached) return { text: cached, by: '' };
  for (const h of visionHelpers(settings, except)) {
    try {
      let text = '';
      await chat({ provider: h.provider, model: h.model, system: '', messages: [{ role: 'user', content: DESCRIBE, images: [img] }], settings, signal, maxTokens: 1500, noBridge: true }, (ev) => { if (ev.type === 'text') text += ev.text; });
      text = text.trim();
      if (text) { media.setCaption(img.id, text); return { text, by: h.provider }; }
    } catch (e) { if (e && e.code === 'aborted') throw e; /* try the next AI that can see */ }
  }
  return { text: '', by: '' };
}

const attr = (s) => String(s || '').replace(/["<>&]/g, '_');
// Messages for an AI that cannot see: each picture becomes its description.
async function asText(messages, settings, signal, emit, except) {
  const bridge = !settings.vision || settings.vision.bridge !== false;
  const by = new Set();
  let blind = false;
  const out = [];
  for (const m of messages) {
    if (!m.images || !m.images.length) { out.push({ role: m.role, content: m.content }); continue; }
    const parts = [];
    for (const img of m.images) {
      const c = bridge ? await captionFor(img, settings, signal, except) : { text: media.getCaption(img.id), by: '' };
      if (c.by) by.add(c.by);
      if (c.text) parts.push(`<image name="${attr(img.name)}" described-by="another assistant">\n${c.text}\n</image>`);
      else { blind = true; parts.push(`<image name="${attr(img.name)}">(a picture is attached here but could not be read; say so if the answer depends on it)</image>`); }
    }
    out.push({ role: m.role, content: parts.concat(m.content ? [m.content] : []).join('\n\n') });
  }
  if (by.size) emit({ type: 'notice', code: 'vision_bridge', detail: [...by].map((id) => preset(id).label).join(', ') });
  if (blind) emit({ type: 'notice', code: 'no_vision' });
  return out;
}

// Messages for an AI that can see: the picture bytes ride along.
function withPictures(messages) {
  return messages.map((m) => {
    if (!m.images || !m.images.length) return { role: m.role, content: m.content };
    const images = [];
    for (const img of m.images) {
      try { images.push({ name: img.name, mime: media.mimeOf(img.id), data: media.read(img.id).toString('base64') }); } catch (_) { /* the file is gone: the words still go */ }
    }
    return images.length ? { role: m.role, content: m.content, images } : { role: m.role, content: m.content || '(the attached picture is no longer available)' };
  });
}

async function chat(req, emit) {
  const settings = req.settings;
  const r = resolve(req.provider, settings);
  const out = settings.output || {};
  if (!req.model) throw new ProviderError('no_model', r.preset.label);
  const send = (messages, tap) => {
    const common = { model: req.model, system: req.system, messages, signal: req.signal, maxTokens: req.maxTokens != null ? req.maxTokens : (Number(out.maxTokens) || 0) };
    if (r.preset.kind === 'claude-cli') return cli.chat(Object.assign(common, { effort: out.effort }), tap);
    if (r.preset.kind === 'anthropic') {
      return anthropic.chat(Object.assign(common, { apiKey: r.apiKey, baseUrl: (settings.baseUrls && settings.baseUrls.claude) || '', effort: out.effort, fallbacks: settings.claudeFallbacks !== false }), tap);
    }
    return oai.chat(Object.assign(common, { apiKey: r.apiKey, baseUrl: r.baseUrl, tokenParam: r.preset.tokenParam, firstByteMs: req.firstByteMs, noBusyRetry: req.noBusyRetry }), tap);
  };
  const pictures = req.messages.some((m) => m.images && m.images.length);
  try {
    let res;
    if (!pictures) res = await send(req.messages.map((m) => ({ role: m.role, content: m.content })), emit);
    else if (sees(r.preset, req.model)) {
      let streamed = false;
      try { res = await send(withPictures(req.messages), (ev) => { if (ev.type === 'text') streamed = true; emit(ev); }); }
      catch (e) {
        // A model that turns out not to take pictures after all: describe them and ask again.
        if (e.code !== 'bad_request' || streamed || req.noBridge) throw e;
        res = await send(await asText(req.messages, settings, req.signal, emit, req.provider), emit);
      }
    } else res = await send(await asText(req.messages, settings, req.signal, emit, req.provider), emit);
    quota.note(req.provider, res && res.limits);
    if (req.provider === 'deepseek') quota.refreshDeepseek(r.apiKey, r.baseUrl);
    return res;
  } catch (e) {
    if (e && e.code === 'credit') quota.spent(req.provider, e.message);
    throw e;
  }
}

async function listModels(id, settings) {
  const r = resolve(id, settings);
  if (r.preset.kind === 'claude-cli') return r.preset.models.slice();
  if (r.preset.kind === 'anthropic') return anthropic.listModels({ apiKey: r.apiKey, baseUrl: (settings.baseUrls && settings.baseUrls.claude) || '' });
  return oai.listModels({ apiKey: r.apiKey, baseUrl: r.baseUrl });
}

// One-shot, non-streaming call used for rewrites, summaries and connection tests.
async function complete({ provider, model, system, user, settings, timeoutMs, maxTokens }) {
  let text = '';
  const signal = AbortSignal.timeout(timeoutMs || 30000);
  const res = await chat({ provider, model, system, messages: [{ role: 'user', content: user }], settings, signal, maxTokens: maxTokens || undefined }, (ev) => { if (ev.type === 'text') text += ev.text; });
  return { text: text.trim(), usage: res.usage, model: res.model || model };
}

// A cheap model for background jobs: the explicit choice from settings, else the first ready
// provider in rough order of speed and price.
const HELPER_ORDER = ['groq', 'gemini', 'deepseek', 'claude', 'openai', 'claude-cli', 'ollama', 'anythingllm', 'custom'];
function helper(settings) {
  const h = settings.helper || {};
  const pick = (id, model) => {
    const p = preset(id);
    if (!p || statusOf(p, settings) !== 'ready') return null;
    const m = model || p.helperModel || modelsOf(p, settings).model;
    return m ? { provider: id, model: m } : null;
  };
  if (h.provider && h.provider !== 'auto') { const x = pick(h.provider, h.model); if (x) return x; }
  for (const id of HELPER_ORDER) { const x = pick(id); if (x) return x; }
  return null;
}

// Once a live model list arrives: keep the wanted model if the provider still offers it,
// otherwise choose a plain chat model, so a stale built-in default never blocks the first message.
const NOT_CHAT = /embed|image|imagen|tts|audio|whisper|speech|transcri|video|veo|moderation|realtime|rerank|guard|aqa|robotics|computer-use|search/i;
const FAMILY = { deepseek: 'deepseek', gemini: 'gemini', openai: 'gpt', claude: 'claude' };
function pickModel(id, ids, wanted) {
  if (!Array.isArray(ids) || !ids.length) return wanted || '';
  if (wanted && ids.includes(wanted)) return wanted;
  const fam = FAMILY[id];
  const chatty = ids.filter((m) => !NOT_CHAT.test(m));
  const own = fam ? chatty.filter((m) => m.toLowerCase().startsWith(fam)) : chatty;
  const pool = own.length ? own : chatty;
  // Whole name parts only: "gemini" must not count as "mini".
  const stable = pool.filter((m) => !/(^|[-_.:/])(preview|exp|experimental|beta|lite|nano|mini|tiny)([-_.:/]|$)/i.test(m));
  return stable[0] || pool[0] || ids[0];
}

module.exports = { PRESETS, preset, describe, resolve, chat, listModels, complete, helper, statusOf, baseUrlOf, pickModel, sees, visionHelpers, ProviderError };
