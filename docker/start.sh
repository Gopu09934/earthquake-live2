#!/bin/bash
set -euo pipefail

#############################################
# Validate required environment
#############################################
if [ -z "${YOUTUBE_STREAM_KEY:-}" ]; then
    echo "ERROR: YOUTUBE_STREAM_KEY is not set"
    exit 1
fi

WIDTH="${STREAM_WIDTH:-1280}"
HEIGHT="${STREAM_HEIGHT:-720}"
FPS="${STREAM_FPS:-24}"
DISPLAY_NUM=99
export DISPLAY=":${DISPLAY_NUM}"

echo "========================================"
echo "EQ Watch -> YouTube Live"
echo "Resolution : ${WIDTH}x${HEIGHT}"
echo "FPS        : ${FPS}"
echo "========================================"

#############################################
# 1. Virtual display
#############################################
echo "Starting Xvfb on display :${DISPLAY_NUM}..."
Xvfb ":${DISPLAY_NUM}" -screen 0 "${WIDTH}x${HEIGHT}x24" -nolisten tcp &
XVFB_PID=$!
sleep 2

#############################################
# 2. Local static server for the dashboard
#    (fetch() of data/*.json needs a real http:// origin, not file://)
#############################################
echo "Starting local dashboard server on :8080..."
python3 -m http.server 8080 --directory /app/site --bind 127.0.0.1 &
HTTP_PID=$!
sleep 1

#############################################
# 3. Chromium, rendering the dashboard, on the virtual display
#############################################
echo "Launching Chromium via Puppeteer..."
DASHBOARD_URL="${DASHBOARD_URL:-http://localhost:8080/index.html}" \
    node /app/render.js "$WIDTH" "$HEIGHT" &
RENDER_PID=$!

# give Chromium time to launch, load the page, and complete its first
# live data fetch before ffmpeg starts capturing frames
sleep 10

cleanup() {
    echo "Shutting down..."
    kill "$RENDER_PID" "$HTTP_PID" "$XVFB_PID" 2>/dev/null || true
    wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

#############################################
# 4. Optional looping background audio (same convention as the video
#    stream project — comma-separated URLs, looped via ffmpeg concat)
#############################################
AUDIO_INPUT_ARGS=(-f lavfi -i "anullsrc=r=44100:cl=stereo")
AUDIO_MAP="1:a"

if [ -n "${AUDIO_URL:-}" ]; then
    PLAYLIST="/tmp/audio_playlist.txt"
    {
        echo "ffconcat version 1.0"
        IFS=',' read -ra RAW_AUDIO_URLS <<< "$AUDIO_URL"
        for a in "${RAW_AUDIO_URLS[@]}"; do
            a="${a#"${a%%[![:space:]]*}"}"
            a="${a%"${a##*[![:space:]]}"}"
            [ -n "$a" ] || continue
            esc="${a//\'/\'\\\'\'}"
            echo "file '${esc}'"
        done
    } > "$PLAYLIST"

    if [ -s "$PLAYLIST" ] && grep -q "^file " "$PLAYLIST"; then
        echo "Background audio enabled from AUDIO_URL."
        AUDIO_INPUT_ARGS=(-stream_loop -1 -protocol_whitelist file,http,https,tcp,tls,crypto -f concat -safe 0 -i "$PLAYLIST")
    else
        echo "NOTICE: AUDIO_URL set but produced no valid entries — streaming silent audio."
    fi
else
    echo "NOTICE: AUDIO_URL not set — streaming with a silent audio track (YouTube requires an audio stream)."
fi

#############################################
# 5. ffmpeg: capture the X11 display, push to YouTube RTMP
#    Retries a few times on transient failure before giving up (the
#    outer GitHub Actions restart/watchdog workflows handle recovery
#    beyond that).
#############################################
MAX_RETRIES="${MAX_RETRIES:-3}"
RETRY_DELAY="${RETRY_DELAY:-5}"
attempt=1

while [ "$attempt" -le "$MAX_RETRIES" ]; do
    echo "----------------------------------------"
    echo "Starting ffmpeg capture (attempt ${attempt}/${MAX_RETRIES})..."
    echo "----------------------------------------"

    ffmpeg \
    -hide_banner \
    -loglevel warning \
    -stats \
    -nostdin \
    -f x11grab \
    -video_size "${WIDTH}x${HEIGHT}" \
    -framerate "${FPS}" \
    -i "${DISPLAY}.0" \
    "${AUDIO_INPUT_ARGS[@]}" \
    -c:v libx264 \
    -preset veryfast \
    -tune zerolatency \
    -pix_fmt yuv420p \
    -b:v 2500k \
    -maxrate 2800k \
    -bufsize 5600k \
    -g $((FPS * 2)) \
    -keyint_min $((FPS * 2)) \
    -sc_threshold 0 \
    -c:a aac \
    -b:a 128k \
    -ar 44100 \
    -ac 2 \
    -map 0:v \
    -map "${AUDIO_MAP}" \
        -f flv \
        "rtmp://a.rtmp.youtube.com/live2/${YOUTUBE_STREAM_KEY}"
    exit_code=$?
    set -e

    if [ "$exit_code" -eq 0 ]; then
        echo "ffmpeg exited normally."
        break
    fi

    echo "WARNING: ffmpeg exited with code ${exit_code} (attempt ${attempt}/${MAX_RETRIES})."
    attempt=$((attempt + 1))

    # Chromium may have died along with a bad capture — check and relaunch if needed.
    if ! kill -0 "$RENDER_PID" 2>/dev/null; then
        echo "Chromium process is no longer running — relaunching..."
        DASHBOARD_URL="${DASHBOARD_URL:-http://localhost:8080/index.html}" \
            node /app/render.js "$WIDTH" "$HEIGHT" &
        RENDER_PID=$!
        sleep 8
    fi

    if [ "$attempt" -le "$MAX_RETRIES" ]; then
        echo "Retrying in ${RETRY_DELAY}s..."
        sleep "$RETRY_DELAY"
    else
        echo "ERROR: Max retries reached. Exiting — the restart/watchdog workflows will start a fresh run."
        exit 1
    fi
done
