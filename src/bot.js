import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { config } from './config.js';
import { getLog } from './log.js';
import { createSink } from './audio/sinks.js';
import { Mixer } from './audio/mixer.js';
import { Player } from './audio/player.js';
import { Resolver } from './audio/resolver.js';
import { Library } from './audio/library.js';
import { MeetingSession } from './meeting/session.js';
import { CommandHandler } from './commands/handler.js';
import { parseCommand, canonical } from './commands/parser.js';
import { fmtTime } from './util.js';
import { run } from './audio/resolver.js';

const log = getLog('bot');

/**
 * Wires everything together: audio engine <-> meeting session <-> chat commands <-> web UI events.
 * Emits: 'player', 'session', 'chat' (log entries), 'settings'.
 */
export class MeetTunes extends EventEmitter {
  constructor({ sink } = {}) {
    super();
    this.settingsFile = path.join(config.dataDir, 'settings.json');
    this.settings = {
      displayName: config.defaultDisplayName,
      lastUrl: '',
      prefix: config.commandPrefix,
      allowlist: config.commandAllowlist,
      announce: true,
    };
    this.sink = sink || createSink(config.audio);
    this.mixer = new Mixer(this.sink, { volume: config.audio.defaultVolume });
    this.resolver = new Resolver();
    this.player = new Player({ mixer: this.mixer, resolver: this.resolver });
    this.library = new Library();
    this.session = new MeetingSession({ getPrefix: () => this.settings.prefix });
    this.commands = new CommandHandler({
      player: this.player,
      resolver: this.resolver,
      library: this.library,
      getPrefix: () => this.settings.prefix,
      onLeave: () => this.leave('Asked to leave from chat'),
    });
    this.chatLog = [];
    this.audio = { sink: this.sink.kind, ok: true, error: null };
    this.rates = new Map(); // sender -> timestamps of recent commands
    this.globalRate = [];
    this.joining = false;
    this.lastAnnouncedId = null;
    this.idleSince = Date.now();
  }

  async init() {
    await fs.mkdir(config.dataDir, { recursive: true });
    await this.library.init();
    try {
      // Only known keys, only through the same validation as the API (no prototype pollution via the file).
      const saved = JSON.parse(await fs.readFile(this.settingsFile, 'utf8'));
      this._applySettings(saved);
    } catch {
      /* first run or unreadable file: keep defaults */
    }
    await this._checkAudio();
    this.sink.on?.('fatal', (e) => this._audioProblem(`Audio output failed: ${e.message}`));
    this.mixer.start();

    this.player.on('state', () => this.emit('player'));
    this.player.on('error', (m) => this._chatEntry({ kind: 'system', sender: 'MeetTunes', text: m }));
    this.player.on('state', () => this._maybeAnnounce());
    this.session.on('status', (s) => {
      this.emit('session', s);
      if (s.state === 'joined') this.idleSince = Date.now();
    });
    this.session.on('left', (reason) => {
      this.player.stop();
      this.player.clear();
      this._chatEntry({ kind: 'system', sender: 'MeetTunes', text: `Left meeting: ${reason}` });
    });
    this.session.on('chat', (m) => this._onChat(m));

    this.idleTimer = setInterval(() => this._idleCheck(), 30000);
    log.info(`ready (audio sink: ${this.sink.kind}, prefix "${this.settings.prefix}")`);
  }

  async shutdown() {
    clearInterval(this.idleTimer);
    await this.session.leave('Shutting down').catch(() => {});
    this.mixer.stop();
  }

  // ---- audio health ---------------------------------------------------------------------------
  _audioProblem(msg) {
    this.audio = { sink: this.sink.kind, ok: false, error: msg };
    log.error(msg);
    this.emit('session', this.session.snapshot());
  }

  /** With the PulseAudio sink, make sure the virtual devices exist - otherwise the meeting hears silence. */
  async _checkAudio() {
    if (this.sink.kind !== 'pulse') return;
    try {
      const sinks = await run('pactl', ['list', 'short', 'sinks'], { timeoutMs: 5000 });
      const sources = await run('pactl', ['list', 'short', 'sources'], { timeoutMs: 5000 });
      if (!sinks.split('\n').some((l) => l.split('\t')[1] === config.audio.pulseSink)) throw new Error(`PulseAudio sink "${config.audio.pulseSink}" not found`);
      if (!sources.split('\n').some((l) => l.split('\t')[1] === config.audio.pulseMic)) throw new Error(`PulseAudio source "${config.audio.pulseMic}" not found`);
    } catch (e) {
      this.audio = { sink: 'pulse', ok: false, error: `${e.message}. Run docker/pulse-setup.sh or set AUDIO_SINK=none. The meeting will hear nothing.` };
      log.error(this.audio.error);
    }
  }

  // ---- settings -------------------------------------------------------------------------------
  /** Validate + apply known keys only. Returns the settings object. */
  _applySettings(patch) {
    const s = this.settings;
    if (typeof patch.displayName === 'string' && patch.displayName.trim()) s.displayName = patch.displayName.trim().slice(0, 60);
    if (typeof patch.lastUrl === 'string') s.lastUrl = patch.lastUrl.trim().slice(0, 2000);
    if (typeof patch.prefix === 'string' && /^[^\s\w]{1,2}$/.test(patch.prefix.trim())) s.prefix = patch.prefix.trim();
    if (Array.isArray(patch.allowlist)) s.allowlist = patch.allowlist.map((x) => String(x).trim().slice(0, 60)).filter(Boolean).slice(0, 50);
    if (typeof patch.announce === 'boolean') s.announce = patch.announce;
    return s;
  }

  async updateSettings(patch) {
    const s = this._applySettings(patch || {});
    await this.session.setPrefix(s.prefix);
    await fs.mkdir(config.dataDir, { recursive: true });
    // lastUrl can contain a meeting passcode: keep the file private.
    await fs.writeFile(this.settingsFile, JSON.stringify(s, null, 2), { mode: 0o600 });
    this.emit('settings', s);
    return s;
  }

  // ---- meeting --------------------------------------------------------------------------------
  async join(url, displayName) {
    if (this.joining || this.session.active) throw new Error('Already in (or joining) a meeting');
    this.joining = true; // closes the window between this check and the session starting
    try {
      const name = (displayName || this.settings.displayName || 'MeetTunes').trim();
      await this.updateSettings({ displayName: name, lastUrl: url });
      this._chatEntry({ kind: 'system', sender: 'MeetTunes', text: `Joining as "${name}"...` });
      this._startJoin(url, name);
    } finally {
      this.joining = false;
    }
  }

  _startJoin(url, name) {
    // Fire and forget: progress is reported through session status events.
    const started = this.session.join({ url, displayName: name });
    started.then(
      () => {
        this._chatEntry({ kind: 'system', sender: 'MeetTunes', text: `Joined. Type ${this.settings.prefix}help in the meeting chat.` });
        this.sendToMeeting(`MeetTunes is here! Type ${this.settings.prefix}help for commands, e.g. ${this.settings.prefix}play <song name>`);
      },
      (e) => this._chatEntry({ kind: 'system', sender: 'MeetTunes', text: `Join failed: ${e.message}` }),
    );
    return started;
  }

  leave(reason) {
    return this.session.leave(reason);
  }

  sendToMeeting(text, { log: doLog = true } = {}) {
    if (!text) return;
    if (doLog) this._chatEntry({ kind: 'bot', sender: this.settings.displayName, text });
    if (this.session.state === 'joined') return this.session.sendChat(text);
  }

  // ---- chat commands --------------------------------------------------------------------------
  _chatEntry(e) {
    const entry = { t: Date.now(), ...e };
    this.chatLog.push(entry);
    if (this.chatLog.length > 200) this.chatLog.shift();
    this.emit('chat', entry);
  }

  _allowed(sender) {
    const list = this.settings.allowlist;
    if (!list.length) return true;
    return !!sender && list.some((n) => n.toLowerCase() === sender.toLowerCase());
  }

  async _onChat({ sender, text }) {
    this._chatEntry({ kind: 'chat', sender, text });
    const cmd = parseCommand(text, this.settings.prefix);
    if (!cmd) return;
    const name = canonical(cmd.name);
    if (!this.commands.has(name)) return; // "#hashtag" in normal conversation - stay quiet
    if (!this._allowed(sender)) {
      log.warn(`ignored "${name}" from ${sender || 'unknown sender'} (not in allowlist)`);
      return;
    }
    if (!this._rateOk(sender)) return;
    this.idleSince = Date.now();
    log.info(`command from ${sender || '?'}: ${this.settings.prefix}${cmd.name} ${cmd.args}`);
    const reply = await this.commands.execute(cmd.name, cmd.args, { sender });
    if (/^Now playing/.test(reply)) this.lastAnnouncedId = this.player.current?.id;
    if (reply) this.sendToMeeting(reply);
  }

  /** Sliding 10 s window per sender plus a global one, so a spammer (or many fake names) can't flood the bot. */
  _rateOk(sender) {
    const now = Date.now();
    const recent = (arr) => arr.filter((t) => now - t < 10000);
    const key = (sender || '?').toLowerCase();
    const mine = recent(this.rates.get(key) || []);
    this.globalRate = recent(this.globalRate);
    if (mine.length >= config.commandRate.perSender || this.globalRate.length >= config.commandRate.global) {
      if (mine.length === config.commandRate.perSender) {
        mine.push(now); // one "slow down" per window, not one per spammed command
        this.rates.set(key, mine);
        this.sendToMeeting('Slow down - too many commands.');
      }
      return false;
    }
    mine.push(now);
    this.rates.set(key, mine);
    this.globalRate.push(now);
    if (this.rates.size > 200) for (const [k, v] of this.rates) if (!recent(v).length) this.rates.delete(k);
    return true;
  }

  _maybeAnnounce() {
    if (!this.settings.announce || this.session.state !== 'joined') return;
    const p = this.player;
    if (p.status !== 'playing' || !p.current || p.current.id === this.lastAnnouncedId) return;
    const id = p.current.id;
    clearTimeout(this._announceTimer);
    this._announceTimer = setTimeout(() => {
      if (this.player.current?.id !== id || this.lastAnnouncedId === id) return;
      this.lastAnnouncedId = id;
      const t = this.player.current;
      this.sendToMeeting(`Now playing: ${t.title}${t.artist ? ' - ' + t.artist : ''}${t.duration ? ` (${fmtTime(t.duration)})` : ''}`);
    }, 400);
  }

  _idleCheck() {
    const mins = config.autoLeaveIdleMinutes;
    if (!mins || this.session.state !== 'joined') return;
    if (this.player.status === 'playing' || this.player.status === 'paused') this.idleSince = Date.now();
    else if (Date.now() - this.idleSince > mins * 60000) this.leave(`Idle for ${mins} minutes`);
  }

  // ---- snapshot for the UI --------------------------------------------------------------------
  snapshot() {
    return {
      player: this.player.getState(),
      session: this.session.snapshot(),
      settings: this.settings,
      audio: this.audio,
    };
  }
}
