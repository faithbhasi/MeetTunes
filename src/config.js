import path from 'node:path';

const env = process.env;
const bool = (v, d) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(v));
const int = (v, d) => (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : d);

const dataDir = path.resolve(env.DATA_DIR || './data');

export const config = {
  port: int(env.PORT, 3000),
  host: env.HOST || '0.0.0.0',
  /** HTTP basic-auth password for the web UI. Empty = no auth (only do that on localhost!). */
  uiPassword: env.UI_PASSWORD || '',
  dataDir,
  profileDir: path.resolve(env.PROFILE_DIR || path.join(dataDir, 'profile')),
  musicDir: path.resolve(env.MUSIC_DIR || './music'),

  defaultDisplayName: env.BOT_NAME || 'MeetTunes',
  commandPrefix: env.COMMAND_PREFIX || '#',
  /** Comma separated display names allowed to use chat commands. Empty = everyone. */
  commandAllowlist: (env.COMMAND_ALLOWLIST || '').split(',').map((s) => s.trim()).filter(Boolean),

  audio: {
    /** pulse = PulseAudio virtual mic (Docker / Linux). none = decode and discard (dev / tests). */
    sink: env.AUDIO_SINK || 'pulse',
    pulseSink: env.PULSE_MUSIC_SINK || 'meettunes',
    pulseMic: env.PULSE_MIC_SOURCE || 'meettunes_mic',
    pulseOut: env.PULSE_MEETING_SINK || 'meeting_out',
    sampleRate: 48000,
    channels: 2,
    defaultVolume: int(env.DEFAULT_VOLUME, 50),
    maxVolume: int(env.MAX_VOLUME, 100),
  },

  media: {
    ytdlp: env.YTDLP_PATH || 'yt-dlp',
    ffmpeg: env.FFMPEG_PATH || 'ffmpeg',
    /** youtube | soundcloud */
    searchProvider: env.SEARCH_PROVIDER || 'youtube',
    /** extra yt-dlp args, e.g. "--js-runtimes node --extractor-args youtube:player_client=web" */
    ytdlpArgs: (env.YTDLP_ARGS || '').split(/\s+/).filter(Boolean),
    cookiesFile: env.YTDLP_COOKIES || '',
    maxQueue: int(env.MAX_QUEUE, 200),
    maxPlaylistImport: int(env.MAX_PLAYLIST_IMPORT, 50),
    /** Block private / loopback hosts for URLs coming in via chat (SSRF guard). */
    allowPrivateUrls: bool(env.ALLOW_PRIVATE_URLS, false),
  },

  browser: {
    headless: bool(env.HEADLESS, false), // headful under Xvfb is the most compatible with meeting clients
    executablePath: env.CHROMIUM_PATH || undefined,
    noSandbox: bool(env.CHROMIUM_NO_SANDBOX, true),
    joinTimeoutMs: int(env.JOIN_TIMEOUT_SEC, 600) * 1000, // how long we wait in a lobby to be admitted
    selectorsFile: env.SELECTORS_FILE || '',
    allowMockMeeting: bool(env.ALLOW_MOCK_MEETING, false),
  },

  /** Leave automatically after N minutes with nothing playing and no commands. 0 = never. */
  autoLeaveIdleMinutes: int(env.AUTO_LEAVE_IDLE_MIN, 0),
};

export default config;
