import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CommandHandler } from '../../src/commands/handler.js';

/** Records calls so we can assert on how commands drive the player. */
function setup({ tracks = [] } = {}) {
  const calls = [];
  const player = {
    queue: [], index: -1, status: 'idle', position: 12, shuffle: false, loop: 'off',
    mixer: { volume: 50, muted: false },
    current: null,
    add(ts, o) { calls.push(['add', ts.map((t) => t.title), o]); this.queue.push(...ts); this.current = this.current || ts[0]; this.status = 'playing'; this.index = 0; return ts; },
    pause() { calls.push(['pause']); return true; },
    resume() { calls.push(['resume']); return false; },
    stop() { calls.push(['stop']); },
    next() { calls.push(['next']); }, previous() { calls.push(['previous']); },
    seek(s) { calls.push(['seek', s]); },
    setVolume(v) { calls.push(['vol', v]); this.mixer.volume = v; return v; },
    adjustVolume(d) { calls.push(['dvol', d]); this.mixer.volume += d; return this.mixer.volume; },
    setMuted(m) { calls.push(['mute', m]); this.mixer.muted = m; },
    setLoop(m) { this.loop = m; }, cycleLoop() { this.loop = 'all'; },
    setShuffle(v) { this.shuffle = v; },
    remove(i) { calls.push(['remove', i]); return { title: 'gone' }; },
    play(i) { calls.push(['play', i]); },
    clear() { calls.push(['clear']); },
  };
  const resolver = { resolveQuery: async (q) => tracks.length ? tracks : [{ id: '1', title: `Hit for ${q}`, artist: 'A', duration: 65 }], search: async () => [{ id: 's1', title: 'One', duration: 10 }, { id: 's2', title: 'Two', duration: 20 }] };
  const library = { find: async () => [], toTrack: (x) => x };
  const h = new CommandHandler({ player, resolver, library, getPrefix: () => '#', onLeave: () => calls.push(['leave']) });
  return { h, calls, player };
}
const run = (h, name, args = '', sender = 'Alice') => h.execute(name, args, { sender });

test('play queues the top result and replies', async () => {
  const { h, calls } = setup();
  const r = await run(h, 'play', 'daft punk');
  assert.match(r, /^Now playing: Hit for daft punk - A \(1:05\)/);
  assert.deepEqual(calls[0].slice(0, 2), ['add', ['Hit for daft punk']]);
  assert.equal(calls[0][2].requestedBy, 'Alice');
});

test('volume: absolute, relative, query and bad input', async () => {
  const { h, calls } = setup();
  assert.equal(await run(h, 'volume', '30'), 'Volume 30%');
  assert.equal(await run(h, 'vol', '+10'), 'Volume 40%');
  assert.equal(await run(h, 'v', '-15%'), 'Volume 25%');
  assert.match(await run(h, 'volume'), /Volume is 25%/);
  assert.match(await run(h, 'volume', 'loud'), /Usage/);
  assert.deepEqual(calls.filter((c) => c[0] === 'vol' || c[0] === 'dvol'), [['vol', 30], ['dvol', 10], ['dvol', -15]]);
});

test('search + pick uses a per-sender memory', async () => {
  const { h, calls } = setup();
  const list = await run(h, 'search', 'queen', 'Alice');
  assert.match(list, /1\. One \(0:10\)\n2\. Two/);
  assert.match(await run(h, 'pick', '2', 'Alice'), /Two/);
  assert.equal(calls.at(-1)[1][0], 'Two');
  assert.match(await run(h, 'pick', '1', 'Bob'), /No recent search/);
  assert.match(await run(h, 'pick', '9', 'Alice'), /between 1 and 2/);
});

test('transport commands + aliases', async () => {
  const { h, calls, player } = setup();
  player.queue = [{ title: 'x' }];
  await run(h, 'skip'); await run(h, 'prev'); await run(h, 'pause'); await run(h, 'mute'); await run(h, 'unmute'); await run(h, 'stop');
  assert.deepEqual(calls.map((c) => c[0]), ['next', 'previous', 'pause', 'mute', 'mute', 'stop']);
  assert.match(await run(h, 'resume'), /Nothing to resume/);
});

test('seek accepts absolute and relative times', async () => {
  const { h, calls } = setup();
  await run(h, 'seek', '1:30');
  await run(h, 'seek', '+30');
  await run(h, 'seek', '-5');
  assert.deepEqual(calls.map((c) => c[1]), [90, 42, 7]);
  assert.match(await run(h, 'seek', 'abc'), /Usage/);
});

test('unknown command and errors become replies, never exceptions', async () => {
  const { h, player } = setup();
  assert.match(await run(h, 'dance'), /Unknown command/);
  player.remove = () => { throw new Error('No such queue position'); };
  assert.equal(await run(h, 'remove', '9'), 'Error: No such queue position');
});

test('help lists commands without starting any line with the prefix', async () => {
  const { h } = setup();
  const text = await run(h, 'help');
  assert.ok(text.split('\n').length >= 4);
  assert.ok(!text.split('\n').some((l) => l.trimStart().startsWith('#')), 'a bot line starting with # could be parsed as a command');
  assert.match(await run(h, 'help', 'volume'), /#volume 30/);
});

test('leave triggers the callback', async () => {
  const { h, calls } = setup();
  await run(h, 'leave');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls.at(-1), ['leave']);
});
