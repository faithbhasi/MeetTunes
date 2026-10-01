import fs from 'node:fs';
import { config } from '../../config.js';
import { getLog } from '../../log.js';
import { Zoom } from './zoom.js';
import { Teams } from './teams.js';
import { GoogleMeet } from './meet.js';
import { Webex } from './webex.js';
import { Slack } from './slack.js';
import { Generic } from './generic.js';
import { MockMeeting } from './mock.js';

const log = getLog('platforms');
const ALL = [Zoom, Teams, GoogleMeet, Webex, Slack];

function loadOverrides() {
  if (!config.browser.selectorsFile) return {};
  try {
    return JSON.parse(fs.readFileSync(config.browser.selectorsFile, 'utf8'));
  } catch (e) {
    log.warn(`could not read selectors override ${config.browser.selectorsFile}: ${e.message}`);
    return {};
  }
}

export function parseMeetingUrl(input) {
  let u;
  try {
    u = new URL(String(input).trim());
  } catch {
    throw new Error('That does not look like a meeting link (expected https://...)');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Only http(s) meeting links are supported');
  return u;
}

export function detectPlatform(input) {
  const u = parseMeetingUrl(input);
  if (config.browser.allowMockMeeting && MockMeeting.matches(u)) return MockMeeting;
  return ALL.find((P) => P.matches(u)) || Generic;
}

export function createPlatform(input) {
  const P = detectPlatform(input);
  return new P(loadOverrides()[P.id] || {});
}

export const platformList = () => [...ALL, Generic].map((P) => ({ id: P.id, label: P.label, experimental: P.experimental }));
