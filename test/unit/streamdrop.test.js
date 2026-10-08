// Flaky network / decoder / yt-dlp behaviour, simulated with fake ffmpeg and yt-dlp binaries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-drop-'));
const state = path.join(dir, 'state');
// fake ffmpeg: 1 s of audio then exits with an error (like a dropped HTTP stream); succeeds on the 2nd call
const ff = path.join(dir, 'ffmpeg');
fs.writeFileSync(ff, `#!/usr/bin/env node
const fs = require('fs'); const f = ${JSON.stringify(state)};
const n = (fs.existsSync(f) ? +fs.readFileSync(f, 'utf8') : 0) + 1; fs.writeFileSync(f, String(n));
const mode = process.env.FAKE_MODE || 'drop-once';
const pcm = Buffer.alloc(192000);
if (mode === 'never-starts') { console.error('Connection refused'); process.exit(1); }
if (mode === 'drop-once' && n === 1) { process.stdout.write(pcm, () => process.exit(1)); }
else if (mode === 'drop-always') { process.stdout.write(pcm, () => process.exit(1)); }
else { let i = 0; const t = setInterval(() => { process.stdout.write(Buffer.alloc(192000)); if (++i >= 25) { clearInterval(t); process.exit(0); } }, 1000); }
`, { mode: 0o755 });
// fake yt-dlp: sleeps (hang) or tracks concurrency
const yt = path.join(dir, 'yt-dlp');
fs.writeFileSync(yt, `#!/usr/bin/env node
const fs = require('fs'); const log = ${JSON.stringify(path.join(dir, 'yt.log'))};
fs.appendFileSync(log, 's ' + Date.now() + '\\n');
const ms = +(process.env.YT_SLEEP_MS || 400);
setTimeout(() => { fs.appendFileSync(log, 'e ' + Date.now() + '\\n'); console.log(JSON.stringify({ _type: 'playlist', entries: [{ id: 'a', title: 'T', url: 'https://example.org/a' }] })); }, ms);
`, { mode: 0o755 });

Object.assign(process.env, { FFMPEG_PATH: ff, YTDLP_PATH: yt, YTDLP_TIMEOUT_SEC: '1', YTDLP_CONCURRENCY: '2', AUDIO_SINK: 'none', ALLOW_PRIVATE_URLS: '1' });
const { Mixer } = await import('../../src/audio/mixer.js');
const { NullSink } = await import('../../src/audio/sinks.js');
const { Player } = await import('../../src/audio/player.js');
const { Resolver } = await import('../../src/audio/resolver.js');

const mk = () => {
  const mixer = new Mixer(new NullSink(), { volume: 50 });
  mixer.start();
  const player = new Player({ mixer, resolver: { resolveStream: async (t) => ({ url: 'https://example.org/' + t.id, headers: {} }) } });
  const errors = [];
  player.on('error', (m) => errors.push(m));
  return { player, errors, done: () => (player.stop(), mixer.stop()) };
};
const track = (id, duration = 30) => ({ id, kind: 'url', title: id, duration, source: 'https://example.org/' + id });

test('stream drops mid-track: playback resumes from where it stopped', async () => {
  fs.rmSync(state, { force: true });
  process.env.FAKE_MODE = 'drop-once';
  const { player, errors, done } = mk();
  player.add([track('a')]);
  await sleep(2600);
  assert.equal(fs.readFileSync(state, 'utf8'), '2', 'ffmpeg restarted once');
  assert.ok(player.position >= 1 && player.position < 5, `resumed near 1s, pos ${player.position}`);
  assert.deepEqual(errors, []);
  done();
});

test('a stream that keeps dropping does not loop forever', async () => {
  fs.rmSync(state, { force: true });
  process.env.FAKE_MODE = 'drop-always';
  const { player, done } = mk();
  player.add([track('a'), track('b')]);
  await sleep(6000);
  const calls = +fs.readFileSync(state, 'utf8');
  assert.ok(calls <= 8, `bounded retries, got ${calls} ffmpeg launches`);
  done();
});

test('a stream that never starts is reported, skipped, and stops after repeated failures', async () => {
  fs.rmSync(state, { force: true });
  process.env.FAKE_MODE = 'never-starts';
  const { player, errors, done } = mk();
  player.add([track('a'), track('b'), track('c'), track('d')]);
  await sleep(2500);
  assert.equal(player.status, 'idle');
  assert.ok(errors.length >= 1 && /Playback failed/.test(errors[0]), errors.join('|'));
  assert.ok(+fs.readFileSync(state, 'utf8') <= 4);
  done();
});

test('yt-dlp hang: search times out with a clear error instead of blocking forever', async () => {
  process.env.YT_SLEEP_MS = '5000';
  const r = new Resolver();
  const t0 = Date.now();
  await assert.rejects(() => r.search('anything', 1), /timed out/i);
  assert.ok(Date.now() - t0 < 3000);
  delete process.env.YT_SLEEP_MS;
});

test('chat spam cannot start more than YTDLP_CONCURRENCY yt-dlp processes at once', async () => {
  fs.rmSync(path.join(dir, 'yt.log'), { force: true });
  process.env.YT_SLEEP_MS = '300';
  const r = new Resolver();
  await Promise.all(Array.from({ length: 8 }, (_, i) => r.search('q' + i, 1)));
  const events = fs.readFileSync(path.join(dir, 'yt.log'), 'utf8').trim().split('\n').map((l) => l.split(' ')).sort((a, b) => a[1] - b[1] || (a[0] === 'e' ? -1 : 1));
  let cur = 0, max = 0;
  for (const [k] of events) { cur += k === 's' ? 1 : -1; max = Math.max(max, cur); }
  assert.equal(events.length, 16);
  assert.ok(max <= 2, `max concurrent yt-dlp = ${max}`);
});
