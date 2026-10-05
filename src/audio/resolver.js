import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { config } from '../config.js';
import { getLog } from '../log.js';
import { assertSafeUrl, looksLikeUrl } from './netguard.js';

const log = getLog('media');
const DIRECT_EXT = new Set(['.mp3', '.ogg', '.oga', '.opus', '.wav', '.flac', '.m4a', '.aac', '.weba']);
const STREAM_TTL_MS = 8 * 60 * 1000;

export const newTrackId = () => crypto.randomUUID();

const safeDecode = (s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s; // a stray "%" in a file name is not an error
  }
};

/** yt-dlp occasionally prints warnings or an error page instead of JSON: say that, not "Unexpected token". */
function parseJson(out) {
  try {
    return JSON.parse(out);
  } catch {
    throw new Error('Could not read the response from yt-dlp (is it up to date?)');
  }
}

/** Chat participants can trigger searches; cap how many yt-dlp processes run at once. */
class Semaphore {
  constructor(n) {
    this.free = n;
    this.waiters = [];
  }
  async run(fn) {
    if (this.free > 0) this.free--;
    else await new Promise((r) => this.waiters.push(r));
    try {
      return await fn();
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.free++;
    }
  }
}
const ytSem = new Semaphore(config.media.ytdlpConcurrency);
const ytdlp = (args) => ytSem.run(() => run(config.media.ytdlp, args, { timeoutMs: config.media.ytdlpTimeoutMs }));

/** Run a command, collect stdout, enforce timeout + output cap. No shell involved. */
export function run(cmd, args, { timeoutMs = 45000, maxBytes = 25 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let size = 0;
    const timer = setTimeout(() => {
      p.kill('SIGKILL');
      reject(new Error(`${cmd} timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);
    p.stdout.on('data', (d) => {
      size += d.length;
      if (size > maxBytes) {
        p.kill('SIGKILL');
        reject(new Error('output too large'));
      } else out += d;
    });
    p.stderr.on('data', (d) => (err = (err + d).slice(-2000)));
    p.on('error', (e) => {
      clearTimeout(timer);
      reject(e.code === 'ENOENT' ? new Error(`${cmd} not found - is it installed?`) : e);
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(lastLine(err) || `${cmd} exited with code ${code}`));
    });
  });
}

const lastLine = (s) =>
  s
    .trim()
    .split('\n')
    .filter(Boolean)
    .pop()
    ?.replace(/^ERROR:\s*/, '');

function ytdlpBase() {
  const a = ['--no-warnings', '--ignore-no-formats-error', '--socket-timeout', '15', ...config.media.ytdlpArgs];
  if (config.media.cookiesFile) a.push('--cookies', config.media.cookiesFile);
  return a;
}

function thumbFor(e) {
  if (e.thumbnail) return e.thumbnail;
  if (Array.isArray(e.thumbnails) && e.thumbnails.length) return e.thumbnails[e.thumbnails.length - 1].url;
  if (e.id && /youtube|youtu\.be/i.test(`${e.ie_key || ''} ${e.extractor || ''} ${e.url || ''}`)) {
    return `https://i.ytimg.com/vi/${e.id}/mqdefault.jpg`;
  }
  return null;
}

function entryToTrack(e, extra = {}) {
  const source = e.webpage_url || e.original_url || e.url;
  return {
    id: newTrackId(),
    kind: 'url',
    title: e.title || e.fulltitle || source || 'Unknown title',
    artist: e.uploader || e.channel || e.artist || e.creator || '',
    duration: Number.isFinite(e.duration) ? e.duration : null,
    thumbnail: thumbFor(e),
    source,
    ...extra,
  };
}

export class Resolver {
  /** Search the configured provider. Returns flat (not yet stream-resolved) tracks. */
  async search(query, count = 5) {
    query = String(query).trim();
    if (!query) throw new Error('Empty search query');
    let provider = config.media.searchProvider;
    const m = /^(yt|youtube|sc|soundcloud):\s*(.+)$/i.exec(query);
    if (m) {
      provider = /^s/i.test(m[1]) ? 'soundcloud' : 'youtube';
      query = m[2];
    }
    const prefix = provider === 'soundcloud' ? 'scsearch' : 'ytsearch';
    const out = await ytdlp([
      ...ytdlpBase(),
      '--flat-playlist',
      '-J',
      '--',
      `${prefix}${count}:${query}`,
    ]);
    const info = parseJson(out);
    const tracks = (info.entries || []).filter(Boolean).map((e) => entryToTrack(e));
    if (!tracks.length) throw new Error(`No results for "${query}"`);
    return tracks;
  }

  /** A pasted URL (single track or playlist) -> tracks. */
  async fromUrl(url) {
    const u = await assertSafeUrl(url);
    const ext = path.extname(u.pathname).toLowerCase();
    if (DIRECT_EXT.has(ext)) {
      return [
        {
          id: newTrackId(),
          kind: 'direct',
          title: safeDecode(path.basename(u.pathname)) || u.hostname,
          artist: u.hostname,
          duration: null,
          thumbnail: null,
          source: u.href,
        },
      ];
    }
    // A watch link that also carries &list=... means "this video" (as in a browser address bar), not the whole list.
    const singleVideo = u.searchParams.has('v') && u.searchParams.has('list');
    const out = await ytdlp([
      ...ytdlpBase(),
      '--flat-playlist',
      ...(singleVideo ? ['--no-playlist'] : []),
      '--playlist-end',
      String(config.media.maxPlaylistImport),
      '-f',
      'bestaudio/best',
      '-J',
      '--',
      u.href,
    ]);
    const info = parseJson(out);
    if (info._type === 'playlist' && Array.isArray(info.entries)) {
      const tracks = info.entries.filter((e) => e && (e.url || e.webpage_url)).map((e) => entryToTrack(e, { playlist: info.title }));
      if (!tracks.length) throw new Error('Playlist is empty');
      return tracks;
    }
    const t = entryToTrack(info);
    t.source = info.webpage_url || u.href;
    t._stream = this._streamFromInfo(info);
    return [t];
  }

  /** Text or URL -> tracks. Text gives the top search hit. */
  async resolveQuery(input, { count = 1 } = {}) {
    if (looksLikeUrl(input)) return this.fromUrl(input.trim());
    return this.search(input, count);
  }

  _streamFromInfo(info) {
    const f = info.requested_formats?.find((x) => x.acodec !== 'none') || info.requested_formats?.[0] || info;
    if (!f?.url) return null;
    return { url: f.url, headers: f.http_headers || info.http_headers || {}, at: Date.now() };
  }

  /** Resolve a direct, ffmpeg-readable URL for a track (stream URLs expire, so do this at play time). */
  async resolveStream(track) {
    if (track.kind === 'local') return { url: track.path, headers: {}, local: true };
    if (track.kind === 'direct') {
      await assertSafeUrl(track.source);
      return { url: track.source, headers: {} };
    }
    if (track._stream && Date.now() - track._stream.at < STREAM_TTL_MS) return track._stream;
    const u = await assertSafeUrl(track.source);
    log.info(`resolving stream for "${track.title}"`);
    const out = await ytdlp([...ytdlpBase(), '--no-playlist', '-f', 'bestaudio/best', '-J', '--', u.href]);
    const info = parseJson(out);
    const stream = this._streamFromInfo(info);
    if (!stream) throw new Error('No playable audio stream found');
    track._stream = stream;
    if (!track.duration && Number.isFinite(info.duration)) track.duration = info.duration;
    if (!track.thumbnail) track.thumbnail = thumbFor(info);
    if (!track.artist) track.artist = info.uploader || info.channel || '';
    return stream;
  }
}
