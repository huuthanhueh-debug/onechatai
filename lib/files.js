'use strict';
// Local files and folders: browse, search, and turn a file into text the model can read.
// Read-only. Text and code are read directly; .docx/.xlsx/.pptx are unpacked with zlib;
// .pdf uses the optional pdf-parse package. Every size limit reports truncation to the caller.
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const { estimate } = require('./tokens');

const TEXT_EXT = new Set(('txt md markdown json jsonl csv tsv log xml yml yaml toml ini cfg conf env js mjs cjs ts tsx jsx py rb go rs java kt c h cpp hpp cs php swift sql sh bash ps1 psm1 bat cmd vbs html htm css scss less vue svelte r lua pl dart gradle properties tex rst srt vtt gitignore dockerfile').split(' '));
const DOC_EXT = new Set(['docx', 'xlsx', 'pptx', 'pdf']);
// Pictures are not turned into text: they travel to the AI as pictures (see lib/media.js).
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp']);
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const BINARY_EXT = new Set(('exe dll bin iso zip rar 7z gz tar ico mp3 mp4 mov avi mkv wav flac ogg webm woff woff2 ttf otf db sqlite pyc class jar apk msi doc xls ppt psd ai').split(' '));
const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', 'dist', 'build', '.next', '__pycache__', '.venv', 'venv', '$RECYCLE.BIN', 'System Volume Information', '.cache']);
const MAX_FILE_BYTES = 60 * 1024 * 1024;
const MAX_INFLATE = 80 * 1024 * 1024;

const err = (code, message) => Object.assign(new Error(message || code), { code });
const extOf = (name) => { const e = path.extname(name).slice(1).toLowerCase(); return e || path.basename(name).toLowerCase().replace(/^\./, ''); };
const kindOf = (name) => { const e = extOf(name); return DOC_EXT.has(e) ? 'doc' : IMAGE_EXT.has(e) ? 'image' : BINARY_EXT.has(e) ? 'binary' : TEXT_EXT.has(e) ? 'text' : 'unknown'; };
const isSensitive = (name) => /^\.env(\.|$)|\.(pem|key|pfx|p12)$|^id_(rsa|ed25519)$|secrets?\.json$/i.test(path.basename(name));

function roots(linked) {
  const out = [];
  const home = os.homedir();
  for (const [id, p] of [['home', home], ['desktop', path.join(home, 'Desktop')], ['documents', path.join(home, 'Documents')], ['downloads', path.join(home, 'Downloads')]]) {
    if (fs.existsSync(p)) out.push({ id, path: p, name: path.basename(p), kind: 'quick' });
  }
  for (const p of linked || []) if (typeof p === 'string' && fs.existsSync(p)) out.push({ id: 'linked', path: p, name: path.basename(p) || p, kind: 'linked' });
  if (process.platform === 'win32') {
    for (const c of 'CDEFGHIJKLMNOPQRSTUVWXYZ') { const d = c + ':\\'; if (fs.existsSync(d)) out.push({ id: 'drive', path: d, name: c + ':', kind: 'drive' }); }
  } else out.push({ id: 'drive', path: '/', name: '/', kind: 'drive' });
  return out;
}

function list(dir) {
  const abs = path.resolve(String(dir || ''));
  let ents;
  try { ents = fs.readdirSync(abs, { withFileTypes: true }); }
  catch (e) { throw err(e.code === 'ENOENT' ? 'not_found' : e.code === 'EPERM' || e.code === 'EACCES' ? 'no_access' : 'read_failed', e.message); }
  const items = [];
  for (const d of ents) {
    if (d.name.startsWith('$') || d.name === 'System Volume Information') continue;
    const p = path.join(abs, d.name);
    let isDir = d.isDirectory(), size = 0, mtime = 0;
    try { const st = fs.statSync(p); isDir = st.isDirectory(); size = st.size; mtime = st.mtimeMs; } catch (_) { continue; }
    items.push({ name: d.name, path: p, dir: isDir, size: isDir ? 0 : size, mtime, kind: isDir ? 'dir' : kindOf(d.name), sensitive: !isDir && isSensitive(d.name) });
    if (items.length >= 3000) break;
  }
  items.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) : a.dir ? -1 : 1));
  const parent = path.dirname(abs);
  return { path: abs, parent: parent === abs ? null : parent, items };
}

const strip = (s) => s.normalize('NFD').replace(/\p{M}/gu, '').replace(/đ/g, 'd').toLowerCase();

// Breadth-first filename search across the given folders, bounded so it always returns fast.
function search(dirs, q, max) {
  const needle = strip(String(q || '').trim());
  const out = [];
  if (!needle) return out;
  const queue = (dirs || []).filter((d) => typeof d === 'string').map((d) => ({ dir: d, depth: 0 }));
  let visited = 0;
  while (queue.length && out.length < (max || 60) && visited < 30000) {
    const { dir, depth } = queue.shift();
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
    for (const d of ents) {
      visited += 1;
      const p = path.join(dir, d.name);
      if (d.isDirectory()) { if (depth < 6 && !SKIP_DIRS.has(d.name) && !d.name.startsWith('.')) queue.push({ dir: p, depth: depth + 1 }); }
      if (strip(d.name).includes(needle)) {
        out.push({ name: d.name, path: p, dir: d.isDirectory(), kind: d.isDirectory() ? 'dir' : kindOf(d.name) });
        if (out.length >= (max || 60)) break;
      }
    }
  }
  return out;
}

// Indented listing of a folder, so the model can see structure without reading every file.
function tree(dir, maxDepth, maxEntries) {
  const lines = [];
  let count = 0, truncated = false;
  const walk = (d, depth) => {
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    ents.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
    for (const e of ents) {
      if (count >= (maxEntries || 300)) { truncated = true; return; }
      if (e.name.startsWith('$')) continue;
      count += 1;
      lines.push('  '.repeat(depth) + e.name + (e.isDirectory() ? '/' : ''));
      if (e.isDirectory() && depth + 1 < (maxDepth || 3) && !SKIP_DIRS.has(e.name)) walk(path.join(d, e.name), depth + 1);
    }
  };
  walk(dir, 0);
  return { text: lines.join('\n') + (truncated ? '\n…' : ''), truncated };
}

// ---- zip (office documents) -------------------------------------------------------------
function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw err('bad_document', 'not a zip container');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let n = 0; n < count && off + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10), csize = buf.readUInt32LE(off + 20), usize = buf.readUInt32LE(off + 24);
    const nlen = buf.readUInt16LE(off + 28), elen = buf.readUInt16LE(off + 30), clen = buf.readUInt16LE(off + 32), lho = buf.readUInt32LE(off + 42);
    entries.set(buf.toString('utf8', off + 46, off + 46 + nlen), { method, csize, usize, lho });
    off += 46 + nlen + elen + clen;
  }
  const read = (name) => {
    const f = entries.get(name);
    if (!f) return null;
    if (f.usize > MAX_INFLATE) throw err('too_large', name);
    const start = f.lho + 30 + buf.readUInt16LE(f.lho + 26) + buf.readUInt16LE(f.lho + 28);
    const data = buf.subarray(start, start + f.csize);
    if (f.method === 0) return data;
    if (f.method !== 8) throw err('bad_document', 'unsupported compression');
    return zlib.inflateRawSync(data, { maxOutputLength: MAX_INFLATE });
  };
  return { names: [...entries.keys()], read };
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
  if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
  return ENT[e] != null ? ENT[e] : m;
});
const numbered = (names, re) => names.map((n) => ({ n, m: re.exec(n) })).filter((x) => x.m).sort((a, b) => Number(a.m[1]) - Number(b.m[1])).map((x) => x.n);

function docxText(buf) {
  const z = unzip(buf);
  const xml = z.read('word/document.xml');
  if (!xml) throw err('bad_document', 'word/document.xml missing');
  let out = '';
  const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:br\s*\/?>|<\/w:p>|<\/w:tc>|<\/w:tr>/g;
  let m;
  const s = xml.toString('utf8');
  while ((m = re.exec(s))) {
    if (m[1] != null) out += decode(m[1]);
    else if (m[0].startsWith('<w:tab')) out += '\t';
    else if (m[0] === '</w:tc>') out += ' | ';
    else out += '\n';
  }
  // A table cell ends its paragraph before the cell closes: fold that break into the separator.
  return out.replace(/\n \| /g, ' | ').replace(/ \| \n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function pptxText(buf) {
  const z = unzip(buf);
  const parts = [];
  numbered(z.names, /^ppt\/slides\/slide(\d+)\.xml$/).forEach((name, i) => {
    const s = z.read(name).toString('utf8');
    let text = '';
    const re = /<a:t>([\s\S]*?)<\/a:t>|<\/a:p>/g;
    let m;
    while ((m = re.exec(s))) text += m[1] != null ? decode(m[1]) : '\n';
    parts.push(`--- Slide ${i + 1} ---\n${text.replace(/\n{2,}/g, '\n').trim()}`);
  });
  return parts.join('\n\n');
}

const colIndex = (ref) => { let n = 0; for (const ch of ref) { const c = ch.charCodeAt(0); if (c < 65 || c > 90) break; n = n * 26 + (c - 64); } return n - 1; };

function xlsxText(buf, maxChars) {
  const z = unzip(buf);
  const shared = [];
  const ss = z.read('xl/sharedStrings.xml');
  if (ss) {
    const re = /<si>([\s\S]*?)<\/si>/g;
    let m;
    const s = ss.toString('utf8');
    while ((m = re.exec(s))) shared.push(decode((m[1].match(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g) || []).map((t) => t.replace(/<[^>]+>/g, '')).join('')));
  }
  const names = [];
  const wb = z.read('xl/workbook.xml');
  if (wb) { const re = /<sheet\s[^>]*?name="([^"]*)"/g; let m; const s = wb.toString('utf8'); while ((m = re.exec(s))) names.push(decode(m[1])); }
  const parts = [];
  let total = 0;
  numbered(z.names, /^xl\/worksheets\/sheet(\d+)\.xml$/).forEach((name, i) => {
    if (total > (maxChars || Infinity)) return;
    const s = z.read(name).toString('utf8');
    const rows = [];
    const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
    let rm;
    while ((rm = rowRe.exec(s)) && rows.length < 5000) {
      const cells = [];
      const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
      let cm;
      while ((cm = cellRe.exec(rm[1]))) {
        const attrs = cm[1], inner = cm[2] || '';
        const ref = (/\br="([A-Z]+)\d+"/.exec(attrs) || [])[1];
        const type = (/\bt="(\w+)"/.exec(attrs) || [])[1];
        let v = (/<v>([\s\S]*?)<\/v>/.exec(inner) || [])[1];
        if (type === 's' && v != null) v = shared[Number(v)] != null ? shared[Number(v)] : '';
        else if (type === 'inlineStr') v = decode((inner.match(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g) || []).map((t) => t.replace(/<[^>]+>/g, '')).join(''));
        else if (v != null) v = decode(v);
        const idx = ref ? colIndex(ref) : cells.length;
        cells[idx] = v == null ? '' : String(v).replace(/[\t\r\n]+/g, ' ');
      }
      const line = Array.from(cells, (c) => c || '').join('\t').replace(/\t+$/, '');
      if (line) { rows.push(line); total += line.length + 1; if (total > (maxChars || Infinity)) break; }
    }
    parts.push(`--- Sheet: ${names[i] || i + 1} ---\n${rows.join('\n')}`);
  });
  return parts.join('\n\n');
}

async function pdfText(buf) {
  let mod;
  try { mod = require('pdf-parse'); } catch (_) { throw err('pdf_unsupported', 'pdf-parse is not installed'); }
  if (typeof mod.PDFParse === 'function') {
    const parser = new mod.PDFParse({ data: new Uint8Array(buf) });
    try { const r = await parser.getText(); return String((r && r.text) || ''); }
    finally { if (typeof parser.destroy === 'function') await parser.destroy().catch(() => {}); }
  }
  const fn = typeof mod === 'function' ? mod : mod.default;
  const r = await fn(buf);
  return String((r && r.text) || '');
}

function decodeText(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) { const b = Buffer.from(buf.subarray(2)); b.swap16(); return b.toString('utf16le'); }
  const head = buf.subarray(0, 8192);
  for (let i = 0; i < head.length; i++) if (head[i] === 0) throw err('binary', 'binary file');
  return buf.toString('utf8').replace(/^\uFEFF/, '');
}

async function extract(name, buf, maxChars) {
  const e = extOf(name);
  if (BINARY_EXT.has(e) || IMAGE_EXT.has(e)) throw err('binary', name);
  let text;
  try {
    if (e === 'docx') text = docxText(buf);
    else if (e === 'xlsx') text = xlsxText(buf, maxChars);
    else if (e === 'pptx') text = pptxText(buf);
    else if (e === 'pdf') text = await pdfText(buf);
    else text = decodeText(buf);
  } catch (x) {
    if (x.code) throw x;
    throw err('bad_document', x.message);
  }
  text = text.replace(/\r\n/g, '\n');
  const chars = text.length;
  let truncated = false;
  if (maxChars && chars > maxChars) { text = text.slice(0, maxChars) + '\n…'; truncated = true; }
  return { text, chars, truncated };
}

async function readFile(file, maxChars) {
  const abs = path.resolve(String(file));
  let st;
  try { st = fs.statSync(abs); } catch (e) { throw err('not_found', abs); }
  if (st.isDirectory()) { const t = tree(abs); return { name: path.basename(abs) || abs, path: abs, kind: 'tree', text: t.text, chars: t.text.length, truncated: t.truncated, tokens: estimate(t.text) }; }
  if (st.size > MAX_FILE_BYTES) throw err('too_large', abs);
  const buf = fs.readFileSync(abs);
  const r = await extract(path.basename(abs), buf, maxChars);
  return { name: path.basename(abs), path: abs, kind: 'file', text: r.text, chars: r.chars, truncated: r.truncated, tokens: estimate(r.text), sensitive: isSensitive(abs) };
}

// Read everything attached to one message. Per-file and total limits are enforced here;
// anything cut or skipped is reported, never dropped silently. Pictures come back as raw
// bytes in `images` (the caller checks and stores them); everything else as text in `files`.
async function collect({ paths, inline, perFileChars, totalChars }) {
  const files = [], errors = [], images = [];
  let remaining = totalChars || Infinity;
  const push = (f) => {
    if (remaining <= 0) { errors.push({ name: f.name, code: 'over_budget' }); return; }
    if (f.text.length > remaining) { f.text = f.text.slice(0, remaining) + '\n…'; f.truncated = true; f.tokens = estimate(f.text); }
    remaining -= f.text.length;
    files.push(f);
  };
  for (const p of paths || []) {
    if (IMAGE_EXT.has(extOf(String(p)))) {
      try {
        const abs = path.resolve(String(p));
        let st;
        try { st = fs.statSync(abs); } catch (_) { throw err('not_found', abs); }
        if (st.size > MAX_IMAGE_BYTES) throw err('too_large', abs);
        images.push({ name: path.basename(abs), path: abs, buf: fs.readFileSync(abs) });
      } catch (e) { errors.push({ name: path.basename(String(p)), path: String(p), code: e.code && !/^E[A-Z]+$/.test(e.code) ? e.code : 'read_failed' }); }
      continue;
    }
    try { push(await readFile(p, perFileChars)); }
    catch (e) { errors.push({ name: path.basename(String(p)), path: String(p), code: e.code || 'read_failed' }); }
  }
  for (const it of inline || []) {
    const name = path.basename(String((it && it.name) || 'file'));
    try {
      const buf = Buffer.from(String((it && it.data) || ''), 'base64');
      if (buf.length > MAX_FILE_BYTES) throw err('too_large', name);
      if (IMAGE_EXT.has(extOf(name)) || /^image\//.test(String((it && it.type) || ''))) { images.push({ name, path: '', buf, w: Number(it.w) || 0, h: Number(it.h) || 0 }); continue; }
      const r = await extract(name, buf, perFileChars);
      push({ name, path: '', kind: 'file', text: r.text, chars: r.chars, truncated: r.truncated, tokens: estimate(r.text), sensitive: isSensitive(name) });
    } catch (e) { errors.push({ name, code: e.code || 'read_failed' }); }
  }
  return { files, errors, images };
}

const attr = (s) => String(s).replace(/["<>&]/g, '_');
function render(files) {
  return (files || []).map((f) => f.kind === 'tree'
    ? `<folder path="${attr(f.path)}">\n${f.text}\n</folder>`
    : `<file name="${attr(f.name)}"${f.path ? ` path="${attr(f.path)}"` : ''}${f.truncated ? ' truncated="true"' : ''}>\n${f.text}\n</file>`).join('\n\n');
}

module.exports = { roots, list, search, tree, readFile, extract, collect, render, unzip, docxText, xlsxText, pptxText, kindOf, isSensitive, extOf };
