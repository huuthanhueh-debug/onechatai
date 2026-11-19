'use strict';
// Every conversation ("task") gets its own output folder, created the first time something
// is saved. Files the AI writes, screenshots and exported drawings all land there, so the
// user never has to create a file by hand. Nothing outside that folder is ever written.
const fs = require('fs');
const os = require('os');
const path = require('path');

const err = (code, message) => Object.assign(new Error(message || code), { code });
// Types Windows runs on a double-click. The AI may write documents and source text, never these.
const BLOCKED = new Set(('exe dll com scr msi msp bat cmd ps1 psm1 vbs vbe js jse wsf wsh hta lnk url reg cpl jar pif inf').split(' '));
const MAX_BYTES = 40 * 1024 * 1024;
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

function baseDir(settings) {
  const set = String((settings && settings.outputDir) || '').trim();
  if (set) return path.resolve(set);
  if (process.env.ONECHAT_DATA) return path.join(process.env.ONECHAT_DATA, 'output'); // tests and portable use stay self-contained
  const docs = path.join(os.homedir(), 'Documents');
  return path.join(fs.existsSync(docs) ? docs : os.homedir(), 'OneChat');
}

// Characters Windows refuses in names, control characters, and trailing dots or spaces.
const clean = (s) => String(s || '').replace(/[<>:"/\\|?*\p{Cc}]/gu, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
const pad = (n) => String(n).padStart(2, '0');

// "2026-11-13 Tìm giá vé Đà Nẵng": readable in Explorer and sorted by day.
function folderName(conv, now) {
  const d = new Date(now || conv.created || Date.now());
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + (clean(conv.title).slice(0, 48).trim() || 'OneChat');
}

// The conversation's folder, created on first use and remembered in conv.outDir.
function folderFor(conv, settings, now) {
  if (conv.outDir) { try { if (fs.statSync(conv.outDir).isDirectory()) return conv.outDir; } catch (_) { /* moved or deleted: make a new one */ } }
  const base = baseDir(settings), name = folderName(conv, now);
  let dir = path.join(base, name);
  for (let n = 2; fs.existsSync(dir) && n < 500; n++) dir = path.join(base, name + ' (' + n + ')');
  fs.mkdirSync(dir, { recursive: true });
  conv.outDir = dir;
  return dir;
}

// A name the AI or the window asked for -> a path that is certainly inside the folder.
function inside(dir, name) {
  const parts = String(name || '').replace(/\\/g, '/').split('/').map(clean).filter(Boolean);
  if (!parts.length || parts.length > 3) throw err('bad_name', 'bad file name');
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(parts[parts.length - 1])) throw err('bad_name', 'reserved file name');
  const root = path.resolve(dir);
  const file = path.resolve(root, parts.join(path.sep));
  if (!file.startsWith(root + path.sep)) throw err('bad_name', 'outside the output folder');
  return { file, rel: parts.join('/') };
}

// ---- versions: the rollback path before every risky step ------------------------------------
// A file about to be replaced is first copied into .phien-ban, and the whole folder is copied
// there before a command runs. Restoring copies back, after keeping the current state too, so a
// restore can itself be undone. Nothing in this file deletes anything.
const VERS = '.phien-ban';
const stamp = (d) => { d = d || new Date(); return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()) + '-' + String(d.getMilliseconds()).padStart(3, '0'); };
const free = (p) => { let q = p; for (let n = 2; fs.existsSync(q); n++) q = p + '-' + n; return q; };

function keepVersion(dir, name) {
  const at = inside(dir, name);
  if (!fs.existsSync(at.file) || !fs.statSync(at.file).isFile()) return null;
  const ext = path.extname(at.rel), base = at.rel.slice(0, at.rel.length - ext.length);
  const to = free(path.join(dir, VERS, base + ' (' + stamp() + ')' + ext));
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(at.file, to);
  return { kind: 'file', rel: path.relative(dir, to).split(path.sep).join('/'), of: at.rel };
}

function snapshot(dir, label) {
  const ents = fs.readdirSync(dir).filter((e) => e !== VERS);
  if (!ents.length) return null;
  const to = free(path.join(dir, VERS, clean(label || 'ban-chup') + ' ' + stamp()));
  fs.mkdirSync(to, { recursive: true });
  for (const e of ents) fs.cpSync(path.join(dir, e), path.join(to, e), { recursive: true });
  return { kind: 'folder', rel: path.relative(dir, to).split(path.sep).join('/'), of: '' };
}

// Puts a kept version back. backup = { rel, of } as keepVersion / snapshot returned it.
function restore(dir, backup) {
  const root = path.resolve(dir, VERS);
  const from = path.resolve(dir, String((backup && backup.rel) || ''));
  if (!from.startsWith(root + path.sep) || !fs.existsSync(from)) throw err('not_found', 'that version is not in ' + VERS);
  const files = [];
  if (fs.statSync(from).isFile()) {
    const at = inside(dir, backup.of);
    const before = keepVersion(dir, at.rel);
    fs.mkdirSync(path.dirname(at.file), { recursive: true });
    fs.copyFileSync(from, at.file);
    files.push(at.rel);
    return { files, kept: before ? [before] : [] };
  }
  const before = snapshot(dir, 'truoc-khoi-phuc');
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name), r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(p, r);
      else { const to = path.join(dir, ...r.split('/')); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(p, to); files.push(r); }
    }
  };
  walk(from, '');
  return { files, kept: before ? [before] : [] };
}

function write(dir, name, data) {
  const at = inside(dir, name);
  if (at.rel.split('/')[0].toLowerCase() === VERS) throw err('bad_name', 'the ' + VERS + ' folder keeps old versions and cannot be written to');
  const ext = path.extname(at.file).slice(1).toLowerCase();
  if (!ext) throw err('bad_name', 'the file name needs an extension, for example .md, .csv or .html');
  if (BLOCKED.has(ext)) throw err('blocked_type', 'a .' + ext + ' file can run programs when opened, so the app does not create it');
  let buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data == null ? '' : data), 'utf8');
  // Excel only shows Vietnamese correctly in a CSV that starts with a byte-order mark.
  if (ext === 'csv' && !Buffer.isBuffer(data) && !buf.subarray(0, 3).equals(BOM)) buf = Buffer.concat([BOM, buf]);
  if (buf.length > MAX_BYTES) throw err('too_large', 'file over 40 MB');
  fs.mkdirSync(path.dirname(at.file), { recursive: true });
  fs.writeFileSync(at.file, buf);
  return { name: at.rel, path: at.file, bytes: buf.length };
}

function read(dir, name, maxChars) {
  const at = inside(dir, name);
  let buf;
  try { buf = fs.readFileSync(at.file); } catch (_) { throw err('not_found', at.rel + ' is not in the output folder'); }
  if (buf.subarray(0, 8192).includes(0)) throw err('binary', at.rel + ' is not a text file');
  let text = buf.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // byte-order mark
  const max = maxChars || 8000;
  return { name: at.rel, text: text.length > max ? text.slice(0, max) + '\n…' : text, chars: text.length };
}

function list(dir) {
  const out = [];
  const walk = (d, rel, depth) => {
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      if (out.length >= 300) return;
      const p = path.join(d, e.name), r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) { if (depth < 3 && !(depth === 0 && e.name === VERS)) walk(p, r, depth + 1); } else { try { const st = fs.statSync(p); out.push({ name: r, bytes: st.size, mtime: st.mtimeMs }); } catch (_) { /* vanished */ } }
    }
  };
  walk(dir, '', 0);
  return out.sort((a, b) => b.mtime - a.mtime);
}

module.exports = { BLOCKED, VERS, baseDir, folderName, folderFor, inside, write, read, list, keepVersion, snapshot, restore };
