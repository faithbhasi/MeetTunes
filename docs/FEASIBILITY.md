# Feasibility assessment

**Question:** can a lightweight, containerised "music bot" join Teams / Zoom / Google Meet / Webex / Slack
meetings from a pasted link, play music into the call, and be controlled both from a web UI and from the
meeting chat (`#play`, `#pause`, `#volume 30`, ...), like a Discord music bot?

**Answer:** yes, with one important difference from Discord. Discord has an official bot API; the meeting
products do not offer anything comparable for *arbitrary* meetings. The only approach that works on any
invite link without being a registered app in the organisation is to **join as a browser guest** - exactly
what a human does - and feed the browser a virtual microphone. That is what MeetTunes does.

## How it works

```
 Web UI / chat command
        |
   MeetTunes (Node)
     |-- yt-dlp  -> finds / resolves the track
     |-- ffmpeg  -> decodes to 48 kHz stereo PCM
     |-- Mixer   -> 20 ms clock: volume, mute, pause, position  --> pacat
     |                                                              |
     |                              PulseAudio null sink "meettunes" (+ monitor)
     |                                                              |
     |                              virtual microphone "meettunes_mic"
     |                                                              |
     `-- Playwright -> Chromium (headful on Xvfb) -----------------+  (captures the "mic")
             joins https://zoom.us/wc/... / Teams / Meet / Webex as a guest,
             reads chat via a DOM observer, types replies into the chat box
```

* **Audio out:** the meeting client believes it is capturing a normal microphone. Meeting clients apply
  echo-cancellation / noise-suppression / AGC to microphones, which wrecks music, so an init script forces
  those constraints off on every `getUserMedia()` call (verified in the e2e test).
* **Chat in:** a `MutationObserver` in every frame reports new chat messages (de-duplicated, history ignored).
  If a platform's selectors stop matching, a generic "text that starts with the prefix" scan takes over.
* **Chat out:** the bot types into the chat box (multi-line replies as one message).
* **Control from the UI:** REST + WebSocket; plain HTML/JS, no build step.
* **Lightweight:** one container, one Chromium. Expect roughly 400-700 MB RAM and a fraction of a CPU core
  while in a meeting (the video tiles are the main cost; the bot never turns on video). One container = one
  meeting; run several containers for several meetings.

## Per-platform reality

| Platform | Join as guest from link | Chat read/write | Notes |
|---|---|---|---|
| **Zoom** | Yes - web client (`/wc/<id>/join`), name + passcode | Yes | Meetings can disallow web-client join, require sign-in, or use a waiting room (the bot waits; admit it). Zoom applies its own audio processing; hosts/participants can enable "Original sound" for best music quality. |
| **Microsoft Teams** | Yes - "Continue on this browser" -> name -> Join | Yes | Tenants can block anonymous join or force a lobby. Teams applies noise suppression server-side; "high fidelity music" mode is a user setting that the bot cannot toggle for itself. |
| **Google Meet** | Often **no** - many meetings require a signed-in Google account | Yes | Sign a dedicated bot account in once through *Live View*; the browser profile is persisted in the `/data` volume. "Ask to join" must be approved by a host. |
| **Webex** | Yes - "Join from your browser" with name + email | Yes (best effort) | A guest e-mail is required by the form (`GUEST_EMAIL`). |
| **Slack Huddles** | **No anonymous join** - requires a signed-in workspace member | Experimental | Sign in once through Live View. Huddle "chat" is the huddle thread; selectors are the least certain. |
| Anything else | Best effort (name + "Join" clicks) | Generic prefix scan | Live View lets you finish manually. |

## What is verified, and what is not

**Verified in this repository (automated, `npm test` / `npm run test:e2e`):**
* Mixer timing, pause/mute/volume, position accounting; player queue / next / previous / loop / seek / error handling.
* Real Chromium joins a **mock meeting** (pre-join form, lobby, chat panel that starts closed), reads chat
  commands from another "participant", replies in chat, and the page's own microphone analyser confirms the
  audio really arrives through the PulseAudio virtual mic, follows `#volume`, `#mute`, `#pause`, `#seek`.
* Chat observer: grouped senders, id/occurrence de-duplication, re-render safety, generic fallback, prefix change.
* yt-dlp integration (against a fake binary), URL safety guard, local library path-traversal protection,
  command parsing / handling, platform detection (including look-alike hostnames).

**NOT verified (could not be tested from the build sandbox - treat as the main risk):**
* **The DOM selectors for the real products.** They are written from knowledge of each web client and are
  the part most likely to need adjustment, because vendors change markup often. Mitigations built in:
  state-driven join loop (tolerates screens in any order), selector lists with fallbacks, the generic chat
  fallback, a `SELECTORS_FILE` override (no code change needed), *Live View* (see and click in the bot's
  browser, e.g. to admit prompts / sign in / solve a captcha) and `/api/debug/dom` (selector probe + DOM dump).
* Live YouTube playback (the sandbox blocks it). YouTube frequently blocks datacenter IPs and needs an
  up-to-date yt-dlp (auto-updated at container start), a JS runtime (`YTDLP_ARGS="--js-runtimes node"`)
  and sometimes cookies (`YTDLP_COOKIES`). `SEARCH_PROVIDER=soundcloud`, direct mp3 links and the local
  library avoid that problem.
* The Docker image build (no Docker daemon was available) - the steps mirror what the e2e test does by hand.

## Risks and policy

* **Terms of service.** Automating a browser guest and injecting audio may conflict with a platform's or an
  organisation's policies. Use it only in meetings where participants know and agree a music bot is joining.
  The bot announces itself in chat on join and uses a clearly bot-like display name by default.
* **Detection / hardening.** Platforms may add bot checks (captcha, sign-in walls) at any time; Live View
  is the escape hatch.
* **Audio latency.** Commands take effect in the mixer within ~100 ms; participants hear the change about
  0.6-1 s later because of the capture path and the meeting client's own buffering.
* **Security.** Anyone in the meeting can paste links, so URLs are restricted to http(s) and private /
  loopback / link-local targets are refused (redirects are not re-checked - run the container with no access
  to sensitive internal networks). The web UI should be password protected (`UI_PASSWORD`) and not exposed
  without TLS. `COMMAND_ALLOWLIST` restricts who may issue chat commands (matched by display name, which a
  meeting participant can usually choose freely - it is a convenience, not strong authentication).
* **Official alternatives** (more robust, but need tenant/admin buy-in per meeting): Teams Real-time Media
  bots (Graph Communications), Zoom Meeting SDK / RTMS, Google Meet Media API, Webex Meeting SDK / bot
  accounts. They would plug in as additional "platform" adapters.
