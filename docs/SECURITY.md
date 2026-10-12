# Security model, test results and hardening log

MeetTunes is a self-hosted, single-tenant tool: whoever can open the web UI controls a browser that is
signed into meetings (and possibly into a Google/Slack account). Treat the UI like an admin console.

## Trust boundaries

| Actor | Trusted? | What they can do |
|---|---|---|
| Web UI user (password) | Fully | Everything: join meetings, drive the bot's browser (Live view), upload files |
| **Meeting participants** | **No** | Type chat commands, paste links, choose any display name |
| Meeting page / music sites | No | Run in Chromium; send metadata (titles, thumbnails) that the UI renders |
| Other web pages in the operator's browser | No | May try CSRF / WebSocket hijack / DNS rebinding against `localhost:3000` |

## Findings from the hardening passes (all fixed, each covered by a test)

| # | Severity | Finding | Fix | Test |
|---|---|---|---|---|
| 1 | High | **Any participant could make the bot leave** by typing text such as "The meeting has ended" / "You were removed" / "waiting room": the monitor trusted page text | Monitor decides from the meeting toolbar only; text patterns are used only when the toolbar is gone | `scenarios: chat text that looks like...` |
| 2 | High | **First command after join was silently dropped** when other messages (e.g. the bot's own greeting) appeared in the same scan | Replaced the "several messages = history" heuristic with a generic scan that skips selector-owned text, plus explicit re-baselining when the panel is reopened | `chatObserver: REGRESSION...` |
| 3 | High | Cleanup race: closing the browser was treated as a crash, producing double cleanup that could wipe a *new* join's state | Idempotent, generation-guarded cleanup; closes we cause are ignored | `scenarios: host ends / removed / crash / two joins` |
| 4 | High | Short tracks lost their tail (Node discards unread child stdout once the process exits) | Explicit buffering `PcmSource` in flowing mode | `player: natural end advances`, e2e |
| 5 | Medium | `#constructor`, `#__proto__`, `#toString` resolved to `Object.prototype` members and were *executed* | `Object.hasOwn` command/alias lookup | `robustness: prototype-property command names` |
| 6 | Medium | SSRF: meeting links, `Live view -> goto` and played URLs could target `127.0.0.1`, `169.254.169.254`, `file:` | One guard (`assertSafeUrl`) on every URL entry point, re-checked at stream-resolution time | `security: SSRF`, `scenarios: live view` |
| 7 | Medium | DNS rebinding could drive an unauthenticated localhost UI from a hostile web page | `Host` allow-list (localhost, IPs, `ALLOWED_HOSTS`) when no password is set | `localhost.test.js` |
| 8 | Medium | Chat flood / many fake names could spawn unbounded yt-dlp processes and queue spam | Per-sender + global rate limit, yt-dlp concurrency cap and timeout, queue/arg/search-memory caps, chat send queue cap | `robustness`, `streamdrop`, `scenarios: command flood` |
| 9 | Medium | Meeting passcodes (`pwd=`, `p=`, `MTID=`) leaked into logs and UI status; `settings.json` was world-readable | URL redaction; settings file mode `0600` | `robustness: redactUrl`, `security: settings` |
| 10 | Medium | No clickjacking/CSP protection for a UI that can click inside a signed-in browser | CSP, `X-Frame-Options: DENY`, `nosniff`, `no-referrer`, `no-store` | `security: headers` |
| 11 | Low | Brute-forceable password; the browser's credential-less first request was counted as a failure | 10 failures / 5 min lockout, counting only presented-but-wrong credentials | `security: brute force` |
| 12 | Low | `$&` style prefix corrupted help text (`String.replace` patterns); `__proto__` keys could be loaded from `settings.json` | Function replacers; whitelisted keys only | `security: "$&" prefix / settings` |
| 13 | Low | Stalled WebSocket clients buffered unlimited screenshots | Backpressure: drop frames, then disconnect; client and payload caps | `security: WebSocket` |
| 14 | Low | Bot could not leave when moved back to the lobby after joining; cancel during join waited for navigation timeouts | Lobby-after-join state; cancel closes the browser immediately | `scenarios: relobby / cancel` |
| 15 | Low | A pause pressed while a track was loading was ignored; clean early EOF of a stream skipped the rest of the song | Pending-pause; early-EOF retry; zero-audio ends count as failures | `robustness`, `streamdrop` |
| 16 | Low | Missing PulseAudio devices meant the meeting heard silence with no explanation | Start-up device check, warning banner in the UI | `robustness: missing PulseAudio devices` |
| 17 | Medium | **Concurrent page input**: the monitor, chat replies, un-mute, leave and Live-view clicks all drive one mouse/keyboard; an "Unmute" click could land in the middle of typing a reply (found as a ~50% flaky test) | All page interaction is serialised through one lock | `scenarios: host mutes the bot on purpose` (6/6 stable) |
| 18 | Medium | Bot re-un-muted itself every 4 s even when a host muted it on purpose (rude, and a way to get removed) | Un-mute at join and when music starts (throttled to once per 30 s); the monitor never un-mutes | `scenarios: host mutes the bot on purpose` |
| 19 | Medium | Zoom-style "Join Audio by Computer" appears *after* entering, so the bot could sit in the call with no microphone | Audio join is attempted at join and retried by the monitor | `scenarios: late audio prompt` |
| 20 | Low | Queueing the same result twice (`#pick` twice) created two entries with one id, breaking `previous`/shuffle bookkeeping; a video link with `&list=` imported the whole playlist; malformed `%` in a URL and non-JSON yt-dlp output gave cryptic errors; a cancelled join logged "Joined"; one stray rejected promise could crash the process | Fresh id per entry; `--no-playlist` for watch+list links; safe decode + readable errors; state check; global `unhandledRejection` logger | `robustness`, `resolver`, `scenarios: cancel` |
| 21 | **High** | **SSRF guard bypass via IPv6**: `http://[::ffff:127.0.0.1]/` (the URL parser rewrites it to `[::ffff:7f00:1]`), `[::ffff:169.254.169.254]`, NAT64 `64:ff9b::/96`, 6to4 `2002::/16`, `::a.b.c.d` and site-local `fec0::/10` were treated as public, so a meeting participant could point the bot at loopback services or cloud metadata | IPv6 is parsed into bytes and any embedded IPv4 is checked; Teredo, multicast, ULA, link-/site-local and unparsable forms are refused | `netguard: IPv4 hidden inside IPv6...` |
| 22 | Low | API accepted a fractional queue index (leaking `Cannot read properties of undefined`), an index past the end silently played track 1, and `add-track` accepted unsafe links and negative / absurd durations | Strict integer position checks; `add-track` runs the SSRF guard up front and bounds `duration` | `player: fractional / non-integer queue positions...` |

Dependency audit: `npm audit` reports 0 vulnerabilities. Keep **yt-dlp** current (it parses hostile pages);
the container updates it at start.

## Known limitations / residual risk

* **Display names are not authentication.** `COMMAND_ALLOWLIST` matches the sender name shown in chat, which a
  participant can often choose freely. Use it to reduce accidents, not to stop a determined guest. Any
  participant can issue `#leave`, `#stop`, `#clear` unless the allow-list is set.
* **Redirects are not re-validated** for played URLs (yt-dlp/ffmpeg follow them). The effect is limited to
  audio being played into the meeting, but keep the container off sensitive internal networks anyway.
* **Chromium runs with `--no-sandbox`** by default in Docker (the container is the sandbox: non-root user, all
  capabilities dropped, `no-new-privileges`, pids/memory limits). Meeting pages are untrusted content; keep
  the image updated. To use Chromium's own sandbox set `CHROMIUM_NO_SANDBOX=false` and supply a suitable
  seccomp profile.
* **No TLS built in.** Basic-auth credentials travel in clear over plain HTTP. Put a TLS reverse proxy in
  front for anything but localhost, and set `ALLOWED_HOSTS`/`UI_PASSWORD`.
* **Real platform markup is untested** (see FEASIBILITY.md): selector drift can break joining/chat until the
  selectors are updated; Live view is the fallback.
* Terms of service: see FEASIBILITY.md.

## How to re-run the checks

```bash
npm test            # 96 unit/security/robustness tests (no audio hardware needed)
npm run test:e2e    # 52 end-to-end tests with real Chromium + PulseAudio (Linux, non-root)
npm audit
```
