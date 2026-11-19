'use strict';
// What the operator's tools do on this computer, and where each one stops to ask the user.
//   browser_*      the OneChat Chrome window (lib/chrome.js)
//   file_*         only inside this task's output folder (lib/output.js)
//   computer_open  always asks first
//   run_command    always asks first; script hosts, downloads and destructive commands are refused outright
const fs = require('fs');
const path = require('path');
const { exec, spawn } = require('child_process');
const output = require('./output');
const media = require('./media');
const chrome = require('./chrome');

const err = (code, message) => Object.assign(new Error(message || code), { code });
const attr = (s) => String(s || '').replace(/["<>&\n]/g, ' ').slice(0, 300);
const clip = (s, n) => (String(s).length > n ? String(s).slice(0, n) + '\n…' : String(s));

const SEARCH = {
  bing: (q) => 'https://www.bing.com/search?q=' + encodeURIComponent(q),
  duckduckgo: (q) => 'https://duckduckgo.com/?q=' + encodeURIComponent(q),
  google: (q) => 'https://www.google.com/search?hl=vi&q=' + encodeURIComponent(q),
};
// Buttons whose press changes something outside this computer or cannot be taken back.
const RISKY = /\b(pay|buy|purchase|order|checkout|send|post|publish|submit|delete|remove|confirm|transfer|subscribe|sign ?up|register|accept|agree|allow|authori[sz]e|install|download)\b|thanh toán|đặt hàng|đặt mua|mua ngay|mua hàng|xác nhận|gửi|đăng bài|đăng tin|đăng ký|xoá|xóa|chuyển khoản|chuyển tiền|chấp nhận|đồng ý|cho phép|tải xuống|tải về|cài đặt/i;
// Never run, even with the user's yes: script hosts (the antivirus on this kind of machine
// kills a network program that starts one), downloaders, and commands that delete or reconfigure.
const REFUSED = new RegExp('(^|[&|(])\\s*(' + ['power' + 'shell', 'pwsh', 'w' + 'script', 'c' + 'script', 'mshta', 'rundll32', 'regsvr32', 'msiexec', 'curl', 'wget', 'certutil', 'bitsadmin',
  'format', 'diskpart', 'shutdown', 'bcdedit', 'vssadmin', 'cipher', 'takeown', 'icacls', 'schtasks', 'sc', 'net', 'reg', 'wmic', 'del', 'erase', 'rd', 'rmdir', 'attrib', 'start', 'cmd', 'forfiles'].join('|') + ')(\\.exe)?(\\s|$)', 'i');

function renderPage(p, from) {
  const at = Math.max(0, Number(from) || 0);
  const more = p.text.length > at + 5000;
  const items = p.elements.slice(0, 60).map((e) => '[' + e.id + '] ' + e.kind + (e.label ? ' "' + e.label + '"' : '') + (e.value ? ' value="' + e.value + '"' : '') + (e.href && /^https?:/i.test(e.href) ? ' -> ' + e.href.slice(0, 110) : ''));
  let out = '<page url="' + attr(p.url) + '" title="' + attr(p.title) + '">\n' + p.text.slice(at, at + 5000) + (more ? '\n…(the text continues: browser_read {"more": true})' : '')
    + '\n--- items you can click or type into ---\n' + (items.join('\n') || '(none)') + (p.elements.length > 60 ? '\n…(' + (p.elements.length - 60) + ' more items not listed)' : '') + '\n</page>';
  if (chrome.isChallenge(p)) out += '\nNOTE: this page is a human check (CAPTCHA). Do not try to pass it. Use wait_for_user so the user does it in the Chrome window, or use another site.';
  else if (p.password) out += '\nNOTE: this page asks for a sign-in. Never type a password. Use wait_for_user so the user signs in themselves in the Chrome window.';
  return out;
}

// ctx: { browser, settings, folder() -> dir, ask({kind, tool, text}) -> Promise<boolean>, onFile(file),
//        sees, port, desktop (false = never start programs: tests) }
function make(ctx) {
  const op = (ctx.settings && ctx.settings.operator) || {};
  const askAll = op.confirm === 'all';
  const denied = { text: 'The user did not allow this. Do not try it again: continue another way or finish.', brief: 'not allowed' };
  let offset = 0, shots = 0;
  const page = (p) => { offset = 0; return { text: renderPage(p, 0), brief: clip(p.title || p.url, 80) }; };
  const webUrl = (raw) => {
    let u = String(raw || '').trim();
    if (!u) throw err('bad_url', 'no address given');
    if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) u = 'https://' + u;
    let parsed;
    try { parsed = new URL(u); } catch (_) { throw err('bad_url', 'not a web address: ' + raw); }
    if (!/^https?:$/.test(parsed.protocol)) throw err('bad_url', 'only http and https addresses can be opened');
    if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(parsed.hostname) && String(parsed.port) === String(ctx.port)) throw err('bad_url', 'that address is this app itself');
    return parsed.href;
  };
  const saved = (file) => { if (ctx.onFile) ctx.onFile(file); return file; };

  const tools = {
    async browser_search(a) {
      const q = String(a.query || '').trim();
      if (!q) throw err('bad_args', 'browser_search needs a "query"');
      const first = SEARCH[op.search] ? op.search : 'bing';
      let last = null;
      for (const name of [first].concat(Object.keys(SEARCH).filter((k) => k !== first))) {
        last = await ctx.browser.open(SEARCH[name](q));
        if (!chrome.isChallenge(last)) return page(last);
      }
      return page(last); // every engine asked for a human check: the note on the page says what to do
    },
    async browser_open(a) { return page(await ctx.browser.open(webUrl(a.url))); },
    async browser_read(a) {
      const p = await ctx.browser.snapshot();
      offset = a.more ? offset + 5000 : 0;
      return { text: renderPage(p, offset), brief: clip(p.title || p.url, 80) };
    },
    async browser_click(a) {
      const at = await ctx.browser.locate(a.id);
      if (!at) throw err('no_element', 'there is no item [' + a.id + '] on the page now: read the page again');
      if ((askAll || RISKY.test(at.label)) && !(await ctx.ask({ kind: 'approve', tool: 'browser_click', text: '«' + (at.label || '[' + a.id + ']') + '» — ' + at.host }))) return denied;
      return page(await ctx.browser.click(a.id));
    },
    async browser_type(a) {
      const at = await ctx.browser.locate(a.id);
      if (!at) throw err('no_element', 'there is no item [' + a.id + '] on the page now: read the page again');
      if (at.secret) throw err('secret_field', 'this field is for a password or code: use wait_for_user so the user types it themselves');
      const text = String(a.text == null ? '' : a.text);
      // Typing into a search box is routine; sending anything else off with Enter is the user's call.
      if ((askAll || (a.enter && !at.search)) && !(await ctx.ask({ kind: 'approve', tool: 'browser_type', text: '«' + clip(text, 200) + '»' + (a.enter ? ' ⏎' : '') + ' — ' + at.host }))) return denied;
      return page(await ctx.browser.type(a.id, text, !!a.enter));
    },
    async browser_back() { return page(await ctx.browser.back()); },
    async browser_screenshot(a) {
      const buf = await ctx.browser.screenshot();
      shots += 1;
      const name = /\.png$/i.test(String(a.name || '')) ? a.name : (String(a.name || '').replace(/\.[^.]*$/, '') || 'man-hinh-' + shots) + '.png';
      const file = saved(output.write(ctx.folder(), name, buf));
      const out = { text: 'Saved a screenshot of the page as ' + file.name + ' in the output folder.', brief: file.name };
      if (ctx.sees) { try { const s = media.save(buf); out.images = [{ id: s.id, name: file.name }]; out.imgTokens = media.tokensFor(s.w, s.h); } catch (_) { /* too large to show: it is still saved */ } }
      return out;
    },
    async file_write(a) {
      if (typeof a.content !== 'string') throw err('bad_args', 'file_write needs the file content after the action block, between the BEGIN FILE and END FILE lines');
      // Replacing a file is the risky part: the old one is kept first, so it can be restored.
      const kept = output.keepVersion(ctx.folder(), a.name);
      if (kept && ctx.onBackup) ctx.onBackup(kept);
      const file = saved(output.write(ctx.folder(), a.name, a.content));
      return { text: 'Saved ' + file.name + ' (' + file.bytes + ' bytes) in the output folder.' + (kept ? ' The previous version was kept as ' + kept.rel + '.' : ''), brief: file.name + (kept ? ' (bản cũ đã giữ)' : '') };
    },
    async ask_user(a) {
      const question = clip(String(a.question || '').trim(), 400);
      if (!question) throw err('bad_args', 'ask_user needs a "question"');
      const options = (Array.isArray(a.options) ? a.options : []).map((o) => (typeof o === 'string' ? { label: o } : o || {}))
        .map((o) => ({ label: clip(String(o.label || '').trim(), 160), detail: clip(String(o.detail || '').trim(), 240) })).filter((o) => o.label).slice(0, 5);
      const rec = Number.isInteger(a.recommended) && a.recommended >= 0 && a.recommended < options.length ? a.recommended : 0;
      const answer = await ctx.ask({ kind: 'choice', tool: 'ask_user', text: question, options, recommended: options.length ? rec : -1 });
      if (typeof answer === 'string' && answer.trim()) return { text: 'The user answered: "' + clip(answer.trim(), 2000) + '"', brief: clip(answer.trim(), 80) };
      return { text: 'The user did not answer. Go on with ' + (options.length ? 'the option you recommended ("' + options[rec].label + '")' : 'the most sensible choice') + ' and tell them in the final answer that you assumed it.', brief: 'no answer' };
    },
    async file_read(a) {
      const r = output.read(ctx.folder(), a.name, 8000);
      return { text: '<file name="' + attr(r.name) + '">\n' + r.text + '\n</file>', brief: r.name };
    },
    async file_list() {
      const list = output.list(ctx.folder());
      return { text: list.length ? list.map((f) => f.name + ' (' + f.bytes + ' bytes)').join('\n') : '(the output folder is empty)', brief: list.length + ' files' };
    },
    async wait_for_user(a) {
      await ctx.browser.front();
      const ok = await ctx.ask({ kind: 'wait', tool: 'wait_for_user', text: clip(String(a.message || ''), 400) });
      if (!ok) return { text: 'The user chose to stop here. Finish now with what you have.', brief: 'stopped' };
      if (!ctx.browser.running()) return { text: 'The user says it is done.', brief: 'done' };
      const p = await ctx.browser.snapshot();
      return { text: 'The user says it is done. The page now:\n' + renderPage(p, 0), brief: 'done' };
    },
    async computer_open(a) {
      const target = String(a.target || '').trim();
      if (!target || /[&|<>^%"`\r\n]/.test(target)) throw err('bad_args', 'computer_open needs a plain file name, program name or web address');
      let run;
      if (/^https?:\/\//i.test(target)) run = ['explorer.exe', [webUrl(target)]];
      else {
        let file = '';
        try { const at = output.inside(ctx.folder(), target); if (fs.existsSync(at.file)) file = at.file; } catch (_) { /* not a file of the output folder */ }
        if (!file && path.isAbsolute(target) && fs.existsSync(target)) file = target;
        if (file) run = ['explorer.exe', [file]];
        else if (/^[\p{L}\p{N}][\p{L}\p{N} ._+-]{0,60}$/u.test(target)) run = ['cmd.exe', ['/d', '/c', 'start', '""', target], { windowsVerbatimArguments: true }];
        else throw err('bad_args', 'nothing by that name to open');
      }
      if (!(await ctx.ask({ kind: 'approve', tool: 'computer_open', text: target }))) return denied;
      if (ctx.desktop !== false && process.platform === 'win32') spawn(run[0], run[1], Object.assign({ detached: true, stdio: 'ignore', windowsHide: false }, run[2] || {})).unref();
      return { text: 'Opened ' + target + '.', brief: target };
    },
    async run_command(a) {
      const command = String(a.command || '').trim();
      if (!command || command.length > 600) throw err('bad_args', 'run_command needs one short command');
      if (REFUSED.test(command)) throw err('refused', 'this app does not run that kind of command (script hosts, downloads, deleting or reconfiguring). Tell the user the exact command so they can decide to run it themselves.');
      if (!(await ctx.ask({ kind: 'approve', tool: 'run_command', text: command, rollback: true }))) return denied;
      const cwd = ctx.folder();
      // The rollback path: a copy of the whole output folder, taken after the yes and before the command.
      const snap = output.snapshot(cwd, 'truoc-lenh');
      if (snap && ctx.onBackup) ctx.onBackup(snap);
      const r = await new Promise((resolve) => exec(command, { cwd, timeout: 60000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 }, (e, stdout, stderr) => resolve({ code: e ? (e.killed ? 'timeout' : e.code) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') })));
      return { text: (snap ? 'The output folder was copied to ' + snap.rel + ' before running.\n' : '') + 'exit code: ' + r.code + '\n<result>\n' + clip((r.stdout + (r.stderr ? '\n[stderr]\n' + r.stderr : '')).trim() || '(no output)', 6000) + '\n</result>', brief: 'exit ' + r.code };
    },
  };
  const run = async (action) => {
    const fn = Object.prototype.hasOwnProperty.call(tools, action.tool) ? tools[action.tool] : null;
    if (!fn) throw err('unknown_tool', 'there is no tool "' + action.tool + '". Tools: ' + Object.keys(tools).join(', '));
    return fn(action);
  };
  run.tools = Object.keys(tools);
  return run;
}

module.exports = { make, renderPage, RISKY, REFUSED };
