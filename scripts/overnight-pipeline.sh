#!/bin/bash
# overnight-pipeline.sh — Full enrichment + cleanup pipeline
# Run: bash scripts/overnight-pipeline.sh

set -e
cd "$(dirname "$0")/.."

# Load env
export $(cat .env | xargs)

echo "╔══════════════════════════════════════════╗"
echo "║  🌙 Overnight Enrichment Pipeline        ║"
echo "║  $(date '+%Y-%m-%d %H:%M:%S')                  ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# Step 1: ML descriptions
echo "━━━ [1/3] ML Description Enrichment ━━━"
node scripts/enrich-ml-details.mjs 500 2>&1 | tee /tmp/re-enrich-ml.log
echo ""

# Step 2: Cleanup + derived fields
echo "━━━ [2/3] Cleanup + Derived Fields ━━━"
node scripts/cleanup-and-enrich.mjs 2>&1 | tee /tmp/re-cleanup.log
echo ""

# Step 3: Rebuild FTS via direct SQL (in case RPC didn't work)
echo "━━━ [3/3] FTS Rebuild via Supabase ━━━"
# This triggers the edge function that rebuilds FTS
curl -s -X POST "${SUPABASE_URL}/functions/v1/detect-price-drops" \
  -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H 'Content-Type: application/json' \
  -d '{}' || echo "  ⚠️ detect-price-drops not available"
echo ""

echo "╔══════════════════════════════════════════╗"
echo "║  ✅ Pipeline complete                     ║"
echo "║  $(date '+%Y-%m-%d %H:%M:%S')                  ║"
echo "║  Logs: /tmp/re-enrich-ml.log             ║"
echo "║        /tmp/re-cleanup.log               ║"
echo "╚══════════════════════════════════════════╝"
