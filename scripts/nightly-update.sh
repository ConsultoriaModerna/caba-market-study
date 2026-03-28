#!/bin/bash
# nightly-update.sh — Complete nightly pipeline (~15-20 min)
# Detects new listings, enriches them, marks stale ones, runs dedup
# Posts summary to Slack #webhooks
#
# Usage: bash scripts/nightly-update.sh
# Cron:  0 6 * * * cd /opt/caba-market-study && export $(cat .env | xargs) && export DISPLAY=:99 && bash scripts/nightly-update.sh >> /var/log/caba-nightly.log 2>&1

cd "$(dirname "$0")/.."
export $(cat .env | xargs)

T0=$(date +%s)
ERRORS=""

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║  🌙 Nightly Update — $(date '+%Y-%m-%d %H:%M')       ║"
echo "╚══════════════════════════════════════════╝"

# Step 1: ML scan (API, ~5 min)
echo "━━━ [1/5] ML Incremental Scan ━━━"
ML_OUT=$(node scripts/incremental-update.mjs 10 2>&1) || ERRORS="${ERRORS}ML scan failed. "
echo "$ML_OUT"
ML_NEW=$(echo "$ML_OUT" | grep -oP '\d+ new' | grep -oP '\d+' || echo "0")
ML_STALE=$(echo "$ML_OUT" | grep -oP '\d+ marked inactive' | grep -oP '\d+' || echo "0")

# Step 2: ZP grid scan (Puppeteer headless, all zones, ~10 min)
echo "━━━ [2/5] ZP Grid Scan (headless) ━━━"
ZP_OUT=$(node scripts/vps/scan-zp-headless.mjs 20 --zone=all 2>&1) || ERRORS="${ERRORS}ZP scan failed. "
echo "$ZP_OUT"
ZP_NEW=$(echo "$ZP_OUT" | grep -oP '\d+ new,' | grep -oP '\d+' || echo "0")
ZP_REFRESHED=$(echo "$ZP_OUT" | grep -oP '\d+ refreshed' | grep -oP '\d+' || echo "0")

# Step 3: Enrich new ML descriptions (~2 min)
echo "━━━ [3/5] ML Description Enrichment ━━━"
ML_ENRICH=$(node scripts/enrich-ml-details.mjs 400 2>&1) || ERRORS="${ERRORS}ML enrichment failed. "
echo "$ML_ENRICH"

# Step 4: Enrich new ZP pages (Chrome, ~5 min for ~50 new)
echo "━━━ [4/5] ZP Chrome Enrichment ━━━"
ZP_ENRICH=$(node scripts/vps/enrich-zp-puppeteer.mjs 3000 100 2>&1) || ERRORS="${ERRORS}ZP enrichment failed. "
echo "$ZP_ENRICH"

# Step 5: Cross-portal dedup + price drops
echo "━━━ [5/5] Dedup + Price Drops ━━━"
DEDUP_OUT=$(node -e "
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const { data } = await sb.rpc('merge_cross_portal_duplicates');
console.log(JSON.stringify(data));
" --input-type=module 2>&1) || ERRORS="${ERRORS}Dedup failed. "
echo "Dedup: $DEDUP_OUT"
DEDUP_COUNT=$(echo "$DEDUP_OUT" | grep -oP '"merged":\d+' | grep -oP '\d+' || echo "0")

DROPS_OUT=$(curl -s -X POST "${SUPABASE_URL}/functions/v1/detect-price-drops" \
  -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H 'Content-Type: application/json' -d '{}' 2>&1) || ERRORS="${ERRORS}Price drops failed. "

# Get current totals
TOTALS=$(node -e "
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const { count: active } = await sb.from('properties').select('id', { count: 'exact', head: true }).eq('is_active', true).is('canonical_id', null);
const { count: drops } = await sb.from('opportunity_events').select('id', { count: 'exact', head: true });
console.log(active + '|' + drops);
" --input-type=module 2>&1)
TOTAL_ACTIVE=$(echo "$TOTALS" | cut -d'|' -f1)
TOTAL_DROPS=$(echo "$TOTALS" | cut -d'|' -f2)

T1=$(date +%s)
DURATION=$((T1 - T0))

echo ""
echo "✅ Nightly update complete — $(date '+%Y-%m-%d %H:%M') (${DURATION}s)"

# Slack notification
STATUS_EMOJI="✅"
STATUS_TEXT="Scrape OK"
if [ -n "$ERRORS" ]; then
  STATUS_EMOJI="⚠️"
  STATUS_TEXT="Completed with errors"
fi

SLACK_MSG="${STATUS_EMOJI} *RE Scraper — $(date '+%d/%m %H:%M')*  |  ${STATUS_TEXT}\n\n"
SLACK_MSG="${SLACK_MSG}📥 *New listings*\n"
SLACK_MSG="${SLACK_MSG}• ML: \`${ML_NEW}\` new  |  ZP: \`${ZP_NEW}\` new\n"
SLACK_MSG="${SLACK_MSG}• ZP refreshed: \`${ZP_REFRESHED}\`  |  Stale removed: \`${ML_STALE}\`\n\n"
SLACK_MSG="${SLACK_MSG}🔄 *Processing*\n"
SLACK_MSG="${SLACK_MSG}• Dedup merged: \`${DEDUP_COUNT}\`\n\n"
SLACK_MSG="${SLACK_MSG}📊 *Totals*\n"
SLACK_MSG="${SLACK_MSG}• Active properties: \`${TOTAL_ACTIVE}\`\n"
SLACK_MSG="${SLACK_MSG}• Price drops tracked: \`${TOTAL_DROPS}\`\n"
SLACK_MSG="${SLACK_MSG}• ⏱️ Duration: \`${DURATION}s\`"

if [ -n "$ERRORS" ]; then
  SLACK_MSG="${SLACK_MSG}\n\n❌ *Errors:* ${ERRORS}"
fi

if [ -n "$SLACK_WEBHOOK" ]; then
  curl -s -X POST "$SLACK_WEBHOOK" \
    -H 'Content-Type: application/json' \
    -d "{\"text\":\"${SLACK_MSG}\"}" > /dev/null
fi
