import { Platform } from './base.js';
import { deepMerge } from '../helpers.js';

export class Webex extends Platform {
  static id = 'webex';
  static label = 'Cisco Webex';
  static matches(u) {
    return /(^|\.)(webex\.com|wbx2\.com)$/i.test(u.hostname);
  }

  static defaults = deepMerge(Platform.defaults, {
    continueInBrowser: ['a:has-text("Join from your browser")', 'button:has-text("Join from your browser")', 'a:has-text("join from your browser")', 'button:has-text("Use the web app")'],
    nameInput: ['input[placeholder*="Your full name" i]', 'input[data-test="guest-name-input"]', 'input[name="name"]', 'input[placeholder*="name" i]'],
    emailInput: ['input[placeholder*="Email address" i]', 'input[type="email"]', 'input[data-test="guest-email-input"]'],
    joinButton: ['button[data-test="join-button"]', 'button:has-text("Join meeting")', 'button:has-text("Join as guest")', 'button:has-text("Next")'],
    camOff: ['button[aria-label*="Stop video" i]'],
    micOn: ['button[aria-label*="Unmute" i]'],
    inMeeting: ['button[aria-label*="Leave meeting" i]', 'button[data-test="leave-button"]', 'button[aria-label="Leave"]'],
    lobby: ['text=/waiting for the host|let you in|lobby/i'],
    leave: ['button[aria-label*="Leave meeting" i]', 'button[data-test="leave-button"]'],
    unmute: ['button[aria-label="Unmute"]', 'button[aria-label*="Unmute" i]'],
    chat: {
      open: ['button[aria-label*="Chat" i]', 'button[data-test="chat-button"]'],
      message: '[class*="chat-message" i], [data-test="chat-message"]',
      sender: '[class*="sender" i], [data-test="chat-message-sender"]',
      text: '[class*="message-text" i], [class*="message-content" i], [data-test="chat-message-text"]',
      time: '[class*="time" i]',
      idAttr: 'data-id',
      input: ['textarea[placeholder*="Type your message" i]', 'div[contenteditable="true"][aria-label*="message" i]', '[data-test="chat-input"]'],
      send: ['button[aria-label*="Send" i]'],
    },
  });
}
