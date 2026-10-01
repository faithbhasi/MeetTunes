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

export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) return isPrivateV4(ip);
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l === '::1' || l === '::') return true;
    if (l.startsWith('fe80') || l.startsWith('fc') || l.startsWith('fd')) return true;
    const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(l);
    if (m) return isPrivateV4(m[1]);
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
