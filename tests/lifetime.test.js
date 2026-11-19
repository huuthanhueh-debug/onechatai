'use strict';
// Server lifetime. Regression for "Failed to fetch": the server used to exit 45 seconds
// after the heartbeat stream dropped, even though the window was still open and still
// calling the API (a hidden or locked-screen browser window reopens the stream late).
const { test } = require('node:test');
const assert = require('node:assert/strict');
require('./helpers');
const { start } = require('../server');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const heartbeat = (app) => {
  const ac = new AbortController();
  fetch(app.url + 'api/alive', { headers: { 'x-onechat-token': app.token }, signal: ac.signal })
    .then(async (r) => { for await (const _ of r.body) { /* beat */ } }).catch(() => {});
  return ac;
};

test('lifetime: a dropped heartbeat does not stop the server while the window keeps calling the API', async () => {
  const exits = [];
  const app = await start({ port: 0, autoExit: true, graceMs: 400, tickMs: 40, quiet: true, onExit: (why) => exits.push(why) });
  const H = { 'x-onechat-token': app.token };
  try {
    const hb = heartbeat(app);
    await sleep(900);
    assert.deepEqual(exits, [], 'an open window keeps it up far past the grace period');
    hb.abort(); // the stream drops; the window itself is still open
    for (let i = 0; i < 8; i++) { await sleep(120); assert.equal((await fetch(app.url + 'api/state', { headers: H })).status, 200); }
    assert.deepEqual(exits, [], 'API calls alone prove a window is open (0.96 s of them, grace is 0.4 s)');
    const again = heartbeat(app); // the window reopens its stream late
    await sleep(700);
    assert.deepEqual(exits, []);
    again.abort();
  } finally { await app.close(); }
});

test('lifetime: it stops once no window has shown life for the whole grace period', async () => {
  const exits = [];
  const app = await start({ port: 0, autoExit: true, graceMs: 300, tickMs: 30, quiet: true, onExit: (why) => exits.push(why) });
  try {
    const hb = heartbeat(app);
    await sleep(200);
    hb.abort(); // window closed for good
    await sleep(150);
    assert.deepEqual(exits, [], 'not before the grace period is over');
    await sleep(500);
    assert.equal(exits.length, 1, 'exactly one shutdown');
    assert.match(exits[0], /^no window for \d+s$/);
  } finally { await app.close(); }
});

test('lifetime: unauthenticated traffic does not keep it alive; without autoExit it never stops', async () => {
  const exits = [];
  const app = await start({ port: 0, autoExit: true, graceMs: 300, tickMs: 30, quiet: true, onExit: (why) => exits.push(why) });
  try {
    for (let i = 0; i < 6; i++) { await sleep(100); await fetch(app.url + 'api/ping'); await fetch(app.url + 'api/state'); }
    assert.equal(exits.length, 1, 'pings and token-less calls are not a window');
  } finally { await app.close(); }
  const still = [];
  const manual = await start({ port: 0, graceMs: 50, tickMs: 20, quiet: true, onExit: (why) => still.push(why) });
  try { await sleep(300); assert.deepEqual(still, []); } finally { await manual.close(); }
});

test('lifetime: the default grace period is minutes, not seconds', async () => {
  const src = require('fs').readFileSync(require.resolve('../server'), 'utf8');
  const m = /opts\.graceMs != null \? opts\.graceMs : (\d+) \* 60 \* 1000/.exec(src);
  assert.ok(m && Number(m[1]) >= 5, 'default grace must be at least 5 minutes');
});
