// The web UI renders attacker-controlled strings (chat sender/text, track titles, file names): no script may run.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { setTimeout as sleep } from 'node:timers/promises';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-ui-'));
Object.assign(process.env, { AUDIO_SINK: 'none', DATA_DIR: path.join(tmp, 'data'), MUSIC_DIR: path.join(tmp, 'music') });
delete process.env.UI_PASSWORD;
const { createServer } = await import('../../src/server.js');
let srv, browser, skip = false;
before(async () => {
  srv = await createServer({ port: 0, host: '127.0.0.1' });
  try { browser = await chromium.launch({ args: ['--no-sandbox'] }); } catch (e) { skip = 'no chromium'; }
});
after(async () => {
  await browser?.close();
  await srv.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const EVIL = '<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>"><svg onload="window.__xss=3">';

test('XSS: hostile chat, track and file names render as text and execute nothing', { skip }, async () => {
  fs.mkdirSync(path.join(tmp, 'music'), { recursive: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => { errors.push('dialog: ' + d.message()); d.dismiss(); });
  await page.goto(`http://127.0.0.1:${srv.port}/`);
  await sleep(500);
  const bot = srv.bot;
  bot._chatEntry({ kind: 'chat', sender: EVIL, text: EVIL });
  bot._chatEntry({ kind: 'system', sender: 'x', text: EVIL });
  bot.player.queue = [{ id: '1', kind: 'url', title: EVIL, artist: EVIL, duration: 5, thumbnail: 'https://x.test/a.png");}body{display:none', source: 'https://x.test/', requestedBy: EVIL }];
  bot.player.index = 0;
  bot.player.status = 'paused';
  bot.player._changed();
  fs.writeFileSync(path.join(tmp, 'music', 'a<img src=x onerror=window.__xss=4>.mp3'), 'x');
  await page.evaluate(() => document.querySelector('#btnSettings')); // keep page alive
  await sleep(1200);
  assert.equal(await page.evaluate(() => window.__xss), undefined);
  assert.deepEqual(errors, []);
  const html = await page.evaluate(() => document.querySelector('#chatLog').innerHTML);
  assert.ok(!/<img|<script|<svg/i.test(html.replace(/&lt;/g, '')), 'markup is escaped in the chat log');
  assert.ok(await page.evaluate(() => document.body.offsetHeight > 100), 'a hostile thumbnail URL cannot inject CSS that hides the page');
  await page.close();
});

test('UI loads with no console errors and the key controls exist', { skip }, async () => {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(`http://127.0.0.1:${srv.port}/`);
  await sleep(800);
  for (const id of ['#meetingUrl', '#displayName', '#btnJoin', '#btnPlay', '#btnNext', '#btnPrev', '#btnMute', '#volBar', '#seekBar', '#btnVolUp', '#btnVolDown', '#searchInput', '#chatInput']) {
    assert.ok(await page.$(id), id);
  }
  assert.deepEqual(errors, []);
  await page.close();
});
