import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';
import { config } from '../config.js';
import { getLog } from '../log.js';
import { sleep, truncate, redactUrl } from '../util.js';
import { assertSafeUrl } from '../audio/netguard.js';
import { createPlatform } from './platforms/index.js';
import { observerInitScript } from './chatObserver.js';
import { framesOf, findVisible } from './helpers.js';

const log = getLog('meeting');
const VIEWPORT = { width: 1280, height: 800 };
const MAX_CHAT_QUEUE = 20;

/**
 * Meeting clients apply echo-cancellation / noise-suppression / AGC to the microphone, which turns music
 * into mush. Force them off for every getUserMedia() / applyConstraints() call made by the page.
 */
const AUDIO_CONSTRAINT_PATCH = `(() => {
  const raw = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2 };
  const patch = (c) => (c && c.audio ? { ...c, audio: c.audio === true ? { ...raw } : { ...c.audio, ...raw } } : c);
  const md = navigator.mediaDevices;
  if (md && md.getUserMedia) {
    const orig = md.getUserMedia.bind(md);
    md.getUserMedia = (c) => orig(patch(c));
  }
  const origApply = MediaStreamTrack.prototype.applyConstraints;
  MediaStreamTrack.prototype.applyConstraints = function (c) {
    return origApply.call(this, this.kind === 'audio' && c ? { ...c, ...raw } : c);
  };
})();`;

/**
 * Owns one Chromium instance and one meeting. Emits:
 *  - 'status'  ({state, detail, platform, ...})
 *  - 'chat'    ({sender, text, mode})        messages seen in the meeting chat
 *  - 'left'    (reason)
 * States: idle -> starting -> joining -> lobby -> joined -> leaving -> idle (or error)
 */
export class MeetingSession extends EventEmitter {
  constructor({ getPrefix }) {
    super();
    this.getPrefix = getPrefix;
    this.gen = 0; // bumped per join; callbacks from an older session are ignored
    this.reset();
    this.sendQueue = Promise.resolve();
    this.queued = 0;
    this.recentSent = [];
  }

  reset() {
    this.context = null;
    this.page = null;
    this.platform = null;
    this.abort = null;
    this.monitor = null;
    this.chatArmed = false;
    this.joinedOnce = false;
    this.closing = false;
    this.info = { state: 'idle', detail: '', platform: null, url: null, displayName: null, since: Date.now(), chatMode: null, error: null };
  }

  get state() {
    return this.info.state;
  }
  get active() {
    return !['idle', 'error'].includes(this.info.state);
  }

  _set(state, detail = '', extra = {}) {
    this.info = { ...this.info, state, detail, since: Date.now(), error: state === 'error' ? detail : null, ...extra };
    log.info(`${state}${detail ? ': ' + detail : ''}`);
    this.emit('status', this.snapshot());
  }

  snapshot() {
    return { ...this.info, chatArmed: this.chatArmed };
  }

  // ---- join -----------------------------------------------------------------------------------
  async join({ url, displayName }) {
    if (this.active) throw new Error('Already in (or joining) a meeting - leave first');
    const platform = createPlatform(url);
    if (platform.id !== 'mock') await assertSafeUrl(url); // no private / loopback / non-http meeting links
    if (this.active) throw new Error('Already in (or joining) a meeting - leave first'); // re-check after the await
    this.reset();
    const gen = ++this.gen;
    this.platform = platform;
    this.abort = new AbortController();
    this._set('starting', 'Launching browser...', { platform: platform.id, platformLabel: platform.label, url: redactUrl(url), displayName });
    try {
      await this._launch(gen);
      const ctx = {
        page: this.page,
        url,
        displayName,
        guestEmail: process.env.GUEST_EMAIL || 'meettunes@example.com',
        timeoutMs: config.browser.joinTimeoutMs,
        signal: this.abort.signal,
        log,
        setStatus: (s, d) => gen === this.gen && this._set(s, d),
      };
      this._set('joining', `Opening ${platform.label}...`);
      await platform.join(ctx);
      if (this.abort.signal.aborted) throw new Error('Cancelled');
      await this._armChat();
      this.joinedOnce = true;
      this._set('joined', 'In the meeting', { chatMode: this.chatArmed ? 'armed' : 'unavailable' });
      this._startMonitor(gen);
    } catch (e) {
      if (gen !== this.gen) throw e; // superseded; someone else owns the state now
      const cancelled = this.abort?.signal.aborted;
      const msg = cancelled ? 'Cancelled' : e.message;
      log.error(`join failed: ${msg}`);
      await this._closeBrowser();
      if (cancelled) {
        this.reset();
        this.emit('status', this.snapshot());
        this.emit('left', 'Cancelled');
      } else this._set('error', msg);
      if (!cancelled) throw e;
    }
  }

  async _launch(gen) {
    await fs.mkdir(config.profileDir, { recursive: true });
    const env = { ...process.env };
    if (config.audio.sink === 'pulse') {
      env.PULSE_SOURCE = config.audio.pulseMic; // what Chromium records from = our virtual microphone
      env.PULSE_SINK = config.audio.pulseOut; // where meeting audio goes (a dead-end sink; avoids feedback)
    }
    const args = [
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      '--lang=en-US',
      `--window-size=${VIEWPORT.width},${VIEWPORT.height + 90}`,
    ];
    if (config.browser.noSandbox) args.push('--no-sandbox', '--disable-setuid-sandbox');
    this.context = await chromium.launchPersistentContext(config.profileDir, {
      headless: config.browser.headless,
      executablePath: config.browser.executablePath,
      args,
      env,
      viewport: VIEWPORT,
      locale: 'en-US',
      permissions: ['microphone'],
      ignoreDefaultArgs: ['--enable-automation'],
      acceptDownloads: false,
    });
    const context = this.context;
    context.on('close', () => {
      // Only a close we did not cause, for the session that is still current, is a crash.
      if (gen === this.gen && context === this.context && !this.closing && this.active) this._onBrowserGone();
    });
    await this.context.addInitScript(AUDIO_CONSTRAINT_PATCH);
    await this.context.addInitScript(observerInitScript(this.platform.chatSpec(this.getPrefix())));
    this.page = this.context.pages()[0] || (await this.context.newPage());
    this.page.on('crash', () => gen === this.gen && !this.closing && this._cleanup('The browser tab crashed'));
    await this.page.exposeFunction('__mtChat', (json) => this._onChatMessage(json));
    // Auto-arm observers in frames created after we joined.
    this.page.on('framenavigated', (f) => this.chatArmed && f.evaluate(() => window.__mtArm?.()).catch(() => {}));
    this.page.on('dialog', (d) => d.dismiss().catch(() => {}));
    // Pop-ups (e.g. "open in app" windows) just get closed.
    this.context.on('page', (p) => {
      if (p !== this.page) p.close().catch(() => {});
    });
  }

  async _armChat() {
    for (const f of framesOf(this.page)) await f.evaluate(() => window.__mtArm?.()).catch(() => {});
    this.chatArmed = true;
  }

  _onBrowserGone() {
    log.warn('browser closed unexpectedly');
    this._cleanup('The browser closed unexpectedly');
  }

  /**
   * Watches the meeting. Decisions are based on the meeting *toolbar* (leave button), never on page text alone:
   * anyone in the chat could type "the meeting has ended" or "waiting room" to make the bot leave.
   */
  _startMonitor(gen) {
    let missed = 0;
    this.monitor = setInterval(async () => {
      if (gen !== this.gen || !['joined', 'lobby'].includes(this.state) || this.checking) return;
      this.checking = true;
      try {
        const page = this.page;
        if (!page || page.isClosed()) return this._cleanup('The browser page closed');
        if (await this.platform.inMeetingUi(page)) {
          missed = 0;
          if (this.state === 'lobby') this._set('joined', 'Back in the meeting');
          if (!(await this.platform.chatReady(page))) await this._reopenChat();
          await this.platform.ensureMicOn(page);
        } else if (await this.platform.isInLobby(page)) {
          missed = 0;
          if (this.state !== 'lobby') this._set('lobby', 'Moved back to the lobby - waiting to be admitted again');
        } else if (await this.platform.hasEnded(page)) {
          return this._cleanup('The meeting ended (or the bot was removed)');
        } else if (++missed >= 5) {
          return this._cleanup('Lost the meeting UI (call ended?)');
        }
      } catch (e) {
        log.debug?.(`monitor: ${e.message}`);
      } finally {
        this.checking = false;
      }
    }, config.browser.monitorMs);
  }

  /** Re-open the chat panel; whatever it shows afterwards is history, not new commands. */
  async _reopenChat() {
    if (!(await this.platform.openChat(this.page))) return false;
    await sleep(900);
    for (const f of framesOf(this.page)) await f.evaluate(() => window.__mtRebaseline?.()).catch(() => {});
    return true;
  }

  async leave(reason = 'Left the meeting') {
    if (this.state === 'idle' || this.closing) return;
    if (this.abort && !this.joinedOnce && ['starting', 'joining', 'lobby'].includes(this.state)) {
      // Still joining: cancel and tear the browser down so a stuck navigation can't delay it.
      this.abort.abort();
      await this._closeBrowser();
      return;
    }
    this._set('leaving', 'Leaving...');
    try {
      if (this.page && !this.page.isClosed()) await this.platform.leave(this.page);
    } catch {
      /* ignore */
    }
    await this._cleanup(reason);
  }

  /** Idempotent: browser close, monitor and a manual leave can all race to end the session. */
  async _cleanup(reason) {
    if (this.closing) return;
    this.closing = true;
    clearInterval(this.monitor);
    this.monitor = null;
    const platform = this.info.platform;
    await this._closeBrowser();
    this.reset();
    this.emit('status', this.snapshot());
    this.emit('left', reason);
    log.info(`session ended: ${reason} (${platform})`);
  }

  async _closeBrowser() {
    const ctx = this.context;
    this.context = null;
    this.page = null;
    this.chatArmed = false;
    if (ctx) await ctx.close().catch(() => {});
  }

  // ---- chat -----------------------------------------------------------------------------------
  _onChatMessage(json) {
    let m;
    try {
      m = JSON.parse(json);
    } catch {
      return;
    }
    if (!m.text) return;
    // Ignore echoes of what the bot itself posted.
    const lines = m.text.split('\n').map((l) => l.trim());
    if (this.recentSent.length && lines.every((l) => this.recentSent.includes(l))) return;
    this.emit('chat', { sender: m.sender || '', text: m.text, mode: m.mode });
  }

  /** Post text to the meeting chat. Multi-line text becomes one multi-line message. Serialised + rate limited. */
  sendChat(text) {
    const prefix = this.getPrefix();
    const lines = String(text)
      .split('\n')
      .map((l) => truncate(l, 400))
      // A reply line must never look like a command, or the generic observer could re-trigger on it.
      .map((l) => (l.trimStart().startsWith(prefix) ? `- ${l.trimStart()}` : l));
    if (this.queued >= MAX_CHAT_QUEUE) return this.sendQueue; // chat is wedged or flooded; don't pile up
    this.queued++;
    this.recentSent.push(...lines.map((l) => l.trim()));
    this.recentSent = this.recentSent.slice(-60);
    this.sendQueue = this.sendQueue
      .then(() => this._sendWithRetry(lines))
      .catch((e) => log.warn(`could not send chat message: ${e.message}`))
      .then(() => sleep(700))
      .finally(() => this.queued--);
    return this.sendQueue;
  }

  /** The panel can close or re-render between "is it open?" and typing: retry a few times, re-opening each time. */
  async _sendWithRetry(lines, attempts = 3) {
    let last;
    for (let i = 0; i < attempts; i++) {
      try {
        return await this._sendNow(lines);
      } catch (e) {
        last = e;
        if (this.state !== 'joined') break;
        await sleep(400);
      }
    }
    throw last;
  }

  async _sendNow(lines) {
    if (this.state !== 'joined') throw new Error('not in a meeting');
    const page = this.page;
    if (!(await this.platform.chatReady(page))) await this._reopenChat();
    const input = await findVisible(page, this.platform.sel.chat.input);
    if (!input) throw new Error('chat input not found (see Live View / selectors override)');
    await input.click({ timeout: 3000 });
    for (let i = 0; i < lines.length; i++) {
      if (i) await page.keyboard.press('Shift+Enter');
      if (lines[i]) await page.keyboard.insertText(lines[i]);
    }
    const sendBtn = this.platform.sel.chat.send.length ? await findVisible(page, this.platform.sel.chat.send) : null;
    if (sendBtn) await sendBtn.click({ timeout: 3000 }).catch(() => page.keyboard.press('Enter'));
    else await page.keyboard.press('Enter');
  }

  async setPrefix(prefix) {
    if (!this.page) return;
    for (const f of framesOf(this.page)) await f.evaluate((p) => window.__mtSetPrefix?.(p), prefix).catch(() => {});
  }

  // ---- live view / remote control / diagnostics ------------------------------------------------
  async screenshot() {
    if (!this.page || this.page.isClosed()) return null;
    try {
      return await this.page.screenshot({ type: 'jpeg', quality: 55, timeout: 4000 });
    } catch {
      return null;
    }
  }

  async remote(action) {
    const page = this.page;
    if (!page || page.isClosed()) throw new Error('No browser is running');
    switch (action.type) {
      case 'click':
        if (![action.x, action.y].every((v) => Number.isFinite(v) && v >= 0 && v <= 1)) throw new Error('bad coordinates');
        await page.mouse.click(action.x * VIEWPORT.width, action.y * VIEWPORT.height);
        break;
      case 'type':
        await page.keyboard.insertText(String(action.text || '').slice(0, 500));
        break;
      case 'key':
        if (!/^[A-Za-z0-9+]{1,30}$/.test(action.key || '')) throw new Error('bad key');
        await page.keyboard.press(action.key);
        break;
      case 'scroll':
        await page.mouse.wheel(0, Math.max(-2000, Math.min(2000, Number(action.dy) || 0)));
        break;
      case 'goto': {
        const u = await assertSafeUrl(String(action.url || '')); // no file:, chrome:, or internal addresses
        await page.goto(u.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
        break;
      }
      default:
        throw new Error('unknown action');
    }
  }

  /** Per-frame look at the chat selectors + trimmed DOM, to help fix selectors when a platform changes. */
  async diagnostics() {
    if (!this.page) throw new Error('No browser is running');
    const frames = [];
    for (const f of framesOf(this.page)) {
      const probe = await f.evaluate(() => window.__mtProbe?.()).catch(() => null);
      const html = await f.evaluate(() => document.body?.innerHTML?.slice(0, 120000) || '').catch(() => '');
      frames.push({ url: f.url().slice(0, 160), probe, htmlLength: html.length, html });
    }
    return { platform: this.platform?.id, state: this.state, chatArmed: this.chatArmed, selectors: this.platform?.sel, frames };
  }
}
