#!/bin/bash
# run-nightly.sh — Full nightly pipeline for VPS
# Runs: ML token refresh → ML scrape → ML descriptions → ZP enrichment → price drops
# Usage: bash scripts/vps/run-nightly.sh
# Cron:  0 3 * * * bash /opt/caba-market-study/scripts/vps/run-nightly.sh >> /var/log/caba-scrape.log 2>&1

set -e
cd /opt/caba-market-study
export $(cat .env | xargs)
export DISPLAY=:99

LOG="/var/log/caba-scrape.log"

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║  🌙 Nightly Pipeline — $(date '+%Y-%m-%d %H:%M')    ║"
echo "╚══════════════════════════════════════════╝"

# Start xvfb if not running
if ! pgrep -x Xvfb > /dev/null; then
  Xvfb :99 -screen 0 1280x800x24 &
  sleep 2
fi

# ML steps disabled until ban lifts (2026-04-02)
# Set ML_ENABLED=true in .env to re-enable
ML_ENABLED="${ML_ENABLED:-false}"

if [ "$ML_ENABLED" = "true" ]; then
  echo "━━━ [1/4] ML Token Refresh ━━━"
  node scripts/refresh-ml-token.mjs 2>&1 || echo "⚠️ Token refresh failed (may be expired)"

  echo "━━━ [2/4] ML Scrape ━━━"
  node scrape-meli-local.mjs 40 2>&1 || echo "⚠️ ML scrape failed"

  echo "━━━ [3/4] ML Descriptions ━━━"
  node scripts/enrich-ml-details.mjs 400 2>&1 || echo "⚠️ ML enrichment failed"
else
  echo "━━━ [1-3/4] ML steps SKIPPED (ML_ENABLED=false, ban active until 2026-04-02) ━━━"
fi

# Step 4: ZP enrichment (via Puppeteer)
echo "━━━ [4/4] ZP Enrichment ━━━"
BATCH=1
while true; do
  echo "  Batch $BATCH..."
  node scripts/vps/enrich-zp-puppeteer.mjs 3000 500 2>&1

  REMAINING=$(node -e "
    import { createClient } from '@supabase/supabase-js';
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { count } = await sb.from('properties')
      .select('id', { count: 'exact', head: true })
      .eq('source', 'zonaprop').eq('is_active', true)
      .not('permalink', 'is', null)
      .or('description.is.null,covered_area.is.null,bedrooms.is.null,bathrooms.is.null');
    console.log(count || 0);
  " --input-type=module 2>/dev/null)

  echo "  Remaining: $REMAINING"
  [ "$REMAINING" -lt 10 ] && break
  BATCH=$((BATCH + 1))
  sleep 10
done

# Step 5: Detect price drops
echo "━━━ [5/5] Price Drop Detection ━━━"
curl -s -X POST "${SUPABASE_URL}/functions/v1/detect-price-drops" \
  -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H 'Content-Type: application/json' -d '{}' || echo "⚠️ Edge function unavailable"

echo ""
echo "✅ Nightly pipeline complete — $(date '+%Y-%m-%d %H:%M')"
