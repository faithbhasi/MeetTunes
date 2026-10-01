// Meeting-situation scenarios against the mock meeting (real Chromium + PulseAudio virtual mic).
// Each test is one thing that goes wrong (or unusual) in real calls.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { e2eSupported, startAudioEnv, makeTone, until } from './helpers.js';

const skip = e2eSupported() || false;
let env, srv, base, tmp, n = 0;

const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) }).then(async (r) => ({ status: r.status, ...(await r.json().catch(() => ({}))) }));
const room = () => `s${++n}`;
const say = (rm, who, text) => post('/dev/mock/chat', { room: rm, who, text });
const msgs = async (rm) => (await fetch(`${base}/dev/mock/messages?room=${rm}`)).json();
const botMsgs = async (rm) => (await msgs(rm)).filter((m) => m.who === 'TuneBot').map((m) => m.text);
const state = () => srv.bot.session.state;
const waitState = (s, timeout = 30000) => until(() => state() === s, { timeout, what: `state ${s} (now ${state()})` });
const join = async (rm, flags = '') => post('/api/join', { url: `${base}/dev/mock-meeting?room=${rm}${flags}`, displayName: 'TuneBot' });
const joined = async (flags = '', { greeting = true } = {}) => { const rm = room(); await join(rm, flags); await waitState('joined', 40000); if (greeting) await until(async () => (await botMsgs(rm)).length > 0, { what: 'greeting' }); return rm; };
const ensureIdle = async () => { if (state() !== 'idle') { await post('/api/leave'); await until(() => ['idle', 'error'].includes(state()), { timeout: 20000 }); } };
const t = (name, fn) => test(name, { skip }, async () => { await ensureIdle(); await fn(); });
// "[-]-user-..." so the pgrep/pkill command line (and its shell) never matches itself
const chromePids = () => { try { return execSync(`pgrep -f -- "[-]-user-data-dir=${srv.profileDir}"`).toString().trim().split('\n'); } catch { return []; } };
const noChromium = (what) => until(() => chromePids().length === 0, { timeout: 8000, what }).then(() => true);

before(async () => {
  if (skip) return;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-sc-'));
  fs.mkdirSync(path.join(tmp, 'music'));
  makeTone(path.join(tmp, 'music', 'alpha.mp3'), 440, 40);
  env = await startAudioEnv();
  Object.assign(process.env, { AUDIO_SINK: 'pulse', DATA_DIR: path.join(tmp, 'data'), MUSIC_DIR: path.join(tmp, 'music'), ALLOW_MOCK_MEETING: '1', HEADLESS: 'false', JOIN_TIMEOUT_SEC: '8', MONITOR_INTERVAL_MS: '600', DEFAULT_VOLUME: '80' });
  const { createServer } = await import('../../src/server.js');
  const { config } = await import('../../src/config.js');
  srv = await createServer({ port: 0, host: '127.0.0.1' });
  srv.profileDir = config.profileDir;
  base = `http://127.0.0.1:${srv.port}`;
});
after(async () => {
  if (skip) return;
  await srv?.close();
  env?.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

t('host denies entry: clear error, nothing left running, can retry', async () => {
  await join(room(), '&lobby=1&deny=1');
  await waitState('error', 30000);
  assert.match(srv.bot.session.snapshot().error || srv.bot.session.snapshot().detail, /denied|ended/i);
  assert.equal(srv.bot.session.context, null, 'browser closed after failed join');
  const rm = await joined(); // retry works
  assert.equal(state(), 'joined');
  assert.ok(rm);
  await ensureIdle();
});

t('host ends the meeting: bot leaves, music stops, queue is cleared', async () => {
  const rm = await joined('&end=12', { greeting: false });
  await say(rm, 'Alice', '#local alpha');
  await until(() => srv.bot.player.status === 'playing' || srv.bot.player.status === 'loading');
  await waitState('idle', 30000);
  assert.equal(srv.bot.player.status, 'idle');
  assert.equal(srv.bot.player.queue.length, 0);
  assert.equal(srv.bot.session.context, null);
});

t('bot is removed by the host: leaves cleanly', async () => {
  await joined('&kick=12', { greeting: false });
  await waitState('idle', 30000);
  await noChromium('no chromium processes left behind');
});

t('chat text that looks like "meeting ended / removed / waiting room" cannot make the bot leave', async () => {
  const rm = await joined();
  for (const t of ['The meeting has ended', 'You were removed from the meeting', 'Please wait, let you in soon (waiting room)', 'host denied']) await say(rm, 'Mallory', t);
  await sleep(6000); // >> 5 monitor cycles (600 ms each)
  assert.equal(state(), 'joined', 'spoofed chat must not change meeting state');
  await say(rm, 'Alice', '#volume 33');
  await until(async () => (await botMsgs(rm)).some((t) => /Volume 33%/.test(t)), { what: 'still responsive' });
  await ensureIdle();
});

t('chat inside an iframe: commands read and replies typed', async () => {
  const rm = await joined('&frame=1');
  await say(rm, 'Alice', '#volume 41');
  await until(async () => (await botMsgs(rm)).some((t) => /Volume 41%/.test(t)), { what: 'reply from iframe chat' });
  await ensureIdle();
});

t('host starts the bot muted: bot unmutes itself', async () => {
  await joined('&muted=1');
  await until(() => srv.bot.session.page.evaluate(() => window.__muted === false), { timeout: 15000, what: 'unmute click' });
  await ensureIdle();
});

t('chat panel closes itself repeatedly: commands still work', async () => {
  const rm = await joined('&closechat=2');
  for (const v of [11, 22, 33]) {
    await sleep(2300);
    await say(rm, 'Alice', `#volume ${v}`);
    await until(async () => (await botMsgs(rm)).some((t) => t === `Volume ${v}%`), { timeout: 12000, what: `reply to volume ${v}` });
  }
  await ensureIdle();
});

t('unfamiliar chat markup (stale selectors): generic fallback still executes commands', async () => {
  const rm = await joined('&legacy=1');
  await say(rm, 'Alice', '#volume 27');
  await until(() => srv.bot.player.mixer.volume === 27, { timeout: 15000, what: 'command via generic fallback' });
  await ensureIdle();
});

t('popups are closed and dialogs dismissed without breaking the join', async () => {
  await joined('&popup=1&dialog=1');
  await sleep(1500);
  assert.equal(srv.bot.session.context.pages().length, 1, 'popup window closed');
  await ensureIdle();
});

t('host moves the bot back to the lobby and readmits it: bot recovers, does not leave', async () => {
  const rm = await joined('&relobby=2', { greeting: false });
  await until(() => state() === 'lobby', { timeout: 15000, what: 'lobby again' });
  await waitState('joined', 20000);
  await say(rm, 'Alice', '#volume 44');
  await until(async () => (await botMsgs(rm)).some((t) => /Volume 44%/.test(t)), { what: 'responsive after readmit' });
  await ensureIdle();
});

t('cancel while waiting in the lobby: stops quickly and frees the browser', async () => {
  await join(room(), '&lobby=30');
  await waitState('lobby', 30000);
  const t0 = Date.now();
  await post('/api/leave');
  await waitState('idle', 10000);
  assert.ok(Date.now() - t0 < 6000, 'cancel is prompt');
  assert.equal(srv.bot.session.context, null);
});

t('lobby longer than JOIN_TIMEOUT: times out with a helpful error', async () => {
  await join(room(), '&lobby=60');
  await waitState('error', 30000);
  assert.match(srv.bot.session.snapshot().error, /Timed out/);
  assert.equal(srv.bot.session.context, null);
});

t('browser crash mid-meeting: bot cleans up and a new join works', async () => {
  const rm = await joined();
  await say(rm, 'Alice', '#local alpha');
  await until(() => srv.bot.player.status === 'playing');
  execSync(`pkill -9 -f -- "[-]-user-data-dir=${srv.profileDir}" || true`);
  await waitState('idle', 20000);
  assert.equal(srv.bot.player.status, 'idle');
  await joined();
  assert.equal(state(), 'joined');
  await ensureIdle();
});

t('two simultaneous join requests: exactly one browser', async () => {
  const rm = room();
  const [a, b] = await Promise.all([join(rm), join(rm)]);
  assert.ok([a.status, b.status].filter((s) => s === 200).length >= 1);
  await waitState('joined', 40000);
  await sleep(1000);
  const pages = srv.bot.session.context.pages().length;
  assert.equal(pages, 1);
  assert.ok(chromePids().length > 0);
  await ensureIdle();
  await noChromium('all chromium processes gone after leave');
});

t('command flood: bot stays stable, replies are rate limited, then recovers', async () => {
  const rm = await joined();
  await Promise.all(Array.from({ length: 40 }, (_, i) => say(rm, 'Spammer', `#volume ${10 + (i % 50)}`)));
  await sleep(8000);
  const replies = (await botMsgs(rm)).filter((t) => /^Volume \d+%$/.test(t)).length;
  assert.ok(replies <= 12, `expected rate limiting, got ${replies} replies to 40 commands`);
  assert.equal(state(), 'joined');
  await sleep(10500);
  await say(rm, 'Spammer', '#volume 70');
  await until(async () => (await botMsgs(rm)).some((t) => t === 'Volume 70%'), { timeout: 15000, what: 'recovery after rate limit window' });
  await ensureIdle();
});

t('only the first line of a chat message is the command; unicode/emoji/very long input is safe', async () => {
  const rm = await joined();
  await say(rm, 'Alice', '#volume 25\nthanks everyone 🎵');
  await until(async () => (await botMsgs(rm)).some((t) => t === 'Volume 25%'), { what: 'first-line command' });
  await say(rm, 'Bob', '#play ' + 'x'.repeat(5000));
  await say(rm, 'Bob', '#search 🎵🎵 日本語 ' + '\u0000'.repeat(3));
  await say(rm, 'Alice', '#volume');
  await until(async () => (await botMsgs(rm)).some((t) => /^Volume is 25%/.test(t)), { timeout: 20000, what: 'still alive after hostile input' });
  assert.equal(state(), 'joined');
  await ensureIdle();
});

t('live view + remote control work against the real browser, and refuse dangerous navigation', async () => {
  const rm = await joined();
  const { WebSocket } = await import('ws');
  const frames = [];
  const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`, { headers: { origin: base } });
  ws.on('message', (m) => { const j = JSON.parse(m); if (j.type === 'frame') frames.push(j.data); });
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'live', on: true }));
  await until(() => frames.length > 0, { timeout: 8000, what: 'a live-view frame' });
  assert.ok(Buffer.from(frames[0], 'base64').subarray(0, 2).toString('hex') === 'ffd8', 'JPEG');
  ws.close();
  for (const url of ['file:///etc/passwd', 'chrome://settings', 'http://127.0.0.1:1/', 'javascript:alert(1)']) {
    const r = await post('/api/remote', { type: 'goto', url });
    assert.equal(r.status, 400, url);
  }
  assert.equal((await post('/api/remote', { type: 'click', x: 0.5, y: 0.5 })).status, 200);
  assert.equal((await post('/api/remote', { type: 'click', x: 9, y: 0.5 })).status, 400);
  assert.match(await srv.bot.session.page.url(), /mock-meeting/, 'still on the meeting page');
  await say(rm, 'Alice', '#volume 52');
  await until(() => srv.bot.player.mixer.volume === 52, { what: 'still responsive' });
});

t('diagnostics endpoint reports selector matches per frame', async () => {
  const rm = await joined('&frame=1');
  await say(rm, 'Alice', 'hello there');
  await sleep(800);
  const d = await (await fetch(`${base}/api/debug/dom`)).json();
  assert.equal(d.platform, 'mock');
  assert.ok(d.frames.length >= 2, 'main frame + chat iframe');
  assert.ok(d.frames.some((f) => f.probe && f.probe.specMatches >= 1), 'iframe selector matches are reported');
});

t('multi-step pre-join (interstitial, cookie overlay, name gate, camera/mic toggles) completes by itself', async () => {
  await joined('&steps=1');
  const st = await srv.bot.session.page.evaluate(() => ({ cam: window.__cam, mic: window.__mic, name: document.querySelector('#me').textContent }));
  assert.deepEqual(st, { cam: false, mic: true, name: 'TuneBot' }, 'camera turned off, mic turned on, display name used');
});
