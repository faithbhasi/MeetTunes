import { Platform } from './base.js';
import { deepMerge } from '../helpers.js';

/** A tiny fake meeting site served by MeetTunes itself (/dev/mock-meeting). Used for tests and demos. */
export class MockMeeting extends Platform {
  static id = 'mock';
  static label = 'Mock meeting (dev)';
  static matches(u) {
    return u.pathname.startsWith('/dev/mock-meeting');
  }

  static defaults = deepMerge(Platform.defaults, {
    nameInput: ['#name'],
    joinButton: ['#join'],
    inMeeting: ['#leave'],
    lobby: ['#lobby'],
    ended: ['#ended'],
    leave: ['#leave'],
    chat: {
      open: ['#open-chat'],
      message: '.msg',
      sender: '.who',
      text: '.body',
      time: '.ts',
      idAttr: 'data-id',
      input: ['#chat-input'],
      send: ['#chat-send'],
    },
  });
}
