import { EventEmitter } from 'node:events';

/** Tiny logger that also keeps a ring buffer so the web UI can show recent activity. */
class Logger extends EventEmitter {
  constructor() {
    super();
    this.ring = [];
  }
  _push(level, scope, msg) {
    const entry = { t: Date.now(), level, scope, msg: String(msg) };
    this.ring.push(entry);
    if (this.ring.length > 300) this.ring.shift();
    const line = `${new Date(entry.t).toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${entry.msg}`;
    (level === 'error' ? console.error : console.log)(line);
    this.emit('entry', entry);
  }
  scope(scope) {
    return {
      info: (m) => this._push('info', scope, m),
      warn: (m) => this._push('warn', scope, m),
      error: (m) => this._push('error', scope, m),
      debug: (m) => process.env.DEBUG && this._push('debug', scope, m),
    };
  }
}

export const logger = new Logger();
export const getLog = (scope) => logger.scope(scope);
