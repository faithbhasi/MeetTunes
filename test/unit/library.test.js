import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { Library } from '../../src/audio/library.js';

const mk = async () => {
  const lib = new Library(fs.mkdtempSync(path.join(os.tmpdir(), 'mt-lib-')));
  await lib.init();
  return lib;
};

test('rejects path traversal and non-audio names', async () => {
  const lib = await mk();
  for (const n of ['../evil.mp3', '/etc/passwd.mp3', 'a/b.mp3', '..', '.hidden.mp3', 'notes.txt', 'x.sh', '']) {
    assert.throws(() => lib.pathFor(n), /Invalid|Unsupported/, n);
  }
  assert.equal(path.dirname(lib.pathFor('ok.mp3')), lib.dir);
});

test('upload, list, find, delete', async () => {
  const lib = await mk();
  assert.equal(await lib.save('Daft Punk - One More Time.mp3', Readable.from([Buffer.from('fake')])), 'Daft Punk - One More Time.mp3');
  await lib.save('other.wav', Readable.from([Buffer.from('x')]));
  const all = await lib.list();
  assert.deepEqual(all.map((f) => f.name), ['Daft Punk - One More Time.mp3', 'other.wav']);
  assert.equal((await lib.find('one more')).length, 1);
  assert.equal((await lib.find('daft time')).length, 1, 'all words must match, any order');
  assert.equal((await lib.find('nope')).length, 0);
  const t = lib.toTrack(all[0]);
  assert.equal(t.kind, 'local');
  assert.ok(t.path.startsWith(lib.dir));
  await lib.remove('other.wav');
  assert.equal((await lib.list()).length, 1);
});

test('failed upload leaves no partial file', async () => {
  const lib = await mk();
  const bad = new Readable({ read() { this.destroy(new Error('connection lost')); } });
  await assert.rejects(() => lib.save('half.mp3', bad), /connection lost/);
  assert.deepEqual(fs.readdirSync(lib.dir), []);
});
