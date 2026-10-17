#!/usr/bin/env bash
# Turns a Debian/Ubuntu machine (e.g. the old laptop behind the TV) into a
# PlayBox console: server starts on boot, Chromium opens full-screen on login.
#
#   cd ~/TrackerGame && ./deploy/setup-kiosk.sh
#
# Assumes: a desktop session with auto-login enabled (Settings → Users →
# Automatic Login), and this repo cloned in your home folder.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
USER_NAME="$(id -un)"

echo "==> Installing system packages"
sudo apt-get update
sudo apt-get install -y curl unclutter v4l-utils
if ! command -v chromium >/dev/null && ! command -v chromium-browser >/dev/null && ! command -v google-chrome >/dev/null; then
  sudo apt-get install -y chromium || sudo apt-get install -y chromium-browser || sudo snap install chromium
fi
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  echo "==> Installing Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

echo "==> Installing and building PlayBox"
cd "$REPO"
npm install
npm run build

echo "==> Server service (starts on boot)"
sudo tee /etc/systemd/system/playbox.service >/dev/null <<EOF
[Unit]
Description=PlayBox server
After=network.target

[Service]
User=$USER_NAME
WorkingDirectory=$REPO
ExecStart=$(command -v node) $REPO/server/server.mjs
Restart=always
RestartSec=2
Environment=PORT=8080

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now playbox.service

echo "==> Kiosk browser on login"
mkdir -p "$HOME/.config/autostart"
cat > "$HOME/.config/autostart/playbox-kiosk.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=PlayBox Kiosk
Exec=$REPO/deploy/kiosk.sh
X-GNOME-Autostart-enabled=true
EOF
chmod +x "$REPO/deploy/kiosk.sh"

echo "==> Keep the screen awake and the lid-closed laptop running"
gsettings set org.gnome.desktop.session idle-delay 0 2>/dev/null || true
gsettings set org.gnome.desktop.screensaver lock-enabled false 2>/dev/null || true
sudo sed -i 's/^#\?HandleLidSwitch=.*/HandleLidSwitch=ignore/; s/^#\?HandleLidSwitchExternalPower=.*/HandleLidSwitchExternalPower=ignore/' /etc/systemd/logind.conf
echo "    (lid-close is now ignored; takes effect after reboot)"

echo
echo "Done. Reboot to start in kiosk mode. Admin page: http://$(hostname -I | awk '{print $1}'):8080/admin.html"
echo "Cameras found:"
v4l2-ctl --list-devices 2>/dev/null || true
