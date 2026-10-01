import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand, canonical } from '../../src/commands/parser.js';
import { parseTime, fmtTime } from '../../src/util.js';

test('parses commands with and without arguments', () => {
  assert.deepEqual(parseCommand('#play never gonna give you up'), { name: 'play', args: 'never gonna give you up' });
  assert.deepEqual(parseCommand('  #PAUSE  '), { name: 'pause', args: '' });
  assert.deepEqual(parseCommand('#volume 30'), { name: 'volume', args: '30' });
  // only the first line is the command; the rest is chit-chat
  assert.deepEqual(parseCommand('#play https://youtu.be/x?t=1\nsecond line'), { name: 'play', args: 'https://youtu.be/x?t=1' });
  assert.deepEqual(parseCommand('#volume 20\r\nthanks!'), { name: 'volume', args: '20' });
  assert.equal(parseCommand('hello\n#play x'), null, 'a command must be the first line');
});

test('ignores ordinary chat, bare prefixes and numeric hashtags', () => {
  for (const t of ['hello #play', 'play', '#', '# play', '#1 priority', '##', '', null, undefined, 42]) {
    assert.equal(parseCommand(t), null, String(t));
  }
});

test('custom prefix', () => {
  assert.deepEqual(parseCommand('!skip', '!'), { name: 'skip', args: '' });
  assert.equal(parseCommand('#skip', '!'), null);
});

test('aliases map to canonical names', () => {
  assert.equal(canonical('skip'), 'next');
  assert.equal(canonical('prev'), 'previous');
  assert.equal(canonical('vol'), 'volume');
  assert.equal(canonical('play'), 'play');
});

test('parseTime understands mm:ss, seconds, 1m30s and relative offsets', () => {
  assert.deepEqual(parseTime('1:30'), { value: 90, relative: false });
  assert.deepEqual(parseTime('1:02:03'), { value: 3723, relative: false });
  assert.deepEqual(parseTime('45'), { value: 45, relative: false });
  assert.deepEqual(parseTime('1m30s'), { value: 90, relative: false });
  assert.deepEqual(parseTime('+30'), { value: 30, relative: true });
  assert.deepEqual(parseTime('-15'), { value: -15, relative: true });
  assert.equal(parseTime('soon'), null);
  assert.equal(parseTime(''), null);
});

test('fmtTime', () => {
  assert.equal(fmtTime(83), '1:23');
  assert.equal(fmtTime(3700), '1:01:40');
  assert.equal(fmtTime(NaN), '--:--');
});
