import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { config } from './config.js';
import { getLog, logger } from './log.js';
import { MeetTunes } from './bot.js';
import { platformList, detectPlatform } from './meeting/platforms/index.js';
import { assertSafeUrl } from './audio/netguard.js';
import { mockMeetingRouter } from './dev/mockMeeting.js';

const log = getLog('server');
const here = path.dirname(fileURLToPath(import.meta.url));

const safeEqual = (a, b) => {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
};

function authorized(req) {
  if (!config.uiPassword) return true;
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const pass = Buffer.from(h.slice(6), 'base64').toString().split(':').slice(1).join(':');
  return safeEqual(pass, config.uiPassword);
}

/** Brute-force guard for the UI password: 10 failures per 5 minutes per address. */
const failures = new Map();
function authBlocked(req) {
  const ip = req.socket.remoteAddress || '?';
  const f = failures.get(ip);
  return !!f && f.until > Date.now() && f.count >= 10;
}
function authFailed(req) {
  const ip = req.socket.remoteAddress || '?';
  const now = Date.now();
  const f = failures.get(ip);
  if (!f || f.until < now) failures.set(ip, { count: 1, until: now + 5 * 60 * 1000 });
  else f.count++;
  if (failures.size > 1000) for (const [k, v] of failures) if (v.until < now) failures.delete(k);
}

/**
 * DNS-rebinding guard. Without a password, a web page on the internet could resolve its own hostname to
 * 127.0.0.1 and drive the bot from the victim's browser; only accept localhost / IP literals / ALLOWED_HOSTS.
 * (With a password the attacker's origin has no credentials, so any Host is fine - e.g. behind a reverse proxy.)
 */
function hostAllowed(req) {
  if (config.uiPassword) return true;
  const host = (req.headers.host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || net.isIP(host) > 0 || config.allowedHosts.includes(host);
}

const CSP = "default-src 'self'; img-src 'self' https: data:; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

/** Same-origin check: stops other web pages from driving a bot that lives on localhost. */
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

export async function createServer({ bot, port = config.port, host = config.host } = {}) {
  bot = bot || new MeetTunes();
  await bot.init();

  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Cache-Control': 'no-store',
    });
    if (!req.path.startsWith('/dev')) {
      // /dev = test-only mock meeting (inline scripts, iframes). Everything else is locked down; Live view lets
      // you click inside the bot's browser, so the UI must never be frameable (clickjacking).
      res.set({ 'Content-Security-Policy': CSP, 'X-Frame-Options': 'DENY' });
    }
    if (!hostAllowed(req)) return res.status(403).send('Host not allowed (set ALLOWED_HOSTS or UI_PASSWORD)');
    if (authBlocked(req)) return res.status(429).send('Too many failed attempts - try again later');
    if (!authorized(req)) {
      if (req.headers.authorization) authFailed(req); // the browser's first, credential-less request is not an attack
      res.set('WWW-Authenticate', 'Basic realm="MeetTunes"');
      return res.status(401).send('Authentication required');
    }
    if (req.method !== 'GET' && req.method !== 'HEAD' && !sameOrigin(req)) return res.status(403).json({ error: 'Cross-origin request blocked' });
    next();
  });
  app.use(express.static(path.join(here, 'public')));
  if (config.browser.allowMockMeeting) app.use('/dev', mockMeetingRouter());

  const api = express.Router();
  const json = express.json({ limit: '64kb' });
  api.use((req, res, next) => (req.is('application/octet-stream') ? next() : json(req, res, next)));
  api.use((req, res, next) => {
    if (req.method !== 'GET' && !req.is('application/json') && !req.is('application/octet-stream') && req.headers['content-length'] > 0) {
      return res.status(415).json({ error: 'Content-Type must be application/json' });
    }
    if (req.body === undefined || req.body === null || typeof req.body !== 'object') req.body = {};
    next();
  });

  const wrap = (fn) => async (req, res) => {
    try {
      const out = await fn(req, res);
      if (!res.headersSent) res.json(out ?? { ok: true });
    } catch (e) {
      log.warn(`${req.method} ${req.path}: ${e.message}`);
      if (!res.headersSent) res.status(400).json({ error: e.message });
    }
  };
  const P = bot.player;
  const num = (v, name) => {
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
    return n;
  };

  api.get('/state', wrap(() => ({ ...bot.snapshot(), platforms: platformList(), chat: bot.chatLog.slice(-100), log: logger.ring.slice(-60) })));

  // meeting
  api.post('/detect', wrap((req) => {
    const P2 = detectPlatform(req.body.url);
    return { id: P2.id, label: P2.label, experimental: P2.experimental };
  }));
  api.post('/join', wrap(async (req) => {
    if (typeof req.body.url !== 'string' || !req.body.url) throw new Error('Paste a meeting link first');
    const plat = detectPlatform(req.body.url); // validate early so the user gets an immediate error
    if (plat.id !== 'mock') await assertSafeUrl(req.body.url);
    if (bot.session.active) throw new Error('Already in (or joining) a meeting');
    await bot.join(req.body.url, req.body.displayName);
  }));
  api.post('/leave', wrap(() => bot.leave('Left from the web UI')));
  api.post('/chat/send', wrap((req) => {
    if (bot.session.state !== 'joined') throw new Error('Not in a meeting');
    bot.sendToMeeting(String(req.body.text || '').slice(0, 1000));
  }));
  api.post('/remote', wrap((req) => bot.session.remote(req.body)));
  api.get('/debug/dom', wrap(() => bot.session.diagnostics()));

  // player transport
  api.post('/player/play', wrap((req) => (req.body.index !== undefined ? P.play(num(req.body.index, 'index')) : P.resume())));
  api.post('/player/pause', wrap(() => P.pause()));
  api.post('/player/resume', wrap(() => P.resume()));
  api.post('/player/toggle', wrap(() => P.togglePause()));
  api.post('/player/stop', wrap(() => P.stop()));
  api.post('/player/next', wrap(() => P.next()));
  api.post('/player/previous', wrap(() => P.previous()));
  api.post('/player/seek', wrap((req) => P.seek(num(req.body.position, 'position'))));
  api.post('/player/volume', wrap((req) => ({ volume: req.body.delta !== undefined ? P.adjustVolume(num(req.body.delta, 'delta')) : P.setVolume(num(req.body.volume, 'volume')) })));
  api.post('/player/mute', wrap((req) => ({ muted: typeof req.body.muted === 'boolean' ? P.setMuted(req.body.muted) : P.toggleMute() })));
  api.post('/player/loop', wrap((req) => (req.body.mode ? P.setLoop(req.body.mode) : P.cycleLoop())));
  api.post('/player/shuffle', wrap((req) => P.setShuffle(typeof req.body.on === 'boolean' ? req.body.on : !P.shuffle)));

  // queue
  api.post('/queue/remove', wrap((req) => P.remove(num(req.body.index, 'index'))));
  api.post('/queue/move', wrap((req) => P.move(num(req.body.from, 'from'), num(req.body.to, 'to'))));
  api.post('/queue/clear', wrap((req) => P.clear({ keepCurrent: !!req.body?.keepCurrent })));
  api.post('/queue/add', wrap(async (req) => {
    // Same path as chat: a query or URL.
    const q = String(req.body.query || '').trim();
    if (!q) throw new Error('Type a song name or paste a link');
    const msg = await bot.commands.execute(req.body.now ? 'playnow' : 'play', q, { sender: 'Web UI' });
    if (/^Error:/.test(msg)) throw new Error(msg.replace(/^Error:\s*/, ''));
    return { message: msg };
  }));
  api.post('/queue/add-track', wrap((req) => {
    const t = req.body.track || {};
    if (typeof t.source !== 'string') throw new Error('Invalid track');
    const track = { id: crypto.randomUUID(), kind: 'url', title: String(t.title || t.source).slice(0, 200), artist: String(t.artist || '').slice(0, 100), duration: Number.isFinite(t.duration) ? t.duration : null, thumbnail: typeof t.thumbnail === 'string' && /^https:\/\//.test(t.thumbnail) ? t.thumbnail : null, source: t.source };
    P.add([track], { playNow: !!req.body.now, requestedBy: 'Web UI' });
  }));
  api.get('/search', wrap(async (req) => ({ results: await bot.resolver.search(String(req.query.q || ''), 8) })));

  // library
  api.get('/library', wrap(async () => ({ files: await bot.library.list() })));
  api.put('/library/:name', wrap(async (req) => ({ name: await bot.library.save(req.params.name, req) })));
  api.delete('/library/:name', wrap((req) => bot.library.remove(req.params.name)));
  api.post('/library/play', wrap(async (req) => {
    const [hit] = await bot.library.find(String(req.body.name || ''));
    if (!hit) throw new Error('File not found');
    P.add([bot.library.toTrack(hit)], { playNow: !!req.body.now, requestedBy: 'Web UI' });
  }));

  // settings
  api.get('/settings', wrap(() => bot.settings));
  api.post('/settings', wrap((req) => bot.updateSettings(req.body || {})));

  app.use('/api', api);
  app.use((req, res) => res.status(404).json({ error: 'Not found' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    // bad JSON, oversized body, aborted upload...: a plain JSON error, never a stack trace
    res.status(err.status && err.status < 500 ? err.status : 400).json({ error: err.type === 'entity.too.large' ? 'Request too large' : 'Bad request' });
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 });
  const MAX_CLIENTS = 20;
  const clients = new Set();

  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/ws' || !hostAllowed(req) || authBlocked(req) || !authorized(req) || !sameOrigin(req)) {
      if (req.headers.authorization && !authorized(req)) authFailed(req);
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  // A stalled client must not make us buffer megabytes of screenshots: drop frames for it, cut it off if it is hopeless.
  const send = (ws, msg) => {
    if (ws.readyState !== 1) return;
    if (ws.bufferedAmount > 16 * 1024 * 1024) return ws.terminate();
    if (msg.type === 'frame' && ws.bufferedAmount > 512 * 1024) return;
    ws.send(JSON.stringify(msg));
  };
  const broadcast = (msg) => clients.forEach((ws) => send(ws, msg));

  wss.on('connection', (ws) => {
    if (clients.size >= MAX_CLIENTS) return ws.close(1013, 'too many clients');
    ws.live = false;
    clients.add(ws);
    send(ws, { type: 'hello', ...bot.snapshot(), platforms: platformList(), chat: bot.chatLog.slice(-100), log: logger.ring.slice(-60) });
    ws.on('message', (raw) => {
      try {
        const m = JSON.parse(raw);
        if (m.type === 'live') ws.live = !!m.on;
      } catch {
        /* ignore */
      }
    });
    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
  });

  let playerTimer = null;
  const pushPlayer = () => {
    if (playerTimer) return;
    playerTimer = setTimeout(() => {
      playerTimer = null;
      broadcast({ type: 'player', player: P.getState() });
    }, 120);
  };
  bot.on('player', pushPlayer);
  bot.on('session', (s) => broadcast({ type: 'session', session: s, audio: bot.audio }));
  bot.on('chat', (entry) => broadcast({ type: 'chat', entry }));
  bot.on('settings', (settings) => broadcast({ type: 'settings', settings }));
  logger.on('entry', (entry) => broadcast({ type: 'log', entry }));

  // progress + VU tick while something is playing
  const tick = setInterval(() => {
    if (clients.size && P.status !== 'idle') broadcast({ type: 'player', player: P.getState() });
  }, 500);

  // live view: only while someone is watching and a browser exists
  let framing = false;
  const frames = setInterval(async () => {
    if (framing || !bot.session.page) return;
    const watchers = [...clients].filter((c) => c.live);
    if (!watchers.length) return;
    framing = true;
    try {
      const buf = await bot.session.screenshot();
      if (buf) {
        const data = buf.toString('base64');
        watchers.forEach((c) => send(c, { type: 'frame', data }));
      }
    } finally {
      framing = false;
    }
  }, 1000);

  await new Promise((resolve) => server.listen(port, host, resolve));
  const addr = server.address();
  log.info(`web UI on http://${host === '0.0.0.0' ? 'localhost' : host}:${addr.port}${config.uiPassword ? ' (password protected)' : ''}`);
  if (!config.uiPassword && host !== '127.0.0.1' && host !== 'localhost') {
    log.warn('UI_PASSWORD is not set - anyone who can reach this port can control the bot. Set UI_PASSWORD or bind to 127.0.0.1.');
  }

  const close = async () => {
    clearInterval(tick);
    clearInterval(frames);
    await bot.shutdown();
    wss.close();
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  };
  return { app, server, bot, port: addr.port, close };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const srv = await createServer();
  const stop = async () => {
    await srv.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
