import { Platform } from './base.js';

/** Fallback for any other web meeting link: best-effort name + join clicks, then use Live View to assist. */
export class Generic extends Platform {
  static id = 'generic';
  static label = 'Other meeting (best effort)';
  static experimental = true;
}
