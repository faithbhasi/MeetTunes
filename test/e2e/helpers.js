import { spawn, execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** True when this machine can run the audio e2e (Linux + pulseaudio + Xvfb + ffmpeg). */
export function e2eSupported() {
  if (process.platform !== 'linux') return 'not linux';
  if (process.getuid?.() === 0) return 'PulseAudio refuses to run as root - run as a normal user';
  for (const bin of ['pulseaudio', 'pactl', 'pacat', 'Xvfb', 'ffmpeg']) {
    try {
      execFileSync('which', [bin], { stdio: 'ignore' });
    } catch {
      return `${bin} not installed`;
    }
  }
  return null;
}

export async function startAudioEnv() {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-run-'));
  fs.chmodSync(runtime, 0o700);
  process.env.XDG_RUNTIME_DIR = runtime;
  execFileSync(path.join(root, 'docker/pulse-setup.sh'), { env: process.env, stdio: 'pipe' });
  const display = ':' + (90 + Math.floor(Math.random() * 9));
  const xvfb = spawn('Xvfb', [display, '-screen', '0', '1400x1000x24', '-nolisten', 'tcp'], { stdio: 'ignore' });
  process.env.DISPLAY = display;
  await sleep(800);
  return {
    stop() {
      xvfb.kill();
      try {
        execFileSync('pulseaudio', ['--kill'], { env: process.env, stdio: 'ignore' });
      } catch {
        /* already gone */
      }
    },
  };
}

export function makeTone(file, freq, seconds) {
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=${seconds}`, '-af', 'volume=6', file]);
}

export async function until(fn, { timeout = 15000, interval = 150, what = 'condition' } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(interval);
  }
}
