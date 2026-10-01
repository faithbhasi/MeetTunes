# MeetTunes: Node + Chromium (Playwright) + PulseAudio virtual microphone + ffmpeg + yt-dlp.
# The Playwright base image already contains Chromium and its system libraries; keep the tag in sync
# with the "playwright" version in package.json.
FROM mcr.microsoft.com/playwright:v1.56.1-noble

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      pulseaudio pulseaudio-utils ffmpeg xvfb ca-certificates curl tini \
    && rm -rf /var/lib/apt/lists/*

# Standalone yt-dlp binary (no Python needed). It is updated at container start - YouTube changes often.
RUN curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux -o /usr/local/bin/yt-dlp \
    && chmod +x /usr/local/bin/yt-dlp

WORKDIR /app
COPY package.json package-lock.json ./
RUN PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --omit=dev
COPY src ./src
COPY docker ./docker
RUN chmod +x docker/*.sh

# Run as an unprivileged user (PulseAudio refuses to run as root, and it is safer anyway).
RUN useradd -m -u 1001 mt && mkdir -p /data /music && chown -R mt:mt /data /music /app
USER mt

ENV NODE_ENV=production \
    PORT=3000 HOST=0.0.0.0 \
    DATA_DIR=/data MUSIC_DIR=/music \
    AUDIO_SINK=pulse HEADLESS=false \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
VOLUME ["/data", "/music"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD curl -fsS -u ":${UI_PASSWORD:-}" http://127.0.0.1:${PORT}/api/settings >/dev/null || exit 1
ENTRYPOINT ["/usr/bin/tini", "--", "/app/docker/entrypoint.sh"]
