// Without a password the UI is only reachable via localhost / IP literals (DNS-rebinding guard).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-lh-'));
Object.assign(process.env, { AUDIO_SINK: 'none', DATA_DIR: path.join(tmp, 'data'), MUSIC_DIR: path.join(tmp, 'music'), ALLOWED_HOSTS: 'bot.example.org' });
delete process.env.UI_PASSWORD;
const { createServer } = await import('../../src/server.js');
let srv;
before(async () => (srv = await createServer({ port: 0, host: '127.0.0.1' })));
after(async () => {
  await srv.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const withHost = (host) => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port: srv.port, path: '/api/state', headers: { host } }, (res) => { res.resume(); resolve(res.statusCode); });
  r.on('error', reject);
  r.end();
});

test('rebinding hostnames are rejected, localhost / IPs / ALLOWED_HOSTS accepted', async () => {
  assert.equal(await withHost('evil.attacker.net'), 403);
  assert.equal(await withHost('evil.attacker.net:3000'), 403);
  assert.equal(await withHost('127.0.0.1:3000'), 200);
  assert.equal(await withHost('localhost:3000'), 200);
  assert.equal(await withHost('[::1]:3000'), 200);
  assert.equal(await withHost('bot.example.org'), 200);
});
