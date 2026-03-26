#!/bin/bash
# nightly-update.sh — Complete nightly pipeline (~15-20 min)
# Detects new listings, enriches them, marks stale ones, runs dedup
#
# Usage: bash scripts/nightly-update.sh
# Cron:  0 3 * * * cd /path/to/real-estate && bash scripts/nightly-update.sh >> /tmp/re-nightly.log 2>&1

set -e
cd "$(dirname "$0")/.."
export $(cat .env | xargs)

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║  🌙 Nightly Update — $(date '+%Y-%m-%d %H:%M')       ║"
echo "╚══════════════════════════════════════════╝"

# Step 1: ML scan (API, ~5 min)
echo "━━━ [1/5] ML Incremental Scan ━━━"
node scripts/incremental-update.mjs 10 2>&1 || echo "⚠️ ML scan failed"

# Step 2: ZP grid scan (Chrome, ~2 min)
echo "━━━ [2/5] ZP Grid Scan ━━━"
node scripts/scan-zp-grid.mjs 20 2>&1 || echo "⚠️ ZP scan failed"

# Step 3: Enrich new ML descriptions (~2 min)
echo "━━━ [3/5] ML Description Enrichment ━━━"
node scripts/enrich-ml-details.mjs 400 2>&1 || echo "⚠️ ML enrichment failed"

# Step 4: Enrich new ZP pages (Chrome, ~5 min for ~50 new)
echo "━━━ [4/5] ZP Chrome Enrichment ━━━"
node scripts/enrich-zp-chrome.mjs 3000 100 2>&1 || echo "⚠️ ZP enrichment failed"

# Step 5: Cross-portal dedup + price drops
echo "━━━ [5/5] Dedup + Price Drops ━━━"
node -e "
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const { data } = await sb.rpc('merge_cross_portal_duplicates');
console.log('Dedup:', JSON.stringify(data));
" --input-type=module 2>&1 || echo "⚠️ Dedup failed"

curl -s -X POST "${SUPABASE_URL}/functions/v1/detect-price-drops" \
  -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H 'Content-Type: application/json' -d '{}' 2>&1 || echo "⚠️ Price drops failed"

echo ""
echo "✅ Nightly update complete — $(date '+%Y-%m-%d %H:%M')"
