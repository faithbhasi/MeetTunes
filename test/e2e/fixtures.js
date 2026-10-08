// Test fixtures for the GUI test: a local "music site" and a fake yt-dlp that talks to it,
// so search, playlists, pasted links and streaming all run for real without internet access.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const FREQS = { 1: 330, 2: 440, 3: 550 };

/** HTTP server that serves /t1.mp3 /t2.mp3 /t3.mp3 (40 s tones) with Range support, like a real CDN. */
export async function startMusicSite(dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [i, f] of Object.entries(FREQS)) {
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=${f}:duration=40`, '-af', 'volume=6', path.join(dir, `t${i}.mp3`)]);
  }
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    const m = /^\/t([123])\.mp3$/.exec(req.url);
    if (!m) return res.writeHead(404).end();
    const file = path.join(dir, `t${m[1]}.mp3`);
    const size = fs.statSync(file).size;
    const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    if (range) {
      const start = +range[1];
      const end = range[2] ? +range[2] : size - 1;
      res.writeHead(206, { 'content-type': 'audio/mpeg', 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 });
      fs.createReadStream(file, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { 'content-type': 'audio/mpeg', 'accept-ranges': 'bytes', 'content-length': size });
      fs.createReadStream(file).pipe(res);
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, hits, close: () => new Promise((r) => (server.closeAllConnections?.(), server.close(r))) };
}

/** A yt-dlp stand-in: searches, single "video pages" and playlists all point at the local music site. */
export function writeFakeYtdlp(file, port) {
  fs.writeFileSync(
    file,
    `#!/usr/bin/env node
const a = process.argv.slice(2); const target = a[a.length - 1]; const P = ${port};
const search = /^(?:yt|sc)search(\\d+):(.*)$/s.exec(target);
const track = (i) => ({ id: 'id' + i, title: 'Track ' + i, uploader: 'Fake Artist ' + i, duration: 40, webpage_url: 'http://127.0.0.1:' + P + '/track/' + i, url: 'http://127.0.0.1:' + P + '/t' + i + '.mp3', http_headers: {} });
if (search) {
  const n = Math.min(+search[1], 3);
  console.log(JSON.stringify({ _type: 'playlist', entries: Array.from({ length: n }, (_, k) => ({ id: 'id' + (k + 1), title: 'Result ' + (k + 1) + ' for ' + search[2], uploader: 'Fake Artist ' + (k + 1), duration: 40, url: 'http://127.0.0.1:' + P + '/track/' + (k + 1) })) }));
} else if (/\\/playlist\\//.test(target)) {
  console.log(JSON.stringify({ _type: 'playlist', title: 'Fake Mix', entries: [1, 2, 3].map((i) => ({ id: 'id' + i, title: 'Mix song ' + i, uploader: 'DJ', duration: 40, url: 'http://127.0.0.1:' + P + '/track/' + i })) }));
} else if (/\\/track\\/(\\d)/.test(target)) {
  console.log(JSON.stringify(track(/\\/track\\/(\\d)/.exec(target)[1])));
} else { console.error('ERROR: Unsupported URL: ' + target); process.exit(1); }
`,
    { mode: 0o755 },
  );
}
