'use strict';
// OneChat as a desktop app: its own window and taskbar icon, a tray icon, start with Windows.
// The shell only shows the UI. The server stays the same Node program as before, started as
// a child with --use-system-ca (needed on machines where antivirus inspects TLS) and
// restarted if it ever stops. Keys and chats live where they always did (%APPDATA%\OneChat).
const { app, BrowserWindow, Tray, Menu, shell, session, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const cfg = require('../lib/config');

const ROOT = path.join(__dirname, '..');
const ICON = path.join(ROOT, 'public', 'icon.png');
const ICO = path.join(ROOT, 'public', 'icon.ico'); // several sizes in one file: what the Windows taskbar wants
const WIN = process.platform === 'win32';
const PORT = Number(process.env.ONECHAT_PORT) || cfg.loadSettings().port;
const HOME_URL = 'http://127.0.0.1:' + PORT + '/';
const ARGS = process.argv.slice(1);
const START_HIDDEN = ARGS.includes('--hidden');
const SMOKE = (ARGS.find((a) => a.startsWith('--smoke=')) || '').slice(8); // self-test: load, report, quit
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let win = null, tray = null, server = null, quitting = false, restarts = 0;

// Chromium's own profile goes in a subfolder so it never mixes with OneChat's data files.
app.setPath('userData', path.join(app.getPath('appData'), cfg.APP, 'electron'));
app.setAppUserModelId('OneChat');

async function ping() {
  try { const r = await fetch(HOME_URL + 'api/ping', { signal: AbortSignal.timeout(1500) }); const j = await r.json(); return !!j && j.app === 'onechat'; }
  catch (_) { return false; }
}

function findNode() {
  const guess = [process.env.ONECHAT_NODE, path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node.exe')];
  for (const g of guess) if (g && fs.existsSync(g)) return g;
  return 'node';
}

function startServer() {
  const log = fs.openSync(path.join(app.getPath('temp'), 'onechat.log'), 'a');
  server = spawn(findNode(), ['--use-system-ca', path.join(ROOT, 'server.js'), '--port', String(PORT), '--no-auto-exit'], { cwd: ROOT, windowsHide: true, stdio: ['ignore', log, log] });
  server.on('error', () => { server = null; });
  server.on('exit', () => {
    server = null;
    if (!quitting && restarts++ < 5) setTimeout(ensureServer, 800); // the page reconnects by itself
  });
}

// Use a OneChat server that is already running, else start one and wait until it answers.
async function ensureServer() {
  if (await ping()) return true;
  if (!server) startServer();
  for (let i = 0; i < 80; i++) { await sleep(250); if (await ping()) return true; }
  return false;
}

function showWindow() {
  if (!win) return createWindow(true);
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow(show) {
  win = new BrowserWindow({
    width: 1320, height: 880, minWidth: 720, minHeight: 520, show: false, title: 'OneChat', icon: WIN && fs.existsSync(ICO) ? ICO : ICON,
    autoHideMenuBar: true, backgroundColor: '#faf9f5',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.removeMenu();
  // The taskbar button belongs to OneChat, not to the Electron program that runs it: its own
  // icon and name, and "Pin to taskbar" pins something that starts OneChat again.
  if (WIN && fs.existsSync(ICO)) {
    try { win.setAppDetails({ appId: 'OneChat', appIconPath: ICO, appIconIndex: 0, relaunchCommand: '"' + process.execPath + '" "' + ROOT + '"', relaunchDisplayName: 'OneChat' }); } catch (_) { /* the window icon still applies */ }
  }
  win.loadURL(HOME_URL);
  win.once('ready-to-show', () => { if (show) win.show(); });
  win.on('close', (e) => { if (!quitting) { e.preventDefault(); win.hide(); } }); // closing keeps it in the tray
  win.on('closed', () => { win = null; });
  // Links the user clicks open in their browser; the app window itself never leaves OneChat.
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//i.test(url) && !url.startsWith(HOME_URL)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(HOME_URL)) e.preventDefault(); });
  if (SMOKE) win.webContents.once('did-finish-load', async () => {
    await sleep(3000);
    let info;
    try {
      info = await win.webContents.executeJavaScript(`(async () => ({ title: document.title, electron: /Electron/.test(navigator.userAgent),
        pills: [...document.querySelectorAll('#pills .pill')].map((p) => p.textContent), agentButton: !!document.querySelector('#btnAgent'),
        offlineBanner: !document.querySelector('#offline').hidden, welcome: (document.querySelector('.welcome h1') || {}).textContent || '',
        mic: !!(navigator.mediaDevices && window.MediaRecorder),
        state: await fetch('/api/state', { headers: { 'x-onechat-token': document.querySelector('meta[name="onechat-token"]').content } }).then((r) => r.status) }))()`);
    } catch (e) { info = { error: String(e && e.message) }; }
    info.autostart = autostart();
    fs.writeFileSync(SMOKE, JSON.stringify(info, null, 2));
    quitting = true;
    app.quit();
  });
}

// "Start with Windows": a per-user login item that launches this app hidden in the tray.
// (Electron quotes each argument itself; quoting ROOT here would break the path.)
const LOGIN = { path: process.execPath, args: [ROOT, '--hidden'] };
const MARKER = path.join(cfg.dataDir(), 'autostart.set'); // remembers the owner's choice: "off" or anything else = on
const autostart = () => { try { return !!app.getLoginItemSettings(LOGIN).openAtLogin; } catch (_) { return false; } };
const wantAutostart = () => { try { return fs.readFileSync(MARKER, 'utf8').trim() !== 'off'; } catch (_) { return true; } };
const setAutostart = (on) => { app.setLoginItemSettings(Object.assign({ openAtLogin: !!on }, LOGIN)); try { fs.writeFileSync(MARKER, on ? 'on' : 'off'); } catch (_) {} };

function buildTray() {
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
  tray.setToolTip('OneChat');
  const refresh = () => tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Mở OneChat  ·  Open', click: showWindow },
    { label: 'Khởi động cùng Windows  ·  Start with Windows', type: 'checkbox', checked: autostart(), click: (item) => { setAutostart(item.checked); refresh(); } },
    { type: 'separator' },
    { label: 'Thoát OneChat  ·  Quit', click: () => { quitting = true; app.quit(); } },
  ]));
  refresh();
  tray.on('click', showWindow);
}

function main() {
  if (!app.requestSingleInstanceLock()) { app.quit(); return; } // already running: that instance shows its window
  app.on('second-instance', showWindow);
  app.on('window-all-closed', () => { /* stay in the tray */ });
  app.on('before-quit', () => { quitting = true; if (server) { try { server.kill(); } catch (_) {} } });
  app.whenReady().then(async () => {
    const allowed = ['media', 'clipboard-sanitized-write', 'clipboard-read'];
    const ours = (u) => String(u || '').startsWith(HOME_URL.slice(0, -1));
    session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(ours(wc.getURL()) && allowed.includes(perm)));
    session.defaultSession.setPermissionCheckHandler((wc, perm, origin) => ours(origin) && allowed.includes(perm));
    // The owner asked for it to start with Windows, so that is the default; the tray menu changes it.
    // Re-applied on every start, which also repairs the entry if the app folder was moved.
    if (!SMOKE) setAutostart(wantAutostart());
    buildTray();
    await ensureServer();
    createWindow(!START_HIDDEN || !!SMOKE);
    // Watchdog: whoever started the server, bring it back if it is ever gone.
    setInterval(() => { if (!quitting) ensureServer(); }, 15000);
  });
}
main();
