'use strict';
// Speech-to-text fallback for when the browser's built-in recognition is unavailable:
// the recorded clip goes to a Whisper-compatible endpoint (Groq first, then OpenAI).
const secrets = require('./secrets');
const { ProviderError, httpCode, netCode } = require('./providers/openai-compat');

const TARGETS = [
  { id: 'groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3-turbo' },
  { id: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-transcribe' },
];

function target(settings) {
  for (const t of TARGETS) {
    const key = secrets.get(t.id);
    if (key) return Object.assign({}, t, { key, baseUrl: (settings.baseUrls && settings.baseUrls[t.id]) || t.baseUrl });
  }
  return null;
}

const available = (settings) => !!target(settings);

async function transcribe(buf, { mime, lang, settings }) {
  const t = target(settings);
  if (!t) throw new ProviderError('no_stt', 'no speech-to-text key');
  if (!buf || !buf.length) throw new ProviderError('bad_request', 'empty audio');
  const type = String(mime || 'audio/webm').split(';')[0];
  const ext = type.includes('ogg') ? 'ogg' : type.includes('mp4') || type.includes('m4a') ? 'm4a' : type.includes('wav') ? 'wav' : 'webm';
  const form = new FormData();
  form.append('file', new Blob([buf], { type }), 'audio.' + ext);
  form.append('model', t.model);
  form.append('response_format', 'json');
  const l = String(lang || '').slice(0, 2).toLowerCase();
  if (l === 'vi' || l === 'en') form.append('language', l);
  let res;
  try {
    res = await fetch(t.baseUrl.replace(/\/+$/, '') + '/audio/transcriptions', { method: 'POST', headers: { authorization: 'Bearer ' + t.key }, body: form, signal: AbortSignal.timeout(60000) });
  } catch (e) { throw new ProviderError(netCode(e), e.message); }
  if (!res.ok) {
    let msg = '';
    try { const j = await res.json(); msg = (j.error && j.error.message) || j.message || ''; } catch (_) {}
    throw new ProviderError(httpCode(res.status), msg, res.status);
  }
  const j = await res.json();
  return { text: String(j.text || '').trim(), via: t.id };
}

module.exports = { available, transcribe, TARGETS };
