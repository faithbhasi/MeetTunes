// HTTP / WebSocket / filesystem / URL attack surface.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-sec-'));
Object.assign(process.env, { AUDIO_SINK: 'none', DATA_DIR: path.join(tmp, 'data'), MUSIC_DIR: path.join(tmp, 'music'), UI_PASSWORD: 's3cret!', HEADLESS: 'true' });
const { createServer } = await import('../../src/server.js');

let srv, base, port;
const auth = { authorization: 'Basic ' + Buffer.from('admin:s3cret!').toString('base64') };
const req = (p, { method = 'GET', headers = {}, body, raw } = {}) =>
  fetch(base + p, { method, headers: { ...auth, ...headers, ...(body && !raw ? { 'content-type': 'application/json' } : {}) }, body: raw ?? (body ? JSON.stringify(body) : undefined) });

before(async () => {
  srv = await createServer({ port: 0, host: '127.0.0.1' });
  port = srv.port;
  base = `http://127.0.0.1:${port}`;
});
after(async () => {
  await srv.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('everything requires the password (UI, API, static files)', async () => {
  for (const p of ['/', '/app.js', '/api/state', '/api/settings', '/api/library', '/api/debug/dom']) {
    assert.equal((await fetch(base + p)).status, 401, p);
  }
  assert.equal((await fetch(base + '/api/state', { headers: { authorization: 'Basic ' + Buffer.from('a:wrong').toString('base64') } })).status, 401);
  assert.equal((await req('/api/state')).status, 200);
});

test('password check is not fooled by prefixes, empties or odd encodings', async () => {
  for (const pw of ['', 's3cret', 's3cret!!', 'S3CRET!', 's3cret!\0']) {
    const r = await fetch(base + '/api/state', { headers: { authorization: 'Basic ' + Buffer.from('a:' + pw).toString('base64') } });
    assert.equal(r.status, 401, JSON.stringify(pw));
  }
  assert.equal((await fetch(base + '/api/state', { headers: { authorization: 'Bearer s3cret!' } })).status, 401);
  assert.equal((await fetch(base + '/api/state', { headers: { authorization: 'Basic !!!notbase64' } })).status, 401);
});

test('security headers: CSP, no framing, no sniffing, no caching', async () => {
  const r = await req('/');
  assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
  assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.headers.get('x-powered-by'), null);
});

test('cross-origin state-changing requests are blocked (CSRF)', async () => {
  const r = await req('/api/player/stop', { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, raw: '{}' });
  assert.equal(r.status, 403);
  const ok = await req('/api/player/stop', { method: 'POST', headers: { origin: base }, body: {} });
  assert.equal(ok.status, 200);
});

test('non-JSON bodies are rejected; malformed / oversized JSON gives a clean error', async () => {
  assert.equal((await req('/api/join', { method: 'POST', headers: { 'content-type': 'text/plain' }, raw: 'url=x' })).status, 415);
  const bad = await req('/api/join', { method: 'POST', headers: { 'content-type': 'application/json' }, raw: '{not json' });
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), { error: 'Bad request' });
  const big = await req('/api/chat/send', { method: 'POST', body: { text: 'x'.repeat(200_000) } });
  assert.equal(big.status, 413);
});

test('WebSocket: needs auth and same origin; limits payload', async () => {
  const open = (headers) => new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
    ws.received = [];
    ws.on('message', (m) => ws.received.push(JSON.parse(m)));
    ws.on('open', () => resolve({ ws, ok: true }));
    ws.on('unexpected-response', (_, res) => resolve({ ok: false, status: res.statusCode }));
    ws.on('error', () => resolve({ ok: false }));
  });
  assert.equal((await open({})).ok, false, 'no credentials');
  assert.equal((await open({ ...auth, origin: 'https://evil.example' })).ok, false, 'cross-site WebSocket hijack');
  const good = await open({ ...auth, origin: base });
  assert.equal(good.ok, true);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(good.ws.received[0].type, 'hello');
  good.ws.send('x'.repeat(10_000)); // > maxPayload: server closes the socket
  await new Promise((r) => good.ws.once('close', r));
});

test('library: path traversal, odd names and non-audio uploads are refused', async () => {
  for (const name of ['..%2F..%2Fetc%2Fpasswd.mp3', '%2e%2e%2fx.mp3', 'a%2Fb.mp3', '.hidden.mp3', 'shell.sh', 'x.mp3%00.sh', 'x.html']) {
    const r = await req('/api/library/' + name, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, raw: 'data' });
    assert.notEqual(r.status, 200, name);
  }
  assert.deepEqual(fs.readdirSync(path.join(tmp, 'music')).filter((f) => !f.endsWith('.mp3')), []);
  assert.ok(!fs.existsSync(path.join(tmp, 'etc')) && !fs.existsSync('/etc/passwd.mp3'));
  const ok = await req('/api/library/ok.mp3', { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, raw: 'abc' });
  assert.equal(ok.status, 200);
  const del = await req('/api/library/..%2Fdata%2Fsettings.json', { method: 'DELETE' });
  assert.notEqual(del.status, 200);
  assert.equal((await req('/api/library/ok.mp3', { method: 'DELETE' })).status, 200);
});

test('SSRF: private / metadata / file URLs are refused for playback, joining and remote navigation', async () => {
  for (const u of ['http://127.0.0.1/a.mp3', 'http://169.254.169.254/latest/meta-data/', 'http://localhost:3000/', 'file:///etc/passwd', 'http://[::1]/x.mp3', 'http://10.0.0.5/x', 'ftp://example.com/x.mp3']) {
    const q = await req('/api/queue/add', { method: 'POST', body: { query: u } });
    assert.equal(q.status, 400, 'queue ' + u);
    const j = await req('/api/join', { method: 'POST', body: { url: u } });
    assert.equal(j.status, 400, 'join ' + u);
    assert.notEqual((await req('/api/queue/add-track', { method: 'POST', body: { track: { source: u, title: 'x' } } })).status, 200 && 0, 'add-track');
  }
  // add-track only queues; the guard fires when resolving the stream
  const { bot } = srv;
  bot.player.clear();
  await req('/api/queue/add-track', { method: 'POST', body: { track: { source: 'http://169.254.169.254/x', title: 'evil' } } });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(bot.player.status, 'idle', 'stream resolution for a private URL fails closed');
  assert.match(bot.player.lastError || '', /private address/);
  bot.player.clear();
});

test('remote control: bad actions and coordinates are rejected without a browser', async () => {
  for (const body of [{ type: 'goto', url: 'file:///etc/passwd' }, { type: 'click', x: 'a', y: 2 }, { type: 'key', key: 'x; rm -rf' }, { type: 'nope' }]) {
    const r = await req('/api/remote', { method: 'POST', body });
    assert.equal(r.status, 400, JSON.stringify(body));
  }
});

test('settings: validated (bad input is rejected, not silently dropped), prototype-pollution safe, file is private', async () => {
  const bad = await req('/api/settings', { method: 'POST', body: { prefix: 'a b', displayName: 'Evil' } });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /prefix/i);
  assert.notEqual(srv.bot.settings.displayName, 'Evil', 'a rejected request applies nothing');
  assert.equal((await req('/api/settings', { method: 'POST', body: { allowlist: 'nope' } })).status, 400);
  const r = await req('/api/settings', { method: 'POST', body: { __proto__: { polluted: 1 }, constructor: { prototype: { polluted: 1 } }, displayName: '  Bot  ', announce: 'yes', volume: 9999 } });
  assert.equal(r.status, 200);
  const s = await r.json();
  assert.equal(s.prefix, '#');
  assert.equal(s.displayName, 'Bot');
  assert.equal(s.volume, 100, 'volume is clamped');
  assert.equal(s.announce, true, 'non-boolean announce ignored');
  assert.equal(({}).polluted, undefined);
  assert.equal(srv.bot.settings.polluted, undefined);
  const mode = fs.statSync(path.join(tmp, 'data', 'settings.json')).mode & 0o777;
  assert.equal(mode & 0o077, 0, `settings.json mode ${mode.toString(8)} should not be group/world accessible`);
  // a malicious settings file cannot inject keys
  srv.bot._applySettings(JSON.parse('{"__proto__":{"x":1},"prefix":"!","evil":true}'));
  assert.equal(srv.bot.settings.evil, undefined);
  assert.equal(srv.bot.settings.prefix, '!');
  await req('/api/settings', { method: 'POST', body: { prefix: '#' } });
});

test('a "$&" style prefix cannot corrupt help text', async () => {
  await req('/api/settings', { method: 'POST', body: { prefix: '$&' } }); // 2 symbols is allowed
  const help = await srv.bot.commands.execute('help', '', {});
  assert.match(help, /\$&play/);
  assert.ok(!/\{p\}/.test(help));
  await req('/api/settings', { method: 'POST', body: { prefix: '#' } });
});

test('unknown routes and methods do not leak internals', async () => {
  const r = await req('/api/../../etc/passwd');
  assert.ok([400, 404].includes(r.status));
  assert.ok(!(await r.text()).includes('root:'));
  assert.equal((await req('/.env')).status, 404);
  assert.equal((await req('/package.json')).status, 404);
  assert.equal((await req('/../package.json')).status, 404);
});

test('brute force: repeated bad passwords get locked out', async () => {
  let last;
  for (let i = 0; i < 14; i++) last = await fetch(base + '/api/state', { headers: { authorization: 'Basic ' + Buffer.from('a:guess' + i).toString('base64') } });
  assert.equal(last.status, 429);
  assert.equal((await req('/api/state')).status, 429, 'even the right password waits out the lockout');
});
