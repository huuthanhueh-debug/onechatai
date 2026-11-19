'use strict';
// Claude through the locally installed Claude Code CLI (`claude -p`). Uses the user's own
// Claude login, so no API key is needed. Runs in safe mode with every tool disabled: it can
// only answer, never read files or run commands, and none of the user's hooks or plugins load.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const cfg = require('../config');
const { ProviderError } = require('./openai-compat');

let found; // undefined = not looked up yet
function findBin() {
  if (found !== undefined) return found;
  if (process.env.ONECHAT_NO_CLI === '1') return (found = null);
  const tryFile = (p) => { try { return p && fs.statSync(p).isFile() ? p : null; } catch (_) { return null; } };
  const win = process.platform === 'win32';
  const direct = [
    process.env.ONECHAT_CLAUDE_BIN,
    win && process.env.APPDATA && path.join(process.env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
    path.join(os.homedir(), '.local', 'bin', win ? 'claude.exe' : 'claude'),
  ];
  for (const p of direct) { const f = tryFile(p); if (f) return (found = { bin: f, shell: false }); }
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const exe = tryFile(path.join(dir, win ? 'claude.exe' : 'claude'));
    if (exe) return (found = { bin: exe, shell: false });
    if (win && tryFile(path.join(dir, 'claude.cmd'))) return (found = { bin: 'claude', shell: true });
  }
  return (found = null);
}
const resetBin = () => { found = undefined; };

// The CLI takes one prompt, so earlier turns are folded into it as a labelled transcript.
function flatten(messages) {
  if (messages.length <= 1) return messages.length ? String(messages[0].content) : '';
  const prior = messages.slice(0, -1).map((m) => `[${m.role}]\n${m.content}${m.images && m.images.length ? '\n(attached pictures: ' + m.images.map((im) => im.name).join(', ') + ')' : ''}`).join('\n\n');
  return `<conversation_so_far>\n${prior}\n</conversation_so_far>\n\nReply to the latest user message below, continuing the conversation above.\n\n${messages[messages.length - 1].content}`;
}

// Parse one stream-json event. Kept separate so it can be tested without spawning the CLI.
function handleEvent(j, st, emit) {
  if (!j || typeof j !== 'object') return;
  if (j.type === 'system' && j.subtype === 'init' && j.model) { st.model = j.model; return; }
  if (j.type === 'stream_event' && j.event) {
    const ev = j.event;
    if (ev.type === 'content_block_delta' && ev.delta) {
      if (ev.delta.type === 'text_delta' && ev.delta.text) { st.gotDelta = true; emit({ type: 'text', text: ev.delta.text }); }
      else if (ev.delta.type === 'thinking_delta' && ev.delta.thinking) emit({ type: 'thinking', text: ev.delta.thinking });
    }
    return;
  }
  if (j.type === 'assistant' && j.message && !st.gotDelta) {
    for (const b of j.message.content || []) if (b.type === 'text' && b.text) emit({ type: 'text', text: b.text });
    return;
  }
  // The plan's own usage windows (5-hour, weekly) arrive with every answer.
  if (j.type === 'rate_limit_event') { if (j.rate_limit_info) st.limits = j.rate_limit_info; return; }
  if ('total_cost_usd' in j || j.type === 'result') st.result = j;
}

function finish(st, exitCode, stderr) {
  const r = st.result;
  if (r && r.is_error) {
    const msg = String(r.result || r.error || r.subtype || 'error').slice(0, 400);
    throw new ProviderError(/log ?in|authenticat|api key|oauth/i.test(msg) ? 'auth' : /usage limit|limit reached|hit your limit|quota|credit balance/i.test(msg) ? 'credit' : /limit|overloaded/i.test(msg) ? 'rate' : 'cli_error', msg);
  }
  if (!r) {
    const msg = String(stderr || '').trim().slice(-400) || 'claude exited with code ' + exitCode;
    throw new ProviderError(/log ?in|authenticat|api key/i.test(msg) ? 'auth' : 'cli_error', msg);
  }
  const u = r.usage || {};
  return {
    model: st.model || '',
    usage: { in: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0), out: u.output_tokens || 0, cacheRead: u.cache_read_input_tokens || 0 },
    cost: typeof r.total_cost_usd === 'number' ? r.total_cost_usd : null,
    notionalCost: true, // billed against the Claude subscription, not per token
    limits: st.limits ? { cli: st.limits } : null,
  };
}

// The CLI must run as a standalone, signed-in Claude Code: with the user's own login, not an
// API key from the environment, and without settings inherited from a host Claude session
// when OneChat itself was started from inside one.
function childEnv(base) {
  const env = Object.assign({}, base);
  const hosted = 'CLAUDE_CODE_ENTRYPOINT' in env || 'CLAUDECODE' in env;
  for (const k of Object.keys(env)) {
    if (k === 'CLAUDECODE' || k === 'CLAUDE_PID' || k === 'CLAUDE_EFFORT' || k === 'ANTHROPIC_API_KEY' || k === 'ANTHROPIC_AUTH_TOKEN') delete env[k];
    else if (/^CLAUDE_(CODE|AGENT_SDK|PREVIEW)_/.test(k)) delete env[k];
    else if (hosted && k === 'ANTHROPIC_BASE_URL') delete env[k];
  }
  return env;
}

const quote = (a) => (a === '' ? '""' : /[\s"&|<>^]/.test(a) ? '"' + a.replace(/"/g, '\\"') + '"' : a);

function chat(opts, emit) {
  const loc = findBin();
  if (!loc) return Promise.reject(new ProviderError('cli_missing', 'Claude Code CLI not found'));
  // Both values become command-line arguments: accept only plain identifiers.
  if (!/^[\w.:@/-]{1,100}$/.test(String(opts.model || 'opus'))) return Promise.reject(new ProviderError('bad_request', 'invalid model name'));
  if (opts.effort && !['auto', 'low', 'medium', 'high', 'xhigh', 'max'].includes(opts.effort)) return Promise.reject(new ProviderError('bad_request', 'invalid effort'));
  const work = path.join(cfg.dataDir(), 'cli');
  fs.mkdirSync(work, { recursive: true });
  const sysFile = path.join(work, 'sys-' + crypto.randomBytes(6).toString('hex') + '.txt');
  // The CLI adds details of its own process (working directory, platform, git state) to the
  // prompt. They describe this app's scratch folder, not anything of the user's.
  fs.writeFileSync(sysFile, (opts.system || 'You are a helpful assistant.')
    + '\n\nYou are answering inside a chat app. Claude Code\'s own built-in tools are switched off here; tools the app itself offers, if any, are described above in plain text and are real. Environment details that appear in this prompt (working directory, platform, git status) describe the host process, not the user\'s project: never mention or rely on them.');
  const args = ['-p', '--safe-mode', '--tools', '', '--model', opts.model || 'opus', '--output-format', 'stream-json', '--verbose',
    '--include-partial-messages', '--no-session-persistence', '--system-prompt-file', sysFile];
  if (opts.effort && opts.effort !== 'auto') args.push('--effort', opts.effort);
  // With pictures the prompt goes in as one structured message; plain text stays plain text.
  const pics = [];
  for (const m of opts.messages) for (const im of m.images || []) pics.push(im);
  if (pics.length) args.push('--input-format', 'stream-json');
  const stdin = pics.length
    ? JSON.stringify({ type: 'user', message: { role: 'user', content: pics.slice(-8).map((im) => ({ type: 'image', source: { type: 'base64', media_type: im.mime, data: im.data } })).concat([{ type: 'text', text: flatten(opts.messages) || 'Look at the attached picture.' }]) } }) + '\n'
    : flatten(opts.messages);
  const env = childEnv(process.env);

  return new Promise((resolve, reject) => {
    const child = loc.shell
      ? spawn([loc.bin].concat(args.map(quote)).join(' '), { cwd: work, env, shell: true, windowsHide: true })
      : spawn(loc.bin, args, { cwd: work, env, windowsHide: true });
    const st = { gotDelta: false, result: null, model: '' };
    let buf = '', stderr = '', done = false;
    const cleanup = () => { try { fs.unlinkSync(sysFile); } catch (_) {} if (opts.signal) opts.signal.removeEventListener('abort', onAbort); };
    const fail = (e) => { if (done) return; done = true; cleanup(); reject(e); };
    const onAbort = () => { try { child.kill(); } catch (_) {} fail(new ProviderError('aborted', 'aborted')); };
    if (opts.signal) { if (opts.signal.aborted) return onAbort(); opts.signal.addEventListener('abort', onAbort, { once: true }); }
    const line = (l) => { const t = l.trim(); if (!t || t[0] !== '{') return; let j; try { j = JSON.parse(t); } catch (_) { return; } try { handleEvent(j, st, emit); } catch (e) { fail(e); } };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { line(buf.slice(0, i)); buf = buf.slice(i + 1); } });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
    child.on('error', (e) => fail(new ProviderError('cli_missing', e.message)));
    child.on('close', (code) => {
      if (done) return;
      if (buf) line(buf);
      try { const r = finish(st, code, stderr); done = true; cleanup(); resolve(r); } catch (e) { fail(e); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(stdin);
  });
}

module.exports = { chat, findBin, resetBin, flatten, handleEvent, finish, childEnv };
