import { Platform } from './base.js';
import { deepMerge } from '../helpers.js';
import { clickFirst } from '../helpers.js';

export class GoogleMeet extends Platform {
  static id = 'meet';
  static label = 'Google Meet';
  static matches(u) {
    return /(^|\.)meet\.google\.com$/i.test(u.hostname);
  }

  // Meet usually wants a signed-in Google account. Sign the bot account in once through Live View;
  // the browser profile is persisted, so it stays signed in.
  static defaults = deepMerge(Platform.defaults, {
    nameInput: ['input[aria-label="Your name"]', 'input[placeholder="Your name"]', 'input[autocomplete="name"]'],
    camOff: ['button[aria-label*="Turn off camera" i]', '[role="button"][aria-label*="Turn off camera" i]'],
    micOn: ['button[aria-label*="Turn on microphone" i]', '[role="button"][aria-label*="Turn on microphone" i]'],
    cookie: ['button:has-text("Got it")', 'button:has-text("Dismiss")', 'button:has-text("Continue without microphone and camera")'],
    joinButton: ['button:has-text("Ask to join")', 'button:has-text("Join now")', 'button:has-text("Switch here")'],
    inMeeting: ['button[aria-label*="Leave call" i]'],
    lobby: ['text=/Asking to be let in|Someone will let you in soon|You.ll join when someone lets you in|waiting for the host/i'],
    ended: ['text=/You.ve been removed from the meeting|Your meeting has ended|You can.t join this video call|Return to home screen|You left the meeting/i'],
    leave: ['button[aria-label*="Leave call" i]'],
    unmute: ['button[aria-label*="Turn on microphone" i]'],
    chat: {
      open: ['button[aria-label*="Chat with everyone" i]', 'button[aria-label*="Show everyone" i] ~ button[aria-label*="Chat" i]'],
      message: '[data-message-text], [data-is-user-message]',
      sender: '[data-sender-name]',
      text: '[data-message-text], div[jsname="dTKtvb"]',
      time: '',
      idAttr: 'data-message-id',
      input: ['textarea[aria-label*="Send a message" i]', 'textarea[placeholder*="Send a message" i]'],
      send: ['button[aria-label*="Send a message" i]'],
    },
  });

  async prejoinStep(ctx) {
    await super.prejoinStep(ctx);
    // Camera/mic permission nag when no camera exists in the container.
    await clickFirst(ctx.page, ['button:has-text("Continue without camera")', 'button:has-text("Use microphone")'], { timeout: 1500 });
  }
}
