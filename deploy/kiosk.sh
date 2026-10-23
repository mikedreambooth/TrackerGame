#!/usr/bin/env bash
# Launches Chromium full-screen on the PlayBox site, and relaunches it if it ever
# crashes. Launcher options go in the URL, e.g. KIOSK_URL=https://...?model=full
# Once loaded, the site is cached offline by its service worker.
URL="${KIOSK_URL:-http://localhost:8080/}"
BROWSER="$(command -v chromium || command -v chromium-browser || command -v google-chrome)"

unclutter -idle 1 -root >/dev/null 2>&1 &

# Give the network / local server a moment (the cached site works offline anyway).
for _ in $(seq 1 20); do curl -fs "$URL" >/dev/null && break; sleep 1; done

# Wait for the pose tracker (the page also waits and reconnects, but this avoids a
# "waiting for the tracker" flash at boot).
for _ in $(seq 1 60); do (echo >/dev/tcp/127.0.0.1/8765) 2>/dev/null && break; sleep 1; done

while true; do
  "$BROWSER" \
    --kiosk "$URL" \
    --autoplay-policy=no-user-gesture-required \
    --noerrdialogs --disable-infobars --disable-session-crashed-bubble \
    --disable-features=Translate \
    --check-for-update-interval=31536000 \
    --ignore-gpu-blocklist --enable-gpu-rasterization \
    --user-data-dir="$HOME/.config/playbox-chromium"
  sleep 2
done
