import { sleep } from '../../util.js';
import { clickFirst, deepMerge, fillFirst, isVisible, pollUntil } from '../helpers.js';

/**
 * A Platform knows how to drive one meeting product's *web client*: pre-join screen, lobby, in-meeting
 * toolbar and chat DOM. All DOM knowledge lives in `defaults` (selector lists), which can be patched
 * without code changes through a selectors.json override file - meeting UIs change often.
 *
 * Selector lists use Playwright selector syntax (text=, :has-text(), css). The `chat.message|sender|text|time`
 * entries are evaluated with document.querySelectorAll inside the page, so those must be plain CSS.
 */
export class Platform {
  static id = 'generic';
  static label = 'Generic web meeting';
  static experimental = false;
  static matches() {
    return true;
  }

  static defaults = {
    cookie: ['#onetrust-accept-btn-handler', 'button:has-text("Accept all")', 'button:has-text("Accept cookies")'],
    continueInBrowser: [],
    nameInput: ['input[autocomplete="name"]', 'input[placeholder*="name" i]', 'input[aria-label*="name" i]', 'input[name*="name" i]'],
    emailInput: [],
    camOff: [],
    micOn: [],
    audioJoin: [],
    joinButton: ['button:has-text("Join now")', 'button:has-text("Join meeting")', 'button:has-text("Join")', 'button:has-text("Continue")'],
    inMeeting: ['button[aria-label*="Leave" i]', 'button[aria-label*="Hang up" i]', 'button:has-text("Leave")'],
    lobby: ['text=/waiting for the host|let you in|admit you|waiting room|waiting to be admitted/i'],
    ended: ['text=/meeting (has )?ended|you.ve been removed|you were removed|call ended/i'],
    leave: ['button[aria-label*="Leave" i]', 'button[aria-label*="Hang up" i]', 'button:has-text("Leave")'],
    unmute: [],
    chat: { open: [], message: '', sender: '', text: '', time: '', idAttr: '', input: [], send: [] },
  };

  constructor(overrides = {}) {
    this.sel = deepMerge(this.constructor.defaults, overrides);
    this.id = this.constructor.id;
    this.label = this.constructor.label;
    this.lastJoinClick = 0;
  }

  /** Rewrite the pasted link into the one that opens the browser client, if needed. */
  normalizeUrl(url) {
    return url;
  }

  chatSpec(prefix) {
    const c = this.sel.chat;
    return { message: c.message, sender: c.sender, text: c.text, time: c.time, idAttr: c.idAttr, prefix };
  }

  async isInMeeting(page) {
    return (await isVisible(page, this.sel.inMeeting)) && !(await isVisible(page, this.sel.lobby));
  }
  /** Toolbar-only check (no text patterns): what the monitor trusts, because chat text can't fake a button. */
  async inMeetingUi(page) {
    return isVisible(page, this.sel.inMeeting);
  }
  async isInLobby(page) {
    return isVisible(page, this.sel.lobby);
  }
  async hasEnded(page) {
    return isVisible(page, this.sel.ended);
  }

  /** One pass of the pre-join automation. Every step is idempotent and only acts on what's visible. */
  async prejoinStep(ctx) {
    const { page, displayName } = ctx;
    const s = this.sel;
    await clickFirst(page, s.cookie, { timeout: 1500 });
    await clickFirst(page, s.continueInBrowser);
    const named = await fillFirst(page, s.nameInput, displayName);
    if (s.emailInput.length) await fillFirst(page, s.emailInput, ctx.guestEmail);
    await clickFirst(page, s.camOff, { timeout: 1500 });
    await clickFirst(page, s.micOn, { timeout: 1500 });
    await clickFirst(page, s.audioJoin, { timeout: 2500 });
    // Join button: throttled, and wait a beat after typing the name so the form validates.
    if (Date.now() - this.lastJoinClick > 4000) {
      if (named) await sleep(600);
      if (await clickFirst(page, s.joinButton)) this.lastJoinClick = Date.now();
    }
  }

  async join(ctx) {
    const { page, signal, setStatus, log } = ctx;
    const url = this.normalizeUrl(ctx.url);
    log.info(`opening ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const started = Date.now();
    let lastState = '';
    for (;;) {
      if (signal.aborted) throw new Error('Cancelled');
      if (await this.isInMeeting(page)) break;
      if (await this.hasEnded(page)) throw new Error('The meeting has ended or the host denied entry');
      let state;
      if (await this.isInLobby(page)) state = 'lobby';
      else {
        state = 'joining';
        try {
          await this.prejoinStep(ctx);
        } catch (e) {
          log.debug?.(`prejoin step: ${e.message}`);
        }
      }
      if (state !== lastState) {
        setStatus(state, state === 'lobby' ? 'Waiting for the host to admit the bot...' : 'Filling in the pre-join screen...');
        lastState = state;
      }
      if (Date.now() - started > ctx.timeoutMs) {
        throw new Error('Timed out waiting to get into the meeting (open Live View to see where it is stuck)');
      }
      await sleep(900);
    }
    await this.afterJoin(ctx);
  }

  /** Once inside: make sure the mic is live and the chat panel is open. */
  async afterJoin(ctx) {
    await sleep(1500);
    // Zoom asks "Join Audio by Computer" only after you are in; without it the bot has no microphone at all.
    // One immediate try; if the prompt shows up later, the monitor clicks it (see MeetingSession._startMonitor).
    await this.joinAudio(ctx.page);
    await this.ensureMicOn(ctx.page);
    await this.openChat(ctx.page);
    await sleep(1200); // let any chat history render so it is baselined, not replayed as commands
  }

  /** Connect computer audio if the client shows a prompt for it. Returns true if something was clicked. */
  async joinAudio(page) {
    return this.sel.audioJoin.length ? clickFirst(page, this.sel.audioJoin, { timeout: 2000 }) : false;
  }

  async ensureMicOn(page) {
    return this.sel.unmute.length ? clickFirst(page, this.sel.unmute, { timeout: 2000 }) : false;
  }

  async chatReady(page) {
    return isVisible(page, this.sel.chat.input);
  }

  async openChat(page) {
    if (await this.chatReady(page)) return true;
    if (this.sel.chat.open.length && (await clickFirst(page, this.sel.chat.open, { timeout: 2500 }))) {
      // Return as soon as the input shows up (a fixed sleep is slow, and a panel that closes again is then missed).
      return !!(await pollUntil(() => this.chatReady(page), { timeout: 1500, interval: 100 }));
    }
    return false;
  }

  async leave(page) {
    await clickFirst(page, this.sel.leave, { timeout: 2000 });
    await sleep(500);
  }
}
