// Things built from an answer: mind maps, charts, drawings, generated pictures, slideshow
// videos. The model writes a fenced block (```mindmap, ```chart, ```svg, ```image, ```video)
// and this file turns it into something to look at and save. Everything is built with DOM
// calls, so model text never becomes markup; model-made SVG is shown through <img>, where
// scripts cannot run and nothing is fetched from outside.
(function () {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';
  const PALETTE = ['#3f7fd0', '#3f9d8b', '#c98a2b', '#c64545', '#8a5fbf', '#4a9a57', '#d0703f', '#5b6b7a'];
  const INK = '#1f2a37', SOFT = '#5b6676';
  const FONT = '"Segoe UI", system-ui, -apple-system, sans-serif';
  let ctx = { t: (k) => k, api: null, blobUrl: null, getBlob: null, saveToFolder: null, toast: () => {}, errText: (c) => String(c), imageAI: () => false };

  // ---- pure helpers (no DOM; covered by tests) ----------------------------------------------
  // An indented outline -> a tree. Bullets, numbers and # headings are accepted as markers.
  function parseOutline(src) {
    const rows = [];
    for (const raw of String(src || '').replace(/\t/g, '  ').split('\n')) {
      if (!raw.trim()) continue;
      const m = /^(\s*)(#{1,6}\s+|[-*+•]\s+|\d+[.)]\s+)?(.*)$/.exec(raw);
      let depth = Math.floor(m[1].length / 2);
      if (m[2] && m[2][0] === '#') depth = m[2].trim().length - 1;
      const text = m[3].replace(/\*\*|__|`/g, '').trim();
      if (text) rows.push({ depth, text });
      if (rows.length >= 200) break;
    }
    if (!rows.length) return null;
    const min = Math.min(...rows.map((r) => r.depth));
    const top = { text: '', children: [] };
    const stack = [{ node: top, depth: -1 }];
    for (const r of rows) {
      const d = r.depth - min;
      while (stack.length > 1 && stack[stack.length - 1].depth >= d) stack.pop();
      const node = { text: r.text.slice(0, 140), children: [] };
      stack[stack.length - 1].node.children.push(node);
      stack.push({ node, depth: d });
    }
    return top.children.length === 1 ? top.children[0] : Object.assign(top, { text: '◎' });
  }

  function wrap(text, max) {
    const t = String(text);
    if (t.length <= max) return [t];
    let cut = t.lastIndexOf(' ', max);
    if (cut < max * 0.5) cut = max;
    const a = t.slice(0, cut).trim();
    let b = t.slice(cut).trim();
    if (b.length > max) b = b.slice(0, max - 1).trim() + '…';
    return [a, b];
  }

  // Left-to-right tree: every leaf gets its own row, a parent sits midway between its children.
  function layoutTree(root, measure) {
    const m = measure || ((t) => t.length * 7.4);
    const ROW = 40, GAP = 44, PAD = 13;
    const widths = [], nodes = [];
    let leaf = 0;
    const walk = (n, depth, branch) => {
      n.depth = depth; n.branch = branch;
      n.lines = wrap(n.text, depth === 0 ? 26 : 32);
      n.w = Math.ceil(Math.max(...n.lines.map((l) => m(l, depth <= 1))) + PAD * 2);
      n.h = n.lines.length > 1 ? 36 : 26;
      widths[depth] = Math.max(widths[depth] || 0, n.w);
      nodes.push(n);
      if (!n.children.length) { n.row = leaf; leaf += 1; }
      else { n.children.forEach((c, i) => walk(c, depth + 1, depth === 0 ? i : branch)); n.row = (n.children[0].row + n.children[n.children.length - 1].row) / 2; }
    };
    walk(root, 0, -1);
    const xs = [];
    let x = 12;
    widths.forEach((w, d) => { xs[d] = x; x += w + GAP; });
    for (const n of nodes) { n.x = xs[n.depth]; n.y = 12 + n.row * ROW + (ROW - n.h) / 2; }
    return { nodes, width: Math.ceil(x - GAP + 12), height: 24 + leaf * ROW };
  }

  // Chart data as the model wrote it -> a checked description, or null when it cannot be drawn.
  function parseChart(src) {
    let j;
    try { j = JSON.parse(src); } catch (_) { return null; }
    if (!j || typeof j !== 'object') return null;
    const labels = (Array.isArray(j.labels) ? j.labels : []).map((x) => String(x).slice(0, 40)).slice(0, 60);
    const rawSeries = Array.isArray(j.series) ? j.series : (Array.isArray(j.data) ? [{ name: '', data: j.data }] : []);
    const series = rawSeries.map((s) => ({ name: String((s && s.name) || '').slice(0, 40), data: (Array.isArray(s && s.data) ? s.data : []).slice(0, labels.length).map(Number) }))
      .filter((s) => s.data.length === labels.length && s.data.every(Number.isFinite)).slice(0, 8);
    if (!labels.length || !series.length) return null;
    return { type: ['bar', 'line', 'pie'].includes(j.type) ? j.type : 'bar', title: String(j.title || '').slice(0, 120), unit: String(j.unit || '').slice(0, 24), labels, series };
  }

  function niceTicks(min, max, count) {
    if (!(max > min)) max = min + 1;
    const raw = (max - min) / (count || 5);
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / mag;
    const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
    const lo = Math.floor(min / step + 1e-9) * step, hi = Math.ceil(max / step - 1e-9) * step;
    const ticks = [];
    for (let i = 0; lo + i * step <= hi + step / 2; i++) ticks.push(Number((lo + i * step).toPrecision(12)));
    return { min: lo, max: hi, step, ticks };
  }

  // A question the AI asks back: checked, trimmed, never more than five choices.
  function parseAsk(src) {
    let j;
    try { j = JSON.parse(src); } catch (_) { return null; }
    if (!j || typeof j !== 'object') return null;
    const question = String(j.question || '').trim().slice(0, 400);
    const options = (Array.isArray(j.options) ? j.options : []).map((o) => (typeof o === 'string' ? { label: o } : o || {}))
      .map((o) => ({ label: String(o.label || '').trim().slice(0, 200), detail: String(o.detail || '').trim().slice(0, 300) })).filter((o) => o.label).slice(0, 5);
    if (!question) return null;
    const rec = Number.isInteger(j.recommended) && j.recommended >= 0 && j.recommended < options.length ? j.recommended : 0;
    return { question, why: String(j.why || '').trim().slice(0, 300), options, recommended: options.length ? rec : -1 };
  }

  function parseVideo(src) {
    let j;
    try { j = JSON.parse(src); } catch (_) { return null; }
    if (!j || !Array.isArray(j.scenes)) return null;
    const scenes = j.scenes.slice(0, 24).map((x, i) => ({
      title: String((x && x.title) || '').slice(0, 90), text: String((x && x.text) || '').slice(0, 260), emoji: String((x && x.emoji) || '').slice(0, 8),
      color: /^#[0-9a-f]{6}$/i.test(String(x && x.color)) ? String(x.color) : PALETTE[i % PALETTE.length],
      seconds: Math.max(1.5, Math.min(20, Number(x && x.seconds) || 4)), image: String((x && x.image) || '').slice(0, 1000),
    })).filter((x) => x.title || x.text);
    if (!scenes.length) return null;
    return { title: String(j.title || '').slice(0, 100), scenes, total: scenes.reduce((a, b) => a + b.seconds, 0) };
  }

  const fit = (w, h, max) => { const k = Math.min(1, max / Math.max(w, h, 1)); return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) }; };
  const fileName = (s) => (String(s || '').normalize('NFD').replace(/\p{M}/gu, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').replace(/[^\w]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50).toLowerCase() || 'onechat');

  // ---- DOM helpers ------------------------------------------------------------------------
  function h(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return n;
  }
  function s(tag, attrs, text) {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, v);
    if (text != null) n.textContent = text;
    return n;
  }
  const btn = (label, onclick) => h('button', { class: 'btn ghost small', type: 'button', onclick }, label);
  const serialize = (node) => new XMLSerializer().serializeToString(node);
  const dataUrl = (xml) => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);
  function download(name, blob) {
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 15000);
  }
  function rasterise(url, w, hh) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const c = h('canvas', { width: w, height: hh });
        const g = c.getContext('2d');
        g.fillStyle = '#fff'; g.fillRect(0, 0, w, hh);
        g.drawImage(img, 0, 0, w, hh);
        c.toBlob((b) => (b ? resolve(b) : reject(new Error('png'))), 'image/png');
      };
      img.onerror = () => reject(new Error('svg'));
      img.src = url;
    });
  }
  let measurer = null;
  function measure(text, bold) {
    if (!measurer) measurer = document.createElement('canvas').getContext('2d');
    measurer.font = (bold ? '600 ' : '400 ') + '13px ' + FONT;
    return measurer.measureText(text).width;
  }
  const color = (n) => PALETTE[Math.max(0, n.branch) % PALETTE.length];

  // A drawing with its save buttons. `xml()` gives the SVG text at the moment of saving.
  function figure(view, name, w, hh, xml) {
    const save = async (png) => {
      try { download(name + (png ? '.png' : '.svg'), png ? await rasterise(dataUrl(xml()), w * 2, hh * 2) : new Blob([xml()], { type: 'image/svg+xml' })); }
      catch (_) { ctx.toast(ctx.t('st_export_failed')); }
    };
    // Straight into the task's output folder, as a picture and as an editable drawing: no dialog.
    const keep = async () => {
      try {
        await ctx.saveToFolder(name + '.png', await rasterise(dataUrl(xml()), w * 2, hh * 2));
        await ctx.saveToFolder(name + '.svg', new Blob([xml()], { type: 'image/svg+xml' }));
      } catch (_) { ctx.toast(ctx.t('st_export_failed')); }
    };
    return h('div', { class: 'st-card' }, h('div', { class: 'st-view' }, view), h('div', { class: 'st-tools' },
      ctx.saveToFolder ? btn('💾 ' + ctx.t('st_save_folder'), keep) : null, btn('⬇ SVG', () => save(false)), btn('⬇ PNG', () => save(true))));
  }

  // ---- mind map ---------------------------------------------------------------------------
  function mindmapSvg(root) {
    const L = layoutTree(root, measure);
    const svg = s('svg', { xmlns: NS, viewBox: '0 0 ' + L.width + ' ' + L.height, width: L.width, height: L.height, 'font-family': FONT, 'font-size': 13 });
    svg.append(s('rect', { width: L.width, height: L.height, fill: '#ffffff' }));
    for (const n of L.nodes) for (const c of n.children) {
      const x1 = n.x + n.w, y1 = n.y + n.h / 2, x2 = c.x, y2 = c.y + c.h / 2, mx = (x1 + x2) / 2;
      svg.append(s('path', { d: 'M' + x1 + ',' + y1 + ' C' + mx + ',' + y1 + ' ' + mx + ',' + y2 + ' ' + x2 + ',' + y2, fill: 'none', stroke: color(c), 'stroke-width': c.depth === 1 ? 2.2 : 1.5, opacity: 0.8 }));
    }
    for (const n of L.nodes) {
      const col = n.depth === 0 ? INK : color(n);
      svg.append(s('rect', { x: n.x, y: n.y, width: n.w, height: n.h, rx: 9, fill: n.depth <= 1 ? col : '#ffffff', stroke: col, 'stroke-width': 1.4 }));
      n.lines.forEach((line, i) => svg.append(s('text', { x: n.x + n.w / 2, y: n.y + (n.lines.length > 1 ? 15 + i * 14 : n.h / 2 + 4.5), 'text-anchor': 'middle', fill: n.depth <= 1 ? '#ffffff' : INK, 'font-weight': n.depth <= 1 ? 600 : 400 }, line)));
    }
    return { svg, w: L.width, h: L.height, title: root.text };
  }

  // ---- chart ------------------------------------------------------------------------------
  function chartSvg(c) {
    const W = 680, H = 380, L = 64, R = 18, T = c.title ? 46 : 20;
    const legend = c.series.length > 1;
    const B = 34 + (legend ? 24 : 0);
    const svg = s('svg', { xmlns: NS, viewBox: '0 0 ' + W + ' ' + H, width: W, height: H, 'font-family': FONT, 'font-size': 12 });
    svg.append(s('rect', { width: W, height: H, fill: '#ffffff' }));
    if (c.title) svg.append(s('text', { x: W / 2, y: 26, 'text-anchor': 'middle', 'font-size': 15, 'font-weight': 600, fill: INK }, c.title));
    const num = (v) => Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 });
    const unit = c.unit ? ' ' + c.unit : '';
    if (c.type === 'pie') {
      const data = c.series[0].data.map((v) => Math.max(0, v));
      const total = data.reduce((a, b) => a + b, 0) || 1;
      const cx = 190, cy = T + (H - T - 16) / 2, r = Math.min(150, (H - T - 28) / 2);
      const at = (a) => (cx + r * Math.cos(a)).toFixed(2) + ',' + (cy + r * Math.sin(a)).toFixed(2);
      let a0 = -Math.PI / 2;
      data.forEach((v, i) => {
        const a1 = a0 + (v / total) * Math.PI * 2;
        if (v >= total) svg.append(s('circle', { cx, cy, r, fill: PALETTE[i % PALETTE.length] }));
        else if (v > 0) svg.append(s('path', { d: 'M' + cx + ',' + cy + ' L' + at(a0) + ' A' + r + ',' + r + ' 0 ' + (a1 - a0 > Math.PI ? 1 : 0) + ' 1 ' + at(a1) + ' Z', fill: PALETTE[i % PALETTE.length], stroke: '#ffffff', 'stroke-width': 1.5 }));
        a0 = a1;
      });
      c.labels.forEach((lab, i) => {
        const y = T + 18 + i * 22;
        if (y > H - 8) return;
        svg.append(s('rect', { x: 380, y: y - 10, width: 12, height: 12, rx: 2, fill: PALETTE[i % PALETTE.length] }));
        svg.append(s('text', { x: 398, y, fill: INK }, lab + ' — ' + num(c.series[0].data[i]) + unit + ' (' + Math.round((data[i] / total) * 100) + '%)'));
      });
      return { svg, w: W, h: H, title: c.title };
    }
    const all = c.series.flatMap((x) => x.data);
    const tk = niceTicks(Math.min(0, ...all), Math.max(0, ...all), 5);
    const pw = W - L - R, ph = H - T - B;
    const y = (v) => T + ph - ((v - tk.min) / (tk.max - tk.min)) * ph;
    for (const v of tk.ticks) {
      svg.append(s('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), stroke: v === 0 ? '#8a94a3' : '#e3e7ee', 'stroke-width': 1 }));
      svg.append(s('text', { x: L - 8, y: y(v) + 4, 'text-anchor': 'end', fill: SOFT }, num(v)));
    }
    if (c.unit) svg.append(s('text', { x: L, y: T - 8, fill: SOFT, 'font-size': 11 }, c.unit));
    const n = c.labels.length, band = pw / n, every = Math.ceil(n / 12), few = n * c.series.length <= 14;
    c.labels.forEach((lab, i) => { if (i % every === 0) svg.append(s('text', { x: L + band * (i + 0.5), y: T + ph + 17, 'text-anchor': 'middle', fill: SOFT }, lab.length > 14 ? lab.slice(0, 13) + '…' : lab)); });
    c.series.forEach((ser, k) => {
      const col = PALETTE[k % PALETTE.length];
      const tip = (i, v) => (ser.name ? ser.name + ' · ' : '') + c.labels[i] + ': ' + num(v) + unit;
      if (c.type === 'line') {
        svg.append(s('polyline', { points: ser.data.map((v, i) => (L + band * (i + 0.5)).toFixed(1) + ',' + y(v).toFixed(1)).join(' '), fill: 'none', stroke: col, 'stroke-width': 2.4, 'stroke-linejoin': 'round' }));
        ser.data.forEach((v, i) => {
          const dot = s('circle', { cx: L + band * (i + 0.5), cy: y(v), r: 3.4, fill: col });
          dot.append(s('title', {}, tip(i, v)));
          svg.append(dot);
          if (few) svg.append(s('text', { x: L + band * (i + 0.5), y: y(v) - 8, 'text-anchor': 'middle', 'font-size': 10.5, fill: INK }, num(v)));
        });
      } else {
        const bw = Math.min(46, (band * 0.72) / c.series.length);
        ser.data.forEach((v, i) => {
          const x = L + band * (i + 0.5) - (bw * c.series.length) / 2 + bw * k;
          const top = Math.min(y(v), y(0)), tall = Math.max(1, Math.abs(y(v) - y(0)));
          const bar = s('rect', { x, y: top, width: bw - 2, height: tall, rx: 2, fill: col });
          bar.append(s('title', {}, tip(i, v)));
          svg.append(bar);
          if (few) svg.append(s('text', { x: x + (bw - 2) / 2, y: v >= 0 ? top - 4 : top + tall + 12, 'text-anchor': 'middle', 'font-size': 10.5, fill: INK }, num(v)));
        });
      }
    });
    if (legend) {
      let lx = L;
      c.series.forEach((ser, k) => {
        const name = ser.name || '#' + (k + 1);
        svg.append(s('rect', { x: lx, y: H - 21, width: 12, height: 12, rx: 2, fill: PALETTE[k % PALETTE.length] }));
        svg.append(s('text', { x: lx + 17, y: H - 11, fill: INK }, name));
        lx += 34 + measure(name);
      });
    }
    return { svg, w: W, h: H, title: c.title };
  }

  // ---- model-made SVG ---------------------------------------------------------------------
  function safeSvg(src) {
    const doc = new DOMParser().parseFromString(String(src).slice(0, 400000), 'image/svg+xml');
    const root = doc.documentElement;
    if (!root || root.nodeName.toLowerCase() !== 'svg' || doc.getElementsByTagName('parsererror').length) return null;
    for (const n of Array.from(doc.querySelectorAll('script, foreignObject, iframe, embed, object, audio, video, link, meta, style'))) {
      if (n.nodeName.toLowerCase() !== 'style' || /@import|url\s*\(/i.test(n.textContent || '')) n.remove();
    }
    for (const n of Array.from(doc.querySelectorAll('*'))) for (const a of Array.from(n.attributes)) {
      const name = a.name.toLowerCase(), val = String(a.value).trim().toLowerCase();
      if (name.startsWith('on') || ((name === 'href' || name === 'xlink:href' || name === 'src') && !val.startsWith('#') && !val.startsWith('data:image/'))) n.removeAttribute(a.name);
    }
    if (!root.getAttribute('xmlns')) root.setAttribute('xmlns', NS);
    const vb = (root.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
    let w = parseFloat(root.getAttribute('width')) || (vb.length === 4 ? vb[2] : 640), hh = parseFloat(root.getAttribute('height')) || (vb.length === 4 ? vb[3] : 400);
    if (!(w > 0 && hh > 0)) { w = 640; hh = 400; }
    const d = fit(w, hh, 1200);
    root.setAttribute('width', d.w); root.setAttribute('height', d.h);
    return { xml: serialize(root), w: d.w, h: d.h };
  }

  // ---- generated picture ------------------------------------------------------------------
  function imageWidget(prompt, live) {
    const note = h('div', { class: 'st-note' });
    const box = h('div', { class: 'st-card' }, h('div', { class: 'st-prompt', text: '🎨 ' + prompt }), note);
    const show = async (r) => {
      const url = await ctx.blobUrl('/api/media/' + r.id);
      const img = h('img', { class: 'st-img', alt: prompt, src: url });
      box.textContent = '';
      box.append(h('div', { class: 'st-view' }, img), h('div', { class: 'st-tools' },
        h('span', { class: 'st-note', text: r.provider ? ctx.t('st_image_by', { who: r.provider, model: r.model || '' }) : '' }),
        ctx.saveToFolder ? btn('💾 ' + ctx.t('st_save_folder'), async () => ctx.saveToFolder(fileName(prompt) + '.' + r.id.split('.').pop(), await ctx.getBlob('/api/media/' + r.id))) : null,
        btn('⬇ ' + ctx.t('st_save'), async () => download(fileName(prompt) + '.' + r.id.split('.').pop(), await ctx.getBlob('/api/media/' + r.id)))));
    };
    let busy = false;
    const make = async () => {
      if (busy) return;
      busy = true; note.textContent = ctx.t('st_image_making');
      try { await show(await ctx.api('/api/media/generate', { body: { prompt } })); }
      catch (e) { note.textContent = '⚠ ' + ctx.t('st_image_failed') + ' — ' + ctx.errText(e.code, e.message); }
      busy = false;
    };
    const makeBtn = btn('🎨 ' + ctx.t('st_image_make'), make);
    box.append(h('div', { class: 'st-tools' }, makeBtn));
    ctx.api('/api/media/generate', { body: { prompt, lookup: true } }).then((r) => {
      if (r.id) return show(r);
      if (!r.available) { note.textContent = ctx.t('st_image_none'); return undefined; }
      return live ? make() : undefined;
    }).catch(() => {});
    return box;
  }

  // ---- slideshow video --------------------------------------------------------------------
  const shade = (hex, k) => { const n = parseInt(hex.slice(1), 16); const f = (v) => Math.max(0, Math.min(255, Math.round(v * k))); return 'rgb(' + f(n >> 16) + ',' + f((n >> 8) & 255) + ',' + f(n & 255) + ')'; };
  function lines(g, text, maxW, maxLines) {
    const out = [];
    let cur = '';
    for (const w of String(text || '').split(/\s+/).filter(Boolean)) {
      const next = cur ? cur + ' ' + w : w;
      if (cur && g.measureText(next).width > maxW) { out.push(cur); cur = w; } else cur = next;
    }
    if (cur) out.push(cur);
    if (out.length > maxLines) { out.length = maxLines; out[maxLines - 1] = out[maxLines - 1].replace(/.{2}$/, '') + '…'; }
    return out;
  }
  function drawScene(g, v, t, pics) {
    const W = 1280, H = 720;
    let i = 0, start = 0;
    while (i < v.scenes.length - 1 && t >= start + v.scenes[i].seconds) { start += v.scenes[i].seconds; i += 1; }
    const sc = v.scenes[i], local = Math.max(0, t - start), k = Math.min(1, local / sc.seconds);
    const grad = g.createLinearGradient(0, 0, W, H);
    grad.addColorStop(0, sc.color); grad.addColorStop(1, shade(sc.color, 0.42));
    g.fillStyle = grad; g.fillRect(0, 0, W, H);
    const pic = pics[i];
    if (pic) {
      const r = Math.max(W / pic.width, H / pic.height) * (1 + 0.08 * k), dw = pic.width * r, dh = pic.height * r;
      g.drawImage(pic, (W - dw) / 2, (H - dh) / 2, dw, dh);
      g.fillStyle = 'rgba(0,0,0,.46)'; g.fillRect(0, 0, W, H);
    }
    g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = '#ffffff';
    let y = 270;
    if (sc.emoji && !pic) {
      g.font = Math.round(150 * (1 + 0.05 * Math.sin(k * Math.PI))) + 'px "Segoe UI Emoji","Apple Color Emoji",sans-serif';
      g.fillText(sc.emoji, W / 2, 200);
      y = 380;
    }
    g.font = '700 58px ' + FONT;
    const head = lines(g, sc.title, 1080, 2);
    head.forEach((ln, n) => g.fillText(ln, W / 2, y + n * 68));
    y += head.length * 68 + 14;
    g.font = '400 34px ' + FONT; g.fillStyle = 'rgba(255,255,255,.92)';
    lines(g, sc.text, 1040, 3).forEach((ln, n) => g.fillText(ln, W / 2, y + n * 46));
    g.font = '400 22px ' + FONT; g.fillStyle = 'rgba(255,255,255,.72)';
    g.textAlign = 'left'; if (v.title) g.fillText(v.title, 40, H - 44);
    g.textAlign = 'right'; g.fillText((i + 1) + ' / ' + v.scenes.length, W - 40, H - 44);
    g.fillStyle = 'rgba(255,255,255,.25)'; g.fillRect(0, H - 10, W, 10);
    g.fillStyle = '#ffffff'; g.fillRect(0, H - 10, W * Math.min(1, t / v.total), 10);
    const fade = Math.min(1, local / 0.35, (sc.seconds - local) / 0.35);
    if (fade < 1) { g.fillStyle = 'rgba(0,0,0,' + ((1 - Math.max(0, fade)) * 0.9).toFixed(3) + ')'; g.fillRect(0, 0, W, H); }
  }
  function videoWidget(v) {
    const canvas = h('canvas', { class: 'st-video', width: 1280, height: 720 });
    const g = canvas.getContext('2d');
    const pics = [];
    let timer = 0, rec = null;
    const still = () => drawScene(g, v, 0.6, pics);
    const playBtn = btn('▶ ' + ctx.t('st_play'), () => (timer ? stop() : play()));
    function stop() {
      clearInterval(timer); timer = 0;
      playBtn.textContent = '▶ ' + ctx.t('st_play');
      if (rec && rec.state !== 'inactive') rec.stop();
    }
    function play() {
      const t0 = performance.now();
      playBtn.textContent = '⏹ ' + ctx.t('st_stop');
      timer = setInterval(() => {
        const t = (performance.now() - t0) / 1000;
        if (t >= v.total) { drawScene(g, v, v.total - 0.4, pics); stop(); } else drawScene(g, v, t, pics);
      }, 33);
    }
    const exportVideo = () => {
      if (timer) stop();
      if (!canvas.captureStream || typeof MediaRecorder === 'undefined') return ctx.toast(ctx.t('st_video_unsupported'), 5000);
      const type = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((x) => MediaRecorder.isTypeSupported(x));
      const chunks = [];
      rec = new MediaRecorder(canvas.captureStream(30), { mimeType: type, videoBitsPerSecond: 4000000 });
      rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      rec.onstop = () => { rec = null; const blob = new Blob(chunks, { type: 'video/webm' }); if (!blob.size) return; if (ctx.saveToFolder) ctx.saveToFolder(fileName(v.title || 'video') + '.webm', blob); else { download(fileName(v.title || 'video') + '.webm', blob); ctx.toast(ctx.t('st_video_done'), 4000); } };
      rec.start();
      ctx.toast(ctx.t('st_video_recording', { s: Math.round(v.total) }), v.total * 1000);
      play();
    };
    const tools = h('div', { class: 'st-tools' }, playBtn, btn('⬇ ' + ctx.t('st_video_export'), exportVideo), h('span', { class: 'st-note', text: ctx.t('st_video_info', { n: v.scenes.length, s: Math.round(v.total) }) }));
    const wanted = v.scenes.map((sc, i) => (sc.image ? i : -1)).filter((i) => i >= 0);
    if (wanted.length && ctx.imageAI()) {
      tools.append(btn('🎨 ' + ctx.t('st_scene_images', { n: wanted.length }), async (e) => {
        e.target.disabled = true;
        try {
          for (const i of wanted) {
            const r = await ctx.api('/api/media/generate', { body: { prompt: v.scenes[i].image } });
            const img = new Image();
            await new Promise((ok, bad) => { img.onload = ok; img.onerror = bad; ctx.blobUrl('/api/media/' + r.id).then((u) => { img.src = u; }, bad); });
            pics[i] = img;
            if (!timer) still();
          }
        } catch (err) { ctx.toast(ctx.t('st_image_failed') + ' — ' + ctx.errText(err.code, err.message), 6000); }
        e.target.disabled = false;
      }));
    }
    still();
    return h('div', { class: 'st-card' }, h('div', { class: 'st-view' }, canvas), tools);
  }

  // ---- a question the AI asks back ------------------------------------------------------------
  // Choices to click (the recommended one first and marked) plus a box for an answer of one's own.
  // Only the newest message can be answered; an older card just shows what was asked.
  function askWidget(q, active) {
    const reply = (text) => { if (active && text && ctx.answer) ctx.answer(text); };
    const card = h('div', { class: 'st-card ask-card' + (active ? '' : ' done') }, h('div', { class: 'ask-q', text: '❓ ' + q.question }));
    if (q.why) card.append(h('div', { class: 'st-note', text: q.why }));
    const list = h('div', { class: 'ask-opts' });
    q.options.forEach((o, i) => {
      const b = h('button', { class: 'ask-opt' + (i === q.recommended ? ' rec' : ''), type: 'button', onclick: () => reply(o.label) },
        h('span', { class: 'ask-lab', text: (i === q.recommended ? '★ ' : '') + o.label }), o.detail ? h('span', { class: 'ask-det', text: o.detail }) : null);
      if (!active) b.disabled = true;
      list.append(b);
    });
    card.append(list);
    if (active) {
      const box = h('input', { type: 'text', class: 'ask-own', placeholder: ctx.t('ask_own_ph') });
      const go = () => { const v = box.value.trim(); if (v) reply(v); };
      box.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); go(); } });
      card.append(h('div', { class: 'ask-row' }, box, h('button', { class: 'btn primary small', type: 'button', onclick: go }, ctx.t('ask_own_send'))));
    } else card.append(h('div', { class: 'st-note', text: ctx.t('ask_answered') }));
    return card;
  }

  // ---- pictures the user attaches ---------------------------------------------------------
  // Shrinks a picture to what the AIs actually use (long edge 1568 px) before it is sent:
  // fewer tokens, faster upload, and nothing over a provider's size limit.
  async function prepareImage(file, name) {
    const MAX = 1568;
    let bmp;
    try { bmp = await createImageBitmap(file); } catch (_) { return null; }
    const asIs = /^image\/(png|jpeg|webp|gif)$/.test(file.type) && file.size <= 1200000 && bmp.width <= MAX && bmp.height <= MAX;
    let blob = file, w = bmp.width, hh = bmp.height, outName = String(name || file.name || 'image');
    if (!asIs) {
      const d = fit(bmp.width, bmp.height, MAX);
      w = d.w; hh = d.h;
      const c = h('canvas', { width: w, height: hh });
      const g = c.getContext('2d');
      g.fillStyle = '#fff'; g.fillRect(0, 0, w, hh);
      g.drawImage(bmp, 0, 0, w, hh);
      blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.88));
      if (!blob) return null;
      outName = outName.replace(/\.[^.]+$/, '') + '.jpg';
    }
    if (bmp.close) bmp.close();
    const data = await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(String(fr.result).split(',')[1] || ''); fr.onerror = () => r(''); fr.readAsDataURL(blob); });
    if (!data) return null;
    return { name: outName, data, type: blob.type || 'image/jpeg', w, h: hh, size: blob.size, image: true, thumb: URL.createObjectURL(blob) };
  }

  // ---- entry point ------------------------------------------------------------------------
  // Replaces each recognised code block in `root` with its rendering; the source stays one click away.
  function enhance(root, opts) {
    const live = !!(opts && opts.live);
    for (const code of Array.from(root.querySelectorAll('.code'))) {
      const lang = ((code.querySelector('.code-head span') || {}).textContent || '').trim().toLowerCase();
      const src = (code.querySelector('pre') || {}).textContent || '';
      let w = null;
      try {
        if (lang === 'mindmap') { const tree = parseOutline(src); if (tree) { const m = mindmapSvg(tree); w = figure(m.svg, fileName(m.title || 'mindmap'), m.w, m.h, () => serialize(m.svg)); } }
        else if (lang === 'chart') { const c = parseChart(src); if (c) { const m = chartSvg(c); w = figure(m.svg, fileName(m.title || 'chart'), m.w, m.h, () => serialize(m.svg)); } }
        else if (lang === 'svg' || ((lang === 'xml' || lang === 'html') && /^\s*<svg[\s>]/i.test(src))) { const d = safeSvg(src); if (d) w = figure(h('img', { class: 'st-img', alt: '', src: dataUrl(d.xml), width: d.w, height: d.h }), 'drawing', d.w, d.h, () => d.xml); }
        else if (lang === 'image') { if (src.trim()) w = imageWidget(src.trim().replace(/\s+/g, ' ').slice(0, 4000), live); }
        else if (lang === 'video') { const v = parseVideo(src); if (v) w = videoWidget(v); }
        else if (lang === 'ask') { const q = parseAsk(src); if (q) { code.replaceWith(askWidget(q, !!(opts && opts.last))); continue; } }
      } catch (_) { w = null; }
      if (!w) continue;
      const det = h('details', { class: 'st-src' }, h('summary', { text: ctx.t('st_source') }));
      code.replaceWith(w);
      det.append(code);
      w.after(det);
    }
  }

  const api = { init: (c) => { ctx = Object.assign(ctx, c); }, enhance, prepareImage, parseAsk, parseOutline, wrap, layoutTree, parseChart, niceTicks, parseVideo, fit, fileName };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.Studio = api;
})();
