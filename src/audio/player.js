import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { config } from '../config.js';
import { getLog } from '../log.js';
import { clamp } from '../util.js';
import { RATE, CHANNELS } from './mixer.js';

const log = getLog('player');

/** Public view of a track (strips internals such as resolved stream URLs). */
const pub = (t) =>
  t && {
    id: t.id,
    kind: t.kind,
    title: t.title,
    artist: t.artist,
    duration: t.duration,
    thumbnail: t.thumbnail,
    source: t.source,
    requestedBy: t.requestedBy || null,
  };

/**
 * Discord-music-bot style player: a playlist-like queue with a cursor, previous/next, loop, shuffle,
 * seek and volume. Decoding is done by ffmpeg; the Mixer handles timing, gain and pause.
 */
export class Player extends EventEmitter {
  constructor({ mixer, resolver }) {
    super();
    this.mixer = mixer;
    this.resolver = resolver;
    this.queue = [];
    this.index = -1;
    this.status = 'idle'; // idle | loading | playing | paused
    this.loop = 'off'; // off | one | all
    this.shuffle = false;
    this.history = []; // track ids, most recent last
    this.played = new Set(); // track ids already played this shuffle round
    this.token = 0;
    this.proc = null;
    this.offsetMs = 0;
    this.failStreak = 0;
    this.retries = 0;
    this.startPaused = false; // pause requested while a track was still loading
    this.lastError = null;
    mixer.on('sourceEnd', (e) => this._onSourceEnd(e));
    mixer.setVolume(clamp(config.audio.defaultVolume, 0, config.audio.maxVolume));
  }

  // ---- state ----------------------------------------------------------------------------------
  get current() {
    return this.status === 'idle' ? null : this.queue[this.index] || null;
  }

  get position() {
    if (this.status === 'idle') return 0;
    const sec = (this.offsetMs + this.mixer.sourceMs) / 1000;
    const d = this.current?.duration;
    return d ? Math.min(sec, d) : sec;
  }

  getState() {
    return {
      status: this.status,
      current: pub(this.current),
      index: this.index,
      position: this.position,
      duration: this.current?.duration ?? null,
      volume: this.mixer.volume,
      maxVolume: config.audio.maxVolume,
      muted: this.mixer.muted,
      loop: this.loop,
      shuffle: this.shuffle,
      level: this.status === 'playing' ? Math.min(1, this.mixer.level) : 0,
      pausedPending: this.startPaused,
      queue: this.queue.map(pub),
      error: this.lastError,
    };
  }

  _changed() {
    this.emit('state');
  }

  // ---- queue management -----------------------------------------------------------------------
  /**
   * Add tracks. `playNow` inserts after the current track and starts it; otherwise they are appended
   * and playback starts only if the player is idle.
   */
  add(tracks, { playNow = false, requestedBy = null } = {}) {
    const room = config.media.maxQueue - this.queue.length;
    if (room <= 0) throw new Error(`Queue is full (${config.media.maxQueue})`);
    // Fresh id per queue entry: the same search result / file can be queued twice, and history, shuffle and
    // "previous" all track entries by id.
    tracks = tracks.slice(0, room).map((t) => ({ ...t, id: globalThis.crypto.randomUUID(), requestedBy: t.requestedBy || requestedBy }));
    if (!tracks.length) return [];
    if (playNow) {
      const at = this.status === 'idle' ? this.queue.length : this.index + 1;
      this.queue.splice(at, 0, ...tracks);
      this.play(at);
    } else {
      const wasIdle = this.status === 'idle';
      const firstNew = this.queue.length;
      this.queue.push(...tracks);
      if (wasIdle) this.play(firstNew);
    }
    this._changed();
    return tracks;
  }

  remove(i) {
    if (i < 0 || i >= this.queue.length) throw new Error('No such queue position');
    const [t] = this.queue.splice(i, 1);
    if (i < this.index) this.index--;
    else if (i === this.index && this.status !== 'idle') {
      if (this.queue[this.index]) this.play(this.index, { fromHistory: true });
      else {
        this._teardown();
        this.status = 'idle';
        this.index = this.queue.length - 1;
      }
    }
    this._changed();
    return t;
  }

  move(from, to) {
    const n = this.queue.length;
    if (from < 0 || from >= n || to < 0 || to >= n) throw new Error('No such queue position');
    const cur = this.queue[this.index];
    const [t] = this.queue.splice(from, 1);
    this.queue.splice(to, 0, t);
    if (cur) this.index = this.queue.indexOf(cur);
    this._changed();
  }

  clear({ keepCurrent = false } = {}) {
    if (keepCurrent && this.current) {
      this.queue = [this.current];
      this.index = 0;
    } else {
      this._teardown();
      this.queue = [];
      this.index = -1;
      this.status = 'idle';
    }
    this.history = [];
    this.played.clear();
    this._changed();
  }

  // ---- transport ------------------------------------------------------------------------------
  /** Start playing the queue item at `i`. */
  play(i = this.index, { fromHistory = false, startSec = 0, keepFail = false } = {}) {
    if (!this.queue.length) throw new Error('The queue is empty');
    if (i < 0 || i >= this.queue.length) i = 0;
    const prev = this.queue[this.index];
    if (!fromHistory && prev && this.status !== 'idle' && prev.id !== this.queue[i].id) this.history.push(prev.id);
    this.index = i;
    this.played.add(this.queue[i].id);
    if (!keepFail) this.failStreak = 0;
    this.retries = 0;
    this.startPaused = false;
    this._start(startSec).catch((e) => this._fail(e.message));
  }

  async _start(startSec = 0) {
    this._teardown(false); // also invalidates any start that is still waiting for its stream URL
    const token = this.token;
    const track = this.queue[this.index];
    if (!track) return;
    this.status = 'loading';
    this.lastError = null;
    this.offsetMs = startSec * 1000;
    this.mixer.setPaused(false);
    this._changed();


    let stream;
    try {
      stream = await this.resolver.resolveStream(track);
    } catch (e) {
      if (token !== this.token) return;
      return this._fail(`Could not load "${track.title}": ${e.message}`);
    }
    if (token !== this.token) return;

    const proc = this._spawnFfmpeg(stream, startSec);
    this.proc = proc;
    proc.once('error', (e) => token === this.token && this._fail(`ffmpeg failed to start: ${e.message}`));
    proc.stderr.on('data', (d) => log.debug(`ffmpeg: ${String(d).trim()}`));
    proc.exited = new Promise((res) => proc.once('close', (code, sig) => res({ code, sig })));
    this.mixer.setSource(proc.stdout, token);
    this.status = this.startPaused ? 'paused' : 'playing';
    this.mixer.setPaused(this.startPaused);
    this.startPaused = false;
    log.info(`playing "${track.title}"${startSec ? ` from ${Math.round(startSec)}s` : ''}`);
    this._changed();
  }

  _spawnFfmpeg(stream, startSec) {
    const isHttp = /^https?:/i.test(stream.url);
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
    if (isHttp) {
      args.push('-protocol_whitelist', 'http,https,tcp,tls,crypto', '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5');
      const h = Object.entries(stream.headers || {}).map(([k, v]) => `${k}: ${v}\r\n`).join('');
      if (h) args.push('-headers', h);
    }
    if (startSec > 0) args.push('-ss', String(startSec));
    args.push('-i', stream.url, '-vn', '-f', 's16le', '-ar', String(RATE), '-ac', String(CHANNELS), 'pipe:1');
    return spawn(config.media.ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  }

  _teardown(resetMixer = true) {
    // Anything still resolving a stream URL for the old track must not start playing afterwards
    // (clear(), removing the last track, stop() and starting another track all come through here).
    this.token++;
    if (this.proc) {
      this.proc.removeAllListeners('error');
      this.proc.kill('SIGKILL');
      this.proc = null;
    }
    this.mixer.clearSource();
    if (resetMixer) {
      this.mixer.setPaused(false);
      this.offsetMs = 0;
    }
  }

  _fail(msg) {
    log.error(msg);
    this.lastError = msg;
    this.emit('error', msg);
    this.failStreak++;
    if (this.failStreak >= 3 || this.queue.length <= 1) {
      this._teardown();
      this.status = 'idle';
      this._changed();
      return;
    }
    this._advance({ skipping: true });
  }

  async _onSourceEnd({ id }) {
    if (id !== this.token || this.status === 'idle') return;
    const proc = this.proc;
    const exit = proc ? await Promise.race([proc.exited, new Promise((r) => setTimeout(() => r({ code: null }), 1500))]) : { code: 0 };
    if (id !== this.token) return;
    const track = this.queue[this.index];
    const pos = this.position;
    if (pos > 1) this.failStreak = 0;
    const cut = exit.code !== 0 && exit.code !== null;
    // A clean EOF long before the known duration is a truncated stream (server/network closed it), not the end.
    const early = !!track?.duration && pos < track.duration - 5;
    if (pos === 0) return this._fail(`Playback failed for "${track?.title}" (no audio received)`);
    if ((cut || early) && this.retries < 2) {
      this.retries++;
      log.warn(`stream for "${track?.title}" ended early at ${Math.round(pos)}s - retrying`);
      if (track) track._stream = null;
      return this._start(pos).catch((e) => this._fail(e.message));
    }
    this._advance();
  }

  _pickNext() {
    const n = this.queue.length;
    if (!n) return null;
    if (this.shuffle) {
      let pool = this.queue.map((t, i) => i).filter((i) => !this.played.has(this.queue[i].id));
      if (!pool.length) {
        if (this.loop !== 'all') return null;
        this.played.clear();
        const cur = this.queue[this.index]?.id;
        pool = this.queue.map((t, i) => i).filter((i) => this.queue[i].id !== cur);
        if (!pool.length) pool = [this.index];
      }
      return pool[Math.floor(Math.random() * pool.length)];
    }
    if (this.index + 1 < n) return this.index + 1;
    return this.loop === 'all' ? 0 : null;
  }

  /** Move on after a track finished (or was skipped). */
  _advance({ skipping = false } = {}) {
    if (this.loop === 'one' && !skipping) return this.play(this.index, { fromHistory: true });
    const next = this._pickNext();
    if (next === null) {
      this._teardown();
      this.status = 'idle';
      log.info('queue finished');
      this.emit('queueEnd');
      return this._changed();
    }
    this.play(next, { keepFail: skipping });
  }

  next() {
    if (!this.queue.length) throw new Error('The queue is empty');
    if (this.status === 'idle') return this.play(Math.min(this.index + 1, this.queue.length - 1));
    const n = this._pickNext();
    if (n === null) {
      this._teardown();
      this.status = 'idle';
      this.emit('queueEnd');
      return this._changed();
    }
    this.play(n);
  }

  previous() {
    if (!this.queue.length) throw new Error('The queue is empty');
    // Like most players: a second press within the first seconds goes back, otherwise restarts the track.
    if (this.status !== 'idle' && this.position > 5) return this.play(this.index, { fromHistory: true });
    while (this.history.length) {
      const id = this.history.pop();
      const i = this.queue.findIndex((t) => t.id === id);
      if (i >= 0) return this.play(i, { fromHistory: true });
    }
    if (!this.shuffle && this.index > 0) return this.play(this.index - 1, { fromHistory: true });
    this.play(this.index < 0 ? 0 : this.index, { fromHistory: true });
  }

  pause() {
    if (this.status === 'loading') {
      this.startPaused = true; // takes effect the moment the track starts
      this._changed();
      return true;
    }
    if (this.status !== 'playing') return false;
    this.status = 'paused';
    this.mixer.setPaused(true);
    this._changed();
    return true;
  }

  resume() {
    if (this.status === 'loading') {
      this.startPaused = false;
      this._changed();
      return true;
    }
    if (this.status === 'paused') {
      this.status = 'playing';
      this.mixer.setPaused(false);
      this._changed();
      return true;
    }
    if (this.status === 'idle' && this.queue.length) {
      this.play(this.index >= 0 && this.index < this.queue.length ? this.index : 0, { fromHistory: true });
      return true;
    }
    return false;
  }

  togglePause() {
    return this.status === 'playing' ? this.pause() : this.resume();
  }

  stop() {
    this._teardown();
    this.status = 'idle';
    this._changed();
  }

  seek(sec) {
    const track = this.current;
    if (!track) throw new Error('Nothing is playing');
    const max = track.duration ? Math.max(0, track.duration - 1) : Infinity;
    sec = clamp(sec, 0, max);
    const wasPaused = this.status === 'paused' || (this.status === 'loading' && this.startPaused);
    this.retries = 0;
    this.startPaused = wasPaused; // a seek must not un-pause
    this._start(sec).catch((e) => this._fail(e.message));
  }

  // ---- volume / modes -------------------------------------------------------------------------
  setVolume(v) {
    v = clamp(Math.round(v), 0, config.audio.maxVolume);
    this.mixer.setVolume(v);
    if (v > 0 && this.mixer.muted) this.mixer.setMuted(false);
    this._changed();
    return v;
  }
  adjustVolume(delta) {
    return this.setVolume(this.mixer.volume + delta);
  }
  setMuted(m) {
    this.mixer.setMuted(m);
    this._changed();
    return this.mixer.muted;
  }
  toggleMute() {
    return this.setMuted(!this.mixer.muted);
  }
  setLoop(mode) {
    if (!['off', 'one', 'all'].includes(mode)) throw new Error('Loop mode must be off, one or all');
    this.loop = mode;
    this._changed();
  }
  cycleLoop() {
    this.setLoop({ off: 'all', all: 'one', one: 'off' }[this.loop]);
  }
  setShuffle(on) {
    this.shuffle = !!on;
    this.played.clear();
    if (this.current) this.played.add(this.current.id);
    this._changed();
  }
}
