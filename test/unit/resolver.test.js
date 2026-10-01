import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A fake yt-dlp so these tests need neither network nor the real binary.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-ytdlp-'));
const shim = path.join(dir, 'yt-dlp');
fs.writeFileSync(shim, `#!/usr/bin/env node
const a = process.argv.slice(2);
require('fs').appendFileSync(${JSON.stringify(path.join(dir, 'calls.log'))}, JSON.stringify(a) + '\\n');
const target = a[a.length - 1];
if (/^ytsearch|^scsearch/.test(target)) {
  const n = +/search(\\d+):/.exec(target)[1];
  console.log(JSON.stringify({ _type: 'playlist', entries: Array.from({ length: n }, (_, i) => ({ id: 'id' + i, title: 'Result ' + (i + 1) + ' for ' + target.split(':')[1], uploader: 'Chan', duration: 100 + i, url: 'https://www.youtube.com/watch?v=id' + i, ie_key: 'Youtube' })) }));
} else if (target.includes('playlist')) {
  console.log(JSON.stringify({ _type: 'playlist', title: 'My List', entries: [{ id: 'a', title: 'A', url: 'https://example.org/a' }, { id: 'b', title: 'B', url: 'https://example.org/b' }] }));
} else if (target.includes('fail')) { console.error('ERROR: Video unavailable'); process.exit(1); }
else console.log(JSON.stringify({ title: 'Single', uploader: 'Me', duration: 42, webpage_url: target, url: 'https://cdn.example.org/audio.m4a', http_headers: { 'User-Agent': 'x' }, thumbnail: 'https://i.example.org/t.jpg' }));
`, { mode: 0o755 });
process.env.YTDLP_PATH = shim;
process.env.ALLOW_PRIVATE_URLS = '1'; // the guard has its own test; here example.org need not resolve

let Resolver;
before(async () => {
  ({ Resolver } = await import('../../src/audio/resolver.js'));
});
const calls = () => fs.readFileSync(path.join(dir, 'calls.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('search returns tracks and passes the query after "--" (no option injection)', async () => {
  const r = new Resolver();
  const tracks = await r.search('--exec rm -rf / evil', 3);
  assert.equal(tracks.length, 3);
  assert.equal(tracks[0].kind, 'url');
  assert.match(tracks[0].thumbnail, /ytimg/);
  const last = calls().at(-1);
  const i = last.indexOf('--');
  assert.ok(i > 0 && last[i + 1] === 'ytsearch3:--exec rm -rf / evil', JSON.stringify(last));
});

test('"sc:" prefix switches to SoundCloud search', async () => {
  const r = new Resolver();
  await r.search('sc: lofi beats', 1);
  assert.equal(calls().at(-1).at(-1), 'scsearch1:lofi beats');
});

test('URL -> single track with a pre-resolved stream; playlist -> many tracks', async () => {
  const r = new Resolver();
  const [t] = await r.resolveQuery('https://example.org/watch?v=1');
  assert.equal(t.title, 'Single');
  assert.equal(t._stream.url, 'https://cdn.example.org/audio.m4a');
  assert.equal((await r.resolveStream(t)).headers['User-Agent'], 'x');
  const pl = await r.resolveQuery('https://example.org/playlist?list=1');
  assert.deepEqual(pl.map((x) => x.title), ['A', 'B']);
  assert.equal(pl[0].playlist, 'My List');
});

test('direct audio links skip yt-dlp; stream resolution happens lazily at play time', async () => {
  const r = new Resolver();
  const before = calls().length;
  const [t] = await r.resolveQuery('https://example.org/dir/song%20one.mp3');
  assert.equal(t.kind, 'direct');
  assert.equal(t.title, 'song one.mp3');
  assert.equal(calls().length, before);
  const s = await r.resolveStream({ id: 'x', kind: 'url', title: 'lazy', source: 'https://example.org/video' });
  assert.equal(s.url, 'https://cdn.example.org/audio.m4a');
});

test('yt-dlp failures surface a readable message', async () => {
  const r = new Resolver();
  await assert.rejects(() => r.resolveQuery('https://example.org/fail'), /Video unavailable/);
});

test('rejects non-http URLs for playback', async () => {
  const r = new Resolver();
  await assert.rejects(() => r.fromUrl('file:///etc/passwd'), /http/i);
});
