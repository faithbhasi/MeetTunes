import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-robust-'));
Object.assign(process.env, { AUDIO_SINK: 'none', DATA_DIR: path.join(dir, 'data'), MUSIC_DIR: path.join(dir, 'music'), MAX_QUEUE: '6', COMMANDS_PER_10S: '8', COMMANDS_GLOBAL_PER_10S: '20' });
const { Mixer } = await import('../../src/audio/mixer.js');
const { NullSink } = await import('../../src/audio/sinks.js');
const { Player } = await import('../../src/audio/player.js');
const { CommandHandler } = await import('../../src/commands/handler.js');
const { parseCommand, canonical } = await import('../../src/commands/parser.js');
const { MeetTunes } = await import('../../src/bot.js');
const { redactUrl } = await import('../../src/util.js');

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const skip = !hasFfmpeg;
const wav = (name, secs) => {
  const f = path.join(dir, name + '.wav');
  spawnSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=300:duration=${secs}`, f]);
  return { id: name, kind: 'local', title: name, duration: secs, path: f, source: 'local:' + name };
};
const slowResolver = (ms) => ({ resolveStream: async (t) => { await sleep(ms); return { url: t.path, headers: {} }; } });
const mkPlayer = (resolver) => {
  const mixer = new Mixer(new NullSink(), { volume: 50 });
  mixer.start();
  const player = new Player({ mixer, resolver });
  player.on('error', () => {});
  return { mixer, player, done: () => (player.stop(), mixer.stop()) };
};
const ffmpegProcs = () => { try { const out = execSync(`ps -eo pid,stat,args | grep "[f]fmpeg .*${dir}"`).toString().trim().split("\n"); if (process.env.DBG) console.log(out.join("\n")); return out.length; } catch { return 0; } };

test('pause pressed while a track is still loading takes effect (and resume cancels it)', { skip }, async () => {
  const { player, done } = mkPlayer(slowResolver(400));
  player.add([wav('slow', 10)]);
  assert.equal(player.status, 'loading');
  assert.equal(player.pause(), true);
  await sleep(800);
  assert.equal(player.status, 'paused');
  const pos = player.position;
  await sleep(300);
  assert.equal(player.position, pos);
  player.resume();
  await sleep(400);
  assert.equal(player.status, 'playing');
  player.next === undefined || player.pause();
  player.seek(5); // seeking while paused must not un-pause
  await sleep(900);
  assert.equal(player.status, 'paused');
  done();
});

test('skip spam: 60 rapid next/previous leave exactly one decoder running and a consistent cursor', { skip }, async () => {
  const { player, done } = mkPlayer(slowResolver(20));
  player.add([wav('a', 20), wav('b', 20), wav('c', 20)]);
  player.setLoop('all');
  for (let i = 0; i < 60; i++) (i % 3 ? player.next() : player.previous());
  await sleep(700);
  assert.ok(['playing', 'loading'].includes(player.status));
  assert.ok(player.index >= 0 && player.index < 3);
  assert.equal(player.current.id, player.queue[player.index].id);
  assert.equal(ffmpegProcs(), 1, 'no leaked ffmpeg processes');
  done();
  await sleep(300);
  assert.equal(ffmpegProcs(), 0, 'all decoders gone after stop');
});

test('removing the playing (last) track goes idle; clearing then next/play throws cleanly', { skip }, async () => {
  const { player, done } = mkPlayer(slowResolver(0));
  player.add([wav('only', 10)]);
  await sleep(200);
  player.remove(0);
  assert.equal(player.status, 'idle');
  assert.equal(player.queue.length, 0);
  assert.throws(() => player.next(), /empty/);
  assert.throws(() => player.previous(), /empty/);
  assert.throws(() => player.play(), /empty/);
  assert.equal(player.pause(), false);
  assert.equal(player.resume(), false);
  assert.throws(() => player.seek(5), /Nothing is playing/);
  done();
});

test('queue is capped (MAX_QUEUE) so chat spam cannot exhaust memory', { skip }, async () => {
  const { player, done } = mkPlayer(slowResolver(0));
  player.add([1, 2, 3, 4, 5, 6].map((i) => wav('q' + i, 5)));
  assert.equal(player.queue.length, 6);
  assert.throws(() => player.add([wav('q7', 5)]), /Queue is full/);
  done();
});

test('shuffle visits every track exactly once, then stops (loop off)', { skip }, async () => {
  const { player, done } = mkPlayer(slowResolver(0));
  const seen = [];
  player.on('state', () => { const c = player.current; if (c && player.status === 'playing' && seen.at(-1) !== c.id) seen.push(c.id); });
  player.setShuffle(true);
  player.add([wav('s1', 0.3), wav('s2', 0.3), wav('s3', 0.3), wav('s4', 0.3)]);
  await sleep(3500);
  assert.equal(player.status, 'idle');
  assert.equal(new Set(seen).size, 4, `visited ${seen.join(',')}`);
  assert.equal(seen.length, 4, 'no repeats');
  done();
});

test('playNow while playing inserts after the current track and does not duplicate decoders', { skip }, async () => {
  const { player, done } = mkPlayer(slowResolver(10));
  player.add([wav('p1', 20), wav('p2', 20)]);
  await sleep(100);
  player.add([wav('now', 20)], { playNow: true });
  await sleep(300);
  assert.equal(player.current.title, 'now');
  assert.deepEqual(player.queue.map((t) => t.title), ['p1', 'now', 'p2']);
  assert.equal(ffmpegProcs(), 1);
  done();
});

// ---- command handling -------------------------------------------------------------------------
const fakeHandler = () => {
  const player = new Proxy({ queue: [], index: -1, status: 'idle', position: 0, mixer: { volume: 50, muted: false }, current: null, shuffle: false, loop: 'off' }, {
    get: (t, k) => (k in t ? t[k] : () => true),
  });
  const resolver = { resolveQuery: async (q) => [{ id: '1', title: q.slice(0, 20), duration: 1 }], search: async () => [{ id: 's', title: 'r', duration: 1 }] };
  return new CommandHandler({ player, resolver, library: { find: async () => [], toTrack: (x) => x }, getPrefix: () => '#' });
};

test('prototype-property command names (#constructor, #__proto__ ...) are not commands', async () => {
  for (const n of ['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty', '__defineGetter__']) {
    assert.equal(canonical(n), n, `canonical(${n}) must not hit Object.prototype`);
    const h = fakeHandler();
    assert.match(await h.execute(n, 'x', { sender: 'a' }), /Unknown command/, n);
    assert.equal(h.has(n), false, n);
  }
  assert.equal(fakeHandler().has('play'), true);
  assert.equal(fakeHandler().has('skip'), true, 'aliases are commands');
});

test('fuzz: no input ever makes the parser or handler throw, and replies are always strings', async () => {
  const h = fakeHandler();
  const alphabet = ['#', 'play', 'volume', 'seek', 'pick', 'remove', 'jump', 'loop', 'shuffle', ' ', '  ', '\n', '\r', '\t', '0', '-1', '+5', '99999999999999999999', '1e9', 'NaN', 'Infinity', '-', ':', '1:2:3:4', '"', "'", '`', '$(id)', '; rm -rf /', '${x}', '../', '%00', '\u0000', '🎵', '日本語', '‮', '<script>', 'http://x', '--exec', 'ä', '\\', '{p}', '$&'];
  let seed = 12345;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  for (let i = 0; i < 4000; i++) {
    let s = '#';
    for (let j = rnd(8) + 1; j > 0; j--) s += alphabet[rnd(alphabet.length)];
    const cmd = parseCommand(s, '#');
    if (!cmd) continue;
    const out = await h.execute(cmd.name, cmd.args, { sender: 'fuzz' });
    assert.equal(typeof out, 'string', JSON.stringify(s));
  }
});

test('rate limiting: per sender and global, with a single "slow down" notice per window', () => {
  const bot = new MeetTunes({ sink: new NullSink() });
  const said = [];
  bot.sendToMeeting = (t) => said.push(t);
  const ok = Array.from({ length: 12 }, () => bot._rateOk('Spammer'));
  assert.equal(ok.filter(Boolean).length, 8);
  assert.equal(said.length, 1, 'one notice, not one per spammed command');
  assert.equal(bot._rateOk('Alice'), true, 'other people are unaffected');
  // many fake names cannot get around the global cap
  const many = Array.from({ length: 40 }, (_, i) => bot._rateOk('fake' + i));
  assert.ok(many.filter(Boolean).length <= 20 - 9, `global cap, got ${many.filter(Boolean).length}`);
});

test('redactUrl hides passcodes and credentials', () => {
  assert.equal(redactUrl('https://zoom.us/j/123?pwd=abc123&x=1'), 'https://zoom.us/j/123?pwd=***&x=1');
  assert.match(redactUrl('https://teams.live.com/meet/9?p=SECRET'), /p=\*\*\*/);
  assert.ok(!redactUrl('https://user:pass@host.com/a?MTID=zzz').includes('pass'));
  assert.ok(!redactUrl('https://user:pass@host.com/a?MTID=zzz').includes('zzz'));
  assert.equal(redactUrl('nonsense'), '[invalid url]');
});

test('missing PulseAudio devices are reported (not silently playing into the void)', async () => {
  process.env.PULSE_MUSIC_SINK = 'definitely_not_a_sink';
  const mod = await import('../../src/audio/sinks.js');
  const bot = new MeetTunes({ sink: new mod.PulseSink({ device: 'definitely_not_a_sink' }) });
  await bot._checkAudio();
  assert.equal(bot.audio.ok, false);
  assert.match(bot.audio.error, /not found|pactl|Connection|failed/i);
  assert.equal(bot.snapshot().audio.ok, false);
});
