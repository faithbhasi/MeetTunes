import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.ALLOW_MOCK_MEETING = '1';
const { detectPlatform, createPlatform, parseMeetingUrl } = await import('../../src/meeting/platforms/index.js');

const id = (u) => detectPlatform(u).id;

test('detects each supported platform from typical invite links', () => {
  assert.equal(id('https://us02web.zoom.us/j/84312345678?pwd=abc123'), 'zoom');
  assert.equal(id('https://acme.zoom.com/j/123456789'), 'zoom');
  assert.equal(id('https://teams.microsoft.com/l/meetup-join/19%3ameeting_xyz%40thread.v2/0?context=%7b%7d'), 'teams');
  assert.equal(id('https://teams.live.com/meet/9412345678901?p=abc'), 'teams');
  assert.equal(id('https://meet.google.com/abc-defg-hij'), 'meet');
  assert.equal(id('https://acme.webex.com/meet/jdoe'), 'webex');
  assert.equal(id('https://acme.webex.com/acme/j.php?MTID=m123'), 'webex');
  assert.equal(id('https://app.slack.com/huddle/T012AB3C4/C012AB3C4'), 'slack');
  assert.equal(id('https://whereby.com/some-room'), 'generic');
  assert.equal(id('http://localhost:3000/dev/mock-meeting?room=1'), 'mock');
});

test('does not mistake lookalike hosts for real platforms', () => {
  assert.equal(id('https://zoom.us.evil.example/j/123456789'), 'generic');
  assert.equal(id('https://notmeet.google.com.evil.io/abc'), 'generic');
  assert.equal(id('https://evilteams.microsoft.com.attacker.net/x'), 'generic');
});

test('rejects things that are not web links', () => {
  for (const bad of ['', 'zoommtg://zoom.us/join?confno=123', 'javascript:alert(1)', 'abc', 'file:///etc/passwd']) {
    assert.throws(() => parseMeetingUrl(bad), undefined, bad);
  }
});

test('Zoom links are rewritten to the browser client with the passcode kept', () => {
  const z = createPlatform('https://us02web.zoom.us/j/84312345678?pwd=abc123');
  const u = new URL(z.normalizeUrl('https://us02web.zoom.us/j/84312345678?pwd=abc123'));
  assert.equal(u.pathname, '/wc/84312345678/join');
  assert.equal(u.searchParams.get('pwd'), 'abc123');
});

test('selector overrides merge into platform defaults', async () => {
  const { Zoom } = await import('../../src/meeting/platforms/zoom.js');
  const z = new Zoom({ chat: { message: '.custom-msg' }, joinButton: ['#my-join'] });
  assert.equal(z.sel.chat.message, '.custom-msg');
  assert.ok(z.sel.chat.input.length > 0, 'unspecified chat keys keep their defaults');
  assert.deepEqual(z.sel.joinButton, ['#my-join']);
});
