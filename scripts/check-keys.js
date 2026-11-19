'use strict';
// Checks every AI that has a key: asks for its model list, then sends one tiny question.
// Prints one line per AI. Keys are never printed, only their masked form.
// Usage: node --use-system-ca scripts/check-keys.js [provider ...]   (no names = all ready ones)
const cfg = require('../lib/config');
const secrets = require('../lib/secrets');
const providers = require('../lib/providers');

const only = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const short = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);

(async () => {
  await secrets.load();
  const settings = cfg.loadSettings();
  const list = providers.describe(settings).filter((p) => (only.length ? only.includes(p.id) : p.ready));
  if (!list.length) { console.log('No AI is ready. Add a key in Settings first.'); return; }
  let bad = 0;
  for (const p of list) {
    const row = { ai: p.label, key: p.keyMask || '(no key needed)', model: p.model };
    try {
      const t0 = Date.now();
      const ids = await providers.listModels(p.id, settings);
      row.models = ids.length;
      row.modelListed = !p.model || ids.includes(p.model);
      const r = await providers.complete({ provider: p.id, model: p.model, system: 'Answer with one word only.', user: 'Reply with exactly: OK', settings, timeoutMs: 90000 });
      row.reply = short(r.text, 40);
      row.usage = r.usage ? `in ${r.usage.in} / out ${r.usage.out}` : 'not reported';
      row.ms = Date.now() - t0;
      row.ok = !!r.text;
    } catch (e) {
      row.ok = false;
      row.error = `${e.code || 'error'}${e.status ? ' (HTTP ' + e.status + ')' : ''}: ${short(e.message, 160)}`;
    }
    if (!row.ok) bad += 1;
    console.log(`${row.ok ? 'OK  ' : 'FAIL'} ${row.ai.padEnd(12)} key ${String(row.key).padEnd(14)} model ${String(row.model).padEnd(22)}`
      + (row.models != null ? ` models ${String(row.models).padStart(3)}${row.modelListed ? '' : ' (chosen model NOT in list)'}` : '')
      + (row.ok ? ` | reply "${row.reply}" | ${row.usage} | ${row.ms} ms` : ` | ${row.error}`));
  }
  console.log(bad ? `${bad} of ${list.length} failed` : `all ${list.length} OK`);
  process.exitCode = bad ? 1 : 0;
})().catch((e) => { console.error('check failed:', short(e && e.message, 200)); process.exitCode = 2; });
