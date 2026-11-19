'use strict';
// Conversations on disk: one JSON file per conversation plus a small index for the sidebar.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cfg = require('./config');

const dir = () => { const d = path.join(cfg.dataDir(), 'conversations'); fs.mkdirSync(d, { recursive: true }); return d; };
const indexFile = () => path.join(dir(), 'index.json');
const ID_RE = /^[a-z0-9]{8,32}$/;
const newId = () => Date.now().toString(36) + crypto.randomBytes(5).toString('hex');
const fileOf = (id) => { if (!ID_RE.test(String(id))) throw Object.assign(new Error('bad id'), { code: 'bad_id' }); return path.join(dir(), id + '.json'); };

const metaOf = (c) => ({ id: c.id, title: c.title, created: c.created, updated: c.updated, provider: c.provider, model: c.model, count: c.messages.length });

function rebuildIndex() {
  const idx = {};
  for (const f of fs.readdirSync(dir())) {
    if (!f.endsWith('.json') || f === 'index.json') continue;
    const c = cfg.readJson(path.join(dir(), f), null);
    if (c && c.id && Array.isArray(c.messages)) idx[c.id] = metaOf(c);
  }
  cfg.writeJson(indexFile(), idx);
  return idx;
}

function index() {
  const idx = cfg.readJson(indexFile(), null);
  return idx && typeof idx === 'object' ? idx : rebuildIndex();
}

const list = () => Object.values(index()).sort((a, b) => b.updated - a.updated);

function create({ provider, model }) {
  const now = Date.now();
  return { id: newId(), title: '', created: now, updated: now, provider, model, summary: '', summaryUpTo: 0, messages: [] };
}

function get(id) {
  const c = cfg.readJson(fileOf(id), null);
  if (!c || !Array.isArray(c.messages)) return null;
  return c;
}

function save(c) {
  c.updated = Date.now();
  cfg.writeJson(fileOf(c.id), c);
  const idx = index();
  idx[c.id] = metaOf(c);
  cfg.writeJson(indexFile(), idx);
  return c;
}

function remove(id) {
  try { fs.unlinkSync(fileOf(id)); } catch (_) {}
  const idx = index();
  delete idx[id];
  cfg.writeJson(indexFile(), idx);
}

function rename(id, title) {
  const c = get(id);
  if (!c) return null;
  c.title = String(title || '').trim().slice(0, 120);
  return save(c);
}

const titleFrom = (text) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, 60);

// ---- journal + backups --------------------------------------------------------------------
// Every turn is also written to an append-only log, and the whole data folder is copied
// once a day, so tasks, history, memory notes and habits never exist in one place only.
const journalFile = () => path.join(cfg.dataDir(), 'history.jsonl');
function journal(entry) {
  try { fs.appendFileSync(journalFile(), JSON.stringify(Object.assign({ at: new Date().toISOString() }, entry)) + '\n'); } catch (_) { /* logging must never break a chat */ }
}
function readJournal(limit) {
  let lines = [];
  try { lines = fs.readFileSync(journalFile(), 'utf8').split('\n').filter(Boolean); } catch (_) {}
  return lines.slice(-(limit || 200)).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
}
const BACKUP_ITEMS = ['settings.json', 'secrets.json', 'usage.json', 'lessons.json', 'quota.json', 'history.jsonl', 'memory', 'conversations', 'media'];
function backup(now) {
  const root = path.join(cfg.dataDir(), 'backups');
  const dest = path.join(root, new Date(now || Date.now()).toISOString().slice(0, 10));
  let copied = 0;
  const copy = (rel) => {
    const src = path.join(cfg.dataDir(), rel);
    try {
      if (fs.statSync(src).isDirectory()) { for (const f of fs.readdirSync(src)) copy(path.join(rel, f)); return; }
      const to = path.join(dest, rel);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      // Pictures never change once written, so a daily copy can be a hard link: it keeps the
      // file alive even if the original is removed, without storing the bytes again each day.
      let linked = false;
      if (rel.split(path.sep)[0] === 'media' && /\.(png|jpg|gif|webp)$/.test(rel)) { try { if (!fs.existsSync(to)) fs.linkSync(src, to); linked = true; } catch (_) { linked = false; } }
      if (!linked) fs.copyFileSync(src, to);
      copied += 1;
    } catch (_) { /* a missing item is simply not there yet */ }
  };
  for (const rel of BACKUP_ITEMS) copy(rel);
  return { dest, copied }; // daily copies are kept forever: nothing here ever deletes one
}

module.exports = { list, create, get, save, remove, rename, newId, titleFrom, rebuildIndex, journal, readJournal, journalFile, backup };
