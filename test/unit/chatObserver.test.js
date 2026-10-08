import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { setTimeout as sleep } from 'node:timers/promises';
import { observerInitScript } from '../../src/meeting/chatObserver.js';

let browser;
let skip = false;
before(async () => {
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  } catch (e) {
    skip = `no chromium: ${e.message.split('\n')[0]}`;
  }
});
after(() => browser?.close());

/** A page with a chat list, an observer configured with `spec`, and a collector for reported messages. */
async function mkPage(spec, html) {
  const page = await browser.newPage();
  const got = [];
  await page.exposeFunction('__mtChat', (j) => got.push(JSON.parse(j)));
  await page.addInitScript(observerInitScript({ prefix: '#', ...spec }));
  // init scripts only run on navigations, so load the document through one (setContent would skip them)
  await page.goto('data:text/html,' + encodeURIComponent(`<body><div id="list">${html}</div><textarea id="in"></textarea></body>`));
  return { page, got };
}
const add = (page, html) => page.evaluate((h) => document.querySelector('#list').insertAdjacentHTML('beforeend', h), html);
const arm = (page) => page.evaluate(() => window.__mtArm());

const SPEC = { message: '.msg', sender: '.who', text: '.body', time: '.ts', idAttr: '' };
const msg = (who, text, ts = '10:00') => `<div class="msg"><span class="who">${who}</span><span class="body">${text}</span><span class="ts">${ts}</span></div>`;

test('reports only new messages, with sender, and ignores history at arm time', { skip }, async () => {
  const { page, got } = await mkPage(SPEC, msg('Old', '#play old song'));
  await arm(page);
  await add(page, msg('Alice', '#play new song'));
  await sleep(400);
  assert.deepEqual(got.map((m) => [m.sender, m.text]), [['Alice', '#play new song']]);
  await page.close();
});

test('the same command repeated is reported each time; re-rendering history is not', { skip }, async () => {
  const { page, got } = await mkPage(SPEC, '');
  await arm(page);
  await add(page, msg('Bob', '#next'));
  await sleep(300);
  await add(page, msg('Bob', '#next')); // identical sender/text/time: a real second command
  await sleep(300);
  assert.equal(got.length, 2);
  // virtualised list re-renders the same two nodes
  await page.evaluate(() => { const l = document.querySelector('#list'); l.innerHTML = l.innerHTML; });
  await sleep(1800);
  assert.equal(got.length, 2, 're-rendered nodes are not new messages');
  await page.close();
});

test('grouped messages: sender header shared by consecutive bodies', { skip }, async () => {
  const spec = { message: '.line', sender: '.hdr', text: '.line', time: '', idAttr: '' };
  const { page, got } = await mkPage(spec, '<div class="hdr">Zed</div><div class="line">#old history</div>');
  await arm(page);
  await add(page, '<div class="hdr">Carol</div><div class="line">#pause</div><div class="line">#resume</div><div class="hdr">Dan</div><div class="line">#volume 10</div>');
  await sleep(400);
  assert.deepEqual(got.map((m) => `${m.sender}:${m.text}`), ['Carol:#pause', 'Carol:#resume', 'Dan:#volume 10']);
  await page.close();
});

test('message ids dedupe even if text/time change (edits, reactions)', { skip }, async () => {
  const spec = { ...SPEC, idAttr: 'data-id' };
  const { page, got } = await mkPage(spec, '');
  await arm(page);
  await add(page, '<div class="msg" data-id="m1"><span class="who">Eve</span><span class="body">#play x</span></div>');
  await sleep(300);
  await page.evaluate(() => (document.querySelector('.body').textContent = '#play x (edited)'));
  await sleep(1800);
  assert.equal(got.length, 1);
  await page.close();
});

test('generic fallback finds prefixed text when the platform selector matches nothing', { skip }, async () => {
  const { page, got } = await mkPage({ ...SPEC, message: '.does-not-exist' }, '<p>welcome</p><p>#play stale history</p>');
  await arm(page);
  await add(page, '<p>hello everyone</p><p>#play fallback works</p><p>#volume 20</p>');
  await sleep(1900);
  assert.deepEqual(got.map((m) => m.text), ['#play fallback works', '#volume 20']);
  assert.equal(got[0].mode, 'generic');
  await page.close();
});

test('generic fallback ignores text being typed into the chat input', { skip }, async () => {
  const { page, got } = await mkPage({ ...SPEC, message: '.nope' }, '');
  await page.evaluate(() => (document.body.innerHTML = '<div contenteditable="true" id="ce"></div>'));
  await page.evaluate(() => (document.querySelector('#ce').textContent = '#play half typed'));
  await sleep(1900);
  assert.equal(got.length, 0);
  await page.close();
});

test('changing the prefix at runtime takes effect', { skip }, async () => {
  const { page, got } = await mkPage({ ...SPEC, message: '.nope' }, '');
  await arm(page);
  await page.evaluate(() => window.__mtSetPrefix('!'));
  await add(page, '<p>#play ignored now</p><p>!play yes</p>');
  await sleep(1900);
  assert.deepEqual(got.map((m) => m.text), ['!play yes']);
  await page.close();
});

test('REGRESSION: first user command in an empty chat is not swallowed when other messages arrive in the same scan', { skip }, async () => {
  const { page, got } = await mkPage(SPEC, '');
  await arm(page);
  // the bot's own greeting and the first command land together
  await add(page, msg('MeetTunes', 'MeetTunes is here! Type #help for commands') + msg('Alice', '#play first song'));
  await sleep(500);
  assert.ok(got.some((m) => m.text === '#play first song' && m.sender === 'Alice'), JSON.stringify(got));
  await page.close();
});

test('selector-owned messages are not double-reported by the generic scan', { skip }, async () => {
  const { page, got } = await mkPage(SPEC, '');
  await arm(page);
  await add(page, msg('Alice', '#pause'));
  await sleep(1900);
  assert.equal(got.filter((m) => m.text === '#pause').length, 1);
  await page.close();
});

test('rebaseline treats whatever is on screen as history', { skip }, async () => {
  const { page, got } = await mkPage(SPEC, '');
  await arm(page);
  await add(page, msg('Old', '#play old one') );
  await page.evaluate(() => window.__mtRebaseline());
  await sleep(300);
  await add(page, msg('New', '#play new one'));
  await sleep(500);
  assert.deepEqual(got.map((m) => m.text).filter((t) => /one$/.test(t)), ['#play new one']);
  await page.close();
});
