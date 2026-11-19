'use strict';
// Bridge to the PromptGate engine (rule-based prompt scoring, local, zero tokens).
// Loads the live plugin when it sits next to this app, else the vendored snapshot, so the
// app keeps working when the plugin folder is absent. Weak prompts get three rewrites —
// A Lean / B Standard / C Deep — offered as buttons; nothing is ever blocked.
const fs = require('fs');
const path = require('path');
const os = require('os');

function candidates() {
  const out = [];
  if (process.env.PROMPTGATE_ROOT) out.push(process.env.PROMPTGATE_ROOT);
  out.push(path.resolve(__dirname, '..', '..', 'promptgate'));
  const cache = path.join(os.homedir(), '.claude', 'plugins', 'cache', 'promptgate', 'promptgate');
  try { for (const v of fs.readdirSync(cache)) out.push(path.join(cache, v)); } catch (_) {}
  out.push(path.resolve(__dirname, '..', 'vendor', 'promptgate'));
  return out;
}

let mods = null; // null = not tried, false = unavailable
function load() {
  if (mods !== null) return mods;
  for (const root of candidates()) {
    try {
      if (!fs.existsSync(path.join(root, 'scripts', 'lib', 'engine.js'))) continue;
      const prev = process.env.CLAUDE_PLUGIN_ROOT;
      process.env.CLAUDE_PLUGIN_ROOT = root; // packs.js resolves <root>/packs from this
      try {
        mods = {
          E: require(path.join(root, 'scripts', 'lib', 'engine.js')),
          packs: require(path.join(root, 'scripts', 'lib', 'packs.js')),
          i18n: require(path.join(root, 'scripts', 'lib', 'i18n.js')),
          root,
        };
        mods.packs.load({ fresh: true });
      } finally { if (prev === undefined) delete process.env.CLAUDE_PLUGIN_ROOT; else process.env.CLAUDE_PLUGIN_ROOT = prev; }
      return mods;
    } catch (_) { mods = null; }
  }
  mods = false;
  return mods;
}

const available = () => !!load();
const info = () => { const m = load(); return m ? { available: true, root: m.root, vendored: m.root.includes(path.join('vendor', 'promptgate')) } : { available: false }; };

function score(text, followUp) {
  const m = load();
  if (!m) return null;
  try {
    const pack = m.packs.load();
    const a = m.E.analyze(String(text || ''), { pack, followUp: !!followUp });
    const T = m.i18n.t(a.lang);
    return {
      a, T, pack,
      score: a.score, type: a.type, depth: a.depth, lang: a.lang, words: a.nWords,
      typeLabel: T.types[a.type] || a.type, depthLabel: T.depth[a.depth] || a.depth,
      missing: a.missing.map((k) => T.dims[k]), tip: m.E.tipFor(a, T) || '',
      dims: a.dims, max: a.max,
    };
  } catch (_) { return null; }
}

// Should this prompt be scored at all? Acknowledgements and very short follow-ups are left alone.
function skip(text) {
  const m = load();
  const t = String(text || '').trim();
  if (!m || !t) return true;
  if (t.startsWith('//')) return true;
  if (m.E.R.ACK.test(t)) return true;
  return m.E.words(t).length < 4;
}

const LABELS = { vi: { A: 'A · Gọn', B: 'B · Chuẩn', C: 'C · Sâu' }, en: { A: 'A · Lean', B: 'B · Standard', C: 'C · Deep' } };
const recommendedFor = (s) => (s.depth === 'deep' ? 'C' : s.depth === 'light' ? 'A' : 'B');

// Rule-based rewrites: instant and free. Lines that would need a placeholder are left out,
// so there is never a blank for the user to fill in.
function variantsByRules(text, s) {
  const m = load();
  if (!m || !s) return null;
  const { E } = m, { a, T, pack } = s;
  const core = E.cleanFiller(String(text));
  const lines = E.rewrite(String(text), a, pack, T).split('\n').filter((l) => !l.includes('⟨'));
  const isCue = (l) => l === T.deepLine || l === T.standardLine;
  const body = lines.filter((l) => !isCue(l));
  const A = core;
  const B = body.length > 1 ? body.concat(a.type === 'question' ? [] : [T.standardLine]).join('\n') : (a.type === 'question' ? core : core + '\n' + T.standardLine);
  const C = body.concat([T.deepLine]).join('\n');
  const seen = new Set([String(text).trim()]);
  const options = [];
  for (const [key, val] of [['A', A], ['B', B], ['C', C]]) {
    const v = String(val || '').trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    options.push({ key, label: LABELS[a.lang === 'vi' ? 'vi' : 'en'][key], text: v });
  }
  if (!options.length) return null;
  const rec = recommendedFor(s);
  return { options, recommended: options.some((o) => o.key === rec) ? rec : options[0].key, via: 'rules' };
}

// Prompt for one cheap model call that writes the three rewrites with details filled in.
function llmPrompt(text, s, context) {
  const vi = s.lang === 'vi';
  const miss = s.missing.join(', ') || (vi ? 'không' : 'none');
  const system = [
    vi ? 'Bạn là PromptGate, bộ tối ưu câu lệnh. Người dùng vừa gõ một yêu cầu còn thiếu chi tiết cho một trợ lý AI.' : 'You are PromptGate, a prompt optimizer. The user typed a request for an AI assistant that is missing details.',
    vi ? `Loại việc: ${s.typeLabel}. Chiều sâu: ${s.depthLabel}. Thiếu: ${miss}.` : `Task: ${s.typeLabel}. Depth: ${s.depthLabel}. Missing: ${miss}.`,
    vi ? 'Viết lại thành 3 phiên bản bằng TIẾNG VIỆT, GIỮ NGUYÊN ý định và mọi chi tiết cụ thể (tên, đường dẫn, số liệu). TỰ ĐIỀN chi tiết còn thiếu bằng suy luận hợp lý từ ngữ cảnh bên dưới. Không để chỗ trống, không hỏi lại.'
       : 'Rewrite it as 3 versions in ENGLISH. KEEP the intent and every concrete detail (names, paths, numbers). FILL IN missing details by reasonable inference from the context below. No placeholders, no questions back.',
    vi ? 'A (Gọn): ngắn nhất, ý cốt lõi + 1 dòng đầu ra, ít token nhất. B (Chuẩn): mục tiêu, ngữ cảnh, đầu ra, ràng buộc, hoàn thành khi. C (Sâu): như B + nêu rủi ro/ca biên, tự kiểm tra, làm trọn vẹn.'
       : 'A (Lean): shortest, core intent + one output line, fewest tokens. B (Standard): goal, context, output, constraints, done when. C (Deep): like B + risks/edge cases, self-check, finish fully.',
    vi ? 'Mỗi bản dưới 120 từ, viết như lời người dùng nói với trợ lý. Định dạng trả về BẮT BUỘC, không thêm gì khác:\n<<<A>>>\n(bản A)\n<<<B>>>\n(bản B)\n<<<C>>>\n(bản C)'
       : 'Each under 120 words, written as the user speaking to the assistant. Return EXACTLY this format and nothing else:\n<<<A>>>\n(version A)\n<<<B>>>\n(version B)\n<<<C>>>\n(version C)',
    context ? (vi ? '\n## Ngữ cảnh (trích)\n' : '\n## Context (excerpt)\n') + String(context).slice(0, 3000) : '',
  ].join('\n');
  return { system, user: String(text) };
}

function parseVariants(out, s) {
  const j = {};
  const re = /<<<\s*([ABC])\s*>>>\s*([\s\S]*?)(?=<<<\s*[ABC]\s*>>>|$)/g;
  let m;
  while ((m = re.exec(String(out || '')))) j[m[1]] = m[2].replace(/^\s*\((?:bản|version) [ABC]\)\s*/i, '').trim();
  const lang = s.lang === 'vi' ? 'vi' : 'en';
  const options = ['A', 'B', 'C'].map((k) => ({ key: k, label: LABELS[lang][k], text: j[k] || '' })).filter((o) => o.text && !o.text.includes('⟨'));
  if (options.length < 2) return null;
  const rec = recommendedFor(s);
  return { options, recommended: options.some((o) => o.key === rec) ? rec : options[0].key, via: 'llm' };
}

module.exports = { available, info, score, skip, variantsByRules, llmPrompt, parseVariants, LABELS };
