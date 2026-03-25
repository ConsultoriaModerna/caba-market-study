#!/bin/bash
# setup.sh — One-time VPS setup for CABA Market Study scraper
# Run on a fresh Ubuntu 22.04+ droplet as root
# Usage: bash setup.sh

set -e

echo "═══ CABA Market Study — VPS Setup ═══"

# System
apt-get update -qq
apt-get install -y -qq curl git xvfb fonts-liberation libnss3 libatk-bridge2.0-0 \
  libdrm2 libxcomposite1 libxdamage1 libxrandr2 libgbm1 libasound2 \
  libpangocairo-1.0-0 libgtk-3-0 libxshmfence1 > /dev/null

# Node.js 20
if ! command -v node &> /dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - > /dev/null
  apt-get install -y -qq nodejs > /dev/null
fi
echo "Node: $(node -v)"

# Chrome
if ! command -v google-chrome &> /dev/null; then
  wget -q https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
  dpkg -i google-chrome-stable_current_amd64.deb || apt-get -f install -y -qq
  rm google-chrome-stable_current_amd64.deb
fi
echo "Chrome: $(google-chrome --version)"

# Project
PROJ_DIR="/opt/caba-market-study"
if [ ! -d "$PROJ_DIR" ]; then
  git clone https://github.com/ConsultoriaModerna/caba-market-study.git "$PROJ_DIR"
fi
cd "$PROJ_DIR"
npm install --production

# Create .env
if [ ! -f .env ]; then
  echo "SUPABASE_URL=https://ysynltkotzizayjtoujf.supabase.co" > .env
  echo "SUPABASE_SERVICE_ROLE_KEY=YOUR_KEY_HERE" >> .env
  echo ""
  echo "⚠️  Edit /opt/caba-market-study/.env with your Supabase service role key"
fi

echo ""
echo "✅ Setup complete. Next steps:"
echo "  1. Edit .env with credentials"
echo "  2. Run: bash scripts/vps/seed-cloudflare.sh  (one-time, to get CF cookies)"
echo "  3. Run: bash scripts/vps/run-nightly.sh      (or set up cron)"
