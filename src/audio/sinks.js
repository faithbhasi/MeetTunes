import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { getLog } from '../log.js';

const log = getLog('sink');

/**
 * A sink consumes raw PCM (s16le, 48 kHz, stereo). The mixer owns the clock, so a sink only has to
 * accept bytes and report back-pressure.
 */
export class NullSink extends EventEmitter {
  constructor() {
    super();
    this.kind = 'none';
    this.bytes = 0;
  }
  start() {}
  write(buf) {
    this.bytes += buf.length;
    return true;
  }
  stop() {}
}

/** Collects everything written to it. Handy for tests. */
export class MemorySink extends NullSink {
  constructor() {
    super();
    this.kind = 'memory';
    this.chunks = [];
  }
  write(buf) {
    this.chunks.push(buf);
    return super.write(buf);
  }
}

/**
 * Streams PCM into a PulseAudio null-sink via `pacat`. The sink's monitor is exposed to Chromium as
 * the virtual microphone (see docker/entrypoint.sh), so whatever we write here is what the meeting hears.
 */
export class PulseSink extends EventEmitter {
  constructor({ device, sampleRate = 48000, channels = 2, latencyMs = 80 }) {
    super();
    this.kind = 'pulse';
    this.device = device;
    this.sampleRate = sampleRate;
    this.channels = channels;
    this.latencyMs = latencyMs;
    this.proc = null;
    this.stopped = true;
    this.blocked = false;
    this.restarts = 0;
  }

  start() {
    this.stopped = false;
    this._spawn();
  }

  _spawn() {
    const args = [
      '--playback',
      `--device=${this.device}`,
      '--format=s16le',
      `--rate=${this.sampleRate}`,
      `--channels=${this.channels}`,
      `--latency-msec=${this.latencyMs}`,
      '--client-name=MeetTunes',
      '--stream-name=music',
    ];
    const proc = spawn('pacat', args, { stdio: ['pipe', 'ignore', 'pipe'] });
    this.proc = proc;
    this.blocked = false;
    let err = '';
    proc.stderr.on('data', (d) => (err = (err + d).slice(-500)));
    proc.stdin.on('error', () => {}); // EPIPE when pacat dies; handled by 'close'
    proc.stdin.on('drain', () => {
      this.blocked = false;
      this.emit('drain');
    });
    proc.on('error', (e) => {
      log.error(`pacat failed to start (${e.message}). Is pulseaudio-utils installed?`);
      this.emit('fatal', e);
    });
    proc.on('close', (code) => {
      if (this.proc !== proc) return;
      this.proc = null;
      if (this.stopped) return;
      this.restarts++;
      log.warn(`pacat exited (code ${code}) ${err.trim()} - restarting (#${this.restarts})`);
      setTimeout(() => !this.stopped && this._spawn(), Math.min(5000, 500 * this.restarts));
    });
  }

  write(buf) {
    if (!this.proc || !this.proc.stdin.writable) return true; // dropped while restarting
    const ok = this.proc.stdin.write(buf);
    if (!ok) this.blocked = true;
    return ok;
  }

  stop() {
    this.stopped = true;
    const p = this.proc;
    this.proc = null;
    if (p) {
      p.stdin.end();
      setTimeout(() => p.kill('SIGKILL'), 500).unref();
    }
  }
}

export function createSink(cfg) {
  if (cfg.sink === 'pulse') {
    return new PulseSink({ device: cfg.pulseSink, sampleRate: cfg.sampleRate, channels: cfg.channels });
  }
  return new NullSink();
}
