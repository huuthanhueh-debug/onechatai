// Minimal, safe Markdown renderer. Everything is HTML-escaped first; only the tags built
// here ever reach the page, and links are limited to http(s). No dependencies.
(function () {
  'use strict';
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const P = '\u0001'; // placeholder delimiter; stripped from the input so it cannot be forged
  const HELD = new RegExp('^' + P + '\\d+' + P + '$');
  const LINK = ' target="_blank" rel="noopener noreferrer"';

  function inline(raw, hold) {
    let s = esc(raw);
    s = s.replace(/`([^`\n]+)`/g, (m, c) => hold('<code>' + c + '</code>'));
    s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (m, t, u) => hold('<a href="' + u + '"' + LINK + '>' + t + '</a>'));
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<]*[^\s<.,;:!?)\]])/g, (m, pre, u) => pre + hold('<a href="' + u + '"' + LINK + '>' + u + '</a>'));
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*\w])\*([^*\s][^*\n]*?)\*(?!\w)/g, '$1<em>$2</em>');
    s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
    return s;
  }

  const splitRow = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  const isSep = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l || '');
  const isItem = (l) => /^\s*(?:[-*+]|\d+[.)])\s+/.test(l || '');

  function render(src) {
    const held = [];
    const hold = (h) => { held.push(h); return P + (held.length - 1) + P; };
    let text = String(src == null ? '' : src).replace(/\r\n?/g, '\n').replace(/[\u0000\u0001]/g, '');
    text = text.replace(/(^|\n)[ \t]*```([^\n`]*)\n([\s\S]*?)(?:\n[ \t]*```[ \t]*(?=\n|$)|$)/g, (m, pre, lang, code) =>
      pre + hold('<div class="code"><div class="code-head"><span>' + esc(lang.trim() || 'code') + '</span><button type="button" class="copy-code">⧉</button></div><pre><code>' + esc(code) + '</code></pre></div>') + '\n');

    const lines = text.split('\n');
    const out = [];
    let para = [];
    const flush = () => { if (para.length) { out.push('<p>' + para.map((l) => inline(l, hold)).join('<br>') + '</p>'); para = []; } };

    function list(start) {
      const stack = [];
      let html = '', i = start;
      for (; i < lines.length; i++) {
        const l = lines[i];
        const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(l);
        if (!m) {
          if (!l.trim()) { let k = i + 1; while (k < lines.length && !lines[k].trim()) k++; if (isItem(lines[k])) { i = k - 1; continue; } break; }
          if (/^\s{2,}\S/.test(l) && !HELD.test(l.trim())) { html += '<br>' + inline(l.trim(), hold); continue; }
          break;
        }
        const indent = m[1].replace(/\t/g, '    ').length, tag = /\d/.test(m[2]) ? 'ol' : 'ul';
        while (stack.length && indent < stack[stack.length - 1].indent) html += '</li></' + stack.pop().tag + '>';
        if (!stack.length || indent > stack[stack.length - 1].indent) {
          const n = parseInt(m[2], 10);
          html += '<' + tag + (tag === 'ol' && n > 1 ? ' start="' + n + '"' : '') + '>';
          stack.push({ indent, tag });
        } else html += '</li>';
        html += '<li>' + inline(m[3], hold);
      }
      while (stack.length) html += '</li></' + stack.pop().tag + '>';
      out.push(html);
      return i - 1;
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) { flush(); continue; }
      if (HELD.test(line.trim())) { flush(); out.push(line.trim()); continue; }
      let m;
      if ((m = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line))) { flush(); const n = Math.min(6, m[1].length + 1); out.push('<h' + n + '>' + inline(m[2], hold) + '</h' + n + '>'); continue; }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); out.push('<hr>'); continue; }
      if (/^\s*>/.test(line)) {
        flush();
        const q = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) { q.push(inline(lines[i].replace(/^\s*>\s?/, ''), hold)); i++; }
        i--;
        out.push('<blockquote>' + q.join('<br>') + '</blockquote>');
        continue;
      }
      if (line.includes('|') && isSep(lines[i + 1])) {
        flush();
        const head = splitRow(line);
        let html = '<div class="table-wrap"><table><thead><tr>' + head.map((c) => '<th>' + inline(c, hold) + '</th>').join('') + '</tr></thead><tbody>';
        i += 2;
        while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
          const cells = splitRow(lines[i]);
          html += '<tr>' + head.map((_, k) => '<td>' + inline(cells[k] || '', hold) + '</td>').join('') + '</tr>';
          i++;
        }
        i--;
        out.push(html + '</tbody></table></div>');
        continue;
      }
      if (isItem(line)) { flush(); i = list(i); continue; }
      para.push(line);
    }
    flush();
    let html = out.join('\n');
    for (let pass = 0; pass < 4 && html.indexOf(P) >= 0; pass++) html = html.replace(new RegExp(P + '(\\d+)' + P, 'g'), (m, n) => held[Number(n)] || '');
    return html;
  }

  const api = { render, escape: esc };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.MD = api;
})();
