#!/bin/sh
# Creates the virtual audio plumbing MeetTunes needs (idempotent):
#
#   MeetTunes (pacat) --> [meettunes] null sink --monitor--> [meettunes_mic] virtual microphone --> Chromium
#   Chromium playback (what meeting people say) --> [meeting_out] null sink (discarded, prevents echo)
#
set -eu
SINK="${PULSE_MUSIC_SINK:-meettunes}"
MIC="${PULSE_MIC_SOURCE:-meettunes_mic}"
OUT="${PULSE_MEETING_SINK:-meeting_out}"

export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/runtime-$(id -u)}"
mkdir -p "$XDG_RUNTIME_DIR" && chmod 700 "$XDG_RUNTIME_DIR"

if ! pactl info >/dev/null 2>&1; then
  # -n: skip the default hardware-probing script; we only need a native socket + our null sinks.
  pulseaudio -n --daemonize=yes --exit-idle-time=-1 --disallow-exit \
    -L "module-native-protocol-unix" --log-target=stderr 2>/dev/null || true
  i=0; until pactl info >/dev/null 2>&1; do i=$((i+1)); [ $i -gt 50 ] && { echo "pulseaudio did not start" >&2; exit 1; }; sleep 0.1; done
fi

has() { pactl list short "$1" | cut -f2 | grep -qx "$2"; }

has sinks "$SINK" || pactl load-module module-null-sink sink_name="$SINK" rate=48000 channels=2 \
  sink_properties=device.description=MeetTunes-Music >/dev/null
has sinks "$OUT"  || pactl load-module module-null-sink sink_name="$OUT" rate=48000 channels=2 \
  sink_properties=device.description=Meeting-Audio-Out >/dev/null
has sources "$MIC" || pactl load-module module-remap-source master="$SINK.monitor" source_name="$MIC" \
  source_properties=device.description=MeetTunes-Microphone >/dev/null

pactl set-default-sink "$OUT"
pactl set-default-source "$MIC"
echo "audio ready: $SINK -> $MIC (mic), $OUT (meeting playback sink)"
