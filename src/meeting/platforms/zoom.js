import { Platform } from './base.js';
import { deepMerge } from '../helpers.js';

export class Zoom extends Platform {
  static id = 'zoom';
  static label = 'Zoom';
  static matches(u) {
    return /(^|\.)(zoom\.us|zoom\.com|zoomgov\.com)$/i.test(u.hostname);
  }

  static defaults = deepMerge(Platform.defaults, {
    nameInput: ['#input-for-name', 'input[placeholder*="name" i]'],
    joinButton: ['button.preview-join-button', 'button:has-text("Join")'],
    // "Join Audio by Computer" appears after joining; the audio can then be muted/unmuted by the footer button.
    audioJoin: ['button.join-audio-by-voip__join-btn', 'button:has-text("Join Audio by Computer")', 'button:has-text("Computer Audio")'],
    cookie: ['#onetrust-accept-btn-handler', '#wc_agree1', 'button:has-text("I Agree")', 'button:has-text("Accept Cookies")'],
    inMeeting: ['button.footer__leave-btn', 'button[aria-label="Leave"]', '#foot-bar button[aria-label*="Leave" i]', '.footer-button__button[aria-label*="Leave" i]'],
    lobby: ['text=/Please wait, the meeting host will let you in soon|waiting room|host will let you in/i'],
    ended: ['text=/This meeting has been ended by host|meeting has ended|You have been removed from this meeting/i'],
    leave: ['button.footer__leave-btn', 'button[aria-label="Leave"]'],
    unmute: ['button[aria-label="unmute my microphone"]', 'button.join-audio-container__btn[aria-label*="unmute" i]', 'button[aria-label="Unmute"]'],
    chat: {
      open: ['button[aria-label*="open the chat panel" i]', 'button[aria-label="chat"]', '#foot-bar button[aria-label*="chat" i]', 'button:has-text("Chat")'],
      message: '.chat-item__chat-info, .chat-message__container',
      sender: '.chat-item__sender, .chat-message__sender',
      text: '.new-chat-message__text-box, .chat-message__text-box, .chat-message__text-content',
      time: '.chat-item__chat-info-header time, .chat-message__time',
      idAttr: 'id',
      input: ['.tiptap.ProseMirror', 'div[aria-label*="Type message" i]', 'textarea.chat-box__chat-textarea', '[contenteditable="true"][aria-label*="message" i]'],
      send: [],
    },
  });

  /** https://zoom.us/j/123456789?pwd=abc  ->  https://zoom.us/wc/123456789/join?pwd=abc (browser client) */
  normalizeUrl(url) {
    try {
      const u = new URL(url);
      const m = /\/(?:j|wc\/join|wc)\/(\d{8,12})/.exec(u.pathname);
      if (m) {
        const out = new URL(`${u.origin}/wc/${m[1]}/join`);
        for (const [k, v] of u.searchParams) out.searchParams.set(k, v);
        out.searchParams.set('fromPWA', '1');
        return out.href;
      }
    } catch {
      /* fall through */
    }
    return url;
  }
}
