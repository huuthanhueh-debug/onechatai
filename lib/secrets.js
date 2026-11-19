'use strict';
// API keys at rest: AES-256-GCM, done in-process with Node's crypto.
// The 32-byte master key lives in its own per-user file outside the data folder
// (%LOCALAPPDATA%\OneChat\secret.key), so secrets.json on its own — copied, backed up or
// synced with the roaming profile — is unreadable. Someone with full access to this Windows
// profile can read both files; that is the limit of this protection.
//
// Why not Windows DPAPI: reaching it needs PowerShell, and a process that listens on a
// network port and then launches PowerShell looks like malware to antivirus software. On
// this machine that got the server killed and server.js deleted. Nothing here spawns a process.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const cfg = require('./config');

const file = () => path.join(cfg.dataDir(), 'secrets.json');
const plainMode = () => process.env.ONECHAT_SECRETS === 'plain';

// A custom data folder (tests, portable use) keeps its key beside it; the normal install
// keeps the key in the local, non-roaming profile.
function keyFile() {
  if (process.env.ONECHAT_DATA) return path.join(cfg.dataDir(), 'secret.key');
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share');
  return path.join(base, cfg.APP, 'secret.key');
}

function masterKey(create) {
  const f = keyFile();
  try { const k = fs.readFileSync(f); if (k.length === 32) return k; } catch (_) {}
  if (!create) return null;
  const k = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, k, { mode: 0o600 });
  return k;
}

function seal(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', masterKey(true), iv);
  const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return { v: 2, mode: 'aes', iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
}

function open(raw) {
  const key = masterKey(false);
  if (!key) throw new Error('master key missing');
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(raw.iv, 'base64'));
  d.setAuthTag(Buffer.from(raw.tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(raw.data, 'base64')), d.final()]).toString('utf8');
}

let cache = null;        // { provider: key }
let mode = 'aes';

async function load() {
  if (cache) return cache;
  const raw = cfg.readJson(file(), null);
  cache = {};
  mode = plainMode() ? 'plain' : 'aes';
  if (!raw || !raw.data) return cache;
  try {
    if (raw.mode === 'aes') cache = JSON.parse(open(raw));
    else if (raw.mode === 'plain') cache = JSON.parse(Buffer.from(raw.data, 'base64').toString('utf8'));
    else throw new Error('unsupported format: ' + raw.mode); // e.g. an old DPAPI file
    if (!cache || typeof cache !== 'object' || Array.isArray(cache)) cache = {};
  } catch (e) {
    // Unreadable (key file gone, other machine, tampered, old format): start empty, but keep
    // the old file so nothing is destroyed silently.
    try { fs.copyFileSync(file(), file() + '.unreadable'); } catch (_) {}
    cache = {};
  }
  return cache;
}

async function persist() {
  const json = JSON.stringify(cache);
  // Keep the previous good file: a user's keys must survive a bad write or a later mistake.
  try { if (fs.statSync(file()).size > 0) fs.copyFileSync(file(), file() + '.bak'); } catch (_) {}
  if (plainMode()) { cfg.writeJson(file(), { v: 1, mode: 'plain', data: Buffer.from(json, 'utf8').toString('base64') }); mode = 'plain'; return; }
  cfg.writeJson(file(), seal(json));
  mode = 'aes';
}

async function set(provider, key) {
  await load();
  const k = String(key || '').trim();
  if (k) cache[provider] = k; else delete cache[provider];
  await persist();
}

// Stored key first, then the conventional environment variable.
const ENV = {
  claude: 'ANTHROPIC_API_KEY', groq: 'GROQ_API_KEY', deepseek: 'DEEPSEEK_API_KEY',
  gemini: 'GEMINI_API_KEY', openai: 'OPENAI_API_KEY', anythingllm: 'ANYTHINGLLM_API_KEY',
};
function get(provider) {
  if (cache && cache[provider]) return cache[provider];
  const env = ENV[provider] && process.env[ENV[provider]];
  return env ? env.trim() : '';
}
const source = (provider) => (cache && cache[provider] ? 'stored' : (ENV[provider] && process.env[ENV[provider]] ? 'env' : ''));

function mask(key) {
  if (!key) return '';
  const k = String(key);
  return k.length <= 8 ? '••••' : k.slice(0, 4) + '…' + k.slice(-4);
}

const reset = () => { cache = null; };

module.exports = { load, set, get, mask, source, reset, ENV, getMode: () => mode, file, keyFile };
