import dns from 'node:dns/promises';
import net from 'node:net';
import { config } from '../config.js';

function isPrivateV4(ip) {
  const [a, b] = ip.split('.').map(Number);
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}

/** Expand any IPv6 text form (incl. "::" and a dotted tail) into its 16 bytes, or null if it isn't valid. */
function ipv6Bytes(ip) {
  let l = ip.toLowerCase().split('%')[0];
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(l);
  if (dotted) {
    const o = dotted[1].split('.').map(Number);
    if (o.some((n) => n > 255)) return null;
    l = l.slice(0, -dotted[1].length) + ((o[0] << 8) | o[1]).toString(16) + ':' + ((o[2] << 8) | o[3]).toString(16);
  }
  const halves = l.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  const out = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    const n = parseInt(g, 16);
    out.push(n >> 8, n & 255);
  }
  return out.length === 16 ? out : null;
}

export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) return isPrivateV4(ip);
  if (net.isIPv6(ip)) {
    const b = ipv6Bytes(ip);
    if (!b) return true; // can't parse: refuse
    const v4 = (i) => `${b[i]}.${b[i + 1]}.${b[i + 2]}.${b[i + 3]}`;
    const zeros = (from, to) => b.slice(from, to).every((x) => x === 0);
    if (zeros(0, 15) && b[15] <= 1) return true; // :: and ::1
    if (zeros(0, 10) && ((b[10] === 255 && b[11] === 255) || zeros(10, 12))) return isPrivateV4(v4(12)); // ::ffff:a.b.c.d and ::a.b.c.d
    if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zeros(4, 12)) return isPrivateV4(v4(12)); // NAT64 64:ff9b::/96
    if (b[0] === 0x20 && b[1] === 0x02) return isPrivateV4(v4(2)); // 6to4 2002::/16 embeds an IPv4 address
    if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0 && b[3] === 0) return true; // Teredo 2001::/32
    if (b[0] === 0xff) return true; // multicast
    if ((b[0] & 0xfe) === 0xfc) return true; // fc00::/7 unique local
    if (b[0] === 0xfe && (b[1] & 0xc0) >= 0x80) return true; // fe80::/10 link-local and fec0::/10 site-local
    return false;
  }
  return true;
}

/**
 * Meeting participants can paste links into chat, so we treat every URL as untrusted:
 * http(s) only, and the host must not resolve to a private/loopback/link-local address.
 * (Best effort - redirects performed later by yt-dlp/ffmpeg are not re-checked.)
 */
export async function assertSafeUrl(input) {
  let u;
  try {
    u = new URL(input);
  } catch {
    throw new Error('Not a valid URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Only http(s) URLs are allowed');
  if (config.media.allowPrivateUrls) return u;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) {
    throw new Error('URL points to a private address');
  }
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw new Error('URL points to a private address');
    return u;
  }
  let addrs;
  try {
    addrs = await dns.lookup(host, { all: true });
  } catch {
    throw new Error(`Cannot resolve ${host}`);
  }
  if (addrs.some((a) => isPrivateAddress(a.address))) throw new Error('URL points to a private address');
  return u;
}

export function looksLikeUrl(s) {
  return /^https?:\/\//i.test(String(s).trim());
}
