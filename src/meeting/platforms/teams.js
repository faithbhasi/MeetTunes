import { Platform } from './base.js';
import { deepMerge } from '../helpers.js';

export class Teams extends Platform {
  static id = 'teams';
  static label = 'Microsoft Teams';
  static matches(u) {
    return /(^|\.)(teams\.microsoft\.com|teams\.live\.com|teams\.cloud\.microsoft)$/i.test(u.hostname);
  }

  static defaults = deepMerge(Platform.defaults, {
    continueInBrowser: ['button[data-tid="joinOnWeb"]', 'button:has-text("Continue on this browser")', 'a:has-text("Continue on this browser")', 'button:has-text("Join on the web instead")'],
    nameInput: ['input[data-tid="prejoin-display-name-input"]', 'input[placeholder*="Enter name" i]', 'input[placeholder*="name" i]'],
    // On the pre-join screen the mic toggle shows aria-checked=false when the mic is off.
    micOn: ['[data-tid="toggle-mute"][aria-checked="false"]'],
    camOff: ['[data-tid="toggle-video"][aria-checked="true"]'],
    joinButton: ['button[data-tid="prejoin-join-button"]', 'button:has-text("Join now")'],
    inMeeting: ['button#hangup-button', 'button[data-tid="hangup-button"]', 'button[aria-label^="Leave" i]'],
    lobby: ['text=/someone in the meeting should let you in soon|let you in soon|waiting for people to let you in|We.ve let people in the meeting know/i'],
    ended: ['text=/meeting has ended|You.ve been removed|you were removed from the meeting|The meeting has ended/i'],
    leave: ['button#hangup-button', 'button[data-tid="hangup-button"]'],
    unmute: ['button[id="microphone-button"][aria-pressed="false"]', 'button[aria-label^="Unmute" i]'],
    chat: {
      open: ['button#chat-button', 'button[data-tid="chat-button"]', 'button[aria-label^="Chat" i]'],
      message: '[data-tid="chat-pane-message"]',
      sender: '[data-tid="message-author-name"], [data-tid="author"]',
      text: '[data-tid="chat-pane-message"] > div:last-child, [id^="content-"], [data-tid="message-body"]',
      time: 'time',
      idAttr: 'data-mid',
      input: ['[data-tid="ckeditor"][contenteditable="true"]', 'div[role="textbox"][contenteditable="true"]'],
      send: ['button[data-tid="newMessageCommands-send"]', 'button[aria-label="Send" i]'],
    },
  });
}
