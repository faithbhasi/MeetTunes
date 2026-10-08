import { config } from '../config.js';
import { getLog } from '../log.js';
import { fmtTime, parseTime, truncate } from '../util.js';
import { looksLikeUrl } from '../audio/netguard.js';
import { canonical } from './parser.js';

const log = getLog('commands');
const SEARCH_TTL_MS = 5 * 60 * 1000;
const MAX_ARG = 300; // chat input is untrusted; nothing legitimate needs more
const MAX_SEARCHERS = 100;

const line = (t) => `${truncate(t.title, 70)}${t.artist ? ` - ${truncate(t.artist, 30)}` : ''}${t.duration ? ` (${fmtTime(t.duration)})` : ''}`;

/**
 * Executes player commands. The same code serves chat commands (#play ...) and the web UI's search box,
 * so behaviour is identical everywhere. Every command resolves to a reply string (or '' for no reply).
 */
export class CommandHandler {
  constructor({ player, resolver, library, getPrefix, onLeave }) {
    this.player = player;
    this.resolver = resolver;
    this.library = library;
    this.getPrefix = getPrefix;
    this.onLeave = onLeave || (() => {});
    this.searches = new Map(); // sender -> { at, results }
    this.table = {
      help: (a) => this.help(a),
      play: (a, c) => this.play(a, c),
      playnow: (a, c) => this.play(a, c, { now: true }),
      search: (a, c) => this.search(a, c),
      pick: (a, c) => this.pick(a, c),
      local: (a, c) => this.local(a, c),
      pause: () => (this.player.pause() ? 'Paused.' : 'Nothing is playing.'),
      resume: () => (this.player.resume() ? 'Resumed.' : 'Nothing to resume - queue something with play.'),
      stop: () => (this.player.stop(), 'Stopped.'),
      next: () => this.skip(1),
      previous: () => this.skip(-1),
      seek: (a) => this.seek(a),
      volume: (a) => this.volume(a),
      volup: () => `Volume ${this.player.adjustVolume(10)}%`,
      voldown: () => `Volume ${this.player.adjustVolume(-10)}%`,
      mute: () => (this.player.setMuted(true), 'Muted.'),
      unmute: () => (this.player.setMuted(false), `Unmuted (volume ${this.player.mixer.volume}%).`),
      queue: (a) => this.queue(a),
      nowplaying: () => this.nowPlaying(),
      remove: (a) => this.remove(a),
      clear: () => (this.player.clear({ keepCurrent: true }), 'Queue cleared.'),
      shuffle: (a) => this.shuffle(a),
      loop: (a) => this.loop(a),
      jump: (a) => this.jump(a),
      leave: () => (setImmediate(() => this.onLeave()), 'Bye!'),
    };
  }

  /** Is this (possibly aliased) name a real command? */
  has(rawName) {
    return Object.hasOwn(this.table, canonical(rawName));
  }

  /** Run one command. Never throws: errors become a reply. */
  async execute(rawName, args, ctx = {}) {
    const name = canonical(rawName);
    const fn = this.has(name) ? this.table[name] : null;
    if (!fn) return `Unknown command "${rawName}". Try ${this.getPrefix()}help`;
    try {
      return (await fn(String(args || '').slice(0, MAX_ARG), ctx)) || '';
    } catch (e) {
      log.warn(`${name} failed: ${e.message}`);
      return `Error: ${e.message}`;
    }
  }

  help(topic) {
    const p = this.getPrefix();
    if (topic) {
      const t = canonical(topic.replace(p, '').toLowerCase());
      const detail = DETAIL[t];
      if (detail) return detail.replaceAll('{p}', () => p);
    }
    return HELP.replaceAll('{p}', () => p);
  }

  async play(query, ctx, { now = false } = {}) {
    if (!query) {
      if (this.player.resume()) return 'Resumed.';
      return `Usage: ${this.getPrefix()}play <song name or URL>`;
    }
    const tracks = await this.resolver.resolveQuery(query, { count: 1 });
    const hits = looksLikeUrl(query) ? tracks : tracks.slice(0, 1);
    const added = this.player.add(hits, { playNow: now, requestedBy: ctx.sender });
    if (!added.length) return 'Nothing added.';
    if (added.length > 1) return `Added ${added.length} tracks${hits[0].playlist ? ` from "${hits[0].playlist}"` : ''}.`;
    const idle = this.player.current?.id === added[0].id;
    return `${idle ? 'Now playing' : 'Queued'}: ${line(added[0])}`;
  }

  async search(query, ctx) {
    if (!query) return `Usage: ${this.getPrefix()}search <query>, then ${this.getPrefix()}pick <number>`;
    const results = await this.resolver.search(query, 5);
    this._remember(ctx, results);
    return [`Results for "${truncate(query, 40)}":`, ...results.map((t, i) => `${i + 1}. ${line(t)}`), `Reply ${this.getPrefix()}pick <number> to play one.`].join('\n');
  }

  async local(query, ctx) {
    const hits = await this.library.find(query);
    if (!hits.length) return query ? `No local files match "${query}".` : 'The local music folder is empty.';
    if (query && hits.length === 1) {
      const [t] = this.player.add([this.library.toTrack(hits[0])], { requestedBy: ctx.sender });
      return `${this.player.current?.id === t.id ? 'Now playing' : 'Queued'}: ${line(t)}`;
    }
    const shown = hits.slice(0, 8);
    this._remember(ctx, shown.map((h) => this.library.toTrack(h)));
    return [`Local files${query ? ` matching "${query}"` : ''} (${hits.length}):`, ...shown.map((h, i) => `${i + 1}. ${line(h)}`), `Reply ${this.getPrefix()}pick <number> to play one.`].join('\n');
  }

  _remember(ctx, results) {
    this.searches.set(ctx.sender || '*', { at: Date.now(), results });
    if (this.searches.size > MAX_SEARCHERS) this.searches.delete(this.searches.keys().next().value); // bounded memory
  }

  async pick(arg, ctx) {
    const n = parseInt(arg, 10);
    const mem = this.searches.get(ctx.sender || '*') || this.searches.get('*');
    if (!mem || Date.now() - mem.at > SEARCH_TTL_MS) return `No recent search. Use ${this.getPrefix()}search <query> first.`;
    if (!Number.isInteger(n) || n < 1 || n > mem.results.length) return `Pick a number between 1 and ${mem.results.length}.`;
    const [t] = this.player.add([mem.results[n - 1]], { requestedBy: ctx.sender });
    return `${this.player.current?.id === t.id ? 'Now playing' : 'Queued'}: ${line(t)}`;
  }

  skip(dir) {
    if (!this.player.queue.length) return 'The queue is empty.';
    if (dir > 0) this.player.next();
    else this.player.previous();
    return '';
  }

  seek(arg) {
    const t = parseTime(arg);
    if (!t) return `Usage: ${this.getPrefix()}seek 1:30  (or +30 / -15)`;
    const target = t.relative ? this.player.position + t.value : t.value;
    this.player.seek(target);
    return `Seeking to ${fmtTime(Math.max(0, target))}`;
  }

  volume(arg) {
    if (!arg) return `Volume is ${this.player.mixer.volume}%${this.player.mixer.muted ? ' (muted)' : ''}`;
    const m = /^([+-])?\s*(\d{1,3})%?$/.exec(arg);
    if (!m) return `Usage: ${this.getPrefix()}volume 0-${config.audio.maxVolume}  (or +10 / -10)`;
    const n = parseInt(m[2], 10);
    const v = m[1] ? this.player.adjustVolume(m[1] === '-' ? -n : n) : this.player.setVolume(n);
    return `Volume ${v}%`;
  }

  queue(arg) {
    const q = this.player.queue;
    if (!q.length) return 'The queue is empty.';
    const cur = this.player.index;
    const start = Math.max(0, cur - 1);
    const page = Math.max(1, parseInt(arg, 10) || 1);
    const from = arg ? (page - 1) * 10 : start;
    const rows = q.slice(from, from + 10).map((t, k) => {
      const i = from + k;
      return `${i === cur && this.player.status !== 'idle' ? '>' : ' '}${i + 1}. ${line(t)}`;
    });
    const more = q.length - (from + rows.length);
    return [`Queue (${q.length} tracks):`, ...rows, more > 0 ? `...and ${more} more (${this.getPrefix()}queue ${page + 1})` : ''].filter(Boolean).join('\n');
  }

  nowPlaying() {
    const p = this.player;
    if (!p.current) return 'Nothing is playing.';
    return `${p.status === 'paused' ? 'Paused' : 'Now playing'}: ${line(p.current)}  [${fmtTime(p.position)}${p.current.duration ? ` / ${fmtTime(p.current.duration)}` : ''}]  vol ${p.mixer.muted ? 'muted' : p.mixer.volume + '%'}`;
  }

  remove(arg) {
    const n = parseInt(arg, 10);
    if (!Number.isInteger(n)) return `Usage: ${this.getPrefix()}remove <queue number>`;
    const t = this.player.remove(n - 1);
    return `Removed: ${truncate(t.title, 70)}`;
  }

  jump(arg) {
    const n = parseInt(arg, 10);
    if (!Number.isInteger(n) || n < 1 || n > this.player.queue.length) return `Usage: ${this.getPrefix()}jump <queue number>`;
    this.player.play(n - 1);
    return '';
  }

  shuffle(arg) {
    const on = /^(on|1|true)$/i.test(arg) ? true : /^(off|0|false)$/i.test(arg) ? false : !this.player.shuffle;
    this.player.setShuffle(on);
    return `Shuffle ${on ? 'on' : 'off'}.`;
  }

  loop(arg) {
    const mode = /^(off|one|all)$/i.test(arg) ? arg.toLowerCase() : arg === 'song' || arg === 'track' ? 'one' : arg === 'queue' ? 'all' : null;
    if (mode) this.player.setLoop(mode);
    else this.player.cycleLoop();
    return `Loop: ${this.player.loop}`;
  }
}

// Every line starts with a label, never with the prefix: a reply that looks like a command could re-trigger the bot.
const HELP = [
  'MeetTunes commands:',
  'Music: {p}play <song|url> | {p}search <q> then {p}pick <n> | {p}local <name>',
  'Control: {p}pause | {p}resume | {p}stop | {p}next | {p}previous | {p}seek <1:30|+30>',
  'Sound: {p}volume <0-100|+10|-10> | {p}mute | {p}unmute',
  'Queue: {p}queue | {p}nowplaying | {p}remove <n> | {p}jump <n> | {p}clear',
  'Modes: {p}shuffle | {p}loop <off|one|all> | {p}leave',
].join('\n');

const DETAIL = {
  play: '{p}play <song name | URL> - search and queue the top result, or queue a link (YouTube, SoundCloud, direct mp3, playlists...). With no argument it resumes.',
  search: '{p}search <query> - shows 5 results; answer with {p}pick <number>.',
  volume: '{p}volume 30 sets 30%. {p}volume +10 / -10 adjusts. {p}volume alone shows the level.',
  seek: '{p}seek 1:30 jumps to 1:30. {p}seek +30 / -15 skips relative to now.',
  loop: '{p}loop off | one | all (no argument cycles).',
};
