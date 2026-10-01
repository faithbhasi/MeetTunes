import { Platform } from './base.js';
import { deepMerge } from '../helpers.js';

/**
 * Slack Huddles have no guest/anonymous join - the browser profile must be signed in to the workspace.
 * Sign in once through Live View (the profile persists). Chat commands are read from the huddle thread.
 */
export class Slack extends Platform {
  static id = 'slack';
  static label = 'Slack Huddle';
  static experimental = true;
  static matches(u) {
    return /(^|\.)slack\.com$/i.test(u.hostname);
  }

  static defaults = deepMerge(Platform.defaults, {
    continueInBrowser: ['a:has-text("use Slack in your browser")', 'a:has-text("Use Slack in your browser")', 'a:has-text("open this link in your browser")'],
    nameInput: [],
    joinButton: ['button[data-qa="huddle_join_button"]', 'button:has-text("Join huddle")', 'button:has-text("Join")'],
    inMeeting: ['button[data-qa="huddle_mini_player_leave_button"]', 'button[aria-label*="Leave huddle" i]', 'button:has-text("Leave")'],
    lobby: [],
    ended: ['text=/huddle has ended|This huddle has ended/i'],
    leave: ['button[data-qa="huddle_mini_player_leave_button"]', 'button[aria-label*="Leave huddle" i]'],
    unmute: ['button[aria-label*="Unmute" i]'],
    chat: {
      open: ['button[aria-label*="thread" i]', 'button[data-qa="huddle_thread_button"]'],
      message: '[data-qa="huddle_thread"] [data-qa="message_container"], .p-huddle_thread [data-qa="message_container"]',
      sender: '[data-qa="message_sender_name"]',
      text: '[data-qa="message-text"], .p-rich_text_section',
      time: '',
      idAttr: 'data-msg-ts',
      input: ['[data-qa="huddle_thread"] [role="textbox"][contenteditable="true"]', '.p-huddle_thread [role="textbox"][contenteditable="true"]'],
      send: ['button[data-qa="texty_send_button"]'],
    },
  });
}
