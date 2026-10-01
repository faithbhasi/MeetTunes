import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { Mixer, FRAME_BYTES, volumeToGain } from '../../src/audio/mixer.js';
import { MemorySink } from '../../src/audio/sinks.js';

/** 1 second of a constant-amplitude signal */
const tone = (seconds, amp = 10000) => {
  const n = 48000 * 2 * seconds;
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(i % 2 ? amp : -amp, i * 2);
  return b;
};
const peakOf = (chunks) => {
  let m = 0;
  for (const c of chunks) for (let i = 0; i < c.length; i += 2) m = Math.max(m, Math.abs(c.readInt16LE(i)));
  return m;
};

test('volume curve is perceptual and monotonic', () => {
  assert.equal(volumeToGain(0), 0);
  assert.equal(volumeToGain(100), 1);
  assert.ok(volumeToGain(50) < 0.5 && volumeToGain(50) > 0.1);
  assert.ok(volumeToGain(30) < volumeToGain(60));
});

test('plays source audio in real time with exact position, and writes silence otherwise', async () => {
  const sink = new MemorySink();
  const m = new Mixer(sink, { volume: 100 });
  m.start();
  await sleep(200);
  assert.equal(peakOf(sink.chunks), 0, 'idle = silence');
  const src = new PassThrough();
  src.end(tone(1));
  m.setSource(src, 1);
  await sleep(500);
  assert.ok(m.sourceMs > 350 && m.sourceMs < 650, `position ~500ms, got ${m.sourceMs}`);
  assert.ok(peakOf(sink.chunks) >= 9000);
  m.stop();
  assert.ok(sink.chunks.every((c) => c.length === FRAME_BYTES), 'every write is exactly one frame');
});

test('pause freezes position and emits silence; resume continues', async () => {
  const sink = new MemorySink();
  const m = new Mixer(sink, { volume: 100 });
  m.start();
  const src = new PassThrough();
  src.end(tone(3));
  m.setSource(src, 1);
  await sleep(300);
  m.setPaused(true);
  await sleep(250); // let queued lookahead frames drain
  const pos = m.sourceMs;
  const mark = sink.chunks.length;
  await sleep(400);
  assert.equal(m.sourceMs, pos);
  assert.equal(peakOf(sink.chunks.slice(mark)), 0);
  m.setPaused(false);
  await sleep(300);
  assert.ok(m.sourceMs > pos + 150);
  m.stop();
});

test('volume and mute scale samples; ramp avoids clicks', async () => {
  const sink = new MemorySink();
  const m = new Mixer(sink, { volume: 100 });
  m.start();
  const src = new PassThrough();
  m.setSource(src, 1);
  src.write(tone(2, 20000));
  m.setVolume(50);
  await sleep(600);
  const quarter = peakOf(sink.chunks.slice(-5));
  assert.ok(Math.abs(quarter - 20000 * volumeToGain(50)) < 400, `got ${quarter}`);
  m.setMuted(true);
  await sleep(300);
  assert.equal(peakOf(sink.chunks.slice(-3)), 0);
  m.stop();
});

test('emits sourceEnd once when the source finishes', async () => {
  const m = new Mixer(new MemorySink());
  m.start();
  let ends = 0;
  m.on('sourceEnd', ({ id }) => {
    assert.equal(id, 7);
    ends++;
  });
  const src = new PassThrough();
  src.end(tone(0.2));
  m.setSource(src, 7);
  await sleep(800);
  assert.equal(ends, 1);
  m.stop();
});
