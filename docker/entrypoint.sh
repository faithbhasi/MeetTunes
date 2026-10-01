#!/bin/sh
set -eu

# 1. virtual audio devices (music sink -> virtual microphone)
/app/docker/pulse-setup.sh

# 2. virtual display: a real (headful) Chromium is far more compatible with meeting clients than headless
if [ "${HEADLESS:-false}" != "true" ]; then
  export DISPLAY="${DISPLAY:-:99}"
  Xvfb "$DISPLAY" -screen 0 1400x1000x24 -nolisten tcp >/dev/null 2>&1 &
  sleep 1
fi

# 3. keep yt-dlp fresh (best effort)
if [ "${YTDLP_AUTO_UPDATE:-true}" = "true" ]; then
  yt-dlp -U >/dev/null 2>&1 || true
fi

# Chromium keeps stale lock files in a persisted profile after an unclean stop
rm -f "${PROFILE_DIR:-${DATA_DIR:-/data}/profile}"/Singleton* 2>/dev/null || true

exec node /app/src/server.js
