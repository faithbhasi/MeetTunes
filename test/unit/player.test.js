import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Mixer } from '../../src/audio/mixer.js';
import { NullSink } from '../../src/audio/sinks.js';
import { Player } from '../../src/audio/player.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-player-'));
const mk = (name, secs) => {
  const f = path.join(dir, name + '.wav');
  if (hasFfmpeg) spawnSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=300:duration=${secs}`, f]);
  return { id: name, kind: 'local', title: name, artist: '', duration: secs, path: f, source: 'local:' + name };
};
const resolver = { resolveStream: async (t) => (t.bad ? Promise.reject(new Error('boom')) : { url: t.path, headers: {}, local: true }) };

function setup() {
  const mixer = new Mixer(new NullSink(), { volume: 50 });
  mixer.start();
  const player = new Player({ mixer, resolver });
  player.on('error', () => {});
  return { mixer, player, stop: () => (player.stop(), mixer.stop()) };
}

test('queue: add starts playback only when idle', { skip: !hasFfmpeg }, async () => {
  const { player, stop } = setup();
  const a = mk('a', 5), b = mk('b', 5);
  player.add([a]);
  assert.equal(player.current.title, 'a');
  player.add([b]);
  assert.equal(player.current.title, 'a', 'adding does not interrupt');
  assert.deepEqual(player.queue.map((t) => t.title), ['a', 'b']);
  stop();
});

test('next / previous / history and playNow', { skip: !hasFfmpeg }, async () => {
  const { player, stop } = setup();
  player.add([mk('a', 20), mk('b', 20), mk('c', 20)]);
  player.next();
  assert.equal(player.current.title, 'b');
  player.next();
  assert.equal(player.current.title, 'c');
  await sleep(100);
  player.previous(); // within 5s of start -> previous track
  assert.equal(player.current.title, 'b');
  player.add([mk('d', 20)], { playNow: true });
  assert.equal(player.current.title, 'd');
  assert.deepEqual(player.queue.map((t) => t.title), ['a', 'b', 'd', 'c']);
  stop();
});

test('natural end advances; end of queue goes idle; loop all wraps; loop one repeats', { skip: !hasFfmpeg }, async () => {
  const { player, stop } = setup();
  player.add([mk('s1', 1), mk('s2', 1)]);
  await sleep(1800);
  assert.equal(player.current?.title, 's2', 'advanced to second track');
  await sleep(1500);
  assert.equal(player.status, 'idle', 'queue finished');
  player.setLoop('all');
  player.play(0);
  await sleep(2800);
  assert.notEqual(player.status, 'idle', 'wrapped around with loop=all');
  player.setLoop('one');
  player.play(0);
  await sleep(1700);
  assert.equal(player.current.title, 's1', 'loop one repeats');
  stop();
});

test('pause/resume/seek/stop and position', { skip: !hasFfmpeg }, async () => {
  const { player, stop } = setup();
  player.add([mk('long', 30)]);
  await sleep(700);
  assert.ok(player.position > 0.3 && player.position < 1.2, `pos ${player.position}`);
  player.pause();
  const p = player.position;
  await sleep(300);
  assert.equal(player.position, p);
  assert.equal(player.status, 'paused');
  player.seek(20);
  await sleep(800);
  assert.equal(player.status, 'paused', 'seek keeps paused state');
  assert.ok(player.position >= 20, `pos ${player.position}`);
  player.resume();
  await sleep(500);
  assert.ok(player.position > 20.2);
  player.stop();
  assert.equal(player.status, 'idle');
  assert.equal(player.position, 0);
  stop();
});

test('volume clamps, adjusts relatively and un-mutes', () => {
  const { player, mixer, stop } = setup();
  assert.equal(player.setVolume(250), 100);
  assert.equal(player.setVolume(-5), 0);
  assert.equal(player.adjustVolume(+30), 30);
  player.setMuted(true);
  player.setVolume(40);
  assert.equal(mixer.muted, false, 'setting a volume un-mutes');
  stop();
});

test('a track that fails to load is skipped; repeated failures stop instead of looping', async () => {
  const { player, stop } = setup();
  player.add([{ id: 'x', kind: 'local', title: 'x', bad: true, source: 'x' }, { id: 'y', kind: 'local', title: 'y', bad: true, source: 'y' }, { id: 'z', kind: 'local', title: 'z', bad: true, source: 'z' }]);
  await sleep(300);
  assert.equal(player.status, 'idle');
  stop();
});

test('remove / move / clear keep the cursor on the current track', { skip: !hasFfmpeg }, async () => {
  const { player, stop } = setup();
  player.add([mk('a', 20), mk('b', 20), mk('c', 20)]);
  player.next(); // on b
  player.remove(0);
  assert.equal(player.current.title, 'b');
  assert.equal(player.index, 0);
  player.move(1, 0); // c before b
  assert.equal(player.current.title, 'b');
  assert.equal(player.index, 1);
  player.clear({ keepCurrent: true });
  assert.deepEqual(player.queue.map((t) => t.title), ['b']);
  assert.throws(() => player.remove(5), /No such queue position/);
  stop();
});

test('fractional / non-integer queue positions are rejected, not silently truncated', { skip: !hasFfmpeg }, () => {
  const { player, stop } = setup();
  player.add([mk('a', 20), mk('b', 20)]);
  for (const bad of [1.5, NaN, Infinity, '1', null]) {
    assert.throws(() => player.remove(bad), /No such queue position/, String(bad));
    assert.throws(() => player.move(bad, 0), /No such queue position/, String(bad));
  }
  assert.equal(player.queue.length, 2);
  assert.doesNotThrow(() => player.play(1.5)); // internal callers fall back to the first track instead of crashing
  assert.equal(player.index, 0);
  stop();
});
