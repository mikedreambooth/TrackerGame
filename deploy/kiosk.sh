#!/usr/bin/env bash
# Launches Chromium full-screen on the PlayBox launcher, and relaunches it if it
# ever crashes. Extra launcher options go in the URL, e.g. KIOSK_URL=...?model=full
URL="${KIOSK_URL:-http://localhost:8080/}"
BROWSER="$(command -v chromium || command -v chromium-browser || command -v google-chrome)"

unclutter -idle 1 -root >/dev/null 2>&1 &

# Wait for the server.
for _ in $(seq 1 60); do curl -fs "$URL" >/dev/null && break; sleep 1; done

while true; do
  "$BROWSER" \
    --kiosk "$URL" \
    --use-fake-ui-for-media-stream \
    --autoplay-policy=no-user-gesture-required \
    --noerrdialogs --disable-infobars --disable-session-crashed-bubble \
    --disable-features=Translate \
    --check-for-update-interval=31536000 \
    --ignore-gpu-blocklist --enable-gpu-rasterization \
    --user-data-dir="$HOME/.config/playbox-chromium"
  sleep 2
done
