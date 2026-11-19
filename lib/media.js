'use strict';
// Pictures the user attaches and pictures the app makes. Each file is written once under a
// name derived from its content, so a conversation only has to remember the id.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cfg = require('./config');

const MIME = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const ID_RE = /^[a-f0-9]{24}\.(png|jpg|gif|webp)$/;
const MAX_BYTES = 5 * 1024 * 1024; // the strictest provider limit for one picture
const err = (code, message) => Object.assign(new Error(message || code), { code });
const dir = () => { const d = path.join(cfg.dataDir(), 'media'); fs.mkdirSync(d, { recursive: true }); return d; };
const isImageName = (name) => /\.(png|jpe?g|gif|webp|bmp)$/i.test(String(name || ''));

// The real format, read from the first bytes: a file name proves nothing.
function sniff(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.toString('latin1', 0, 4) === 'GIF8') return 'gif';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

// Width and height where the header gives them cheaply (PNG, GIF, JPEG).
function size(buf) {
  const kind = sniff(buf);
  try {
    if (kind === 'png') return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    if (kind === 'gif') return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
    if (kind === 'jpg') {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) { i += 1; continue; }
        const m = buf[i + 1];
        if (m === 0xff) { i += 1; continue; }
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
        i += 2 + buf.readUInt16BE(i + 2);
      }
    }
  } catch (_) { /* a damaged header just means "size unknown" */ }
  return null;
}

// Providers bill a picture roughly by its pixel area. Used only for the "≈ tokens" display
// and for fitting history into its budget.
const tokensFor = (w, h) => (w > 0 && h > 0 ? Math.max(85, Math.min(1700, Math.ceil((w * h) / 750))) : 1100);

function save(buf) {
  const ext = sniff(buf);
  if (!ext) throw err('bad_image', 'not a PNG, JPEG, GIF or WebP picture');
  if (buf.length > MAX_BYTES) throw err('too_large', 'picture over 5 MB');
  const id = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 24) + '.' + ext;
  const file = path.join(dir(), id);
  if (!fs.existsSync(file)) fs.writeFileSync(file, buf);
  const dim = size(buf) || {};
  return { id, mime: MIME[ext], bytes: buf.length, w: dim.w || 0, h: dim.h || 0 };
}

const fileOf = (id) => { if (!ID_RE.test(String(id))) throw err('bad_id', 'bad media id'); return path.join(dir(), String(id)); };
const mimeOf = (id) => MIME[String(id).split('.').pop()] || 'application/octet-stream';
function read(id) {
  const file = fileOf(id);
  try { return fs.readFileSync(file); } catch (_) { throw err('not_found', String(id)); }
}

// What an AI that can see said is in a picture, kept so each picture is described only once.
const getCaption = (id) => { try { return fs.readFileSync(fileOf(id) + '.txt', 'utf8'); } catch (_) { return ''; } };
const setCaption = (id, text) => { fs.writeFileSync(fileOf(id) + '.txt', String(text || '')); };

// Generated pictures: prompt -> id, so re-opening a chat never pays for the same picture twice.
const genFile = () => path.join(dir(), 'generated.json');
const promptKey = (prompt) => crypto.createHash('sha256').update(String(prompt).trim()).digest('hex').slice(0, 32);
function findGenerated(prompt) {
  const hit = cfg.readJson(genFile(), {})[promptKey(prompt)];
  return hit && ID_RE.test(String(hit.id)) && fs.existsSync(path.join(dir(), hit.id)) ? hit : null;
}
function rememberGenerated(prompt, info) {
  const g = cfg.readJson(genFile(), {});
  g[promptKey(prompt)] = info;
  cfg.writeJson(genFile(), g);
}

module.exports = { MIME, MAX_BYTES, dir, isImageName, sniff, size, tokensFor, save, read, fileOf, mimeOf, getCaption, setCaption, findGenerated, rememberGenerated };
