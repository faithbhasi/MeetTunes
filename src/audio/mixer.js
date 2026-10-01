import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';

export const RATE = 48000;
export const CHANNELS = 2;
export const FRAME_MS = 20;
export const FRAME_BYTES = ((RATE * FRAME_MS) / 1000) * CHANNELS * 2; // 3840
const LOOKAHEAD_MS = 100;
const MAX_CATCHUP_MS = 1000;

/**
 * Buffers a readable (ffmpeg stdout) in flowing mode and hands out exact byte counts.
 *
 * Do not use Readable.read() on a child's stdout instead: once the process exits, Node resumes any stdio
 * stream that nobody is flowing and throws away what is left - ffmpeg decodes faster than real time and
 * exits early, so the tail of every track would be lost.
 */
export class PcmSource {
  constructor(readable, { high = 1 << 20, low = 1 << 18 } = {}) {
    this.readable = readable;
    this.high = high;
    this.low = low;
    this.chunks = [];
    this.length = 0;
    this.ended = false;
    readable.on('data', (d) => {
      this.chunks.push(d);
      this.length += d.length;
      if (this.length >= this.high) readable.pause();
    });
    const done = () => (this.ended = true);
    readable.on('end', done);
    readable.on('close', done);
    readable.on('error', done);
  }

  /** Exactly n bytes, or null if not available yet. Once ended, returns whatever remains (possibly < n). */
  read(n) {
    if (this.length < n && !(this.ended && this.length > 0)) return null;
    const take = Math.min(n, this.length);
    const out = Buffer.allocUnsafe(take);
    let off = 0;
    while (off < take) {
      const c = this.chunks[0];
      const need = take - off;
      if (c.length <= need) {
        c.copy(out, off);
        off += c.length;
        this.chunks.shift();
      } else {
        c.copy(out, off, 0, need);
        this.chunks[0] = c.subarray(need);
        off += need;
      }
    }
    this.length -= take;
    if (this.length < this.low && this.readable.isPaused?.()) this.readable.resume();
    return out;
  }

  get drained() {
    return this.ended && this.length === 0;
  }

  destroy() {
    this.chunks = [];
    this.length = 0;
    this.readable.removeAllListeners('data');
    this.readable.destroy?.();
  }
}

/** Perceptual volume curve: 0..100 -> 0..1 (50% ~ -12 dB). Values above 100 amplify (clipped). */
export const volumeToGain = (v) => Math.pow(Math.max(0, v) / 100, 2);

/**
 * The mixer owns the real-time clock. Every 20 ms frame it pulls PCM from the current source
 * (an ffmpeg stdout), applies gain, and writes it to the sink - or writes silence when paused/idle.
 *
 * Doing this ourselves (instead of piping ffmpeg -> pacat) gives:
 *  - instant, glitch-free pause/resume/mute/volume (no buffered-audio lag),
 *  - an exact playback position (we count frames), and
 *  - a continuous stream into the virtual microphone, so meeting clients never see a dead device.
 */
export class Mixer extends EventEmitter {
  constructor(sink, { volume = 50 } = {}) {
    super();
    this.sink = sink;
    this.volume = volume;
    this.muted = false;
    this.paused = false;
    this.gain = this.targetGain = volumeToGain(volume);
    this.src = null;
    this.sourceMs = 0;
    this.level = 0;
    this.timer = null;
    this.sentMs = 0;
    this.t0 = 0;
    this.starved = 0;
  }

  start() {
    if (this.timer) return;
    this.sink.start?.();
    this.sink.on?.('drain', () => this._resync());
    this.t0 = performance.now();
    this.sentMs = 0;
    this.timer = setInterval(() => this._tick(), 10);
    this.timer.unref?.(); // the HTTP server keeps the process alive; tests shouldn't hang on a failed assertion
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.clearSource();
    this.sink.stop?.();
  }

  /** Attach a readable of s16le/48k/stereo PCM. Replaces any previous source. */
  setSource(stream, id) {
    this.clearSource();
    const src = new PcmSource(stream);
    src.id = id;
    src.announced = false;
    this.src = src;
    this.sourceMs = 0;
  }

  clearSource() {
    this.src?.destroy();
    this.src = null;
    this.sourceMs = 0;
  }

  setVolume(v) {
    this.volume = v;
    this._updateGain();
  }
  setMuted(m) {
    this.muted = !!m;
    this._updateGain();
  }
  setPaused(p) {
    this.paused = !!p;
  }
  _updateGain() {
    this.targetGain = this.muted ? 0 : volumeToGain(this.volume);
  }

  _resync() {
    // After back-pressure, forget the backlog so we don't burst-write to catch up.
    this.t0 = performance.now() - (this.sentMs - LOOKAHEAD_MS);
  }

  _tick() {
    const now = performance.now();
    let target = now - this.t0 + LOOKAHEAD_MS;
    if (target - this.sentMs > MAX_CATCHUP_MS) {
      // Event loop stalled for a long time; skip ahead instead of flooding the sink.
      this.sentMs = target - LOOKAHEAD_MS;
    }
    while (this.sentMs + FRAME_MS <= target) {
      if (this.sink.blocked) return this._resync();
      this.sink.write(this._nextFrame());
      this.sentMs += FRAME_MS;
    }
  }

  _nextFrame() {
    const ab = new ArrayBuffer(FRAME_BYTES);
    const frame = Buffer.from(ab);
    const s16 = new Int16Array(ab);
    const src = this.src;
    let have = 0;

    if (src && !this.paused) {
      const chunk = src.read(FRAME_BYTES);
      if (chunk && chunk.length) {
        have = chunk.length - (chunk.length % 4);
        chunk.copy(frame, 0, 0, have);
        this.sourceMs += (have / FRAME_BYTES) * FRAME_MS;
        this.starved = 0;
      } else if (!src.ended) {
        this.starved++;
      }
      if (src.drained && !have && !src.announced) {
        src.announced = true;
        // Defer so listeners can replace the source without re-entrancy surprises.
        setImmediate(() => this.emit('sourceEnd', { id: src.id }));
      }
    }

    const samples = have / 2;
    if (samples) {
      const g0 = this.gain;
      const g1 = this.targetGain;
      if (g0 === 1 && g1 === 1) {
        // unity - nothing to do
      } else {
        const step = (g1 - g0) / samples;
        let g = g0;
        for (let i = 0; i < samples; i++) {
          const v = Math.round(s16[i] * g);
          s16[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
          g += step;
        }
      }
      this.gain = g1;
      let peak = 0;
      for (let i = 0; i < samples; i += 8) {
        const a = Math.abs(s16[i]);
        if (a > peak) peak = a;
      }
      this.level = Math.max(peak / 32768, this.level * 0.85);
    } else {
      this.gain = this.targetGain;
      this.level *= 0.7;
    }
    return frame;
  }
}
