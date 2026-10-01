# MeetTunes

A **Discord-style music bot for video meetings.** Paste a Teams / Zoom / Google Meet / Webex / Slack link into
the web UI, and the bot joins the call as a guest and plays music into it. Control it from the web UI
(play, pause, next, previous, seek bar, volume, queue, ...) **or from the meeting chat** with commands such as
`#play`, `#pause`, `#volume 30`.

It runs in one small Docker container: headless-ish Chromium + a PulseAudio virtual microphone.
See [docs/FEASIBILITY.md](docs/FEASIBILITY.md) for how it works, per-platform notes, and what is/isn't verified.

> **Heads-up:** selectors for the real meeting products could not be tested from the development sandbox
> (only a mock meeting site could). Expect to tweak a platform now and then - see
> [Troubleshooting](#troubleshooting). Use it only where everyone in the meeting is OK with a music bot.

## Quick start

```bash
git clone https://github.com/faithbhasi/MeetTunes && cd MeetTunes
cp .env.example .env            # set UI_PASSWORD
mkdir -p music                  # optional: drop mp3/flac/... files here
docker compose up --build
```

Open <http://localhost:3000>, then:

1. Paste the meeting invite link and choose the bot's **display name**.
2. Click **Join meeting**. If the meeting has a lobby/waiting room, admit the bot.
   (Stuck on a screen, or need to sign in? Click **Live view** - you see the bot's browser and can click/type in it.)
3. Add music: search, paste a YouTube/SoundCloud/mp3 link, or play from the local library.
4. Anyone in the meeting chat can now type commands.

## Chat commands

Default prefix `#` (change it in Settings or with `COMMAND_PREFIX`). The bot replies in the meeting chat.

| Command | What it does |
|---|---|
| `#play <song or link>` (`#p`) | Queue the top search result / a link / a playlist. Alone: resume |
| `#playnow <song or link>` | Play right away |
| `#search <query>` then `#pick <n>` | Show 5 results, choose one |
| `#local <name>` | Play a file from the local library |
| `#pause`, `#resume`, `#stop` | Transport |
| `#next` (`#skip`), `#previous` (`#prev`) | Skip. `#previous` restarts the track if >5 s in |
| `#seek 1:30`, `#seek +30`, `#seek -15` | Jump |
| `#volume 30`, `#volume +10`, `#volume -10` | Set / adjust (0-100). `#volume` alone shows it |
| `#mute`, `#unmute` | Silence the bot without pausing |
| `#queue`, `#nowplaying` (`#np`) | Show queue / current track |
| `#remove <n>`, `#jump <n>`, `#clear` | Queue management |
| `#shuffle`, `#loop [off\|one\|all]` | Modes |
| `#help`, `#leave` | Help / make the bot leave |

Unknown `#hashtags` are ignored silently, so normal chat never triggers anything.

## Web UI

Meeting join/leave with status, now-playing card with a **draggable progress bar**, play/pause, previous/next,
stop, shuffle, loop, **volume slider with +/- buttons**, mute, output level meter, queue (click to play,
reorder, remove), search with results, local library upload, meeting chat log with a send box, Live view
(remote control of the bot's browser), and settings (prefix, who may use chat commands, track announcements).
Keyboard: `Space` play/pause, `Shift+←/→` previous/next.

## Configuration (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `UI_PASSWORD` | *(empty)* | HTTP basic-auth password for the UI (any username). **Set it.** |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Listen address |
| `BOT_NAME` | `MeetTunes` | Default display name |
| `COMMAND_PREFIX` | `#` | Chat command prefix |
| `COMMAND_ALLOWLIST` | *(everyone)* | Comma-separated display names allowed to use commands |
| `DEFAULT_VOLUME` / `MAX_VOLUME` | `50` / `100` | Volume (values above 100 amplify and may clip) |
| `SEARCH_PROVIDER` | `youtube` | `youtube` or `soundcloud` (also `#play sc: query`) |
| `YTDLP_ARGS` | | Extra yt-dlp args, e.g. `--js-runtimes node` |
| `YTDLP_COOKIES` | | Cookies file for yt-dlp (helps with YouTube bot checks) |
| `YTDLP_AUTO_UPDATE` | `true` | `yt-dlp -U` at container start |
| `JOIN_TIMEOUT_SEC` | `600` | How long to wait in a lobby |
| `AUTO_LEAVE_IDLE_MIN` | `0` | Leave after N idle minutes (0 = never) |
| `SELECTORS_FILE` | | JSON overriding per-platform selectors |
| `GUEST_EMAIL` | `meettunes@example.com` | Email typed into guest forms that demand one (Webex) |
| `HEADLESS` | `false` | `true` = no Xvfb (less compatible) |
| `ALLOW_PRIVATE_URLS` | `false` | Allow meeting/music URLs on private / LAN addresses |
| `ALLOWED_HOSTS` | | Extra `Host` names accepted when `UI_PASSWORD` is not set (localhost and IPs always work) |
| `COMMANDS_PER_10S` / `COMMANDS_GLOBAL_PER_10S` | `8` / `20` | Chat command rate limits (per sender / everyone) |
| `YTDLP_TIMEOUT_SEC` / `YTDLP_CONCURRENCY` | `45` / `3` | yt-dlp timeout and parallelism |
| `MONITOR_INTERVAL_MS` | `4000` | How often the meeting state is checked |
| `MUSIC_DIR`, `DATA_DIR` | `/music`, `/data` | Library / settings + browser profile |

Persisted in `/data`: settings and the Chromium profile, so a Google/Slack sign-in made through Live view survives restarts.

## Local development (no Docker)

```bash
npm install
AUDIO_SINK=none HEADLESS=true ALLOW_MOCK_MEETING=1 npm start   # decodes audio but discards it
npm test                       # 86 unit / security / robustness tests
npm run test:e2e               # 28 end-to-end tests (real meeting situations); Linux only: pulseaudio, Xvfb, ffmpeg; run as non-root
```

`ALLOW_MOCK_MEETING=1` serves a fake meeting at `/dev/mock-meeting?room=x` - paste that URL to try everything
without a real call. For real audio on Linux, run `docker/pulse-setup.sh` first and leave `AUDIO_SINK=pulse`.

## Security

Set `UI_PASSWORD`, keep the port on localhost or behind a TLS reverse proxy, and read
[docs/SECURITY.md](docs/SECURITY.md): trust boundaries, the 16 issues found and fixed in the hardening pass, and
the remaining limitations (e.g. chat display names are not authentication).

## Troubleshooting

* **Bot can't get past the join screen / chat commands do nothing on a platform.** Open **Live view** and
  finish the step by hand. Then open `/api/debug/dom` (also linked in Live view): it shows, per frame, how many
  chat messages the selectors match plus the DOM. Put corrected selectors in a JSON file and set `SELECTORS_FILE`:
  ```json
  { "zoom": { "chat": { "message": ".new-chat-class", "input": ["div.new-input"] }, "joinButton": ["button#go"] } }
  ```
  (Keys per platform: `cookie, continueInBrowser, nameInput, emailInput, camOff, micOn, audioJoin, joinButton,
  inMeeting, lobby, ended, leave, unmute, chat{open,message,sender,text,time,idAttr,input,send}`.)
  Even when `chat.message` matches nothing, a generic scan still picks up messages starting with the prefix.
* **Google Meet says you can't join.** Sign in a dedicated Google account via Live view once.
* **YouTube errors.** Update yt-dlp (restart the container), try `SEARCH_PROVIDER=soundcloud`, paste direct links,
  use the local library, or supply `YTDLP_COOKIES`.
* **Music sounds thin/choppy to others.** The meeting product's own audio processing; in Zoom enable
  "Original sound" for the bot's audio, in Teams use the music-optimised mic mode if the tenant offers it.
* **Chromium crashes.** Keep `shm_size: 1gb` (compose) and enough RAM.

## Layout

```
src/audio/      mixer (clock, gain, pause), player (queue/ffmpeg), resolver (yt-dlp), library, sinks (PulseAudio)
src/commands/   chat command parser + handler (shared with the web UI)
src/meeting/    Playwright session, in-page chat observer, platform adapters (zoom, teams, meet, webex, slack, generic)
src/public/     the web UI (no build step)
docker/         PulseAudio virtual-mic setup + entrypoint
test/           unit tests + Linux e2e (real Chromium + PulseAudio against a mock meeting)
```
