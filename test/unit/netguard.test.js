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

test('IPv4 hidden inside IPv6 (mapped, NAT64, 6to4, compat) cannot reach private hosts', async () => {
  // The URL parser rewrites [::ffff:127.0.0.1] to [::ffff:7f00:1]; both spellings must be refused.
  for (const u of ['http://[::ffff:127.0.0.1]/', 'http://[::ffff:7f00:1]/', 'http://[::ffff:169.254.169.254]/', 'http://[::ffff:c0a8:101]/', 'http://[64:ff9b::7f00:1]/', 'http://[2002:7f00:1::]/', 'http://[::127.0.0.1]/', 'http://[fec0::1]/', 'http://[ff02::1]/', 'http://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/']) {
    await assert.rejects(() => assertSafeUrl(u), /private/, u);
  }
});

test('public IPv6 addresses (and IPv4 embedded in them) are still allowed', () => {
  for (const ip of ['2001:4860:4860::8888', '2606:4700:4700::1111', '::ffff:8.8.8.8', '::ffff:808:808', '64:ff9b::808:808', '2002:808:808::1']) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
  for (const ip of ['::', '::1', '::ffff:0:1', 'fe80::1%eth0', 'febf::1', 'fc00::1', 'fdff::1', 'not-an-ip']) assert.equal(isPrivateAddress(ip), true, ip);
});
