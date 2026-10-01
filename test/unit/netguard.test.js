import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertSafeUrl, isPrivateAddress, looksLikeUrl } from '../../src/audio/netguard.js';

test('private / loopback / link-local addresses are recognised', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.5', '172.16.0.1', '172.31.255.255', '169.254.169.254', '100.64.0.1', '::1', 'fe80::1', 'fd00::1', '::ffff:10.0.0.1', '0.0.0.0']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111']) assert.equal(isPrivateAddress(ip), false, ip);
});

test('assertSafeUrl blocks SSRF-style targets and non-http schemes', async () => {
  for (const u of ['http://localhost/x', 'http://127.0.0.1:8080/', 'http://169.254.169.254/latest/meta-data', 'http://[::1]/', 'file:///etc/passwd', 'ftp://example.com/a', 'gopher://x', 'not a url', 'http://foo.localhost/']) {
    await assert.rejects(() => assertSafeUrl(u), undefined, u);
  }
});

test('assertSafeUrl allows public IP literals', async () => {
  assert.equal((await assertSafeUrl('https://8.8.8.8/a.mp3')).hostname, '8.8.8.8');
});

test('looksLikeUrl', () => {
  assert.ok(looksLikeUrl('https://x.y'));
  assert.ok(looksLikeUrl('  http://x.y'));
  assert.ok(!looksLikeUrl('ftp://x.y'));
  assert.ok(!looksLikeUrl('rick astley'));
});
