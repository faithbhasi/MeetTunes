# Test report: full functional + GUI pass

Scope: every function of the app, exercised the way a user would use it, in real browsers with real audio
(real Chromium, real PulseAudio virtual microphone, a mock meeting site, a local music site and a fake yt-dlp
that talks to it). Run with `npm test` (unit/security/robustness) and `npm run test:e2e` (meeting situations +
the GUI test). Screenshots from the GUI run: `GUI_SHOTS=/some/dir npm run test:e2e`.

## Result

| Suite | Tests | Result |
|---|---|---|
| Unit / security / robustness | 96 | all pass |
| End-to-end: basic meeting flow | 9 | all pass |
| End-to-end: meeting situations (deny, end, kick, lobby, iframe chat, mute, crash, flood, ...) | 21 | all pass |
| End-to-end: **GUI, every control** | 22 | all pass |

## What the GUI test exercises (one real user action per line, checked in the UI *and* in the meeting's audio)

| Area | Functions tested |
|---|---|
| First load | idle status, empty queue, disabled seek bar, command cheat sheet, no console errors |
| Join | empty link / garbage / `ftp:` / `javascript:` rejected with a message; platform auto-detection note; display name used in the meeting; lobby status + Cancel button; inputs locked while busy; "In meeting"; Enter key joins; join works again after leaving |
| Meeting chat | send box posts to the meeting; participant commands appear highlighted; bot reply logged |
| Local library | list with metadata, upload (valid file, invalid type rejected with message), play by clicking a row, add to queue, delete (with confirm) |
| Search / add music | search results, add to queue, play now (icon and row click), quick add by text, paste a link, paste a playlist (3 tracks), direct `.mp3` URL, error shown for an unsupported link, empty search is a no-op |
| Transport | play/pause (icon, label, **silence in the meeting while paused**), next, previous (restarts after 5 s, goes back before), stop (keeps the queue), play after stop, keyboard: Space, Shift+Left/Right |
| Progress | elapsed/total labels advance, bar moves, **clicking the bar seeks** and audio continues from the new position |
| Volume | + / - buttons, mouse drag on the slider, mute button (icon, "muted" label, **silent in the meeting but not paused**), unmute, slider follows volume changed via chat |
| Modes | shuffle on/off, loop off → all → one → off (titles, icons, `aria-pressed`) |
| Queue | click to play, move up / down (cursor follows), remove (earlier row, current row), count label, clear |
| End of queue | goes idle by itself; loop-all wraps around |
| Settings | prefix change (cheat sheet + chat both switch), invalid prefix reported and nothing saved, allowlist (case-insensitive), announcements on/off |
| Live view | frame appears, click / type / Enter / Tab / scroll reach the bot's browser, diagnostics link, Esc closes, no stale frame after the bot leaves |
| Resilience | server connection dropped: banner, automatic reconnect, fresh state shown |
| Layout / a11y | mobile viewport (no horizontal scroll, controls reachable), every button has an accessible name, toggle buttons expose state |

## Bugs found in this pass (all fixed, each now covered by a test)

| # | Severity | Bug | Found by | Fix |
|---|---|---|---|---|
| 1 | **High** | **Player race:** `clear()`, removing the last track, or `stop()` while a track was still *loading* did not cancel the load, so a ghost track started playing against an empty queue (status "playing", nothing in the queue) | GUI test (queue clear) → unit regression | Every teardown invalidates pending starts |
| 2 | Medium | The **Leave button was visible at idle** (and the Live-view "stale frame" could never be hidden): `.btn { display:inline-flex }` overrode the HTML `hidden` attribute | GUI test (first load) | `[hidden] { display:none !important }` |
| 3 | Medium | After touching the volume slider once, it **ignored volume changes made elsewhere** (chat `#volume`, API) because it kept focus | GUI test | Only ignore updates while the user is actually dragging; re-sync afterwards |
| 4 | Medium | **Shift+←/→ shortcuts stopped working** once any button had focus (the guard added for Space was too broad) | GUI test | Per-key guards; never hijack text fields or browser shortcuts |
| 5 | Medium | **Invalid command prefix silently ignored** while the UI said "Settings saved" | GUI test | Server rejects bad input with a reason; the dialog stays open |
| 6 | Low | **Enter in the meeting-link box did nothing** | GUI test | Enter joins |
| 7 | Low | No indication when the server connection was lost | GUI test | "Connection lost - reconnecting…" banner |
| 8 | Low | Live view kept showing the previous meeting's last frame | GUI test | Cleared when the session ends |
| 9 | Low | Icon-only buttons had no accessible name; toggles didn't expose state | a11y test | `aria-label`, `aria-pressed` |
| 10 | Low | A background settings update would have overwritten text typed in an open Settings dialog | code review | Don't re-render fields while the dialog is open |

## Improvements added

- **Volume is remembered** across restarts (saved a moment after the last change, clamped, private file).
- Seek bar shows the new position immediately instead of jumping back for a moment.
- Music-folder changes appear without a page reload (refresh every 20 s and when the tab regains focus).
- Chat log in the UI is capped; a stale search error is cleared when you type a new query.
- Test tooling: local music site with Range support, fake yt-dlp, per-test state reset (no cascading failures), optional screenshots.

## Test-only issues (not product bugs, listed for honesty)

`innerText` returns the CSS-uppercased label ("NOW PLAYING"); `class.includes('on')` also matches `icon-btn`;
asserting UI text before the WebSocket update arrived; counting UI rows before the previous add had rendered.
All fixed by waiting for the UI (`eventually`) and resetting state per test.

## Not covered (unchanged limitations)

- **Real Teams / Zoom / Meet / Webex / Slack pages**: only the mock meeting is available offline. Selectors may
  need adjusting (Live view + `SELECTORS_FILE`).
- **Real YouTube/SoundCloud**: blocked in the test sandbox; yt-dlp is simulated.
- **Docker image build**: no Docker daemon was available.
- Firefox/Safari for the web UI (tests use Chromium).
