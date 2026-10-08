# Changelog

All notable changes to MeetTunes. Each release is a git tag (`v0.1.0`, `v0.2.0`, ...), so any earlier
version can be viewed or run with `git checkout v0.1.0`, and compared with
`git diff v0.1.0 v0.2.0`. Format follows [Keep a Changelog](https://keepachangelog.com/).

## [0.2.0] - 2026-10-08

### Security
- **Fixed an SSRF guard bypass through IPv6.** Addresses such as `http://[::ffff:127.0.0.1]/`,
  `[::ffff:169.254.169.254]`, NAT64 (`64:ff9b::/96`), 6to4 (`2002::/16`), `::a.b.c.d` and site-local
  `fec0::/10` were treated as public, so a meeting participant could aim the bot at loopback services or
  cloud metadata. IPv6 is now parsed into bytes and any embedded IPv4 address is checked; Teredo, multicast,
  unique-local, link-local and unparsable forms are refused. (`docs/SECURITY.md` #21)
- `POST /api/queue/add-track` now runs the same URL guard up front instead of only at play time.

### Fixed
- Fractional or otherwise non-integer queue positions (`remove`, `move`, `play`) are rejected instead of
  throwing an internal `Cannot read properties of undefined` error; the API no longer silently plays track 1
  for an out-of-range index.
- **Chat messages could be lost silently when the meeting client closes its chat panel** (greeting or command
  reply never appeared, nothing logged). Typing into a panel that has just closed does not raise an error, so the
  retry logic never ran. Sending now checks that the input is still visible before and the text is gone after
  sending, clears leftovers before each attempt, reopens the panel by polling instead of fixed 1.7 s of sleeping,
  fails fast (1.5 s) on vanished elements, and tries up to 4 times. The "chat panel closes itself repeatedly"
  scenario failed ~1 run in 3 before and passed 15 of 15 after.
- `add-track` no longer accepts negative or absurd durations (they broke the progress bar).

### Tests
- Unit tests: 96 -> 99 (IPv6 SSRF regression, public IPv6 still allowed, player index validation).

## [0.1.0] - 2026-10-07

First release.

### Added
- Joins Zoom, Teams, Google Meet, Webex and Slack huddle links as a browser guest (Playwright + Chromium) and
  plays music into the meeting through a virtual microphone (PulseAudio).
- Web UI: join form with display name, full transport controls (play/pause, next, previous, skip, stop, seek by
  dragging the progress bar, volume, mute, loop, shuffle), queue management, search, local library upload,
  chat view and a Live view of the bot's browser.
- Chat commands (`#play`, `#pause`, `#next`, `#previous`, `#mute`, `#volume 30`, `#search`, `#queue`, ...)
  with allow-list, rate limiting and a configurable prefix.
- Docker image and `docker-compose.yml`; optional `UI_PASSWORD`.
- Hardening (20 findings, see `docs/SECURITY.md`), 96 unit tests and 52 real-browser end-to-end tests.
