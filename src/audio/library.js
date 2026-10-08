import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { config } from '../config.js';
import { getLog } from '../log.js';
import { run, newTrackId } from './resolver.js';

const log = getLog('library');
export const AUDIO_EXT = new Set(['.mp3', '.wav', '.flac', '.ogg', '.oga', '.opus', '.m4a', '.aac', '.wma', '.webm', '.mka']);
const MAX_UPLOAD = 300 * 1024 * 1024;

/** Local music folder (mount a volume at /music). */
export class Library {
  constructor(dir = config.musicDir) {
    this.dir = dir;
    this.meta = new Map(); // filename -> {mtimeMs, title, artist, duration}
  }

  async init() {
    await fsp.mkdir(this.dir, { recursive: true });
  }

  /** Resolve a bare filename inside the library; rejects anything that escapes it. */
  pathFor(name) {
    const base = path.basename(String(name));
    if (!base || base !== name || base.startsWith('.')) throw new Error('Invalid file name');
    if (!AUDIO_EXT.has(path.extname(base).toLowerCase())) throw new Error('Unsupported audio type');
    return path.join(this.dir, base);
  }

  async list() {
    let names = [];
    try {
      names = await fsp.readdir(this.dir);
    } catch {
      return [];
    }
    const files = [];
    for (const name of names.sort((a, b) => a.localeCompare(b))) {
      if (name.startsWith('.') || !AUDIO_EXT.has(path.extname(name).toLowerCase())) continue;
      const full = path.join(this.dir, name);
      try {
        const st = await fsp.stat(full);
        if (st.isFile()) files.push({ name, full, st });
      } catch {
        /* vanished */
      }
    }
    // ffprobe is slow on first sight of a file: do a few at a time instead of one by one.
    const items = new Array(files.length);
    let next = 0;
    const worker = async () => {
      while (next < files.length) {
        const i = next++;
        const { name, full, st } = files[i];
        items[i] = { name, size: st.size, ...(await this._probe(name, full, st)) };
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, files.length) }, worker));
    return items;
  }

  async _probe(name, full, st) {
    const cached = this.meta.get(name);
    if (cached && cached.mtimeMs === st.mtimeMs) return cached.data;
    let data = { title: path.basename(name, path.extname(name)), artist: '', duration: null };
    try {
      const out = await run(
        'ffprobe',
        ['-v', 'error', '-show_entries', 'format=duration:format_tags=title,artist', '-of', 'json', full],
        { timeoutMs: 10000 },
      );
      const f = JSON.parse(out).format || {};
      const tags = Object.fromEntries(Object.entries(f.tags || {}).map(([k, v]) => [k.toLowerCase(), v]));
      data = {
        title: tags.title || data.title,
        artist: tags.artist || '',
        duration: f.duration ? parseFloat(f.duration) : null,
      };
    } catch (e) {
      log.debug?.(`ffprobe ${name}: ${e.message}`);
    }
    this.meta.set(name, { mtimeMs: st.mtimeMs, data });
    return data;
  }

  toTrack(item) {
    return {
      id: newTrackId(),
      kind: 'local',
      title: item.title,
      artist: item.artist,
      duration: item.duration,
      thumbnail: null,
      source: `local:${item.name}`,
      path: this.pathFor(item.name),
    };
  }

  async find(query) {
    const q = String(query).toLowerCase().trim();
    const items = await this.list();
    if (!q) return items;
    const words = q.split(/\s+/);
    return items.filter((i) => {
      const hay = `${i.name} ${i.title} ${i.artist}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }

  async save(name, readable) {
    const target = this.pathFor(name);
    let size = 0;
    const tmp = `${target}.part`;
    const counter = async function* (src) {
      for await (const chunk of src) {
        size += chunk.length;
        if (size > MAX_UPLOAD) throw new Error('File too large');
        yield chunk;
      }
    };
    try {
      await pipeline(readable, counter, fs.createWriteStream(tmp));
      await fsp.rename(tmp, target);
    } catch (e) {
      await fsp.rm(tmp, { force: true });
      throw e;
    }
    this.meta.delete(path.basename(target));
    return path.basename(target);
  }

  async remove(name) {
    await fsp.rm(this.pathFor(name), { force: true });
    this.meta.delete(name);
  }
}
