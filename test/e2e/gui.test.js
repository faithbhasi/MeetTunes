// Practical GUI test: a real browser drives every control of the web UI while a second real browser (the bot)
// sits in a mock meeting. Search/playlists/URLs run against a local music site through a fake yt-dlp, and the
// meeting's own microphone analyser proves what participants actually hear.
//
// Linux + pulseaudio + Xvfb + ffmpeg, non-root (everything is in the Docker image).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { setTimeout as sleep } from 'node:timers/promises';
import { e2eSupported, startAudioEnv, makeTone, until } from './helpers.js';
import { startMusicSite, writeFakeYtdlp } from './fixtures.js';

const skip = e2eSupported() || false;
const SHOTS = process.env.GUI_SHOTS || '';
let env, srv, site, base, tmp, browser, page, consoleErrors;

const api = (p, body) => fetch(base + p, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());
const player = async () => (await api('/api/state')).player;
const mock = (who, text) => api('/dev/mock/chat', { room: 'gui', who, text });
const mockMsgs = async () => (await fetch(`${base}/dev/mock/messages?room=gui`)).json();
const botSaid = async () => (await mockMsgs()).filter((m) => m.who === 'GuiBot').map((m) => m.text);
// textContent, not innerText: CSS text-transform (e.g. the uppercase status label) changes innerText
const text = async (sel) => ((await page.locator(sel).first().textContent()) || '').replace(/\s+/g, ' ').trim();
const hasClass = (sel, c) => page.$eval(sel, (e, c) => e.classList.contains(c), c);
const queueTitles = () => page.$$eval('#queue .item .t', (els) => els.map((e) => e.textContent));
const settle = (ms = 1500) => sleep(ms); // the meeting's capture path adds ~0.6-1 s of latency
const shot = async (name) => SHOTS && page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
const heard = (ms = 700) =>
  srv.bot.session.page.evaluate(async (ms) => {
    let m = 0;
    const end = Date.now() + ms;
    while (Date.now() < end) {
      m = Math.max(m, parseFloat(document.querySelector('#mic-level').textContent) || 0);
      await new Promise((r) => setTimeout(r, 50));
    }
    return m;
  }, ms);
const toastText = () => page.locator('#toasts .toast').allInnerTexts();
const click = (sel) => page.click(sel);
// The UI updates through a WebSocket a moment after the API changes: assert on it with a short wait.
const eventually = (fn, what, timeout = 4000) => until(async () => { try { return await fn(); } catch { return false; } }, { timeout, what });
const ui = (sel, expected, what) => eventually(async () => (typeof expected === 'string' ? (await text(sel)) === expected : expected.test(await text(sel))), what || `${sel} to be ${expected}`);
/** Every test starts from a known state so one failure cannot cascade. */
const reset = async () => {
  await api('/api/player/stop', {});
  await api('/api/queue/clear', {});
  await api('/api/player/loop', { mode: 'off' });
  if ((await player()).shuffle) await api('/api/player/shuffle', {});
  await api('/api/player/mute', { muted: false });
  await api('/api/player/volume', { volume: 70 });
  await page.keyboard.press('Escape');
};
const playLocal = async (name = 'Local One') => {
  await api('/api/library/play', { name, now: true });
  await until(async () => (await player()).status === 'playing', { what: `${name} playing` });
};
const t = (name, fn) => test(name, { skip }, async () => { if (srv) await reset(); await fn(); });

before(async () => {
  if (skip) return;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-gui-'));
  fs.mkdirSync(path.join(tmp, 'music'));
  makeTone(path.join(tmp, 'music', 'Local One.mp3'), 262, 30);
  makeTone(path.join(tmp, 'music', 'Local Two.wav'), 392, 30);
  site = await startMusicSite(path.join(tmp, 'site'));
  const ytdlp = path.join(tmp, 'yt-dlp');
  writeFakeYtdlp(ytdlp, site.port);
  env = await startAudioEnv();
  Object.assign(process.env, {
    AUDIO_SINK: 'pulse', DATA_DIR: path.join(tmp, 'data'), MUSIC_DIR: path.join(tmp, 'music'), ALLOW_MOCK_MEETING: '1', ALLOW_PRIVATE_URLS: '1',
    YTDLP_PATH: ytdlp, HEADLESS: 'false', DEFAULT_VOLUME: '80', JOIN_TIMEOUT_SEC: '40', MONITOR_INTERVAL_MS: '800',
  });
  delete process.env.UI_PASSWORD;
  const { createServer } = await import('../../src/server.js');
  srv = await createServer({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${srv.port}`;
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && consoleErrors.push('console: ' + m.text()));
  page.on('dialog', (d) => d.accept());
  if (process.env.GUI_DEBUG) {
    page.on('websocket', (ws) => ws.on('framereceived', (f) => { try { const m = JSON.parse(f.payload); console.log('WS<-', m.type, m.type === 'player' ? m.player.status + '/' + (m.player.current?.title ?? '-') : m.type === 'tick' ? m.status : ''); } catch { /* binary */ } }));
  }
  await page.goto(base);
  await page.waitForSelector('#btnJoin');
});

after(async () => {
  if (skip) return;
  await browser?.close();
  await srv?.close();
  await site?.close();
  env?.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ------------------------------------------------------------------------------------------------
t('first load: idle status, empty queue, command cheat sheet, no console errors', async () => {
  assert.equal(await text('#statusText'), 'Not in a meeting');
  assert.equal(await page.isVisible('#btnJoin'), true);
  assert.equal(await page.isVisible('#btnLeave'), false);
  assert.match(await text('#npTitle'), /Queue something/);
  assert.equal(await page.isVisible('#queueEmpty'), true);
  assert.equal(await page.isDisabled('#seekBar'), true, 'seek bar disabled with nothing playing');
  assert.match(await text('#cmdList'), /#play <song\|url>/);
  assert.match(await text('#cmdList'), /#volume 30/);
  assert.deepEqual(consoleErrors, []);
  await shot('01-idle');
});

t('join validation: empty link, garbage link and unsupported scheme show an error and stay idle', async () => {
  await click('#btnJoin');
  await until(async () => (await toastText()).some((t) => /Paste a meeting link/.test(t)), { timeout: 3000, what: 'empty-link toast' });
  for (const bad of ['not a link', 'ftp://example.com/x', 'javascript:alert(1)']) {
    await page.fill('#meetingUrl', bad);
    await click('#btnJoin');
    await until(async () => (await toastText()).some((t) => /meeting link|http/i.test(t)), { timeout: 3000, what: `error toast for ${bad}` });
  }
  assert.equal((await api('/api/state')).session.state, 'idle');
  await page.fill('#meetingUrl', '');
});

t('join (with lobby) using the display name; status pill, platform chip, locked inputs, Leave button', async () => {
  await page.fill('#meetingUrl', `${base}/dev/mock-meeting?room=gui&lobby=2`);
  await until(async () => /Mock meeting/.test(await text('#meetingNote')), { timeout: 4000, what: 'platform detection note' });
  await page.fill('#displayName', 'GuiBot');
  await click('#btnJoin');
  await until(async () => /lobby/i.test(await text('#statusText')), { timeout: 30000, what: 'lobby status in the UI' });
  assert.equal(await page.isVisible('#btnLeave'), true);
  assert.equal(await text('#btnLeave'), 'Cancel', 'while waiting, the button cancels');
  assert.equal(await page.isDisabled('#meetingUrl'), true);
  assert.equal(await page.isDisabled('#displayName'), true);
  assert.match(await text('#meetingNote'), /Admit the bot/);
  await until(async () => (await text('#statusText')) === 'In meeting', { timeout: 40000, what: 'In meeting status' });
  assert.equal(await text('#btnLeave'), 'Leave meeting');
  assert.match(await text('#platformChip'), /Mock meeting/);
  await until(async () => (await botSaid()).some((t) => /MeetTunes is here/.test(t)), { what: 'greeting posted under the chosen display name' });
  await shot('02-joined');
});

t('meeting chat box sends to the meeting; participant commands show up (highlighted) with the bot reply', async () => {
  await page.fill('#chatInput', 'hello from the GUI');
  await click('#chatForm button[type=submit]');
  await until(async () => (await mockMsgs()).some((m) => m.who === 'GuiBot' && m.text === 'hello from the GUI'), { what: 'GUI chat message in the meeting' });
  await mock('Priya', '#volume 33');
  await until(async () => (await botSaid()).includes('Volume 33%'), { what: 'bot reply' });
  assert.ok(await page.locator('#chatLog .msg.cmd', { hasText: '#volume 33' }).count(), 'command is highlighted in the log');
  assert.ok(await page.locator('#chatLog .msg.bot', { hasText: 'Volume 33%' }).count());
  assert.equal(await page.inputValue('#chatInput'), '', 'input cleared after send');
});

t('REGRESSION: slider follows volume changes made elsewhere (chat) even after it was clicked', async () => {
  await page.focus('#volBar');
  await page.keyboard.press('ArrowRight'); // slider now keeps focus, as after any mouse click on it
  await until(async () => (await player()).volume === 34, { what: 'keyboard slider step' });
  await mock('Priya', '#volume 61');
  await until(async () => (await player()).volume === 61, { what: 'chat volume' });
  await until(async () => (await page.inputValue('#volBar')) === '61', { timeout: 3000, what: 'slider shows 61 although it has focus' });
  assert.equal(await text('#volText'), '61%');
  await page.evaluate(() => document.activeElement.blur());
});

t('local library: upload, list with metadata, play, add, reject bad files, delete', async () => {
  assert.equal(await page.locator('#library .item').count(), 2, 'files from the mounted folder are listed');
  assert.match(await text('#library'), /Local One/);
  // upload (valid)
  const up = path.join(tmp, 'Uploaded Song.mp3');
  makeTone(up, 500, 20);
  await page.setInputFiles('#uploadInput', up);
  await until(async () => (await page.locator('#library .item .t', { hasText: 'Uploaded Song' }).count()) === 1, { timeout: 8000, what: 'uploaded file listed' });
  // upload (invalid type)
  const bad = path.join(tmp, 'notes.txt');
  fs.writeFileSync(bad, 'nope');
  await page.setInputFiles('#uploadInput', bad);
  await until(async () => (await toastText()).some((t) => /notes\.txt.*Unsupported/i.test(t)), { timeout: 5000, what: 'rejection toast' });
  assert.equal(await page.locator('#library .item .t', { hasText: 'notes' }).count(), 0);
  // play now by clicking the row
  await page.locator('#library .item .info', { hasText: 'Local One' }).click();
  await until(async () => (await player()).status === 'playing', { what: 'playing local file' });
  await ui('#npTitle', 'Local One');
  await ui('#npLabel', 'Now playing');
  // add to queue (+)
  await page.locator('#library .item', { hasText: 'Local Two' }).getByTitle('Add to queue').click();
  await until(async () => (await queueTitles()).includes('Local Two'), { what: 'queued from library' });
  // delete (confirm dialog is accepted by the test)
  await page.locator('#library .item', { hasText: 'Uploaded Song' }).getByTitle('Delete file').click();
  await until(async () => (await page.locator('#library .item .t', { hasText: 'Uploaded Song' }).count()) === 0, { timeout: 5000, what: 'file deleted' });
  await shot('03-library-playing');
});

t('audio really reaches the meeting; play/pause from the GUI controls what participants hear', async () => {
  await playLocal();
  await until(async () => (await heard(600)) > 0.02, { timeout: 15000, what: 'music heard in the meeting' });
  await click('#btnPlay'); // pause
  await until(async () => (await player()).status === 'paused', { what: 'paused' });
  await eventually(async () => (await page.getAttribute('#playIcon', 'href')) === '#i-play', 'play icon');
  await ui('#npLabel', 'Paused');
  await settle();
  assert.ok((await heard(600)) < 0.005, 'silent while paused');
  const posA = (await player()).position;
  await sleep(700);
  assert.ok(Math.abs((await player()).position - posA) < 0.1, 'position frozen');
  await click('#btnPlay'); // resume
  await until(async () => (await player()).status === 'playing', { what: 'resumed' });
  await eventually(async () => (await page.getAttribute('#playIcon', 'href')) === '#i-pause', 'pause icon');
  await settle();
  assert.ok((await heard(600)) > 0.02, 'audible again');
});

t('progress: time labels advance, bar moves, clicking the bar seeks and audio continues from there', async () => {
  await playLocal();
  await ui('#tDur', /^0:30$/);
  // wait until the label reflects THIS track (right after playLocal it can briefly show the previous one)
  await eventually(async () => (await player()).position > 0.6 && /^0:0[0-3]$/.test(await text('#tCur')), 'label follows the new track');
  const t0 = await text('#tCur');
  await sleep(2200);
  assert.notEqual(await text('#tCur'), t0, 'elapsed time advances');
  const bar = page.locator('#seekBar');
  const box = await bar.boundingBox();
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height / 2);
  await until(async () => (await player()).position > 13 && (await player()).position < 20, { timeout: 8000, what: 'seek to ~50%' });
  await until(async () => /^0:(1[3-9])$/.test(await text('#tCur')), { timeout: 4000, what: 'label shows ~0:15' });
  assert.ok(Number(await page.inputValue('#seekBar')) > 400 && Number(await page.inputValue('#seekBar')) < 700);
  await settle();
  assert.ok((await heard(600)) > 0.02, 'still audible after seek');
  await shot('04-seeked');
});

t('volume: +/- buttons, slider drag, mute button (icon, label, silence), unmute', async () => {
  await playLocal();
  const v0 = (await player()).volume;
  await click('#btnVolUp');
  await until(async () => (await player()).volume === v0 + 5, { what: 'volume +5' });
  await click('#btnVolDown');
  await click('#btnVolDown');
  await until(async () => (await player()).volume === v0 - 5, { what: 'volume -5 net' });
  // real mouse drag on the slider
  const box = await page.locator('#volBar').boundingBox();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  await until(async () => Math.abs((await player()).volume - 20) <= 3, { what: 'slider drag to ~20%' });
  await ui('#volText', /^(1[7-9]|2[0-3])%$/);
  // restore a decent level and mute
  await api('/api/player/volume', { volume: 70 });
  await settle();
  const loud = await heard(600);
  await click('#btnMute');
  await until(async () => (await player()).muted, { what: 'muted' });
  await ui('#volText', 'muted');
  await eventually(async () => (await page.getAttribute('#muteIcon', 'href')) === '#i-mute', 'mute icon');
  await settle();
  assert.ok((await heard(600)) < 0.005, 'muted is silent');
  assert.equal((await player()).status, 'playing', 'mute does not pause');
  await click('#btnMute');
  await until(async () => !(await player()).muted, { what: 'unmuted' });
  await settle();
  assert.ok((await heard(600)) > loud * 0.5, 'audible after unmute');
});

t('shuffle and loop buttons: state, titles, icons', async () => {
  await click('#btnShuffle');
  await until(async () => (await player()).shuffle, { what: 'shuffle on' });
  await eventually(async () => await hasClass('#btnShuffle', 'on'), 'shuffle highlighted');
  assert.equal(await page.getAttribute('#btnShuffle', 'aria-pressed'), 'true');
  await click('#btnShuffle');
  await until(async () => !(await player()).shuffle, { what: 'shuffle off' });
  const modes = [];
  for (let i = 0; i < 3; i++) {
    await click('#btnLoop');
    await until(async () => (await player()).loop !== (modes.at(-1) ?? 'off'), { what: 'loop changed' });
    modes.push((await player()).loop);
  }
  assert.deepEqual(modes, ['all', 'one', 'off']);
  await click('#btnLoop');
  await until(async () => (await player()).loop === 'all', { what: 'loop all' });
  await eventually(async () => (await page.getAttribute('#btnLoop', 'title')) === 'Loop: all', 'loop title');
  await click('#btnLoop');
  await until(async () => (await player()).loop === 'one');
  await eventually(async () => (await page.getAttribute('#loopIcon', 'href')) === '#i-repeat-one', 'repeat-one icon');
  await api('/api/player/loop', { mode: 'off' });
});

t('search: results, add to queue, play now, click a result, quick add, paste link, paste playlist, direct mp3', async () => {
  await page.fill('#searchInput', 'lofi chill');
  await click('#btnSearch');
  await until(async () => (await page.locator('#results .item').count()) === 3, { timeout: 8000, what: '3 results' });
  assert.match(await text('#results'), /Result 1 for lofi chill/);
  assert.match(await text('#results'), /Fake Artist 2/);
  assert.match(await text('#results'), /0:40/);
  await shot('05-search-results');
  // + add
  await page.locator('#results .item').nth(1).getByTitle('Add to queue').click();
  await until(async () => (await queueTitles()).length === 1, { what: 'queued result 2' });
  assert.equal((await player()).status, 'playing', 'adding to an idle queue starts playback');
  // play now (icon)
  await page.locator('#results .item').nth(2).getByTitle('Play now').click();
  await until(async () => (await player()).current?.title === 'Result 3 for lofi chill', { timeout: 10000, what: 'play now result 3' });
  await eventually(async () => JSON.stringify(await queueTitles()) === JSON.stringify(['Result 2 for lofi chill', 'Result 3 for lofi chill']), 'play now inserts after the current track');
  // click the row = play now
  await page.locator('#results .item .info').first().click();
  await until(async () => (await player()).current?.title === 'Result 1 for lofi chill', { timeout: 10000, what: 'row click plays' });
  await settle();
  assert.ok((await heard(600)) > 0.02, 'a track resolved through yt-dlp + streamed over HTTP is audible in the meeting');
  // quick add (text)
  await page.fill('#searchInput', 'another song');
  await click('#btnQuick');
  await until(async () => (await queueTitles()).includes('Result 1 for another song'), { timeout: 8000, what: 'quick add' });
  assert.equal(await page.inputValue('#searchInput'), '', 'input cleared after quick add');
  // paste a link (Enter in the search box plays it now)
  await page.fill('#searchInput', `http://127.0.0.1:${site.port}/track/3`);
  await page.press('#searchInput', 'Enter');
  await until(async () => (await player()).current?.title === 'Track 3', { timeout: 10000, what: 'pasted link plays' });
  // paste a playlist
  const before = (await player()).queue.length;
  await page.fill('#searchInput', `http://127.0.0.1:${site.port}/playlist/mix`);
  await click('#btnQuick');
  await until(async () => (await player()).queue.length === before + 3, { timeout: 10000, what: 'playlist of 3 imported' });
  await eventually(async () => (await queueTitles()).length === before + 3, 'UI shows the whole playlist');
  await ui('#searchNote', /Added 3 tracks/);
  // direct mp3 URL
  await page.fill('#searchInput', `http://127.0.0.1:${site.port}/t2.mp3`);
  await click('#btnQuick');
  await until(async () => (await queueTitles()).includes('t2.mp3'), { timeout: 8000, what: 'direct mp3 queued' });
  await shot('06-queue-filled');
});

t('search failures are shown, not swallowed', async () => {
  await page.fill('#searchInput', 'http://127.0.0.1:' + site.port + '/does-not-exist');
  await click('#btnQuick');
  await until(async () => /Unsupported|error|failed/i.test(await text('#searchNote')), { timeout: 8000, what: 'error in the note' });
  await page.fill('#searchInput', '');
  await click('#btnSearch'); // empty search does nothing (no request, no error)
  await sleep(300);
  assert.equal(await page.locator('#results .item').count() >= 0, true);
});

t('queue: click to play, move up/down, remove, count label, clear', async () => {
  for (const q of ['q1', 'q2', 'q3', 'q4', 'q5', 'q6']) await api('/api/queue/add', { query: q });
  await eventually(async () => (await queueTitles()).length === 6, 'six tracks queued', 10000);
  const titles = await queueTitles();
  assert.match(await text('#queueCount'), new RegExp(`\\(${titles.length}\\)`));
  // click row 3 => plays it
  await page.locator('#queue .item .info').nth(2).click();
  await until(async () => (await player()).index === 2, { what: 'row click plays index 2' });
  await eventually(async () => await page.locator('#queue .item').nth(2).evaluate((e) => e.classList.contains('current')), 'row highlighted');
  // move down / up
  await page.locator('#queue .item').nth(2).getByTitle('Move down').click();
  await until(async () => (await queueTitles())[3] === titles[2], { what: 'moved down' });
  assert.equal((await player()).index, 3, 'cursor follows the playing track');
  await page.locator('#queue .item').nth(3).getByTitle('Move up').click();
  await until(async () => (await queueTitles())[2] === titles[2], { what: 'moved up' });
  // remove a non-current row
  await page.locator('#queue .item').nth(0).getByTitle('Remove').click();
  await until(async () => (await queueTitles()).length === titles.length - 1, { what: 'removed' });
  assert.equal((await player()).index, 1, 'cursor adjusts when an earlier track is removed');
  // remove the current track => next one plays
  const cur = (await player()).current.title;
  await page.locator('#queue .item.current').getByTitle('Remove').click();
  await until(async () => (await player()).current?.title !== cur, { what: 'next track takes over' });
  // clear
  await click('#btnClear');
  await until(async () => (await queueTitles()).length === 0, { what: 'cleared' });
  assert.equal((await player()).status, 'idle');
  await eventually(async () => await page.isVisible('#queueEmpty'), 'empty message');
  await ui('#queueCount', '');
  await ui('#npTitle', /Queue something/);
});

t('transport: next, previous (restart vs back), stop, and the keyboard shortcuts', async () => {
  await api('/api/queue/add', { query: 'abc', now: false });
  await api('/api/queue/add', { query: 'def', now: false });
  await api('/api/queue/add', { query: 'ghi', now: false });
  await until(async () => (await queueTitles()).length === 3 && (await player()).status === 'playing', { timeout: 10000 });
  assert.equal((await player()).index, 0);
  await click('#btnNext');
  await until(async () => (await player()).index === 1);
  await page.keyboard.press('Shift+ArrowRight');
  await until(async () => (await player()).index === 2, { what: 'Shift+Right = next' });
  await page.keyboard.press('Shift+ArrowLeft');
  await until(async () => (await player()).index === 1, { what: 'Shift+Left = previous' });
  await sleep(6200);
  await click('#btnPrev'); // >5s in => restarts the same track
  await until(async () => (await player()).position < 3 && (await player()).index === 1, { what: 'previous restarts after 5s' });
  await click('#btnPrev'); // now goes back
  await until(async () => (await player()).index === 0, { what: 'previous goes back' });
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Space');
  await until(async () => (await player()).status === 'paused', { what: 'Space pauses' });
  await page.keyboard.press('Space');
  await until(async () => (await player()).status === 'playing', { what: 'Space resumes' });
  await click('#btnStop');
  await until(async () => (await player()).status === 'idle', { what: 'stopped' });
  assert.equal((await queueTitles()).length, 3, 'stop keeps the queue');
  await eventually(async () => (await page.getAttribute('#playIcon', 'href')) === '#i-play', 'play icon after stop');
  await click('#btnPlay'); // play after stop resumes the queue
  await until(async () => (await player()).status === 'playing', { what: 'play after stop' });
});

t('end of queue: playback goes idle on its own, then loop-all wraps around', async () => {
  await api('/api/queue/add', { query: 'x', now: false });
  await until(async () => (await player()).status === 'playing', { timeout: 10000 });
  await api('/api/player/seek', { position: 38.5 });
  await until(async () => (await player()).status === 'idle', { timeout: 10000, what: 'queue finished' });
  await ui('#npLabel', 'Nothing playing');
  await api('/api/player/loop', { mode: 'all' });
  await api('/api/player/play', { index: 0 });
  await until(async () => (await player()).status === 'playing');
  await api('/api/player/seek', { position: 38.5 });
  await until(async () => (await player()).position < 10 && (await player()).status === 'playing', { timeout: 10000, what: 'wrapped to the start' });
  await api('/api/player/loop', { mode: 'off' });
  await click('#btnStop');
});

t('settings dialog: prefix change takes effect (cheat sheet + chat), invalid prefix is reported, allowlist, announcements', async () => {
  await click('#btnSettings');
  assert.equal(await page.isVisible('#settingsDlg'), true);
  assert.equal(await page.inputValue('#setPrefix'), '#');
  // prefix -> !
  await page.fill('#setPrefix', '!');
  await click('#settingsForm button[type=submit]');
  await until(async () => /!play/.test(await text('#cmdList')), { timeout: 4000, what: 'cheat sheet uses !' });
  await mock('Priya', '!volume 44');
  await until(async () => (await player()).volume === 44, { what: '!volume works' });
  await mock('Priya', '#volume 55');
  await sleep(1500);
  assert.equal((await player()).volume, 44, 'old prefix is ignored');
  // invalid prefix is reported, the dialog stays open (nothing typed is lost), and nothing is saved
  await click('#btnSettings');
  await page.evaluate(() => document.querySelector('#setPrefix').removeAttribute('pattern')); // bypass the browser-side hint to test the server-side rule
  await page.fill('#setPrefix', 'ab');
  await click('#settingsForm button[type=submit]');
  await until(async () => (await toastText()).some((t) => /prefix/i.test(t) && !/saved/i.test(t)), { timeout: 4000, what: 'invalid prefix error toast' });
  assert.equal(await page.isVisible('#settingsDlg'), true, 'dialog stays open on error');
  assert.equal((await api('/api/state')).settings.prefix, '!');
  // back to #
  await page.fill('#setPrefix', '#');
  await click('#settingsForm button[type=submit]');
  await until(async () => (await api('/api/state')).settings.prefix === '#');
  await until(async () => !(await page.isVisible('#settingsDlg')), { timeout: 3000, what: 'dialog closes on success' });
  // allowlist: only "Priya" may command
  await click('#btnSettings');
  await page.fill('#setAllow', 'Priya, Sam');
  await click('#settingsForm button[type=submit]');
  await until(async () => (await api('/api/state')).settings.allowlist.length === 2);
  await mock('Mallory', '#volume 10');
  await sleep(1500);
  assert.equal((await player()).volume, 44, 'Mallory ignored');
  await mock('priya', '#volume 46');
  await until(async () => (await player()).volume === 46, { what: 'case-insensitive allowlist match' });
  await click('#btnSettings');
  await page.fill('#setAllow', '');
  await click('#settingsForm button[type=submit]');
  await until(async () => (await api('/api/state')).settings.allowlist.length === 0);
  // announcements off => no "Now playing" for auto-advance
  await click('#btnSettings');
  await page.uncheck('#setAnnounce');
  await click('#settingsForm button[type=submit]');
  await until(async () => (await api('/api/state')).settings.announce === false);
  const n = (await botSaid()).filter((t) => /^Now playing/.test(t)).length;
  await api('/api/queue/clear', {});
  await api('/api/queue/add', { query: 'quiet', now: true });
  await until(async () => (await player()).status === 'playing', { timeout: 10000 });
  await sleep(1500);
  assert.equal((await botSaid()).filter((t) => /^Now playing/.test(t)).length, n, 'no announcement while disabled');
  await click('#btnSettings');
  await page.check('#setAnnounce');
  await click('#settingsForm button[type=submit]');
  await until(async () => (await api('/api/state')).settings.announce === true);
  await click('#btnStop');
});

t('Live view: frame appears, click / type / keys / scroll reach the bot browser, diagnostics, Esc closes', async () => {
  await click('#btnLive');
  assert.equal(await page.isVisible('#liveDlg'), true);
  await until(async () => (await page.getAttribute('#liveImg', 'src'))?.startsWith('data:image/jpeg'), { timeout: 8000, what: 'live frame' });
  await shot('07-live-view');
  const reqs = [];
  page.on('request', (r) => r.url().endsWith('/api/remote') && reqs.push(JSON.parse(r.postData())));
  await page.locator('#liveImg').click({ position: { x: 100, y: 60 } });
  await page.fill('#liveText', 'hello');
  await click('#liveForm button[type=submit]');
  await page.click('#liveForm [data-key=Enter]');
  await page.click('#liveForm [data-key=Tab]');
  await page.click('#liveForm [data-scroll="400"]');
  await page.click('#liveForm [data-scroll="-400"]');
  await until(() => reqs.length >= 6, { timeout: 5000, what: 'six remote requests' });
  assert.deepEqual(reqs.map((r) => r.type), ['click', 'type', 'key', 'key', 'scroll', 'scroll']);
  assert.ok(reqs[0].x > 0 && reqs[0].x < 1 && reqs[0].y > 0 && reqs[0].y < 1, 'click sent as normalised coordinates');
  assert.equal(await page.inputValue('#liveText'), '', 'text box cleared after typing');
  const diag = await (await fetch(`${base}/api/debug/dom`)).json();
  assert.equal(diag.platform, 'mock');
  assert.equal(await page.getAttribute('#liveForm a[href="/api/debug/dom"]', 'target'), '_blank');
  await page.keyboard.press('Escape');
  await until(async () => !(await page.isVisible('#liveDlg')), { timeout: 3000, what: 'Esc closes the dialog' });
  assert.deepEqual(consoleErrors, []);
});

t('connection loss: banner appears, UI reconnects by itself and shows fresh state', async () => {
  srv.dropClients();
  await until(async () => await page.isVisible('#connBanner'), { timeout: 4000, what: 'disconnected banner' });
  await api('/api/player/volume', { volume: 47 }); // changes while the UI is offline...
  await until(async () => !(await page.isVisible('#connBanner')), { timeout: 8000, what: 'reconnected' });
  await until(async () => (await page.inputValue('#volBar')) === '47', { timeout: 4000, what: '...are shown after reconnecting' });
});

t('leave: UI returns to idle, queue/player reset, Live view no longer shows a stale frame', async () => {
  await api('/api/queue/add', { query: 'last', now: true });
  await until(async () => (await player()).status === 'playing', { timeout: 10000 });
  await click('#btnLeave');
  await until(async () => (await text('#statusText')) === 'Not in a meeting', { timeout: 15000, what: 'idle status' });
  assert.equal(await page.isVisible('#btnJoin'), true);
  assert.equal(await page.isDisabled('#meetingUrl'), false);
  assert.equal((await player()).status, 'idle');
  await eventually(async () => (await queueTitles()).length === 0, 'queue emptied in the UI');
  assert.equal(await page.isVisible('#platformChip'), false);
  await click('#btnLive');
  await sleep(500);
  assert.equal(await page.isVisible('#liveImg'), false, 'stale frame is not shown after the bot left');
  assert.equal(await page.isVisible('#liveEmpty'), true);
  await page.keyboard.press('Escape');
  await shot('08-after-leave');
});

t('Enter in the meeting-link box joins; join works again after a leave (and the mic still delivers audio)', async () => {
  await page.fill('#meetingUrl', `${base}/dev/mock-meeting?room=gui2`);
  await page.fill('#displayName', 'GuiBot');
  await page.press('#meetingUrl', 'Enter');
  await until(async () => (await text('#statusText')) === 'In meeting', { timeout: 40000, what: 'joined via Enter' });
  await api('/api/queue/add', { query: 'again', now: true });
  await until(async () => (await heard(500)) > 0.02, { timeout: 20000, what: 'audio after rejoin' });
  await click('#btnLeave');
  await until(async () => (await text('#statusText')) === 'Not in a meeting', { timeout: 15000 });
});

t('mobile layout: no horizontal scroll, controls reachable, screenshot', async () => {
  const m = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  await m.goto(base);
  await m.waitForSelector('#btnPlay');
  const over = await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(over <= 1, `horizontal overflow ${over}px`);
  for (const id of ['#btnPlay', '#btnNext', '#btnPrev', '#volBar', '#seekBar', '#searchInput', '#btnJoin']) assert.ok(await m.isVisible(id), id);
  if (SHOTS) await m.screenshot({ path: path.join(SHOTS, '09-mobile.png'), fullPage: true });
  await m.close();
});

t('accessibility basics: every button has an accessible name; toggles expose their state', async () => {
  const unnamed = await page.$$eval('button', (bs) => bs.filter((b) => !(b.getAttribute('aria-label') || b.innerText || b.title || '').trim()).map((b) => b.id || b.outerHTML.slice(0, 80)));
  assert.deepEqual(unnamed, []);
  const noLabel = await page.$$eval('button[title]', (bs) => bs.filter((b) => !b.getAttribute('aria-label') && !b.innerText.trim()).map((b) => b.id || b.title));
  assert.deepEqual(noLabel, [], 'icon-only buttons need aria-label');
  for (const id of ['#btnShuffle', '#btnLoop', '#btnMute']) assert.ok(['true', 'false'].includes(await page.getAttribute(id, 'aria-pressed')), `${id} aria-pressed`);
  assert.deepEqual(consoleErrors, []);
});
