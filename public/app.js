// OneChat UI. Plain DOM, no framework. All server calls carry the per-run token from the page.
(() => {
  'use strict';
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const TOKEN = $('meta[name="onechat-token"]').content;
  const IN_APP = /Electron/i.test(navigator.userAgent);

  const S = {
    state: null, lang: 'vi', convs: [], conv: null, provider: 'claude-cli', busy: false, abort: null,
    attach: [], memPick: new Map(), memOff: new Set(), an: null, anText: '', anSeq: 0,
    pg: null, panelTab: 'files', fs: { path: '', parent: null, items: [], sel: new Map(), results: null }, memItems: [], memOpen: new Set(),
    usage: null, quota: {}, justArrived: '', voice: { on: false }, setTab: 'ai', setFocus: '', dismissed: new Set(),
  };

  // ---- helpers ----------------------------------------------------------------------------
  function t(key, vars) {
    const dict = window.I18N[S.lang] || window.I18N.en;
    const s = dict[key] != null ? dict[key] : (window.I18N.en[key] != null ? window.I18N.en[key] : key);
    return String(s).replace(/\{(\w+)\}/g, (m, k) => (vars && vars[k] != null ? vars[k] : ''));
  }
  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k === 'html') n.innerHTML = v; // only ever fed MD.render output
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (k === 'value') n.value = v;
      else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'hidden' || k === 'open') n[k] = !!v;
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return n;
  }
  const kfmt = (n) => { n = Number(n) || 0; return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n); };
  const sizeFmt = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : b >= 1024 ? Math.round(b / 1024) + ' KB' : b + ' B');
  const money = (c) => (c == null ? '' : '$' + (c < 0.01 ? c.toFixed(4) : c.toFixed(2)));
  const debounce = (fn, ms) => { let h; return (...a) => { clearTimeout(h); h = setTimeout(() => fn(...a), ms); }; };
  const baseName = (p) => String(p).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || String(p);

  async function api(path, opts) {
    opts = opts || {};
    const headers = Object.assign({ 'x-onechat-token': TOKEN }, opts.headers || {});
    let body = opts.raw;
    if (opts.body !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(opts.body); }
    let res;
    try { res = await fetch(path, { method: opts.method || (body !== undefined ? 'POST' : 'GET'), headers, body, signal: opts.signal }); }
    catch (e) {
      if (e.name === 'AbortError') throw e;
      reconnect(); // no HTTP answer at all: the local server is gone; show the banner and keep trying
      throw Object.assign(new Error(''), { code: 'server_down', status: 0 });
    }
    const j = await res.json().catch(() => ({}));
    if (res.status === 401 && j.error === 'bad_token') sessionReload();
    if (!res.ok) throw Object.assign(new Error(j.message || j.error || String(res.status)), { code: j.error || 'http', status: res.status });
    return j;
  }
  // Pictures need the session token too, so they are fetched once and shown through object URLs.
  const blobUrls = new Map(), blobs = new Map();
  async function getBlob(path) {
    if (blobs.has(path)) return blobs.get(path);
    const res = await fetch(path, { headers: { 'x-onechat-token': TOKEN } });
    if (!res.ok) throw Object.assign(new Error(String(res.status)), { code: 'not_found' });
    const b = await res.blob();
    blobs.set(path, b);
    return b;
  }
  async function blobUrl(path) {
    if (!blobUrls.has(path)) blobUrls.set(path, URL.createObjectURL(await getBlob(path)));
    return blobUrls.get(path);
  }
  function picEl(path, alt) {
    const img = el('img', { alt: alt || '' });
    blobUrl(path).then((u) => { img.src = u; }).catch(() => { img.alt = '⚠ ' + (alt || ''); });
    return img;
  }
  const IMG_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' };
  const isPicture = (name, type) => /^image\//.test(type || '') || /\.(png|jpe?g|gif|webp|bmp)$/i.test(name || '');

  // ---- link to the local server -----------------------------------------------------------
  // One long-lived stream tells the server a window is open. If the server goes away the page
  // says so plainly and keeps probing; when it is back (same run, or restarted with a new
  // session token) the page reconnects by itself, keeping whatever was being typed.
  let linkBusy = false, linkTimer = 0;
  const DRAFT_KEY = 'onechat-draft', RELOAD_KEY = 'onechat-reloaded';
  function sessionReload() {
    try {
      if (Date.now() - Number(sessionStorage.getItem(RELOAD_KEY) || 0) < 15000) return false; // never loop
      sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
      sessionStorage.setItem(DRAFT_KEY, $('#input').value);
    } catch (_) { return false; }
    location.reload();
    return true;
  }
  async function reconnect() {
    clearTimeout(linkTimer);
    if (linkBusy) return;
    linkBusy = true;
    let up = false;
    try { up = (await fetch('/api/ping', { cache: 'no-store' })).ok; } catch (_) {}
    $('#offline').hidden = up;
    if (up) {
      try {
        const res = await fetch('/api/alive', { headers: { 'x-onechat-token': TOKEN } });
        if (res.status === 401) { if (sessionReload()) return; $('#offline').hidden = false; }
        else if (res.ok) { const reader = res.body.getReader(); for (;;) { const { done } = await reader.read(); if (done) break; } }
      } catch (_) {}
    }
    linkBusy = false;
    linkTimer = setTimeout(reconnect, up ? 1500 : 2000);
  }
  // In-page replacement for window.prompt(), which the desktop app does not provide.
  function askText(label, initial) {
    return new Promise((resolve) => {
      const input = el('textarea', { rows: 2 });
      input.value = initial || '';
      const done = (v) => { box.remove(); resolve(v); };
      const box = el('div', { id: 'ask', onmousedown: (e) => { if (e.target.id === 'ask') done(null); } },
        el('div', { class: 'box' }, el('div', { text: label }), input,
          el('div', { class: 'row' }, el('span', { class: 'spacer' }), el('button', { class: 'btn ghost small', onclick: () => done(null) }, t('cancel')), el('button', { class: 'btn primary small', onclick: () => done(input.value.trim()) }, t('ok')))));
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); done(input.value.trim()); } else if (e.key === 'Escape') { e.stopPropagation(); done(null); } });
      document.body.append(box);
      input.focus(); input.select();
    });
  }
  let toastTimer;
  function toast(msg, ms) {
    const n = $('#toast');
    n.textContent = msg; n.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { n.hidden = true; }, ms || 2600);
  }
  const errText = (code, message) => {
    const k = 'err_' + code;
    const known = (window.I18N[S.lang] || {})[k] || window.I18N.en[k];
    return (known || t('err_error')) + (message && !['aborted', 'no_key', 'no_base_url', 'cli_missing', 'no_model', 'server_down'].includes(code) ? ' — ' + message : '');
  };
  const settings = () => S.state.settings;
  const provOf = (id) => S.state.providers.find((p) => p.id === id) || null;
  const curProv = () => (S.provider === 'auto' ? null : provOf(S.provider));
  const taskName = (k) => t('task_' + k);

  async function saveSettings(patch, quiet) {
    try { S.state = await api('/api/settings', { body: patch }); if (!quiet) toast(t('saved'), 1200); }
    catch (e) { toast(errText(e.code, e.message)); }
  }

  // ---- i18n + theme -----------------------------------------------------------------------
  function applyI18n() {
    document.documentElement.lang = S.lang;
    for (const n of $$('[data-i18n]')) n.textContent = t(n.dataset.i18n);
    for (const n of $$('[data-i18n-ph]')) n.placeholder = t(n.dataset.i18nPh);
    for (const n of $$('[data-i18n-title]')) n.title = t(n.dataset.i18nTitle);
    $('#btnLang').textContent = S.lang === 'vi' ? 'VI → EN' : 'EN → VI';
  }
  function applyTheme() {
    const th = settings().theme;
    const dark = th === 'dark' || (th === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }

  // ---- "% left" per AI --------------------------------------------------------------------
  // Only what the provider itself reports, or the user's own monthly allowance. No figure, no badge.
  function clock(ms) {
    const d = new Date(ms), loc = S.lang === 'vi' ? 'vi-VN' : 'en-GB';
    const far = Math.abs(ms - Date.now()) > 20 * 3600 * 1000;
    return (far ? d.toLocaleDateString(loc, { day: '2-digit', month: '2-digit' }) + ' ' : '') + d.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' });
  }
  function quotaLines(q) {
    return (q.lines || []).map((l) => {
      if (l.type === 'spent') return t('q_spent', { time: clock(l.at) });
      if (l.type === 'balance') return t('q_balance', { amount: l.amount, cur: l.currency, time: clock(l.at) });
      if (l.type === 'budget') return t('q_budget', { pct: l.pct, used: l.used, budget: l.budget });
      return t('q_' + l.type, { pct: l.pct, time: l.resetsAt ? clock(l.resetsAt) : '—' });
    });
  }
  function quotaBadge(id) {
    const q = S.quota && S.quota[id];
    if (!q || q.kind === 'unknown') return null;
    if (q.kind === 'balance') return el('span', { class: 'q', text: (q.currency === 'USD' ? '$' : '') + Number(q.amount).toFixed(2) + (q.currency === 'USD' ? '' : ' ' + q.currency) });
    return el('span', { class: 'q ' + (q.pct < 20 ? 'low' : q.pct < 50 ? 'mid' : 'high'), text: (q.kind === 'rate' ? '⚡' : '') + q.pct + '%' });
  }
  const quotaText = (id) => { const q = S.quota && S.quota[id]; return q && q.lines && q.lines.length ? quotaLines(q).join('\n') : t('q_unknown'); };

  // ---- top bar: provider pills + model ----------------------------------------------------
  function renderPills() {
    const box = $('#pills');
    box.textContent = '';
    box.append(el('button', { class: 'pill' + (S.provider === 'auto' ? ' active' : ''), title: t('auto_tip'), onclick: () => setProvider('auto') }, '✨ ', t('auto')));
    let i = 0;
    for (const p of S.state.providers) {
      if (!(p.main || p.ready || p.id === S.provider)) continue;
      i += 1;
      const dot = p.ready ? 'ready' : 'off';
      box.append(el('button', { class: 'pill' + (S.provider === p.id ? ' active' : ''), title: t('st_' + p.status) + (i <= 9 ? '  (Alt+' + i + ')' : '') + (p.ready ? '\n' + quotaText(p.id) : ''), 'aria-label': p.label + ' — ' + t('st_' + p.status), 'aria-pressed': S.provider === p.id ? 'true' : 'false', 'data-prov': p.id, onclick: () => setProvider(p.id) },
        el('span', { class: 'dot ' + dot }), p.label, p.ready ? quotaBadge(p.id) : el('span', { class: 'key', text: '🔑' })));
    }
    box.append(el('button', { class: 'pill', title: t('more_ai_tip'), onclick: () => openSettings('ai') }, '＋'));
  }
  function renderModel() {
    const sel = $('#modelSel');
    const p = curProv();
    sel.textContent = '';
    sel.disabled = !p;
    $('#btnRefreshModels').disabled = !p || p.kind === 'claude-cli';
    if (!p) { sel.append(el('option', { text: t('auto_model') })); return; }
    const list = p.models.slice();
    if (p.model && !list.includes(p.model)) list.unshift(p.model);
    if (!list.length) sel.append(el('option', { value: '', text: t('no_model') }));
    for (const m of list) sel.append(el('option', { value: m, text: m, selected: m === p.model }));
    sel.append(el('option', { value: '__other__', text: t('other_model') }));
  }
  async function setProvider(id) {
    S.provider = id;
    renderPills(); renderModel(); renderDraft();
    await saveSettings(id === 'auto' ? { autoRoute: true } : { autoRoute: false, provider: id }, true);
    $('#autoRoute').checked = S.provider === 'auto';
    renderPills(); renderModel(); renderDraft();
    $('#input').focus();
  }
  async function setModel(m) {
    const p = curProv();
    if (!p || !m) return;
    await saveSettings({ models: { [p.id]: m } }, true);
    renderPills(); renderModel(); renderDraft();
  }
  async function refreshModels() {
    const p = curProv();
    if (!p) return;
    toast(t('loading_models'));
    try {
      const r = await api('/api/providers/models', { body: { provider: p.id } });
      S.state = r.state;
      toast(t('models_loaded', { n: r.models.length }));
      const now = provOf(p.id);
      if (now && !now.model && r.models.length) await setModel(r.models[0]);
      renderPills(); renderModel(); renderDraft();
    } catch (e) { toast(errText(e.code, e.message), 4500); }
  }

  // ---- sidebar ----------------------------------------------------------------------------
  async function loadConvs() { S.convs = (await api('/api/conversations')).conversations; renderConvs(); }
  function renderConvs() {
    const box = $('#convList');
    const q = $('#convSearch').value.trim().toLowerCase();
    box.textContent = '';
    const start = new Date(); start.setHours(0, 0, 0, 0);
    let group = '';
    for (const c of S.convs) {
      if (q && !String(c.title || '').toLowerCase().includes(q)) continue;
      const g = c.updated >= start.getTime() ? t('today') : t('earlier');
      if (g !== group) { group = g; box.append(el('div', { class: 'conv-group', text: g })); }
      const p = provOf(c.provider);
      box.append(el('div', { class: 'conv' + (S.conv && S.conv.id === c.id ? ' active' : ''), title: (p ? p.label + ' · ' : '') + (c.model || ''), onclick: () => openConv(c.id), ondblclick: () => renameConv(c) },
        el('span', { class: 'title', text: c.title || t('untitled') }),
        el('button', { class: 'del', title: t('delete'), onclick: (e) => { e.stopPropagation(); deleteConv(c); } }, '🗑')));
    }
    if (!box.children.length) box.append(el('div', { class: 'muted small pad', text: q ? t('no_match') : t('no_chats') }));
  }
  async function openConv(id) {
    if (S.busy) return;
    try { S.conv = await api('/api/conversations/' + id); } catch (e) { toast(errText(e.code, e.message)); return; }
    if (S.provider !== 'auto' && provOf(S.conv.provider)) { S.provider = S.conv.provider; renderPills(); renderModel(); }
    closePg(); renderConvs(); renderMessages(); renderDraft();
    $('#input').focus();
  }
  function newChat() {
    if (S.busy) return;
    S.conv = null; S.dismissed.clear();
    closePg(); renderConvs(); renderMessages(); renderDraft();
    $('#input').focus();
  }
  async function renameConv(c) {
    const title = await askText(t('rename_prompt'), c.title || '');
    if (title == null) return;
    await api('/api/conversations/' + c.id + '/rename', { body: { title } });
    if (S.conv && S.conv.id === c.id) S.conv.title = title;
    await loadConvs();
  }
  async function deleteConv(c) {
    if (!window.confirm(t('delete_confirm', { title: c.title || t('untitled') }))) return;
    await api('/api/conversations/' + c.id, { method: 'DELETE' });
    if (S.conv && S.conv.id === c.id) newChat();
    await loadConvs();
  }
  async function loadUsage() {
    try { S.usage = await api('/api/usage'); } catch (_) { return; }
    S.quota = S.usage.quota || {};
    renderPills();
    const d = S.usage.today || {};
    $('#todayUsage').textContent = t('today_usage', { n: d.n || 0, in: kfmt(d.in), out: kfmt(d.out) }) + (d.cost ? ' · ' + money(d.cost) : '');
    if (!$('#panel').hidden && S.panelTab === 'habits') renderHabits();
  }

  // ---- messages ---------------------------------------------------------------------------
  const chipStatic = (cls, label, extra, title) => el('span', { class: 'chip static ' + (cls || ''), title: title || label }, el('span', { class: 'name', text: label }), extra ? el('span', { class: 'tk', text: extra }) : null);

  function usageText(m) {
    const u = m.usage;
    if (!u) return '';
    const parts = [(u.estimated ? '≈ ' : '') + '↑' + kfmt(u.in) + ' ↓' + kfmt(u.out)];
    if (u.cacheRead) parts.push('cache ' + kfmt(u.cacheRead));
    if (m.cost != null && m.cost > 0) parts.push((m.notionalCost ? '≈' : '') + money(m.cost));
    return parts.join(' · ');
  }
  function noticeText(n) { return t('notice_' + n.code, { detail: n.detail || '' }); }

  function userEl(m) {
    const d = el('div', { class: 'msg user', 'data-id': m.id });
    const c = m.ctx || {};
    if ((c.images || []).length) d.append(el('div', { class: 'pics' }, ...c.images.map((x) => el('span', { class: 'pic', title: x.name + ' · ≈' + kfmt(x.tokens) + ' tokens' }, picEl('/api/media/' + x.id, x.name)))));
    if (m.text) d.append(el('div', { class: 'bubble', text: m.text }));
    const ctx = el('div', { class: 'ctx' });
    for (const f of c.files || []) ctx.append(chipStatic(f.sensitive ? 'warn' : '', (f.kind === 'tree' ? '📁 ' : '📄 ') + f.name, '≈' + kfmt(f.tokens) + (f.truncated ? ' · ' + t('truncated') : ''), f.path || f.name));
    for (const e of c.fileErrors || []) ctx.append(chipStatic('warn', '⚠ ' + e.name, t('ferr_' + e.code)));
    for (const x of c.memory || []) ctx.append(chipStatic('mem', '🧠 ' + x.name, '≈' + kfmt(x.tokens)));
    if (c.masked) ctx.append(chipStatic('', '🔒 ' + t('masked', { n: c.masked })));
    if (ctx.children.length) d.append(ctx);
    return d;
  }
  function asstEl(m, last) {
    const p = provOf(m.provider);
    const d = el('div', { class: 'msg asst' + (last ? ' last' : ''), 'data-id': m.id || '' });
    d.append(el('div', { class: 'head' }, el('span', { class: 'who', text: p ? p.label : m.provider }), el('span', { class: 'badge', text: m.modelUsed || m.model || '' }),
      m.task ? el('span', { class: 'badge', text: taskName(m.task) }) : null, el('span', { class: 'use', text: usageText(m), title: m.notionalCost ? t('notional_tip') : '' })));
    if (m.thinking) d.append(el('details', { class: 'think' }, el('summary', { text: t('thinking') }), el('div', { class: 't', text: m.thinking })));
    if (m.agent && m.agent.steps && (m.agent.rounds > 0 || m.agent.steps.length > 1)) { // a draft that only asked a question has nothing to show
      const a = m.agent;
      const list = el('div', { class: 't' });
      for (const s of a.steps) {
        const who = (provOf(s.provider) || {}).label || s.provider;
        list.append(el('div', { text: s.node !== 'review' ? t('step_' + s.node, { who, n: s.round || 0 }) : s.score == null ? t('review_unread', { n: s.round }) : t('review_line', { n: s.round, score: s.score }) + ' · ' + who + (s.issues && s.issues.length ? ' — ' + s.issues.join('; ') : '') }));
      }
      if (a.lessonSaved) list.append(el('div', { text: t('lesson_saved', { text: a.lessonSaved }) }));
      d.append(el('details', { class: 'think' }, el('summary', { text: t('agent_summary', { rounds: a.rounds, first: a.firstScore == null ? '–' : a.firstScore, last: a.finalScore == null ? '–' : a.finalScore }) }), list));
    }
    if (m.council && m.council.members) {
      const c = m.council, name = (id) => (provOf(id) || {}).label || id;
      const list = el('div', { class: 't' });
      for (const x of c.members) list.append(el('div', { text: (x.ok ? '✓ ' : '✗ ') + name(x.provider) + ' · ' + x.model + ' — ' + (x.ok ? (x.ms / 1000).toFixed(1) + 's · ' + kfmt(x.chars) + ' ' + t('chars') : errText(x.error, '')) }));
      if (c.judge) list.append(el('div', { text: '⚖ ' + name(c.judge.provider) + ' · ' + c.judge.model + (c.judge.ok ? '' : ' — ' + errText(c.judge.error, '')) }));
      d.append(el('details', { class: 'think' }, el('summary', { text: t('council_summary', { ok: c.members.filter((x) => x.ok).length, n: c.members.length, judge: c.judge && c.judge.ok ? name(c.judge.provider) : '—' }) }), list));
    }
    if (m.operator && (m.operator.steps || []).length) {
      const o = m.operator, list = el('div', { class: 't' });
      for (const s of o.steps) list.append(el('div', { text: (s.ok ? '✓ ' : '✗ ') + toolLine(s) }));
      d.append(el('details', { class: 'think' }, el('summary', { text: t('op_summary', { n: o.steps.length, files: (o.files || []).length }) + (o.limit ? ' · ' + t('op_limit') : '') }), list));
    }
    const body = el('div', { class: 'body', html: window.MD.render(m.text || '') });
    window.Studio.enhance(body, { live: !!m.id && m.id === S.justArrived, last: !!last && !!m.id }); // mind maps, charts, drawings, pictures, videos, questions back
    d.append(body);
    // Files this turn saved into the task's output folder: one click opens a file or the folder.
    if (m.operator && (m.operator.files || []).length) {
      d.append(el('div', { class: 'files' }, ...m.operator.files.map((f) => el('button', { class: 'chip filebtn', title: t('out_open_file'), onclick: () => openOutput(f.name) }, '📄 ' + f.name + ' · ' + sizeFmt(f.bytes))),
        el('button', { class: 'btn ghost small', onclick: () => openOutput() }, '📂 ' + t('out_folder'))));
    }
    // The rollback path: every version kept before a risky step can be put back with one click.
    if (m.operator && (m.operator.backups || []).length) {
      d.append(el('div', { class: 'files' }, ...m.operator.backups.map((b) => el('button', { class: 'chip filebtn', title: b.rel, onclick: () => restoreOutput(b) }, '↶ ' + (b.kind === 'file' ? t('restore_file', { name: b.of }) : t('restore_folder'))))));
    }
    for (const n of m.notices || []) d.append(el('div', { class: 'notice', text: '⚠ ' + noticeText(n) }));
    if (m.partial) d.append(el('div', { class: 'notice', text: '⚠ ' + t('partial') }));
    if (m.id) {
      const a = el('div', { class: 'actions' });
      a.append(el('button', { class: 'act', title: t('copy'), onclick: () => copyText(m.text) }, '⧉ ' + t('copy')));
      a.append(el('button', { class: 'act' + (m.vote > 0 ? ' on' : ''), title: t('vote_up_tip'), onclick: () => vote(m, 1) }, '👍'));
      a.append(el('button', { class: 'act' + (m.vote < 0 ? ' on' : ''), title: t('vote_down_tip'), onclick: () => vote(m, -1) }, '👎'));
      if (last) a.append(el('button', { class: 'act', title: t('regen_tip'), onclick: () => send({ regenerate: true }) }, '↻ ' + t('regen')));
      if (last) a.append(el('button', { class: 'act', title: t('improve_tip'), onclick: async () => { const fb = await askText(t('improve_prompt'), ''); if (fb !== null) send({ improve: true, feedback: fb }); } }, '🔁 ' + t('improve')));
      a.append(el('button', { class: 'act', title: t('remember_tip'), onclick: () => remember(m) }, '📌 ' + t('remember')));
      a.append(el('button', { class: 'act', title: t('save_answer_tip'), onclick: () => saveToFolder(answerName(m.text) + '.md', m.text) }, '💾 ' + t('save_answer')));
      d.append(a);
    }
    return d;
  }
  function welcomeEl() {
    const ready = S.state.providers.filter((p) => p.ready).map((p) => p.label).join(', ');
    return el('div', { class: 'welcome' },
      el('h1', { text: t('welcome_title') }), el('p', { text: t('welcome_sub', { ready: ready || '—' }) }),
      el('div', { class: 'cards' },
        el('div', { class: 'wcard' }, el('b', { text: t('w1_t') }), t('w1_d')),
        el('div', { class: 'wcard' }, el('b', { text: t('w2_t') }), t('w2_d')),
        el('div', { class: 'wcard' }, el('b', { text: t('w3_t') }), t('w3_d')),
        el('div', { class: 'wcard' }, el('b', { text: t('w4_t') }), t('w4_d'))),
      el('p', { class: 'small', style: 'margin-top:16px' }, el('kbd', { text: 'Enter' }), ' ' + t('k_send') + ' · ', el('kbd', { text: 'Shift+Enter' }), ' ' + t('k_newline') + ' · ', el('kbd', { text: 'Ctrl+M' }), ' ' + t('k_mic') + ' · ', el('kbd', { text: 'Ctrl+K' }), ' ' + t('k_new') + ' · ', el('kbd', { text: 'Alt+1…9' }), ' ' + t('k_switch')));
  }
  function renderMessages() {
    const box = $('#messages');
    box.textContent = '';
    const msgs = (S.conv && S.conv.messages) || [];
    if (!msgs.length) { box.append(welcomeEl()); renderMeter(); return; }
    if (S.conv.summary) box.append(el('details', { class: 'think' }, el('summary', { text: t('summary_label', { n: S.conv.summaryUpTo }) }), el('div', { class: 't', text: S.conv.summary })));
    msgs.forEach((m, i) => box.append(m.role === 'user' ? userEl(m) : asstEl(m, i === msgs.length - 1)));
    box.scrollTop = box.scrollHeight;
    renderMeter();
  }
  function renderMeter() {
    $('#meter').textContent = S.conv && S.conv.tokens ? t('conv_tokens', { n: kfmt(S.conv.tokens) }) : '';
  }
  const nearBottom = () => { const b = $('#messages'); return b.scrollHeight - b.scrollTop - b.clientHeight < 140; };
  async function copyText(text) { try { await navigator.clipboard.writeText(text || ''); toast(t('copied'), 1200); } catch (_) { toast(t('copy_failed')); } }
  async function vote(m, value) {
    try { const r = await api('/api/chat/feedback', { body: { convId: S.conv.id, messageId: m.id, value } }); m.vote = r.vote; renderMessages(); toast(t(value > 0 ? 'voted_up' : 'voted_down'), 1600); loadUsage(); }
    catch (e) { toast(errText(e.code, e.message)); }
  }
  async function remember(m) {
    const title = await askText(t('remember_prompt'), (S.conv && S.conv.title) || '');
    if (title == null) return;
    try { await api('/api/memory/note', { body: { title, text: m.text } }); toast(t('remembered')); S.state = await api('/api/state'); if (S.panelTab === 'memory') loadMemory(); }
    catch (e) { toast(errText(e.code, e.message)); }
  }

  // ---- composer: draft analysis, chips, hints ---------------------------------------------
  const inputText = () => $('#input').value.trim();
  function autoGrow() { const a = $('#input'); a.style.height = 'auto'; a.style.height = Math.min(a.scrollHeight, window.innerHeight * 0.38) + 'px'; }
  async function analyzeNow() {
    const text = inputText();
    if (!text) { S.anSeq += 1; S.an = null; S.anText = ''; renderDraft(); return; }
    const seq = ++S.anSeq;
    let r = null;
    try { r = await api('/api/analyze', { body: { text, convId: S.conv ? S.conv.id : null } }); } catch (_) {}
    if (seq !== S.anSeq) return;
    S.an = r; S.anText = text;
    renderDraft();
  }
  const analyzeSoon = debounce(analyzeNow, 320);

  const memAutoOn = () => !!settings().memory.enabled;
  const autoMem = () => (memAutoOn() && S.an && S.an.memory ? S.an.memory.filter((m) => !S.memOff.has(m.id) && !S.memPick.has(m.id)) : []);
  function renderChips() {
    const box = $('#chips');
    box.textContent = '';
    S.attach.forEach((a, i) => box.append(el('span', { class: 'chip' + (a.sensitive ? ' warn' : ''), title: a.path || a.name },
      a.image && a.thumb ? el('img', { class: 'th', src: a.thumb, alt: '' }) : null,
      el('span', { class: 'name', text: (a.image ? '' : a.folder ? '📁 ' : '📄 ') + a.name }), a.size ? el('span', { class: 'tk', text: (a.image && a.w ? a.w + '×' + a.h + ' · ' : '') + sizeFmt(a.size) }) : null,
      el('button', { title: t('remove'), onclick: () => { S.attach.splice(i, 1); renderDraft(); } }, '×'))));
    for (const [id, m] of S.memPick) box.append(el('span', { class: 'chip mem', title: m.description || m.name },
      el('span', { class: 'name', text: '🧠 ' + m.name }), el('span', { class: 'tk', text: '≈' + kfmt(m.tokens) }),
      el('button', { title: t('remove'), onclick: () => { S.memPick.delete(id); renderDraft(); renderMemory(); } }, '×')));
    for (const m of autoMem()) box.append(el('span', { class: 'chip mem', title: t(m.reason === 'pinned' ? 'mem_pinned_tip' : 'mem_auto_tip') + '\n' + (m.description || '') },
      el('span', { class: 'name', text: (m.reason === 'pinned' ? '📌 ' : '🧠 ') + m.name }), el('span', { class: 'tk', text: '≈' + kfmt(m.tokens) + (m.truncated ? ' · ' + t('truncated') : '') }),
      el('button', { title: t('remove'), onclick: () => { S.memOff.add(m.id); renderDraft(); } }, '×')));
  }
  function hint(key, cls, kids) {
    if (S.dismissed.has(key)) return null;
    return el('div', { class: 'hint ' + (cls || '') }, ...kids, el('button', { class: 'icon x', title: t('dismiss'), onclick: () => { S.dismissed.add(key); renderHints(); } }, '✕'));
  }
  function renderHints() {
    const box = $('#hints');
    box.textContent = '';
    const p = curProv();
    if (p && !p.ready) {
      const kids = [el('span', { text: '🔑 ' + t(p.id === 'copilot' ? 'hint_copilot' : 'hint_' + p.status, { label: p.label }) })];
      if (p.status !== 'missing_cli') kids.push(el('button', { class: 'btn small primary', onclick: () => openSettings('ai', p.id) }, t('enter_key')));
      // Leaving the window is never automatic. Copilot alone has no API, so it keeps an explicit, opt-in link.
      if (p.id === 'copilot' && p.web) kids.push(el('button', { class: 'btn ghost small', title: t('open_web_tip'), onclick: () => handoff(p, inputText()) }, t('open_web', { label: p.label })));
      box.append(el('div', { class: 'hint warn' }, ...kids));
    }
    // A picture is attached but this AI cannot see: say who will read it instead, before sending.
    if (p && p.ready && !p.vision && S.attach.some((a) => a.image)) {
      const helper = settings().vision.bridge && S.state.visionHelper ? provOf(S.state.visionHelper) : null;
      box.append(el('div', { class: 'hint' }, el('span', { text: '🖼 ' + (helper ? t('hint_vision_bridge', { label: p.label, helper: helper.label }) : t('hint_no_vision', { label: p.label })) })));
    }
    // A request that needs the web runs in operator mode by itself: say so before it is sent, with a way out.
    if (S.an && S.an.operator && inputText() && !settings().operator.enabled && settings().operator.auto !== false) {
      box.append(el('div', { class: 'hint' }, el('span', { text: '🖱 ' + t(S.noAutoOp ? 'hint_operator_skip' : 'hint_operator_auto') }),
        el('button', { class: 'btn small', onclick: () => { S.noAutoOp = !S.noAutoOp; renderHints(); } }, t(S.noAutoOp ? 'op_auto_undo' : 'op_auto_once'))));
    }
    const rec = S.an && S.an.recommend;
    if (rec && S.provider !== 'auto' && (rec.provider !== S.provider || (p && rec.model && rec.model !== p.model))) {
      const rp = provOf(rec.provider);
      const h = rp && hint('rec:' + S.an.task + rec.provider + rec.model, '', [
        el('span', { text: '💡 ' + t(rec.reason === 'pin' ? 'rec_pin' : 'rec_habit', { task: taskName(S.an.task), label: rp.label, model: rec.model, n: rec.n }) }),
        el('button', { class: 'btn small', onclick: async () => { await saveSettings({ models: { [rec.provider]: rec.model } }, true); await setProvider(rec.provider); } }, t('switch'))]);
      if (h) box.append(h);
    }
    const lim = Number(settings().context.compactAt) || 0;
    if (S.conv && lim && S.conv.tokens > lim) {
      const h = hint('compact:' + S.conv.id + ':' + (S.conv.summaryUpTo || 0), '', [
        el('span', { text: '🗜 ' + t('hint_compact', { n: kfmt(S.conv.tokens) }) }),
        el('button', { class: 'btn small', onclick: compactConv }, t('compact'))]);
      if (h) box.append(h);
    }
  }
  function renderDraft() {
    const sc = $('#pgScore');
    const pgi = S.an && S.an.pg;
    sc.textContent = pgi ? String(pgi.score) : '';
    sc.className = 'score ' + (pgi ? (pgi.score < 50 ? 'low' : pgi.score < 75 ? 'mid' : 'high') : '');
    $('#btnOptimize').title = pgi ? t('pg_badge_tip', { score: pgi.score, type: pgi.type, missing: pgi.missing.join(', ') || '—' }) : t('optimize_tip');
    $('#btnOptimize').hidden = !S.state.promptgate.available || settings().promptgate.mode === 'off';
    $('#btnMemory').classList.toggle('on', memAutoOn());
    $('#btnAgent').classList.toggle('on', !!settings().agent.enabled);
    $('#btnCouncil').classList.toggle('on', !!settings().council.enabled);
    $('#btnOperator').classList.toggle('on', !!settings().operator.enabled);
    renderChips(); renderHints();
    const memTok = autoMem().reduce((s, m) => s + m.tokens, 0) + [...S.memPick.values()].reduce((s, m) => s + m.tokens, 0);
    const draft = (S.an ? S.an.tokens : 0) + memTok;
    $('#draftTokens').textContent = draft ? t('draft_tokens', { n: kfmt(draft) }) + (S.an && S.an.task && inputText() ? ' · ' + taskName(S.an.task) : '') : '';
    $('#btnSend').textContent = S.busy ? t('stop') : t('send');
    $('#btnSend').classList.toggle('danger', S.busy);
  }

  // ---- PromptGate card --------------------------------------------------------------------
  function closePg() { if (S.pg && S.pg.abort) S.pg.abort.abort(); S.pg = null; $('#pgCard').hidden = true; }
  function renderPg(v, status) {
    const box = $('#pgCard');
    box.textContent = '';
    box.hidden = false;
    const head = el('div', { class: 'pg-head' }, el('b', { text: 'PromptGate ▸ ' + (v.score != null ? v.score + '/100' : '…') }));
    if (v.type) head.append(el('span', { class: 'badge', text: v.type }), el('span', { class: 'badge', text: t('depth') + ' ' + v.depth }));
    if (v.missing && v.missing.length) head.append(el('span', { class: 'muted', text: t('pg_missing') + ': ' + v.missing.join(', ') }));
    head.append(el('span', { class: 'spacer' }), el('button', { class: 'icon', title: 'Esc', onclick: closePg }, '✕'));
    box.append(head);
    if (v.tip) box.append(el('div', { class: 'muted small', text: '💡 ' + v.tip }));
    const opts = el('div', { class: 'pg-opts' });
    for (const o of v.options || []) {
      opts.append(el('div', { class: 'pg-opt' + (o.key === v.recommended ? ' rec' : '') },
        el('div', { class: 'lab' }, o.label, o.key === v.recommended ? el('span', { class: 'badge', text: t('recommended') }) : null, el('span', { class: 'spacer' }), el('span', { class: 'muted small', text: '≈' + kfmt(Math.ceil(o.text.length / 3)) })),
        el('div', { class: 'txt', text: o.text }),
        el('div', { class: 'row' },
          el('button', { class: 'btn ghost small', title: t('pg_edit_tip'), onclick: () => { const a = $('#input'); a.value = o.text; closePg(); autoGrow(); a.focus(); analyzeNow(); } }, '✎ ' + t('edit')),
          el('button', { class: 'btn primary small', onclick: () => send({ text: o.text, skipPg: true }) }, t('use_this')))));
    }
    if ((v.options || []).length) box.append(opts);
    box.append(el('div', { class: 'row' },
      el('span', { class: 'muted small', text: status === 'llm' ? '✨ ' + t('pg_llm_wait') : status === 'loading' ? t('pg_loading') : v.via === 'llm' ? '✨ ' + t('pg_via_llm') : t('pg_via_rules') }),
      el('span', { class: 'spacer' }),
      el('span', { class: 'muted small', text: t('pg_enter_again') }),
      el('button', { class: 'btn small', onclick: () => send({ text: S.pg ? S.pg.text : inputText(), skipPg: true }) }, t('send_original'))));
  }
  async function openPg(text, manual) {
    closePg();
    const ac = new AbortController();
    S.pg = { text, abort: ac };
    renderPg({ options: [] }, 'loading');
    const base = { text, convId: S.conv ? S.conv.id : null, fileNames: S.attach.map((a) => a.name), memoryNames: [...S.memPick.values()].map((m) => m.name).concat(autoMem().map((m) => m.name)) };
    let v;
    try { v = await api('/api/promptgate/variants', { body: base, signal: ac.signal }); } catch (_) { v = null; }
    if (!S.pg || S.pg.text !== text) return;
    const canLlm = settings().promptgate.rewrite === 'auto' && !!S.state.helper;
    if (!v || v.unavailable || (!(v.options || []).length && !canLlm)) { closePg(); if (!manual) send({ text, skipPg: true }); else toast(t('pg_nothing')); return; }
    renderPg(v, canLlm ? 'llm' : '');
    if (!canLlm) return;
    try {
      const v2 = await api('/api/promptgate/variants', { body: Object.assign({ llm: true }, base), signal: ac.signal });
      if (!S.pg || S.pg.text !== text) return;
      renderPg(v2.options && v2.options.length ? v2 : v, '');
    } catch (_) { if (S.pg && S.pg.text === text) renderPg(v, ''); }
  }

  // ---- send / stream ----------------------------------------------------------------------
  async function handoff(p, text) {
    if (!text) { window.open(p.web, '_blank', 'noopener'); return; }
    try { await navigator.clipboard.writeText(text); toast(t('handoff_done', { label: p.label }) + (S.attach.length ? ' ' + t('handoff_files') : ''), 5000); }
    catch (_) { toast(t('copy_failed')); }
    window.open(p.web, '_blank', 'noopener');
  }
  function setBusy(b) { S.busy = b; renderDraft(); }

  async function send(opts) {
    opts = opts || {};
    if (S.busy) return;
    const regen = !!opts.regenerate || !!opts.improve;
    let text = opts.text != null ? String(opts.text).trim() : inputText();
    const raw = text.startsWith('//');
    if (raw) text = text.slice(2).trim();
    if (!regen && !text && !S.attach.length) return;
    const p = curProv();
    // An AI that is not set up yet is fixed here, in this window: never by opening another one.
    if (p && !p.ready) { toast(t(p.id === 'copilot' ? 'hint_copilot' : 'hint_' + p.status, { label: p.label }), 5000); return openSettings('ai', p.id); }
    if (!regen && opts.text == null && S.anText !== inputText()) await analyzeNow();
    const mode = settings().promptgate.mode;
    if (!regen && !raw && !opts.skipPg && mode === 'suggest' && S.state.promptgate.available && S.an && S.an.pg && S.an.pg.weak && !(S.pg && S.pg.text === text)) return openPg(text);
    closePg();

    const mem = regen ? [] : [...S.memPick.entries()].map(([id, m]) => ({ id, tokens: m.tokens })).concat(autoMem().map((m) => ({ id: m.id, tokens: m.tokens })));
    const body = {
      convId: S.conv ? S.conv.id : null, text, provider: S.provider, model: p ? p.model : '', regenerate: regen, agent: !!settings().agent.enabled, council: !!settings().council.enabled, operator: !!settings().operator.enabled, noAutoOperator: !!S.noAutoOp, improve: !!opts.improve, feedback: opts.feedback || '',
      files: regen ? [] : S.attach.filter((a) => a.path).map((a) => a.path),
      inline: regen ? [] : S.attach.filter((a) => a.data).map((a) => ({ name: a.name, data: a.data, type: a.type || '', w: a.w || 0, h: a.h || 0 })),
      memoryIds: mem.map((m) => m.id), memoryLimits: Object.fromEntries(mem.map((m) => [m.id, m.tokens])),
    };
    const restore = { value: $('#input').value, attach: S.attach.slice(), pick: new Map(S.memPick) };
    if (!regen) { $('#input').value = ''; S.attach = []; S.memPick.clear(); S.memOff.clear(); S.an = null; S.anText = ''; S.noAutoOp = false; autoGrow(); }
    const ac = new AbortController();
    S.abort = ac;
    setBusy(true);

    const box = $('#messages');
    let live = null, textOut = '', think = '', raf = 0, gotMeta = false, final = null, failed = null;
    const notices = [];
    const paint = () => {
      raf = 0;
      if (!live) return;
      const stick = nearBottom();
      live.body.innerHTML = window.MD.render(textOut);
      live.body.classList.toggle('cursor', true);
      if (think) { live.think.hidden = false; live.thinkText.textContent = think; }
      if (stick) box.scrollTop = box.scrollHeight;
    };
    // A timer, not requestAnimationFrame: frames stop while the window is minimized or
    // covered, and the answer should still be there when the user looks again.
    const schedule = () => { if (!raf) raf = setTimeout(paint, 70); };
    const onEvent = (ev) => {
      if (ev.type === 'meta') {
        gotMeta = true;
        if (!S.conv || S.conv.id !== ev.convId) S.conv = { id: ev.convId, title: ev.title, messages: [], tokens: 0, summary: '' };
        if (regen) while (S.conv.messages.length && S.conv.messages[S.conv.messages.length - 1].role === 'assistant') S.conv.messages.pop();
        else S.conv.messages.push(ev.userMessage);
        S.conv.title = ev.title;
        renderMessages();
        const pr = provOf(ev.provider);
        const d = el('div', { class: 'msg asst last' });
        const thinkText = el('div', { class: 't' });
        const thinkBox = el('details', { class: 'think', hidden: true }, el('summary', { text: t('thinking') }), thinkText);
        const bodyEl = el('div', { class: 'body cursor' });
        const stepsBox = el('div', { class: 'steps' });
        d.append(el('div', { class: 'head' }, el('span', { class: 'who', text: pr ? pr.label : ev.provider }), el('span', { class: 'badge', text: ev.model }), el('span', { class: 'badge', text: taskName(ev.task) }),
          ev.routed ? el('span', { class: 'badge', text: '✨ ' + t('auto') }) : null, ev.council ? el('span', { class: 'badge', text: '👥 ' + t('council') }) : null, ev.operator ? el('span', { class: 'badge', text: '🖱 ' + t('operator') }) : null, el('span', { class: 'use', text: '≈ ↑' + kfmt(ev.estIn) })), stepsBox, thinkBox, bodyEl);
        if (ev.dropped) d.append(el('div', { class: 'notice', text: '⚠ ' + t('dropped', { n: ev.dropped }) }));
        box.append(d);
        box.scrollTop = box.scrollHeight;
        live = { root: d, body: bodyEl, think: thinkBox, thinkText, steps: stepsBox };
        if (S.provider === 'auto' && pr) { $('#modelSel').textContent = ''; $('#modelSel').append(el('option', { text: pr.label + ' · ' + ev.model })); }
      } else if (ev.type === 'step' && live && /^op_/.test(ev.node)) {
        // Operator mode: what the AI is doing on the computer, one line per step.
        if (live.wait) { live.wait.remove(); live.wait = null; }
        if (ev.node === 'op_think') { live.wait = el('div', { class: 'muted', text: t('step_op_think', { n: ev.n }) }); live.steps.append(live.wait); }
        else if (ev.node === 'op_tool') live.steps.append(el('div', { text: toolLine(ev) }));
        else if (ev.detail) live.steps.append(el('div', { class: ev.node === 'op_done' ? 'ok sub' : 'no sub', text: (ev.node === 'op_done' ? '✓ ' : '✗ ') + ev.detail }));
        box.scrollTop = box.scrollHeight;
      } else if (ev.type === 'file' && live) {
        live.steps.append(el('div', { class: 'ok sub', text: '📄 ' + t('file_saved', { name: ev.name }) }));
      } else if (ev.type === 'ask' && live) {
        // The AI stops here until the user decides: nothing risky happens without this click.
        let ask = null;
        const answer = async (allow, text) => { if (ask) ask.remove(); try { await api('/api/operator/answer', { body: { id: ev.id, allow, text: text || undefined } }); } catch (_) { /* the turn has ended */ } };
        const wait = ev.kind === 'wait';
        if (ev.kind === 'choice') {
          // The AI is not sure: pick one of its options (its recommendation first) or answer in your own words.
          const own = el('input', { type: 'text', class: 'ask-own', placeholder: t('ask_own_ph') });
          const go = () => { const v = own.value.trim(); if (v) answer(true, v); };
          own.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); go(); } });
          ask = el('div', { class: 'askbox' }, el('div', { class: 'q1', text: '❓ ' + (ev.text || '') }),
            el('div', { class: 'ask-opts' }, ...(ev.options || []).map((o, i) => el('button', { class: 'ask-opt' + (i === ev.recommended ? ' rec' : ''), onclick: () => answer(true, o.label) },
              el('span', { class: 'ask-lab', text: (i === ev.recommended ? '★ ' : '') + o.label }), o.detail ? el('span', { class: 'ask-det', text: o.detail }) : null))),
            el('div', { class: 'ask-row' }, own, el('button', { class: 'btn primary small', onclick: go }, t('ask_own_send')), el('button', { class: 'btn ghost small', onclick: () => answer(false) }, t('ask_skip'))));
        } else {
          ask = el('div', { class: 'askbox' },
            el('div', { class: 'q1', text: wait ? '🙋 ' + t('ask_wait') : '🔐 ' + t('ask_approve', { what: t('tool_' + ev.tool) }) }),
            el('div', { class: 'what', text: ev.text || '' }),
            ev.rollback ? el('div', { class: 'st-note', text: '↶ ' + t('ask_rollback') }) : null,
            el('div', { class: 'row' }, el('button', { class: 'btn primary small', onclick: () => answer(true) }, t(wait ? 'ask_done' : 'ask_allow')), el('button', { class: 'btn ghost small', onclick: () => answer(false) }, t(wait ? 'ask_stop' : 'ask_deny'))));
        }
        live.root.append(ask);
        box.scrollTop = box.scrollHeight;
        toast(t(ev.kind === 'choice' ? 'ask_choice_toast' : wait ? 'ask_wait' : 'ask_toast'), 6000);
      } else if (ev.type === 'step' && live) {
        live.steps.append(el('div', { class: ev.node === 'council_fail' ? 'no' : ev.node === 'council_done' ? 'ok' : '', text: t('step_' + ev.node, { who: (provOf(ev.provider) || {}).label || ev.provider, n: ev.round, s: ev.ms != null ? (ev.ms / 1000).toFixed(1) : '', err: ev.error ? errText(ev.error, '') : '' }) }));
        box.scrollTop = box.scrollHeight;
      } else if (ev.type === 'review' && live) {
        const pass = ev.score != null && ev.score >= (settings().agent.passScore || 80);
        live.steps.append(el('div', { class: pass ? 'ok' : 'no', text: ev.score == null ? t('review_unread', { n: ev.round }) : t('review_line', { n: ev.round, score: ev.score }) + (ev.issues && ev.issues.length ? ' — ' + ev.issues.join('; ') : '') }));
      } else if (ev.type === 'reset') { textOut = ''; think = ''; schedule();
      } else if (ev.type === 'text') { textOut += ev.text; schedule(); }
      else if (ev.type === 'thinking') { think += ev.text; schedule(); }
      else if (ev.type === 'notice') notices.push(ev);
      else if (ev.type === 'done') final = ev;
      else if (ev.type === 'error') failed = ev;
    };

    try {
      const res = await fetch('/api/chat', { method: 'POST', headers: { 'x-onechat-token': TOKEN, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ac.signal });
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw Object.assign(new Error(j.message || ''), { code: j.error || 'http' }); }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.trim()) { try { onEvent(JSON.parse(line)); } catch (_) {} } }
      }
    } catch (e) {
      // A fetch that fails without an HTTP answer means the local OneChat server is gone.
      failed = failed || { code: e.name === 'AbortError' ? 'aborted' : (e.code || 'server_down'), message: e.name === 'AbortError' || !e.code ? '' : e.message };
    }
    if (failed && failed.code === 'server_down') reconnect();
    if (live) for (const n of live.root.querySelectorAll('.askbox')) n.remove(); // the turn is over: nothing left to answer
    if (raf) clearTimeout(raf);
    S.abort = null;

    if (final && S.conv) {
      S.conv.messages.push(final.message);
      S.conv.tokens = final.convTokens;
      S.justArrived = final.message.id; // lets a freshly requested picture generate itself once
      renderMessages();
      S.justArrived = '';
    } else if (failed) {
      if (!gotMeta && !regen) { $('#input').value = restore.value; S.attach = restore.attach; S.memPick = restore.pick; autoGrow(); }
      if (failed.code === 'bad_token' && sessionReload()) return;
      if (live) {
        live.body.classList.remove('cursor');
        live.body.innerHTML = window.MD.render(textOut);
      }
      if (failed.code === 'aborted') {
        if (live) live.root.append(el('div', { class: 'notice', text: '⏹ ' + t('stopped') }));
        if (S.conv && gotMeta) setTimeout(() => { if (!S.busy && S.conv) api('/api/conversations/' + S.conv.id).then((c) => { S.conv = c; renderMessages(); renderDraft(); }).catch(() => {}); }, 600);
      } else {
        const pr = p || provOf((S.conv && S.conv.provider) || '');
        const errBox = el('div', { class: 'errbox' }, el('div', { text: '⚠ ' + errText(failed.code, failed.message) }));
        const row = el('div', { class: 'row' });
        if (gotMeta) row.append(el('button', { class: 'btn small', onclick: () => send({ regenerate: true }) }, '↻ ' + t('retry')));
        if (['auth', 'no_key', 'no_base_url', 'credit', 'no_model'].includes(failed.code) && pr) row.append(el('button', { class: 'btn small', onclick: () => openSettings('ai', pr.id) }, t('enter_key')));
        errBox.append(row);
        if (live) live.root.append(errBox); else { box.append(el('div', { class: 'msg asst' }, errBox)); box.scrollTop = box.scrollHeight; }
      }
    }
    setBusy(false);
    renderModel();
    analyzeNow();
    loadConvs(); loadUsage();
    $('#input').focus();
  }
  function stop() { if (S.abort) S.abort.abort(); }

  async function compactConv() {
    if (!S.conv || S.busy) return;
    toast(t('compacting'), 20000);
    try {
      const r = await api('/api/conversations/' + S.conv.id + '/compact', { body: {} });
      S.conv = r.conversation;
      renderMessages(); renderDraft();
      toast(r.skipped ? t('compact_skipped') : t('compact_done', { before: kfmt(r.before), after: kfmt(r.after) }), 4000);
    } catch (e) { toast(errText(e.code, e.message), 5000); }
  }

  // ---- side panel -------------------------------------------------------------------------
  function showPanel(tab) {
    if (tab) S.panelTab = tab;
    $('#panel').hidden = false;
    for (const b of $$('#panel .tab')) b.classList.toggle('active', b.dataset.tab === S.panelTab);
    for (const k of ['files', 'memory', 'habits']) $('#tab-' + k).hidden = k !== S.panelTab;
    if (S.panelTab === 'files') { if (!S.fs.path) initFiles(); else renderFiles(); }
    if (S.panelTab === 'memory') loadMemory();
    if (S.panelTab === 'habits') { $('#autoRoute').checked = S.provider === 'auto'; loadUsage().then(renderHabits); }
  }
  function togglePanel(tab) { if (!$('#panel').hidden && (!tab || tab === S.panelTab)) $('#panel').hidden = true; else showPanel(tab); }

  // files
  async function initFiles() {
    try {
      const r = await api('/api/fs/roots');
      const box = $('#fsRoots');
      box.textContent = '';
      for (const x of r.roots) box.append(el('button', { class: 'root' + (x.kind === 'linked' ? ' linked' : ''), title: x.path, onclick: () => openDir(x.path) }, (x.kind === 'linked' ? '📌 ' : x.kind === 'drive' ? '💽 ' : '') + (x.kind === 'quick' ? t('root_' + x.id) : x.name)));
      const linked = r.roots.find((x) => x.kind === 'linked');
      if (!S.fs.path) await openDir(linked ? linked.path : (r.roots.find((x) => x.id === 'documents') || r.roots[0]).path);
    } catch (e) { toast(errText(e.code, e.message)); }
  }
  async function openDir(p) {
    try {
      const r = await api('/api/fs/list?path=' + encodeURIComponent(p));
      S.fs.path = r.path; S.fs.parent = r.parent; S.fs.items = r.items; S.fs.results = null;
      $('#fsPath').value = r.path; $('#fsSearch').value = '';
      renderFiles();
    } catch (e) { toast(t('ferr_' + (e.code || 'read_failed')) + ': ' + p, 3500); }
  }
  function renderFiles() {
    const box = $('#fsList');
    box.textContent = '';
    const linked = settings().files.linked || [];
    $('#fsLink').textContent = linked.includes(S.fs.path) ? t('fs_unlink') : t('fs_link');
    const rows = S.fs.results || S.fs.items;
    for (const it of rows) {
      const usable = it.dir || it.kind !== 'binary';
      const cb = it.dir ? null : el('input', { type: 'checkbox', checked: S.fs.sel.has(it.path), disabled: !usable, onclick: (e) => { e.stopPropagation(); toggleSel(it); } });
      box.append(el('div', { class: 'item' + (usable ? '' : ' dim'), title: it.path + (it.sensitive ? '\n' + t('sensitive_tip') : ''), onclick: () => { if (it.dir) openDir(it.path); else if (usable) toggleSel(it); } },
        cb, el('span', { text: it.dir ? '📁' : it.sensitive ? '🔒' : it.kind === 'doc' ? '📑' : it.kind === 'image' ? '🖼' : '📄' }), el('span', { class: 'nm', text: it.name }), it.dir ? null : el('span', { class: 'sz', text: it.size != null ? sizeFmt(it.size) : '' })));
    }
    if (!rows.length) box.append(el('div', { class: 'muted small pad', text: S.fs.results ? t('no_match') : t('fs_empty') }));
    $('#fsSelInfo').textContent = S.fs.sel.size ? t('fs_selected', { n: S.fs.sel.size }) : '';
    $('#fsAttach').disabled = !S.fs.sel.size;
  }
  function toggleSel(it) { if (S.fs.sel.has(it.path)) S.fs.sel.delete(it.path); else S.fs.sel.set(it.path, it); renderFiles(); }
  async function attachSelected() {
    const picked = [...S.fs.sel];
    S.fs.sel.clear(); renderFiles();
    let n = 0;
    for (const [p, it] of picked) {
      if (it.kind === 'image') {
        // A picture is read here, shrunk to what the AIs use, and sent as a picture (not as text).
        try {
          const res = await fetch('/api/fs/raw?path=' + encodeURIComponent(p), { headers: { 'x-onechat-token': TOKEN } });
          if (!res.ok) throw new Error(String(res.status));
          const a = await window.Studio.prepareImage(new Blob([await res.arrayBuffer()], { type: IMG_TYPES[it.name.split('.').pop().toLowerCase()] || '' }), it.name);
          if (!a) throw new Error('decode');
          S.attach.push(a); n += 1;
        } catch (_) { toast(t('ferr_bad_image') + ': ' + it.name, 4000); }
      } else if (!S.attach.some((a) => a.path === p)) { S.attach.push({ path: p, name: it.name, size: it.size, sensitive: it.sensitive }); n += 1; }
    }
    toast(t('attached', { n }), 1500);
    renderDraft();
    $('#input').focus();
  }
  function attachFolder() {
    if (!S.fs.path || S.attach.some((a) => a.path === S.fs.path)) return;
    S.attach.push({ path: S.fs.path, name: baseName(S.fs.path) + '/', folder: true });
    toast(t('folder_attached'), 2200); renderDraft();
  }
  const searchFiles = debounce(async () => {
    const q = $('#fsSearch').value.trim();
    if (!q) { S.fs.results = null; renderFiles(); return; }
    try { const r = await api('/api/fs/search?q=' + encodeURIComponent(q) + '&path=' + encodeURIComponent(S.fs.path)); S.fs.results = r.results; renderFiles(); } catch (_) {}
  }, 300);
  async function toggleLink() {
    const linked = (settings().files.linked || []).slice();
    const i = linked.indexOf(S.fs.path);
    if (i >= 0) linked.splice(i, 1); else linked.push(S.fs.path);
    await saveSettings({ files: { linked } });
    await initFiles(); renderFiles();
  }
  async function readInline(file) {
    if (isPicture(file.name, file.type)) {
      if (file.size > 40 * 1048576) { toast(t('ferr_too_large') + ': ' + file.name); return null; }
      const a = await window.Studio.prepareImage(file, file.name || 'pasted.png');
      if (!a) toast(t('ferr_bad_image') + ': ' + (file.name || ''), 4000);
      return a;
    }
    return new Promise((resolve) => {
      if (file.size > 15 * 1048576) { toast(t('ferr_too_large') + ': ' + file.name); return resolve(null); }
      const fr = new FileReader();
      fr.onload = () => resolve({ name: file.name, size: file.size, data: String(fr.result).split(',')[1] || '' });
      fr.onerror = () => resolve(null);
      fr.readAsDataURL(file);
    });
  }
  async function addDropped(list) {
    for (const f of Array.from(list || []).slice(0, 12)) { const a = await readInline(f); if (a) S.attach.push(a); }
    renderDraft();
  }

  // memory
  async function loadMemory() {
    try { S.memItems = (await api('/api/memory')).items; } catch (_) { S.memItems = []; }
    renderMemory();
  }
  function renderMemory() {
    const box = $('#memList');
    if (!box || $('#tab-memory').hidden) return;
    box.textContent = '';
    const q = $('#memSearch').value.trim().toLowerCase();
    const off = new Set(settings().memory.disabledSources || []);
    box.append(el('label', { class: 'check' }, el('input', { type: 'checkbox', checked: memAutoOn(), onchange: async (e) => { await saveSettings({ memory: { enabled: e.target.checked } }); renderDraft(); analyzeNow(); } }), el('span', { text: t('mem_auto') })));
    for (const src of S.state.memorySources) {
      const items = S.memItems.filter((m) => m.sourceId === src.id && (!q || (m.name + ' ' + m.description).toLowerCase().includes(q)));
      if (!items.length && (q || src.kind !== 'notes')) continue;
      box.append(el('div', { class: 'src' },
        el('input', { type: 'checkbox', checked: !off.has(src.id), title: t('mem_src_tip'), onchange: async (e) => { const next = new Set(settings().memory.disabledSources || []); if (e.target.checked) next.delete(src.id); else next.add(src.id); await saveSettings({ memory: { disabledSources: [...next] } }); await loadMemory(); analyzeNow(); } }),
        el('span', { text: (src.kind === 'claude' ? 'Claude · ' : '') + src.label + ' (' + items.length + ')' })));
      if (!items.length) box.append(el('div', { class: 'muted small pad', text: t('mem_empty') }));
      for (const m of items) {
        const sel = S.memPick.has(m.id);
        const row = el('div', { class: 'mem' + (sel ? ' sel' : ''), onclick: () => { if (sel) S.memPick.delete(m.id); else S.memPick.set(m.id, m); renderMemory(); renderDraft(); } },
          el('div', { class: 'nm' }, el('span', { class: 'n', text: (sel ? '✓ ' : '') + m.name }), el('span', { class: 'badge', text: m.type }), el('span', { class: 'muted small', text: '≈' + kfmt(m.tokens) }),
            el('button', { class: 'act' + (m.pinned ? ' on' : ''), title: t('mem_pin_tip'), onclick: (e) => { e.stopPropagation(); togglePin(m); } }, '📌'),
            el('button', { class: 'act', title: t('preview'), onclick: (e) => { e.stopPropagation(); previewMem(m); } }, '👁'),
            m.sourceKind === 'notes' ? el('button', { class: 'act', title: t('delete'), onclick: (e) => { e.stopPropagation(); deleteNote(m); } }, '🗑') : null),
          el('div', { class: 'ds', text: m.description }));
        if (S.memOpen.has(m.id) && m.preview != null) row.append(el('div', { class: 'pv', text: m.preview, onclick: (e) => e.stopPropagation() }));
        box.append(row);
      }
    }
  }
  async function togglePin(m) {
    const pins = new Set(settings().memory.pinned || []);
    if (pins.has(m.id)) pins.delete(m.id); else pins.add(m.id);
    await saveSettings({ memory: { pinned: [...pins] } });
    await loadMemory(); analyzeNow();
  }
  async function previewMem(m) {
    if (S.memOpen.has(m.id)) { S.memOpen.delete(m.id); return renderMemory(); }
    try { const r = await api('/api/memory/item?id=' + encodeURIComponent(m.id)); m.preview = r.body + (r.masked ? '\n\n🔒 ' + t('masked', { n: r.masked }) : ''); S.memOpen.add(m.id); renderMemory(); }
    catch (e) { toast(errText(e.code, e.message)); }
  }
  async function deleteNote(m) {
    if (!window.confirm(t('delete_confirm', { title: m.name }))) return;
    await api('/api/memory/note?id=' + encodeURIComponent(m.id), { method: 'DELETE' });
    S.memPick.delete(m.id); S.state = await api('/api/state'); loadMemory();
  }
  async function saveNote() {
    try {
      await api('/api/memory/note', { body: { title: $('#memNoteTitle').value, text: $('#memNoteText').value } });
      $('#memNoteTitle').value = ''; $('#memNoteText').value = ''; $('#memNote').hidden = true;
      S.state = await api('/api/state'); loadMemory(); toast(t('remembered'));
    } catch (e) { toast(e.code === 'empty' ? t('mem_note_empty') : errText(e.code, e.message)); }
  }

  async function exportMemory() {
    try {
      const r = await api('/api/memory/export');
      const url = URL.createObjectURL(new Blob([r.text], { type: 'text/markdown;charset=utf-8' }));
      const a = el('a', { href: url, download: r.filename });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      toast(t('mem_exported', { n: r.count }), 4000);
    } catch (e) { toast(errText(e.code, e.message)); }
  }
  async function importMemory(fileList) {
    const files = [];
    for (const f of Array.from(fileList || []).slice(0, 50)) { if (f.size <= 5 * 1048576) files.push({ name: f.name, text: await f.text() }); }
    if (!files.length) return;
    try {
      const r = await api('/api/memory/import', { body: { files } });
      S.state = await api('/api/state');
      await loadMemory();
      toast(t('mem_imported', { added: r.added, skipped: r.skipped }), 6000);
    } catch (e) { toast(errText(e.code, e.message), 5000); }
  }

  // habits
  function renderHabits() {
    const box = $('#habitList');
    box.textContent = '';
    if (!S.usage) return;
    const ready = S.state.providers.filter((p) => p.ready && p.model);
    for (const row of S.usage.tasks) {
      if (!row.total && !row.pin) continue;
      const sel = el('select', { title: t('pin_tip'), onchange: async (e) => { await saveSettings({ pins: { [row.task]: e.target.value } }); loadUsage(); analyzeNow(); } }, el('option', { value: '', text: t('pin_none') }));
      const seen = new Set();
      const add = (provider, model) => { const key = provider + '|' + model; if (seen.has(key)) return; seen.add(key); const p = provOf(provider); sel.append(el('option', { value: key, text: '📌 ' + (p ? p.label : provider) + ' · ' + model, selected: row.pin === key })); };
      for (const p of ready) add(p.id, p.model);
      for (const r of row.rows) if (provOf(r.provider)) add(r.provider, r.model);
      box.append(el('div', { class: 'htask' }, el('div', { class: 't' }, taskName(row.task), el('span', { class: 'badge', text: row.total + '×' }), sel),
        ...row.rows.slice(0, 3).map((r) => { const p = provOf(r.provider); return el('div', { class: 'r', text: (p ? p.label : r.provider) + ' · ' + r.model + ' — ' + r.n + '×' + (r.up ? ' 👍' + r.up : '') + (r.down ? ' 👎' + r.down : '') + (r.avg != null ? ' · ' + t('avg_score', { n: r.avg }) : '') }); })));
    }
    if (!box.children.length) box.append(el('div', { class: 'muted small pad', text: t('habits_empty') }));
    const ul = $('#usageList');
    ul.textContent = '';
    for (const r of S.usage.totals) { const p = provOf(r.provider); ul.append(el('div', { class: 'urow' }, el('span', { class: 'n', text: (p ? p.label : r.provider) + ' · ' + r.model }), el('span', { text: (r.n || 0) + '×' }), el('span', { class: 'muted', text: '↑' + kfmt(r.in) + ' ↓' + kfmt(r.out) }), r.cost ? el('span', { text: money(r.cost) }) : null)); }
    if (!ul.children.length) ul.append(el('div', { class: 'muted small pad', text: '—' }));
    const ql = $('#quotaList');
    ql.textContent = '';
    for (const p of S.state.providers) if (p.ready) ql.append(el('div', { class: 'urow' }, el('span', { class: 'n', text: p.label }), quotaBadge(p.id) || el('span', { class: 'q', text: '?' }), el('span', { class: 'muted qd', text: quotaText(p.id).replace(/\n/g, ' · ') })));
    renderLessons();
  }
  // What the agent loop has learned so far, per kind of task. Each can be deleted.
  async function renderLessons() {
    const box = $('#lessonList');
    let d;
    try { d = await api('/api/agent/lessons'); } catch (_) { return; }
    box.textContent = '';
    for (const [task, list] of Object.entries(d.tasks || {})) list.forEach((l, i) => box.append(el('div', { class: 'urow' },
      el('span', { class: 'badge', text: taskName(task) }), el('span', { class: 'n', title: l.text, text: l.text }), el('span', { class: 'muted', text: l.n + '×' }),
      el('button', { class: 'act', title: t('delete'), onclick: async () => { await api('/api/agent/lessons?task=' + encodeURIComponent(task) + '&i=' + i, { method: 'DELETE' }); renderLessons(); } }, '🗑'))));
    if (!box.children.length) box.append(el('div', { class: 'muted small pad', text: t('lessons_empty') }));
  }

  // ---- voice ------------------------------------------------------------------------------
  // Inside the desktop app (Electron) the browser's speech service is not available: the
  // constructor exists but every attempt fails, so go straight to record-then-transcribe.
  const SR = IN_APP ? null : (window.SpeechRecognition || window.webkitSpeechRecognition);
  function insertText(s) {
    const a = $('#input');
    a.value = (a.value && !/\s$/.test(a.value) ? a.value + ' ' : a.value) + s;
    autoGrow(); analyzeSoon();
    a.scrollTop = a.scrollHeight;
  }
  function micUi() {
    $('#btnMic').classList.toggle('rec', !!S.voice.on);
    $('#btnVoiceLang').textContent = settings().voice.lang === 'en-US' ? 'EN' : 'VI';
    if (!S.voice.on) { $('#interim').hidden = true; $('#interim').textContent = ''; }
  }
  function micOff() { S.voice = { on: false }; micUi(); }
  function startSR() {
    const r = new SR();
    r.lang = settings().voice.lang; r.continuous = true; r.interimResults = true;
    S.voice = { on: true, kind: 'sr', r, err: '' };
    r.onresult = (e) => {
      let fin = '', inter = '';
      for (let i = e.resultIndex; i < e.results.length; i++) { const tr = e.results[i][0].transcript; if (e.results[i].isFinal) fin += tr; else inter += tr; }
      if (fin.trim()) insertText(fin.trim());
      $('#interim').textContent = inter; $('#interim').hidden = !inter;
    };
    r.onerror = (e) => {
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      S.voice.err = e.error;
      const canFallback = settings().voice.engine === 'auto' && S.state.stt && ['network', 'service-not-allowed', 'language-not-supported'].includes(e.error);
      if (canFallback) { try { r.abort(); } catch (_) {} startRecorder(); return; }
      toast(t(e.error === 'not-allowed' ? 'voice_denied' : e.error === 'audio-capture' ? 'voice_no_mic' : 'voice_error') + ' (' + e.error + ')', 5000);
    };
    r.onend = () => {
      if (S.voice.on && S.voice.kind === 'sr' && S.voice.r === r && !S.voice.err) { try { r.start(); return; } catch (_) {} }
      if (S.voice.kind === 'sr' && S.voice.r === r) micOff();
    };
    try { r.start(); micUi(); } catch (_) { micOff(); toast(t('voice_error')); }
  }
  async function startRecorder() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      const chunks = [];
      S.voice = { on: true, kind: 'rec', rec, stream };
      rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      rec.onstop = async () => {
        stream.getTracks().forEach((x) => x.stop());
        micOff();
        const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
        if (!blob.size) return;
        toast(t('voice_transcribing'), 15000);
        try { const r = await api('/api/stt?lang=' + encodeURIComponent(settings().voice.lang), { method: 'POST', raw: blob, headers: { 'content-type': blob.type } }); if (r.text) insertText(r.text); toast(r.text ? t('voice_done') : t('voice_empty'), 1500); }
        catch (e) { toast(errText(e.code, e.message), 5000); }
      };
      rec.start(); micUi();
      toast(t('voice_recording'), 3000);
    } catch (e) { micOff(); toast(t(e && e.name === 'NotAllowedError' ? 'voice_denied' : 'voice_no_mic'), 5000); }
  }
  function toggleMic() {
    if (S.voice.on) {
      const v = S.voice;
      if (v.kind === 'sr') { S.voice = { on: false, kind: 'sr', r: v.r }; try { v.r.stop(); } catch (_) {} micOff(); }
      else { try { v.rec.stop(); } catch (_) { micOff(); } }
      return;
    }
    const engine = settings().voice.engine;
    if (engine !== 'whisper' && SR) return startSR();
    if (S.state.stt && navigator.mediaDevices) return startRecorder();
    toast(t('voice_unavailable'), 6000);
  }
  async function toggleVoiceLang() {
    const was = S.voice.on && S.voice.kind === 'sr';
    if (was) toggleMic();
    await saveSettings({ voice: { lang: settings().voice.lang === 'en-US' ? 'vi-VN' : 'en-US' } }, true);
    micUi();
    toast(t('voice_lang_now', { lang: settings().voice.lang === 'en-US' ? 'English' : 'Tiếng Việt' }), 1500);
    if (was) setTimeout(toggleMic, 250);
  }

  // ---- settings modal ---------------------------------------------------------------------
  function openSettings(tab, focus) { S.setTab = tab || S.setTab; S.setFocus = focus || ''; $('#modal').hidden = false; renderSettings(); }
  function closeSettings() { $('#modal').hidden = true; renderPills(); renderModel(); renderDraft(); }
  const field = (label, control, help, inline) => el('div', { class: 'field' + (inline ? ' inline' : '') }, el('label', { text: label }), control, help ? el('div', { class: 'help', text: help }) : null);
  const selectOf = (value, options, onchange) => el('select', { onchange: (e) => onchange(e.target.value) }, ...options.map(([v, label]) => el('option', { value: v, text: label, selected: String(v) === String(value) })));
  const numberOf = (value, min, max, step, onchange) => el('input', { type: 'number', value: String(value), min, max, step, onchange: (e) => { const n = Number(e.target.value); if (Number.isFinite(n)) onchange(Math.max(min, Math.min(max, n))); } });
  const checkOf = (label, value, onchange, help) => el('div', { class: 'field' }, el('label', { class: 'check' }, el('input', { type: 'checkbox', checked: !!value, onchange: (e) => onchange(e.target.checked) }), el('span', { text: label })), help ? el('div', { class: 'help', text: help }) : null);
  const patch = async (p) => { await saveSettings(p); applyTheme(); };

  // Asks the provider for its model list: proves the key and address work, and refreshes the models.
  async function testProvider(id, afterSave) {
    try {
      const r = await api('/api/providers/models', { body: { provider: id } });
      S.state = r.state;
      toast('✓ ' + (afterSave ? t('key_saved') + ' · ' : '') + t('models_loaded', { n: r.models.length }) + (r.picked ? ' · ' + r.picked : ''), 4500);
    } catch (e) {
      if (afterSave) { try { S.state = await api('/api/state'); } catch (_) {} }
      toast('✗ ' + (afterSave ? t('key_saved_but') + ' ' : '') + errText(e.code, e.message), 8000);
    }
    if (!$('#modal').hidden) renderSettings();
    renderPills(); renderModel(); renderDraft();
  }
  function provCard(p) {
    const card = el('div', { class: 'prov', 'data-prov': p.id });
    card.append(el('div', { class: 'ph' }, el('b', { text: p.label + (p.sub ? ' · ' + p.sub : '') }), el('span', { class: 'st ' + (p.ready ? 'ready' : p.status === 'web' ? 'web' : ''), text: t('st_' + p.status) }),
      el('span', { class: 'spacer' }), p.keyUrl ? el('a', { href: p.keyUrl, target: '_blank', rel: 'noopener noreferrer', class: 'small', text: t('get_key') + ' ↗' }) : null));
    if (p.kind === 'claude-cli') { card.append(el('div', { class: 'help muted small', text: t('cli_help') }), budgetRow(p)); return card; }
    if (p.id === 'copilot') card.append(el('div', { class: 'help muted small', text: t('copilot_help') }));
    if (p.id === 'anythingllm') card.append(el('div', { class: 'help muted small', text: t('anything_help') }));
    if (p.needsKey || p.id === 'custom') {
      const inp = el('input', { type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: p.hasKey ? p.keyMask + (p.keySource === 'env' ? ' (env)' : '') : t('key_ph') });
      const save = async () => {
        const key = inp.value.trim();
        try { S.state = await api('/api/keys', { body: { provider: p.id, key } }); } catch (e) { toast(errText(e.code, e.message)); return; }
        if (!key) { toast(t('key_removed')); renderSettings(); renderPills(); renderDraft(); return; }
        toast(t('key_checking'), 20000);
        await testProvider(p.id, true); // a saved key is checked at once, so a typo shows up here and not mid-question
      };
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
      card.append(el('div', { class: 'row' }, inp, el('button', { class: 'btn small primary', onclick: save }, t('save')), p.hasKey && p.keySource === 'stored' ? el('button', { class: 'btn small danger', onclick: () => { inp.value = ''; save(); } }, t('remove')) : null));
      if (p.id === S.setFocus) setTimeout(() => inp.focus(), 50);
    }
    if (p.id === 'claude' && S.state.importable['van-phong-ao']) card.append(el('div', { class: 'row' }, el('span', { class: 'help muted small', text: t('import_vpa_help') }), el('button', { class: 'btn small', onclick: async () => { try { S.state = await api('/api/keys/import', { body: { source: 'van-phong-ao' } }); toast(t('key_saved')); renderSettings(); } catch (e) { toast(errText(e.code, e.message)); } } }, t('import_vpa'))));
    if (p.kind === 'openai') {
      const url = el('input', { type: 'text', spellcheck: 'false', value: p.baseUrl, placeholder: p.defaultBaseUrl || 'https://…/v1' });
      const saveUrl = async () => { await saveSettings(p.id === 'custom' ? { custom: { baseUrl: url.value.trim() } } : { baseUrls: { [p.id]: url.value.trim() } }); renderSettings(); };
      url.addEventListener('change', saveUrl);
      card.append(el('div', { class: 'row' }, el('span', { class: 'small muted', text: 'URL' }), url,
        el('button', { class: 'btn small', title: t('refresh_models'), onclick: () => testProvider(p.id) }, t('test'))));
    }
    if (p.kind === 'anthropic') card.append(el('div', { class: 'row' }, el('span', { class: 'spacer' }), el('button', { class: 'btn small', onclick: () => testProvider(p.id) }, t('test'))));
    card.append(budgetRow(p));
    return card;
  }
  // What is left of this AI's allowance as the provider reports it, plus an optional monthly
  // allowance of the user's own for providers that report nothing.
  function budgetRow(p) {
    const inp = numberOf(Number((settings().budgets || {})[p.id]) || 0, 0, 100000, 0.5, async (v) => { await saveSettings({ budgets: { [p.id]: v } }); await loadUsage(); renderSettings(); });
    return el('div', { class: 'quota-row' },
      el('div', { class: 'help muted small', text: '📊 ' + quotaText(p.id).replace(/\n/g, ' · ') }),
      el('div', { class: 'row' }, el('span', { class: 'small muted', text: t('budget_label') }), inp));
  }
  function renderSettings() {
    const st = settings();
    for (const b of $$('#setTabs .tab')) b.classList.toggle('active', b.dataset.set === S.setTab);
    const box = $('#setBody');
    box.textContent = '';
    if (S.setTab === 'ai') {
      box.append(el('div', { class: 'help muted small', text: t(S.state.secretsMode === 'aes' ? 'keys_aes' : 'keys_plain') }));
      for (const p of S.state.providers) box.append(provCard(p));
      const focus = S.setFocus && $('.prov[data-prov="' + S.setFocus + '"]', box);
      if (focus) focus.scrollIntoView({ block: 'center' });
    } else if (S.setTab === 'general') {
      box.append(el('div', { class: 'grid2' },
        field(t('language'), selectOf(st.lang, [['vi', 'Tiếng Việt'], ['en', 'English']], async (v) => { await patch({ lang: v }); S.lang = v; applyI18n(); renderAll(); renderSettings(); })),
        field(t('theme'), selectOf(st.theme, [['auto', t('theme_auto')], ['light', t('theme_light')], ['dark', t('theme_dark')]], (v) => patch({ theme: v })))));
      box.append(checkOf(t('concise'), st.output.concise, (v) => patch({ output: { concise: v } }), t('concise_help')));
      const sys = el('textarea', { rows: 3, placeholder: t('system_ph') });
      sys.value = st.systemPrompt;
      sys.addEventListener('change', () => patch({ systemPrompt: sys.value }));
      box.append(field(t('system_prompt'), sys, t('system_help')));
      box.append(field(t('max_tokens'), numberOf(st.output.maxTokens, 0, 128000, 256, (v) => patch({ output: { maxTokens: v } })), t('max_tokens_help'), true));
      box.append(field(t('effort'), selectOf(st.output.effort, [['auto', t('effort_auto')], ['low', 'low'], ['medium', 'medium'], ['high', 'high'], ['xhigh', 'xhigh']], (v) => patch({ output: { effort: v } })), t('effort_help'), true));
      box.append(field(t('history_budget'), numberOf(st.context.historyBudgetTokens, 0, 900000, 1000, (v) => patch({ context: { historyBudgetTokens: v } })), t('history_budget_help'), true));
      box.append(field(t('compact_at'), numberOf(st.context.compactAt, 0, 900000, 1000, (v) => patch({ context: { compactAt: v } })), t('compact_at_help'), true));
      box.append(field(t('helper'), selectOf(st.helper.provider, [['auto', t('helper_auto') + (S.state.helper ? ' → ' + ((provOf(S.state.helper.provider) || {}).label || '') + ' · ' + S.state.helper.model : '')]].concat(S.state.providers.filter((p) => p.ready).map((p) => [p.id, p.label])), (v) => patch({ helper: { provider: v, model: '' } })), t('helper_help'), true));
      box.append(field(t('agent_critic'), selectOf(st.agent.critic, [['auto', t('agent_critic_auto')]].concat(S.state.providers.filter((p) => p.ready).map((p) => [p.id, p.label])), (v) => patch({ agent: { critic: v } })), t('agent_help'), true));
      box.append(field(t('agent_rounds'), numberOf(st.agent.maxRounds, 0, 4, 1, (v) => patch({ agent: { maxRounds: v } })), null, true));
      box.append(field(t('agent_pass'), numberOf(st.agent.passScore, 1, 100, 5, (v) => patch({ agent: { passScore: v } })), null, true));
      box.append(field(t('council_max'), numberOf(st.council.max, 2, 5, 1, (v) => patch({ council: { max: v } })), t('council_help'), true));
      box.append(field(t('council_judge'), selectOf(st.council.judge, [['auto', t('council_judge_auto')]].concat(S.state.providers.filter((p) => p.ready).map((p) => [p.id, p.label])), (v) => patch({ council: { judge: v } })), null, true));
      box.append(checkOf(t('vision_bridge'), st.vision.bridge, (v) => patch({ vision: { bridge: v } }), t('vision_bridge_help')));
      // Output folder and operator mode.
      const outDir = el('input', { type: 'text', spellcheck: 'false', value: st.outputDir || '', placeholder: S.state.outputBase });
      outDir.addEventListener('change', async () => { await patch({ outputDir: outDir.value.trim() }); S.state = await api('/api/state'); renderSettings(); });
      box.append(field(t('out_dir'), outDir, t('out_dir_help', { path: S.state.outputBase })));
      box.append(checkOf(t('clarify'), st.clarify.enabled !== false, (v) => patch({ clarify: { enabled: v } }), t('clarify_help')));
      box.append(checkOf(t('op_auto'), st.operator.auto !== false, (v) => patch({ operator: { auto: v } }), t('op_auto_help')));
      box.append(field(t('op_steps'), numberOf(st.operator.maxSteps, 3, 40, 1, (v) => patch({ operator: { maxSteps: v } })), null, true));
      box.append(field(t('op_confirm'), selectOf(st.operator.confirm, [['risky', t('op_confirm_risky')], ['all', t('op_confirm_all')]], (v) => patch({ operator: { confirm: v } })), null, true));
      box.append(field(t('op_search'), selectOf(st.operator.search, [['bing', 'Bing'], ['duckduckgo', 'DuckDuckGo'], ['google', 'Google']], (v) => patch({ operator: { search: v } })), null, true));
      box.append(el('div', { class: 'field' }, el('button', { class: 'btn small', disabled: !S.state.browserFound, onclick: async () => { try { await api('/api/operator/browser', { body: {} }); toast(t('op_signin_opened'), 4000); } catch (e) { toast(errText(e.code, e.message), 5000); } } }, '🌐 ' + t('op_signin')),
        el('div', { class: 'help', text: S.state.browserFound ? t('op_signin_help') : t('op_no_browser') })));
      if (IN_APP) box.append(el('div', { class: 'help muted small', text: t('autostart_note') }));
      box.append(el('div', { class: 'help muted small', text: t('data_dir') + ': ' + S.state.dataDir + ' · v' + S.state.version }));
    } else if (S.setTab === 'pg') {
      const info = S.state.promptgate;
      box.append(el('div', { class: 'help muted small', text: info.available ? t(info.vendored ? 'pg_src_vendored' : 'pg_src_live') + ' ' + info.root : t('pg_unavailable') }));
      box.append(field(t('pg_mode'), selectOf(st.promptgate.mode, [['suggest', t('pg_mode_suggest')], ['badge', t('pg_mode_badge')], ['off', t('pg_mode_off')]], async (v) => { await patch({ promptgate: { mode: v } }); analyzeNow(); }), t('pg_mode_help')));
      box.append(field(t('pg_below'), numberOf(st.promptgate.below, 10, 95, 5, (v) => patch({ promptgate: { below: v } })), t('pg_below_help'), true));
      box.append(field(t('pg_rewrite'), selectOf(st.promptgate.rewrite, [['auto', t('pg_rewrite_auto')], ['rules', t('pg_rewrite_rules')]], (v) => patch({ promptgate: { rewrite: v } })), t('pg_rewrite_help')));
    } else if (S.setTab === 'memory') {
      box.append(checkOf(t('mem_auto'), st.memory.enabled, async (v) => { await patch({ memory: { enabled: v } }); analyzeNow(); }, t('mem_auto_help')));
      box.append(el('div', { class: 'grid2' },
        field(t('mem_max'), numberOf(st.memory.maxItems, 0, 10, 1, (v) => patch({ memory: { maxItems: v } }))),
        field(t('mem_budget'), numberOf(st.memory.budgetTokens, 200, 20000, 100, (v) => patch({ memory: { budgetTokens: v } })))));
      box.append(el('div', { class: 'lab', style: 'font-weight:600;color:var(--ink);font-size:13px', text: t('mem_sources') }));
      const off = new Set(st.memory.disabledSources || []);
      for (const src of S.state.memorySources) box.append(el('label', { class: 'check' }, el('input', { type: 'checkbox', checked: !off.has(src.id), onchange: async (e) => { const next = new Set(settings().memory.disabledSources || []); if (e.target.checked) next.delete(src.id); else next.add(src.id); await patch({ memory: { disabledSources: [...next] } }); } }), el('span', { text: (src.kind === 'claude' ? 'Claude · ' : '') + src.label + ' — ' + t('mem_count', { n: src.count }) })));
      box.append(el('div', { class: 'help muted small', text: t('mem_privacy') }));
    } else if (S.setTab === 'voice') {
      box.append(el('div', { class: 'help muted small', text: SR ? t('voice_sr_ok') : t('voice_sr_no') }));
      box.append(field(t('voice_engine'), selectOf(st.voice.engine, [['auto', t('voice_engine_auto')], ['browser', t('voice_engine_browser')], ['whisper', t('voice_engine_whisper')]], (v) => patch({ voice: { engine: v } })), S.state.stt ? t('voice_whisper_ok') : t('voice_whisper_no')));
      box.append(field(t('voice_default_lang'), selectOf(st.voice.lang, [['vi-VN', 'Tiếng Việt'], ['en-US', 'English']], async (v) => { await patch({ voice: { lang: v } }); micUi(); }), null, true));
    }
  }

  // ---- the task's output folder -------------------------------------------------------------
  // Every conversation has one; the app creates it the first time something is saved or it is opened.
  const toolLine = (s) => t('tool_' + s.tool) + (s.detail ? ': ' + s.detail : '');
  // First real line of the answer, without Markdown marks or characters Windows refuses in a name.
  const answerName = (text) => (String(text || '').split('\n').map((l) => l.replace(/[*_`#>|[\]]/g, '').replace(/[<>:"/\\?]/g, ' ').replace(/\s+/g, ' ').trim()).find((l) => l.length > 2) || 'tra-loi').slice(0, 60).replace(/[.\s-]+$/, '') || 'tra-loi';
  async function openOutput(name) {
    if (!S.conv) return toast(t('out_need_chat'), 4500);
    try { const r = await api('/api/output/open', { body: { convId: S.conv.id, name: name || '' } }); toast(t('out_opened', { path: r.path }), 4000); }
    catch (e) { toast(errText(e.code, e.message), 5000); }
    return undefined;
  }
  async function restoreOutput(b) {
    if (!S.conv) return;
    try { const r = await api('/api/output/restore', { body: { convId: S.conv.id, rel: b.rel, of: b.of } }); toast(t('restored', { n: r.files.length }), 5000); }
    catch (e) { toast(errText(e.code, e.message), 5000); }
  }
  // name + text, or name + Blob (pictures, videos): saved straight into the folder, no dialog.
  async function saveToFolder(name, data) {
    if (!S.conv) return toast(t('out_need_chat'), 4500);
    try {
      const body = { convId: S.conv.id, name };
      if (typeof data === 'string') body.text = data;
      else body.data = await new Promise((resolve, reject) => { const fr = new FileReader(); fr.onload = () => resolve(String(fr.result).split(',')[1] || ''); fr.onerror = reject; fr.readAsDataURL(data); });
      const r = await api('/api/output/save', { body });
      toast(t('out_saved', { name: r.file.name }), 3500);
      return r.file;
    } catch (e) { toast(errText(e.code, e.message), 5000); }
    return null;
  }

  // ---- "build" menu: starts a request the app knows how to turn into something visible ------
  function toggleStudioMenu() {
    const old = $('#studioMenu');
    if (old) return old.remove();
    const start = (k) => { const a = $('#input'); a.value = t('studio_' + k + '_start') + ' ' + a.value; autoGrow(); analyzeSoon(); a.focus(); a.setSelectionRange(a.value.length, a.value.length); };
    const menu = el('div', { id: 'studioMenu' }, ...['mindmap', 'chart', 'draw', 'video', 'finance', 'marketing'].map((k) => el('button', { class: 'item', onclick: () => start(k) }, t('studio_' + k))));
    menu.style.left = $('#btnStudio').offsetLeft + 'px';
    $('#btnStudio').parentNode.append(menu);
    return undefined;
  }

  // ---- wiring -----------------------------------------------------------------------------
  function renderAll() { renderPills(); renderModel(); renderConvs(); renderMessages(); renderDraft(); micUi(); if (!$('#panel').hidden) showPanel(); }

  function wire() {
    const input = $('#input');
    input.addEventListener('input', () => { autoGrow(); analyzeSoon(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        if (S.busy) return;
        if (S.pg && S.pg.text === inputText().replace(/^\/\//, '').trim()) return send({ skipPg: true }); // second Enter = send as typed
        send();
      }
    });
    input.addEventListener('paste', (e) => { const f = e.clipboardData && e.clipboardData.files; if (f && f.length) { e.preventDefault(); addDropped(f); } });
    $('#btnSend').addEventListener('click', () => (S.busy ? stop() : send()));
    $('#btnNew').addEventListener('click', newChat);
    $('#convSearch').addEventListener('input', renderConvs);
    $('#btnSettings').addEventListener('click', () => openSettings('ai'));
    $('#modalClose').addEventListener('click', closeSettings);
    $('#modal').addEventListener('mousedown', (e) => { if (e.target.id === 'modal') closeSettings(); });
    for (const b of $$('#setTabs .tab')) b.addEventListener('click', () => { S.setTab = b.dataset.set; S.setFocus = ''; renderSettings(); });
    $('#btnLang').addEventListener('click', async () => { const v = S.lang === 'vi' ? 'en' : 'vi'; await saveSettings({ lang: v }, true); S.lang = v; applyI18n(); renderAll(); });
    $('#btnTheme').addEventListener('click', async () => { const dark = document.documentElement.dataset.theme === 'dark'; await saveSettings({ theme: dark ? 'light' : 'dark' }, true); applyTheme(); });
    $('#btnSide').addEventListener('click', () => $('#app').classList.toggle('no-side'));
    $('#btnPanel').addEventListener('click', () => togglePanel());
    $('#btnPanelClose').addEventListener('click', () => { $('#panel').hidden = true; });
    for (const b of $$('#panel .tab')) b.addEventListener('click', () => showPanel(b.dataset.tab));
    $('#modelSel').addEventListener('change', async (e) => {
      if (e.target.value === '__other__') { const m = await askText(t('other_model_prompt'), ''); if (m && m.trim()) setModel(m.trim()); else renderModel(); }
      else setModel(e.target.value);
    });
    $('#btnRefreshModels').addEventListener('click', refreshModels);
    $('#btnAttach').addEventListener('click', () => togglePanel('files'));
    $('#btnMemory').addEventListener('click', () => togglePanel('memory'));
    $('#btnMic').addEventListener('click', toggleMic);
    $('#btnVoiceLang').addEventListener('click', toggleVoiceLang);
    $('#btnOptimize').addEventListener('click', () => { const x = inputText(); if (!x) return toast(t('pg_type_first')); if (S.pg) closePg(); else openPg(x.replace(/^\/\//, '').trim(), true); });
    $('#fsPath').addEventListener('keydown', (e) => { if (e.key === 'Enter') openDir(e.target.value.trim()); });
    $('#fsUp').addEventListener('click', () => { if (S.fs.parent) openDir(S.fs.parent); });
    $('#fsSearch').addEventListener('input', searchFiles);
    $('#fsLink').addEventListener('click', toggleLink);
    $('#fsAttach').addEventListener('click', attachSelected);
    $('#fsAttachFolder').addEventListener('click', attachFolder);
    $('#memSearch').addEventListener('input', renderMemory);
    $('#memNew').addEventListener('click', () => { $('#memNote').hidden = !$('#memNote').hidden; if (!$('#memNote').hidden) $('#memNoteTitle').focus(); });
    $('#memNoteCancel').addEventListener('click', () => { $('#memNote').hidden = true; });
    $('#memNoteSave').addEventListener('click', saveNote);
    $('#autoRoute').addEventListener('change', (e) => setProvider(e.target.checked ? 'auto' : settings().provider));
    $('#messages').addEventListener('click', (e) => { const b = e.target.closest('.copy-code'); if (b) copyText(b.closest('.code').querySelector('pre').textContent); });

    let dragDepth = 0;
    window.addEventListener('dragenter', (e) => { if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) { dragDepth += 1; $('#drop').hidden = false; } });
    window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('#drop').hidden = true; });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => { e.preventDefault(); dragDepth = 0; $('#drop').hidden = true; if (e.dataTransfer && e.dataTransfer.files.length) addDropped(e.dataTransfer.files); });

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { if (!$('#modal').hidden) return closeSettings(); if (S.pg) return closePg(); if (S.busy) return stop(); }
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); newChat(); }
      else if (mod && e.key.toLowerCase() === 'm') { e.preventDefault(); toggleMic(); }
      else if (mod && e.key === ',') { e.preventDefault(); openSettings('ai'); }
      else if (e.altKey && /^[1-9]$/.test(e.key)) { const pills = $$('#pills .pill[data-prov]'); const b = pills[Number(e.key) - 1]; if (b) { e.preventDefault(); setProvider(b.dataset.prov); } }
    });
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
    // Timers are throttled while the window is hidden: re-check the link the moment it is looked at again.
    document.addEventListener('visibilitychange', () => { if (!document.hidden) reconnect(); });
    window.addEventListener('focus', reconnect);
    window.addEventListener('online', reconnect);
    $('#btnAgent').addEventListener('click', async () => { const on = !settings().agent.enabled; await saveSettings({ agent: { enabled: on } }, true); renderDraft(); toast(t(on ? 'agent_on' : 'agent_off'), 3000); });
    $('#btnCouncil').addEventListener('click', async () => { const on = !settings().council.enabled; await saveSettings({ council: { enabled: on } }, true); renderDraft(); toast(t(on ? 'council_on' : 'council_off'), 4000); });
    $('#btnStudio').addEventListener('click', (e) => { e.stopPropagation(); toggleStudioMenu(); });
    $('#btnOperator').addEventListener('click', async () => { const on = !settings().operator.enabled; await saveSettings({ operator: { enabled: on } }, true); renderDraft(); toast(t(on ? 'operator_on' : 'operator_off'), 5000); });
    $('#btnFolder').addEventListener('click', () => openOutput());
    document.addEventListener('click', () => { const menu = $('#studioMenu'); if (menu) menu.remove(); });
    $('#memExport').addEventListener('click', exportMemory);
    $('#memImport').addEventListener('click', () => $('#memFile').click());
    $('#memFile').addEventListener('change', async (e) => { await importMemory(e.target.files); e.target.value = ''; });
  }

  async function boot() {
    try { S.state = await api('/api/state'); }
    catch (e) { document.body.textContent = 'OneChat: ' + (e.message || 'cannot reach the local server') + '. Close this window and start OneChat again.'; return; }
    S.lang = settings().lang === 'en' ? 'en' : 'vi';
    S.provider = settings().autoRoute ? 'auto' : (provOf(settings().provider) ? settings().provider : 'claude-cli');
    window.Studio.init({ t, api, blobUrl, getBlob, toast, errText, saveToFolder, imageAI: () => !!S.state.imageAI, answer: (text) => { if (!S.busy) send({ text, skipPg: true }); } });
    applyTheme(); applyI18n(); wire();
    renderAll();
    await loadConvs();
    loadUsage(); reconnect();
    try { const d = sessionStorage.getItem(DRAFT_KEY); if (d) { sessionStorage.removeItem(DRAFT_KEY); $('#input').value = d; autoGrow(); analyzeSoon(); } } catch (_) {}
    $('#input').focus();
  }
  boot();
})();
