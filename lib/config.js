'use strict';
// Settings + data directory. Everything the app remembers lives under one folder
// (%APPDATA%\OneChat by default, or ONECHAT_DATA for tests / portable use).
const fs = require('fs');
const path = require('path');
const os = require('os');

const APP = 'OneChat';
const VERSION = require('../package.json').version;

function dataDir() {
  const d = process.env.ONECHAT_DATA
    || path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), APP);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

const DEFAULTS = {
  lang: 'vi',                 // vi | en
  theme: 'auto',              // auto | light | dark
  port: 4780,
  browser: 'auto',            // auto | chrome | edge | default
  provider: 'claude-cli',     // last used provider id
  models: {},                 // provider id -> last used model
  modelCache: {},             // provider id -> [model ids] fetched live
  autoRoute: false,           // pick the AI from learned habits
  systemPrompt: '',
  promptgate: { mode: 'suggest', below: 50, rewrite: 'auto' },   // mode: off | badge | suggest ; rewrite: auto | rules
  memory: { enabled: true, maxItems: 3, budgetTokens: 1500, disabledSources: [], pinned: [], extraSources: [] },
  files: { perFileChars: 60000, totalChars: 200000, linked: [] },
  context: { historyBudgetTokens: 24000, compactAt: 30000 },
  output: { maxTokens: 0, effort: 'auto', concise: false },       // maxTokens 0 = provider default
  voice: { lang: 'vi-VN', engine: 'auto' },                       // engine: auto | browser | whisper
  helper: { provider: 'auto', model: '' },                        // cheap model for rewrites / compaction
  custom: { label: 'Custom', baseUrl: '' },
  baseUrls: {},               // provider id -> base URL override
  claudeFallbacks: true,      // server-side refusal fallback for Claude API
  agent: { enabled: false, critic: 'auto', maxRounds: 2, passScore: 80 }, // answer -> review -> revise loop
  council: { enabled: false, max: 3, judge: 'auto' },                     // several AIs answer, one writes the final answer
  clarify: { enabled: true }, // the AI asks back with options to click (and room for your own answer) when it is unsure
  operator: { enabled: false, auto: true, maxSteps: 20, confirm: 'risky', search: 'bing' }, // the AI works in Chrome, the output folder and on the computer, step by step
  outputDir: '',              // where each task's output folder is made ('' = Documents\OneChat)
  vision: { bridge: true },   // let an AI that can see describe a picture for one that cannot
  budgets: {},                // provider id -> the user's own monthly allowance, in million tokens
  pins: {},                   // task -> "provider|model"
  prices: {},                 // model id -> [input, output, cacheRead] USD per million tokens
};

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

function deepMerge(base, over) {
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  if (!isObj(over)) return out;
  for (const [k, v] of Object.entries(over)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out;
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch (_) { return fallback; }
}

// Write to a temp file then rename, so a crash mid-write never leaves a half file.
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

const settingsFile = () => path.join(dataDir(), 'settings.json');

function loadSettings() {
  return deepMerge(DEFAULTS, readJson(settingsFile(), {}));
}

// Only keys that exist in DEFAULTS are accepted, so a stray request cannot plant arbitrary data.
function sanitizePatch(patch) {
  const out = {};
  if (!isObj(patch)) return out;
  for (const k of Object.keys(DEFAULTS)) if (k in patch) out[k] = patch[k];
  if ('port' in out) { const p = Number(out.port); if (!(p >= 1024 && p <= 65535)) delete out.port; else out.port = p; }
  if ('lang' in out && !['vi', 'en'].includes(out.lang)) delete out.lang;
  return out;
}

function saveSettings(patch) {
  const next = deepMerge(loadSettings(), sanitizePatch(patch));
  writeJson(settingsFile(), next);
  return next;
}

module.exports = { APP, VERSION, DEFAULTS, dataDir, deepMerge, readJson, writeJson, loadSettings, saveSettings, sanitizePatch };
