import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { config } from './config.js';
import { getLog, logger } from './log.js';
import { MeetTunes } from './bot.js';
import { platformList, detectPlatform } from './meeting/platforms/index.js';
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
    if (!authorized(req)) {
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
    if (!req.body.url) throw new Error('Paste a meeting link first');
    detectPlatform(req.body.url); // validate early so the user gets an immediate error
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

  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const clients = new Set();

  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/ws' || !authorized(req) || !sameOrigin(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  const send = (ws, msg) => ws.readyState === 1 && ws.send(JSON.stringify(msg));
  const broadcast = (msg) => clients.forEach((ws) => send(ws, msg));

  wss.on('connection', (ws) => {
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
  bot.on('session', (s) => broadcast({ type: 'session', session: s }));
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
