#!/usr/bin/env bash
# Turns a Debian/Ubuntu machine (e.g. the old laptop behind the TV) into a
# PlayBox console: Chromium opens full-screen on the site at login.
#
# Hosted site (recommended) — the box just needs a browser:
#   ./deploy/setup-kiosk.sh https://mikedreambooth.github.io/TrackerGame/
#
# Fully local — builds the site here and serves it from this machine:
#   ./deploy/setup-kiosk.sh
#
# Assumes a desktop session with auto-login enabled
# (Settings → Users → Automatic Login).
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
SITE_URL="${1:-}"

echo "==> Installing system packages"
sudo apt-get update
sudo apt-get install -y curl unclutter v4l-utils
if ! command -v chromium >/dev/null && ! command -v chromium-browser >/dev/null && ! command -v google-chrome >/dev/null; then
  sudo apt-get install -y chromium || sudo apt-get install -y chromium-browser || sudo snap install chromium
fi

if [ -z "$SITE_URL" ]; then
  echo "==> Local mode: building the site and serving it on this machine"
  if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y nodejs
  fi
  cd "$REPO"
  npm install
  npm run build
  sudo tee /etc/systemd/system/playbox.service >/dev/null <<EOF
[Unit]
Description=PlayBox local site
After=network.target

[Service]
User=$(id -un)
WorkingDirectory=$REPO
ExecStart=$(command -v node) $REPO/server/server.mjs
Restart=always
RestartSec=2
Environment=PORT=8080 HOST=127.0.0.1

[Install]
WantedBy=multi-user.target
EOF
  sudo systemctl daemon-reload
  sudo systemctl enable --now playbox.service
  SITE_URL="http://localhost:8080/"
fi

echo "==> Kiosk browser on login → $SITE_URL"
mkdir -p "$HOME/.config/autostart"
cat > "$HOME/.config/autostart/playbox-kiosk.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=PlayBox Kiosk
Exec=env KIOSK_URL=$SITE_URL $REPO/deploy/kiosk.sh
X-GNOME-Autostart-enabled=true
EOF
chmod +x "$REPO/deploy/kiosk.sh"

echo "==> Keep the screen awake and the lid-closed laptop running"
gsettings set org.gnome.desktop.session idle-delay 0 2>/dev/null || true
gsettings set org.gnome.desktop.screensaver lock-enabled false 2>/dev/null || true
sudo sed -i 's/^#\?HandleLidSwitch=.*/HandleLidSwitch=ignore/; s/^#\?HandleLidSwitchExternalPower=.*/HandleLidSwitchExternalPower=ignore/' /etc/systemd/logind.conf

echo
echo "Done. Reboot to start in kiosk mode."
echo "Cameras found:"
v4l2-ctl --list-devices 2>/dev/null || true
