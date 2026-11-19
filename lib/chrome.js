'use strict';
// The user's Chrome (or Edge), driven over the DevTools protocol through a private pipe:
// no port is opened, so no other program on the machine can take the wheel. It runs with
// its own profile folder; whatever the user signs in to there stays signed in for next time.
// No library: the protocol is JSON messages separated by a zero byte.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const err = (code, message) => Object.assign(new Error(message || code), { code });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NUL = String.fromCharCode(0);

function findBrowser() {
  const pf = process.env.ProgramFiles || 'C:\\Program Files', pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', local = process.env.LOCALAPPDATA || '';
  const list = [
    process.env.ONECHAT_CHROME,
    path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'), path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'), local && path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  for (const p of list) { try { if (p && fs.statSync(p).isFile()) return p; } catch (_) { /* next */ } }
  return '';
}
const FLAGS = ['--no-first-run', '--no-default-browser-check', '--disable-search-engine-choice-screen', '--window-size=1280,900'];

// The same profile in an ordinary Chrome window, with nothing attached to it: for the user
// to sign in to their accounts by hand. Close it before a task that drives the browser.
function openPlain(profileDir, url) {
  const exe = findBrowser();
  if (!exe) throw err('no_browser', 'Chrome or Edge was not found on this computer');
  fs.mkdirSync(profileDir, { recursive: true });
  spawn(exe, ['--user-data-dir=' + profileDir].concat(FLAGS, [url || 'about:blank']), { detached: true, stdio: 'ignore' }).unref();
}

// A page that wants proof of a human: never worked around, always handed to the user.
function isChallenge(page) {
  if (!page) return false;
  if (/\/sorry\/index|google\.com\/recaptcha|\/cdn-cgi\/challenge-platform|\/captcha[/?]/i.test(page.url || '')) return true;
  return (page.text || '').length < 3000 && /unusual traffic|lưu lượng truy cập bất thường|verify (that )?you are (a )?human|are you a robot|not a robot|xác minh bạn là (con )?người|kiểm tra bảo mật/i.test(page.text || '');
}

// ---- code that runs inside the page (never in Node) -----------------------------------------
// Numbers everything that can be clicked or typed into and returns the visible text.
function pageSnapshot() {
  const seen = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 3 && r.height > 3 && s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0'; };
  for (const e of document.querySelectorAll('[data-oc-id]')) e.removeAttribute('data-oc-id');
  const elements = [];
  let n = 0;
  for (const el of document.querySelectorAll('a[href], button, input, textarea, select, summary, [role=button], [role=link], [role=tab], [role=menuitem], [role=checkbox], [contenteditable=""], [contenteditable=true]')) {
    if (n >= 160) break;
    const tag = el.tagName.toLowerCase(), type = (el.getAttribute('type') || '').toLowerCase();
    if ((tag === 'input' && type === 'hidden') || !seen(el)) continue;
    n += 1;
    el.setAttribute('data-oc-id', String(n));
    const secret = tag === 'input' && type === 'password';
    const label = String((tag === 'input' || tag === 'textarea' || tag === 'select' ? '' : el.innerText) || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || (secret ? '' : el.value) || '').replace(/\s+/g, ' ').trim().slice(0, 90);
    const item = { id: n, kind: tag === 'a' ? 'link' : tag === 'input' ? 'input:' + (type || 'text') : el.getAttribute('role') || tag, label };
    if (tag === 'a') item.href = String(el.href || '').slice(0, 220);
    if ((tag === 'input' || tag === 'textarea') && !secret && el.value && type !== 'checkbox' && type !== 'radio') item.value = String(el.value).slice(0, 80);
    elements.push(item);
  }
  const text = String(document.body ? document.body.innerText : '').replace(/[^\S\n]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
  return { title: document.title, url: location.href, text, elements, password: !!Array.from(document.querySelectorAll('input[type=password]')).find(seen) };
}
// Where item [id] is on screen and what kind of thing it is.
function pageLocate(id) {
  const el = document.querySelector('[data-oc-id="' + id + '"]');
  if (!el) return null;
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  const tag = el.tagName.toLowerCase(), type = (el.getAttribute('type') || '').toLowerCase();
  const auto = (el.getAttribute('autocomplete') || '').toLowerCase();
  const hint = [type, el.getAttribute('name'), el.id, el.getAttribute('placeholder'), el.getAttribute('aria-label'), el.getAttribute('role'), el.form && el.form.getAttribute('role'), el.form && el.form.getAttribute('action')].join(' ').toLowerCase();
  const label = String(el.innerText || el.getAttribute('aria-label') || (type === 'password' ? '' : el.value) || el.getAttribute('title') || '').replace(/\s+/g, ' ').trim().slice(0, 90);
  return {
    x: r.left + r.width / 2, y: r.top + r.height / 2, tag, type, label, host: location.host,
    secret: type === 'password' || /password|one-time-code|cc-number|cc-csc|cc-exp/.test(auto),
    search: type === 'search' || /search|tìm|query|(^|\s)q(\s|$)/.test(hint),
    editable: tag === 'input' || tag === 'textarea' || el.isContentEditable,
  };
}
function pageFocus(id) {
  const el = document.querySelector('[data-oc-id="' + id + '"]');
  if (!el) return false;
  el.focus();
  if (typeof el.select === 'function') el.select(); else if (el.isContentEditable) document.execCommand('selectAll', false, null);
  return true;
}

function create(opts) {
  const profile = opts.profileDir;
  let child = null, buf = Buffer.alloc(0), nextId = 1, session = '', targetId = '', popup = '';
  const waiting = new Map();
  const listeners = new Set();

  function onData(chunk) {
    buf = Buffer.concat([buf, chunk]);
    let i;
    while ((i = buf.indexOf(0)) >= 0) {
      const raw = buf.subarray(0, i).toString('utf8');
      buf = buf.subarray(i + 1);
      let m;
      try { m = JSON.parse(raw); } catch (_) { continue; }
      if (m.id && waiting.has(m.id)) {
        const w = waiting.get(m.id);
        waiting.delete(m.id);
        clearTimeout(w.timer);
        if (m.error) w.reject(err('browser_error', m.error.message || 'browser error')); else w.resolve(m.result || {});
      } else if (m.method) {
        if (m.method === 'Target.targetCreated' && m.params.targetInfo.type === 'page' && m.params.targetInfo.openerId === targetId) popup = m.params.targetInfo.targetId;
        if (m.method === 'Target.targetDestroyed' && m.params.targetId === targetId) { session = ''; targetId = ''; }
        for (const l of listeners) l(m);
      }
    }
  }
  function send(method, params, sid) {
    if (!child) return Promise.reject(err('browser_closed', 'the browser is not running'));
    const id = nextId++;
    const msg = { id, method, params: params || {} };
    if (sid) msg.sessionId = sid;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { if (waiting.delete(id)) reject(err('timeout', method + ' took too long')); }, 30000);
      waiting.set(id, { resolve, reject, timer });
      try { child.stdio[3].write(JSON.stringify(msg) + NUL); } catch (e) { waiting.delete(id); clearTimeout(timer); reject(err('browser_closed', e.message)); }
    });
  }
  function waitFor(method, ms) {
    return new Promise((resolve) => {
      const l = (m) => { if (m.method === method && m.sessionId === session) { clearTimeout(t); listeners.delete(l); resolve(true); } };
      const t = setTimeout(() => { listeners.delete(l); resolve(false); }, ms);
      listeners.add(l);
    });
  }

  async function attach(id) {
    const r = await send('Target.attachToTarget', { targetId: id, flatten: true });
    session = r.sessionId; targetId = id;
    await send('Page.enable', {}, session);
    await send('Runtime.enable', {}, session);
  }
  async function attachAny() {
    const r = await send('Target.getTargets');
    const page = (r.targetInfos || []).find((t) => t.type === 'page');
    if (page) return attach(page.targetId);
    return attach((await send('Target.createTarget', { url: 'about:blank' })).targetId);
  }
  async function start() {
    if (child) return;
    const exe = findBrowser();
    if (!exe) throw err('no_browser', 'Chrome or Edge was not found on this computer');
    fs.mkdirSync(profile, { recursive: true });
    const c = spawn(exe, ['--remote-debugging-pipe', '--user-data-dir=' + profile].concat(FLAGS, opts.args || [], ['about:blank']), { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
    child = c; buf = Buffer.alloc(0); session = ''; targetId = '';
    c.stdio[4].on('data', onData);
    c.stdio[3].on('error', () => {}); c.stdio[4].on('error', () => {});
    const gone = () => {
      if (child !== c) return;
      child = null; session = ''; targetId = '';
      for (const w of waiting.values()) { clearTimeout(w.timer); w.reject(err('browser_closed', 'the browser window was closed')); }
      waiting.clear();
    };
    c.on('exit', gone); c.on('error', gone);
    try {
      await send('Target.setDiscoverTargets', { discover: true });
      await attachAny();
    } catch (e) {
      // A Chrome that is already open on this profile swallows the launch and this one exits at once.
      if (e.code === 'browser_closed') throw err('profile_busy', 'the OneChat Chrome window is already open (for signing in): close it, then try again');
      throw e;
    }
  }
  async function ready() { await start(); if (!session) await attachAny(); }
  async function evaluate(expression) {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, session);
    if (r.exceptionDetails) throw err('page_error', String((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text || 'page error').slice(0, 300));
    return r.result ? r.result.value : undefined;
  }
  // After something that may load a new page: wait until the document says it is complete.
  async function settle(ms) {
    const until = Date.now() + (ms || 10000);
    await sleep(350);
    while (Date.now() < until) {
      try { if ((await evaluate('document.readyState')) === 'complete') break; } catch (_) { /* mid-navigation: ask again */ }
      await sleep(250);
    }
    await sleep(300);
  }
  async function snapshot() { await ready(); return evaluate('(' + pageSnapshot + ')()'); }
  async function open(url) {
    await ready();
    const loaded = waitFor('Page.loadEventFired', 25000);
    const r = await send('Page.navigate', { url }, session);
    if (r.errorText) throw err('nav_failed', 'the page could not be opened (' + r.errorText + ')');
    await loaded;
    await sleep(500);
    return snapshot();
  }
  async function locate(id) { await ready(); return evaluate('(' + pageLocate + ')(' + Number(id) + ')'); }
  async function pressAt(at) {
    for (const [type, extra] of [['mouseMoved', {}], ['mousePressed', { button: 'left', clickCount: 1 }], ['mouseReleased', { button: 'left', clickCount: 1 }]]) {
      await send('Input.dispatchMouseEvent', Object.assign({ type, x: at.x, y: at.y }, extra), session);
    }
  }
  const followPopup = async () => { if (popup) { try { await attach(popup); } catch (_) { /* keep the current tab */ } } };
  async function click(id) {
    const at = await locate(id);
    if (!at) throw err('no_element', 'there is no item [' + id + '] on the page now: read the page again');
    popup = '';
    await pressAt(at);
    await sleep(500);
    await followPopup();
    await settle(10000);
    return snapshot();
  }
  async function type(id, text, enter) {
    const at = await locate(id);
    if (!at) throw err('no_element', 'there is no item [' + id + '] on the page now: read the page again');
    if (at.secret) throw err('secret_field', 'this field is for a password or code: the user must type it themselves');
    await pressAt(at);
    await evaluate('(' + pageFocus + ')(' + Number(id) + ')');
    await send('Input.insertText', { text: String(text) }, session);
    if (enter) {
      popup = '';
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: String.fromCharCode(13) }, session);
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }, session);
      await sleep(500);
      await followPopup();
      await settle(10000);
    } else await sleep(250);
    return snapshot();
  }
  async function back() { await ready(); await evaluate('history.back()'); await settle(8000); return snapshot(); }
  async function screenshot() { await ready(); return Buffer.from((await send('Page.captureScreenshot', { format: 'png' }, session)).data, 'base64'); }
  async function front() { if (!child) return; try { await ready(); await send('Page.bringToFront', {}, session); } catch (_) { /* cosmetic */ } }
  async function close() {
    const c = child;
    if (!c) return;
    try { await send('Browser.close'); } catch (_) { /* already going */ }
    await sleep(300);
    try { c.kill(); } catch (_) { /* gone */ }
  }
  return { start, open, snapshot, locate, click, type, back, screenshot, front, close, running: () => !!child, profileDir: profile };
}

module.exports = { create, findBrowser, openPlain, isChallenge };
