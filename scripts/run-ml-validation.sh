#!/bin/bash
# Scheduled ML scraper validation: ROTATE_EVERY=1, 5 pages, headless.
# Self-unloads the LaunchAgent at the end so it's a one-shot.

set -u
PROJECT_DIR="/Users/nico/AI/PROJECTS/real-estate"
LOG="/tmp/ml-validation-$(date +%Y%m%d-%H%M).log"
SUMMARY="$HOME/Desktop/ml-validation-result.txt"
AGENT_LABEL="com.inmofindr.ml-validate"

cd "$PROJECT_DIR" || exit 1

# Keep Mac awake for the run (max 15 min).
caffeinate -i -t 900 &
CAF_PID=$!

{
  echo "=== ML validation run — $(date '+%Y-%m-%d %H:%M:%S %Z') ==="
  echo "Branch: $(git rev-parse --abbrev-ref HEAD)"
  echo "Commit: $(git rev-parse --short HEAD)"
  echo

  # Clean state
  osascript -e 'quit app "Google Chrome"' 2>/dev/null
  sleep 2
  killall "Google Chrome" 2>/dev/null
  rm -rf "$HOME/.cache/caba-ml-chrome-profile"

  # Source env
  set -a
  source .env
  set +a

  # Run smoke
  ML_HEADLESS=1 PROXY_MAX_REQUESTS=200 \
    /Users/nico/.nvm/versions/node/v23.3.0/bin/node \
    scripts/vps/scrape-ml-headless.mjs 5 --zone=caba --type=casa
  EXIT=$?

  echo
  echo "=== exit=$EXIT ==="
} > "$LOG" 2>&1

# Build summary file Nico will see on Desktop
{
  echo "ML validation @ $(date '+%Y-%m-%d %H:%M %Z')"
  echo "Full log: $LOG"
  echo
  echo "--- last 25 lines ---"
  tail -25 "$LOG"
  echo
  echo "--- DB check (recently scraped) ---"
  echo "Run this in Supabase SQL editor when you wake up:"
  echo "  SELECT COUNT(*) FILTER (WHERE last_seen_at > NOW() - INTERVAL '8 hours') AS scraped_overnight,"
  echo "         COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '8 hours') AS new_overnight"
  echo "  FROM properties WHERE source='mercadolibre' AND property_type='casa';"
} > "$SUMMARY"

kill "$CAF_PID" 2>/dev/null

# Self-cleanup: unload the LaunchAgent so it's truly one-shot.
launchctl bootout "gui/$(id -u)/$AGENT_LABEL" 2>/dev/null
rm -f "$HOME/Library/LaunchAgents/$AGENT_LABEL.plist"
