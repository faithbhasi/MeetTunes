// End-to-end: real Chromium joins a mock meeting; chat commands drive the player; the meeting page's own
// microphone analyser proves the audio really arrives through the PulseAudio virtual mic.
//
// Needs Linux + pulseaudio + Xvfb + ffmpeg and a non-root user (it is all in the Docker image).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { e2eSupported, startAudioEnv, makeTone, until, root } from './helpers.js';

const skip = e2eSupported();
let env, srv, base, tmp;

const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
const say = (who, text) => post('/dev/mock/chat', { room: 'e2e', who, text });
const chat = async () => (await fetch(base + '/dev/mock/messages?room=e2e')).json();
const lastBot = async () => (await chat()).filter((m) => m.who === 'TuneBot').map((m) => m.text);
const settle = (ms = 1500) => new Promise((r) => setTimeout(r, ms)); // mic capture path has ~0.6-1s latency
const peak = () => srv.bot.session.page.evaluate(() => parseFloat(document.querySelector('#mic-peak').textContent));
const level = async (ms = 700) => {
  // peak of the mic analyser over a window
  return srv.bot.session.page.evaluate(async (ms) => {
    let m = 0;
    const end = Date.now() + ms;
    while (Date.now() < end) {
      m = Math.max(m, parseFloat(document.querySelector('#mic-level').textContent) || 0);
      await new Promise((r) => setTimeout(r, 50));
    }
    return m;
  }, ms);
};

before(async () => {
  if (skip) return;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-e2e-'));
  fs.mkdirSync(path.join(tmp, 'music'));
  makeTone(path.join(tmp, 'music', 'alpha.mp3'), 440, 30);
  makeTone(path.join(tmp, 'music', 'bravo.wav'), 660, 30);
  env = await startAudioEnv();
  Object.assign(process.env, {
    AUDIO_SINK: 'pulse', DATA_DIR: path.join(tmp, 'data'), MUSIC_DIR: path.join(tmp, 'music'), ALLOW_MOCK_MEETING: '1',
    HEADLESS: 'false', DEFAULT_VOLUME: '80', JOIN_TIMEOUT_SEC: '60',
  });
  const { createServer } = await import('../../src/server.js');
  srv = await createServer({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${srv.port}`;
});

after(async () => {
  if (skip) return;
  await srv?.close();
  env?.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('joins a meeting (with lobby) as the chosen display name', { skip: skip || false }, async () => {
  const r = await post('/api/join', { url: `${base}/dev/mock-meeting?room=e2e&lobby=2`, displayName: 'TuneBot' });
  assert.equal(r.error, undefined);
  await until(() => srv.bot.session.state === 'lobby', { what: 'lobby state' });
  await until(() => srv.bot.session.state === 'joined', { timeout: 40000, what: 'joined state' });
  assert.equal(srv.bot.session.snapshot().platform, 'mock');
  const hello = await until(async () => (await lastBot()).find((t) => /MeetTunes is here/.test(t)), { what: 'greeting in meeting chat' });
  assert.match(hello, /#help/);
});

test('page asked for echo-cancellation but MeetTunes forced it off (music stays clean)', { skip: skip || false }, async () => {
  const info = await srv.bot.session.page.evaluate(() => document.querySelector('#mic-info').textContent);
  assert.match(info, /aec=false/);
  assert.match(info, /ns=false/);
  assert.match(info, /agc=false/);
});

test('#play local -> music arrives on the virtual microphone', { skip: skip || false }, async () => {
  assert.ok((await level(500)) < 0.01, 'silent before playing');
  await say('Alice', '#local alpha');
  await until(async () => (await lastBot()).some((t) => /Now playing: .*alpha/i.test(t)), { what: 'play reply' });
  const loud = await until(async () => ((await level(500)) > 0.02 ? level(800) : 0), { what: 'audio on mic' });
  assert.ok(loud > 0.02, `mic peak ${loud}`);
});

test('#volume changes loudness, #mute silences, #unmute restores', { skip: skip || false }, async () => {
  await say('Alice', '#volume 100');
  await until(async () => srv.bot.player.mixer.volume === 100);
  await settle();
  const full = await level(600);
  await say('Alice', '#volume 30');
  await until(async () => srv.bot.player.mixer.volume === 30);
  await settle();
  const low = await level(600);
  assert.ok(low < full * 0.5, `expected 30% (${low}) well below 100% (${full})`);
  await say('Alice', '#mute');
  await until(async () => srv.bot.player.mixer.muted);
  await settle();
  assert.ok((await level(600)) < 0.005, 'muted should be silent');
  assert.ok(srv.bot.player.status === 'playing', 'mute does not pause playback');
  await say('Alice', '#unmute');
  await until(async () => !srv.bot.player.mixer.muted);
  await settle();
  assert.ok((await level(600)) > 0.01);
});

test('#pause silences, #resume continues from the same place', { skip: skip || false }, async () => {
  await say('Bob', '#pause');
  await until(() => srv.bot.player.status === 'paused');
  const posA = srv.bot.player.position;
  await settle();
  assert.ok((await level(600)) < 0.005, 'paused should be silent');
  assert.ok(Math.abs(srv.bot.player.position - posA) < 0.05, 'position frozen while paused');
  await say('Bob', '#resume');
  await until(() => srv.bot.player.status === 'playing');
  await settle();
  assert.ok((await level(600)) > 0.01);
});

test('#seek, #queue, #next, #previous, #nowplaying', { skip: skip || false }, async () => {
  await say('Alice', '#seek 20');
  await until(() => srv.bot.player.position > 19.5 && srv.bot.player.status === 'playing');
  await say('Alice', '#local bravo');
  await until(async () => (await lastBot()).some((t) => /Queued: .*bravo/i.test(t)), { what: 'queued reply' });
  await say('Alice', '#queue');
  await until(async () => (await lastBot()).some((t) => /Queue \(2 tracks\)/.test(t) && /alpha/i.test(t) && /bravo/i.test(t)), { what: 'queue listing' });
  await say('Alice', '#next');
  await until(() => srv.bot.player.current?.title.match(/bravo/i));
  await until(async () => (await lastBot()).some((t) => /^Now playing: .*bravo/i.test(t)), { what: 'auto announce' });
  await say('Alice', '#np');
  await until(async () => (await lastBot()).some((t) => /^Now playing: .*bravo.*\[0:0\d/i.test(t)), { what: 'nowplaying reply' });
  await new Promise((r) => setTimeout(r, 5500));
  await say('Alice', '#previous'); // >5s into bravo: restarts it first
  await until(() => srv.bot.player.position < 2 && /bravo/i.test(srv.bot.player.current.title));
  await say('Alice', '#previous'); // now go back to alpha
  await until(() => /alpha/i.test(srv.bot.player.current?.title || ''));
});

test('unknown #hashtags are ignored; allowlist blocks other people', { skip: skip || false }, async () => {
  await new Promise((r) => setTimeout(r, 1500)); // let any track-change announcement land first
  const before = (await lastBot()).length;
  await say('Alice', '#nonsense and #1priority');
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal((await lastBot()).length, before, 'no reply to non-commands');
  await post('/api/settings', { allowlist: ['Alice'] });
  await say('Mallory', '#stop');
  await new Promise((r) => setTimeout(r, 1500));
  assert.notEqual(srv.bot.player.status, 'idle', 'Mallory is not allowed');
  await say('alice', '#volume');
  await until(async () => (await lastBot()).some((t) => /^Volume is/.test(t)), { what: 'allowed user reply' });
  await post('/api/settings', { allowlist: [] });
});

test('bot never reacts to its own multi-line help reply', { skip: skip || false }, async () => {
  const n0 = (await lastBot()).length;
  await say('Alice', '#help');
  await until(async () => (await lastBot()).length > n0, { what: 'help reply' });
  await new Promise((r) => setTimeout(r, 3000));
  const replies = (await lastBot()).slice(n0);
  assert.equal(replies.length, 1, `exactly one reply, got ${replies.length}`);
  assert.ok(replies[0].split('\n').length >= 4, 'help is one multi-line message');
});

test('#leave makes the bot leave and stops the music', { skip: skip || false }, async () => {
  await say('Alice', '#leave');
  await until(() => srv.bot.session.state === 'idle', { what: 'idle after leave' });
  assert.equal(srv.bot.player.status, 'idle');
});
