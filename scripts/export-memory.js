'use strict';
// Writes every linked memory entry (Claude Code memory folders + OneChat notes) to one
// Markdown file that OneChat can import again (Memory tab -> Import).
// Usage: node scripts/export-memory.js [output file] [--raw]
//   --raw   keep secret-like values instead of masking them
const fs = require('fs');
const path = require('path');
const cfg = require('../lib/config');
const memory = require('../lib/memory');

const args = process.argv.slice(2);
const raw = args.includes('--raw');
const outArg = args.find((a) => !a.startsWith('--'));

const items = memory.loadItems(cfg.loadSettings()).filter((it) => it.enabled !== false);
const r = memory.exportBundle(items, { masked: !raw });
const out = path.resolve(outArg || r.filename);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, r.text);

const bySource = {};
for (const it of items) bySource[it.sourceLabel] = (bySource[it.sourceLabel] || 0) + 1;
console.log(`${r.count} entries -> ${out}`);
for (const [label, n] of Object.entries(bySource)) console.log(`  ${String(n).padStart(3)}  ${label}`);
console.log(raw ? 'secret-like values were NOT masked (--raw)' : `${r.masked} secret-like value(s) masked`);
