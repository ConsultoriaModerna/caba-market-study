#!/bin/bash
# seed-cloudflare.sh — One-time: open Chrome visible to pass Cloudflare manually
# After CF is passed, cookies are saved in .chrome-profile and reused by the scraper
# Usage: bash scripts/vps/seed-cloudflare.sh

set -e
cd /opt/caba-market-study

echo "Opening Chrome with xvfb + VNC..."
echo "You'll need to VNC into the server to solve the Cloudflare challenge."
echo ""
echo "Steps:"
echo "  1. Install a VNC viewer on your Mac (e.g. 'open vnc://YOUR_SERVER_IP:5900')"
echo "  2. The Chrome window will open to zonaprop.com.ar"
echo "  3. Solve the Cloudflare challenge (click the checkbox)"
echo "  4. Close Chrome (Ctrl+C here)"
echo ""

# Install x11vnc if not present
which x11vnc > /dev/null 2>&1 || apt-get install -y -qq x11vnc > /dev/null

# Start xvfb
export DISPLAY=:99
Xvfb :99 -screen 0 1280x800x24 &
XVFB_PID=$!
sleep 1

# Start VNC server (no password for simplicity — restrict via firewall)
x11vnc -display :99 -forever -nopw &
VNC_PID=$!
sleep 1

echo "VNC running on port 5900. Connect now."
echo "Press Ctrl+C when done."

# Open Chrome
google-chrome \
  --no-sandbox \
  --disable-setuid-sandbox \
  --user-data-dir=/opt/caba-market-study/.chrome-profile \
  --window-size=1280,800 \
  "https://www.zonaprop.com.ar" &

wait

kill $VNC_PID $XVFB_PID 2>/dev/null
echo "Done. Cloudflare cookies saved."
