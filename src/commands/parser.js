/**
 * "#volume 30" -> { name: "volume", args: "30" }. Returns null for anything that is not a command.
 * The prefix must be the very first character so normal chat (and our own replies) never match.
 */
export function parseCommand(text, prefix = '#') {
  if (typeof text !== 'string') return null;
  // Only the first line is the command ("#volume 20\nthanks!" is a command plus chit-chat).
  const t = text.trim().split(/\r?\n/)[0].trim();
  if (!t.startsWith(prefix)) return null;
  const m = /^([a-z][a-z0-9_-]*)(?:\s+(.*))?$/i.exec(t.slice(prefix.length));
  if (!m) return null;
  return { name: m[1].toLowerCase(), args: (m[2] || '').trim() };
}

/** alias -> canonical command name */
export const ALIASES = {
  p: 'play',
  pn: 'playnow',
  find: 'search',
  s: 'search',
  choose: 'pick',
  lib: 'local',
  unpause: 'resume',
  continue: 'resume',
  skip: 'next',
  n: 'next',
  prev: 'previous',
  back: 'previous',
  b: 'previous',
  vol: 'volume',
  v: 'volume',
  vu: 'volup',
  vd: 'voldown',
  q: 'queue',
  np: 'nowplaying',
  now: 'nowplaying',
  rm: 'remove',
  goto: 'jump',
  commands: 'help',
  h: 'help',
  '?': 'help',
  disconnect: 'leave',
  quit: 'leave',
  ff: 'seek',
};

// hasOwn: "#constructor" / "#__proto__" must not resolve to Object.prototype members
export const canonical = (name) => (Object.hasOwn(ALIASES, name) ? ALIASES[name] : name);
