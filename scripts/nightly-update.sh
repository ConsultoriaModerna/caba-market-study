#!/bin/bash
# nightly-update.sh — Complete nightly pipeline
# Single source of truth for all automated scraping/enrichment
# Replaces run-nightly.sh (which should be removed from cron)
#
# Steps: ZP scan -> AP scan -> ZP enrich (loop) -> Stale detection -> Dedup -> Price drops -> Slack
#
# Usage: bash scripts/nightly-update.sh
# Cron:  0 6 * * * cd /opt/caba-market-study && export $(cat .env | xargs) && export DISPLAY=:99 && bash scripts/nightly-update.sh >> /var/log/caba-nightly.log 2>&1

cd "$(dirname "$0")/.."
export $(cat .env | xargs)
export DISPLAY=:99

T0=$(date +%s)
ERRORS=""

echo ""
echo "========================================"
echo "  Nightly Pipeline -- $(date '+%Y-%m-%d %H:%M')"
echo "========================================"

# Start xvfb if not running
if ! pgrep -x Xvfb > /dev/null; then
  Xvfb :99 -screen 0 1280x800x24 &
  sleep 2
fi

# ── Step 1: ML Scan ── DISABLED while API ban is active
# Re-enable when ban lifts (2026-04-02). Set ML_ENABLED=true in .env
ML_ENABLED="${ML_ENABLED:-false}"
ML_NEW="0"
ML_STALE="0"

if [ "$ML_ENABLED" = "true" ]; then
  echo "--- [1/7] ML Scan ---"
  ML_OUT=$(node scripts/vps/scrape-ml-headless.mjs 10 2>&1) || ERRORS="${ERRORS}ML scan failed. "
  echo "$ML_OUT"
  ML_NEW=$(echo "$ML_OUT" | grep -oP '\d+ new' | grep -oP '\d+' || echo "0")
else
  echo "--- [1/7] ML Scan -- SKIPPED (ML_ENABLED=false) ---"
fi

# ── Step 2: ZP Grid Scan (all zones: CABA + GBA Norte, ~10 min)
echo "--- [2/7] ZP Grid Scan (headless, all zones) ---"
ZP_OUT=$(node scripts/vps/scan-zp-headless.mjs 20 --zone=all 2>&1) || ERRORS="${ERRORS}ZP scan failed. "
echo "$ZP_OUT"
ZP_NEW=$(echo "$ZP_OUT" | grep -oP '\d+ new,' | grep -oP '\d+' || echo "0")
ZP_REFRESHED=$(echo "$ZP_OUT" | grep -oP '\d+ refreshed' | grep -oP '\d+' || echo "0")

# ── Step 3: AP Scan (CABA + GBA Norte, ~8 min)
echo "--- [3/7] Argenprop Scan (CABA + GBA Norte) ---"
AP_OUT=$(node scripts/vps/scrape-argenprop.mjs 15 --zone=all 2>&1) || ERRORS="${ERRORS}AP scan failed. "
echo "$AP_OUT"
AP_NEW=$(echo "$AP_OUT" | grep -oP '\d+ new' | grep -oP '\d+' || echo "0")

# ── Step 4: ZP Enrichment (loop until backlog < 50, batch 500)
# If scraper hit a block, the enricher will also likely be blocked -- skip
echo "--- [4/7] ZP Enrichment (Puppeteer, batch loop) ---"
ZP_ENRICHED=0
BATCH=1
MAX_BATCHES=10
while [ $BATCH -le $MAX_BATCHES ]; do
  echo "  Batch $BATCH/$MAX_BATCHES..."
  ENRICH_OUT=$(node scripts/vps/enrich-zp-puppeteer.mjs 3000 500 2>&1)
  ENRICH_EXIT=$?
  echo "$ENRICH_OUT"

  # If circuit breaker aborted, stop enrichment loop immediately
  if echo "$ENRICH_OUT" | grep -q "\[CB\] ABORT"; then
    ERRORS="${ERRORS}ZP enrich aborted by circuit breaker (batch $BATCH). "
    break
  fi
  if [ $ENRICH_EXIT -ne 0 ]; then
    ERRORS="${ERRORS}ZP enrich batch $BATCH failed. "
    break
  fi

  BATCH_COUNT=$(echo "$ENRICH_OUT" | grep -oP 'Updated \d+' | grep -oP '\d+' || echo "0")
  ZP_ENRICHED=$((ZP_ENRICHED + BATCH_COUNT))

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
  [ "$REMAINING" -lt 50 ] && break
  BATCH=$((BATCH + 1))
  sleep 10
done

# ── Step 5: ML Enrichment (descriptions, if enabled)
if [ "$ML_ENABLED" = "true" ]; then
  echo "--- [5/7] ML Description Enrichment ---"
  node scripts/enrich-ml-details.mjs 400 2>&1 || ERRORS="${ERRORS}ML enrichment failed. "
else
  echo "--- [5/7] ML Enrichment -- SKIPPED ---"
fi

# ── Step 6: Mark stale listings inactive (not seen in 14+ days)
echo "--- [6/7] Stale Detection ---"
STALE_OUT=$(node -e "
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Mark properties inactive if not seen in 14 days
const cutoff = new Date(Date.now() - 14 * 86400000).toISOString();
const { data, error } = await sb.from('properties')
  .update({ is_active: false })
  .eq('is_active', true)
  .lt('last_seen_at', cutoff)
  .not('last_seen_at', 'is', null)
  .select('id', { count: 'exact', head: true });

const count = data?.length || 0;
console.log(count + ' marked inactive');
if (error) console.error('Error:', error.message);
" --input-type=module 2>&1) || ERRORS="${ERRORS}Stale detection failed. "
echo "  $STALE_OUT"
STALE_COUNT=$(echo "$STALE_OUT" | grep -oP '\d+' | head -1 || echo "0")

# ── Step 7: Dedup + Price Drops
echo "--- [7/7] Dedup + Price Drops ---"
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
echo "Price drops: $DROPS_OUT"

# ── Summary
TOTALS=$(node -e "
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const { count: active } = await sb.from('properties').select('id', { count: 'exact', head: true }).eq('is_active', true).is('canonical_id', null);
const { count: drops } = await sb.from('price_drops').select('property_id', { count: 'exact', head: true });
const { count: events } = await sb.from('opportunity_events').select('id', { count: 'exact', head: true });
console.log(active + '|' + drops + '|' + events);
" --input-type=module 2>&1)
TOTAL_ACTIVE=$(echo "$TOTALS" | cut -d'|' -f1)
TOTAL_DROPS=$(echo "$TOTALS" | cut -d'|' -f2)
TOTAL_EVENTS=$(echo "$TOTALS" | cut -d'|' -f3)

T1=$(date +%s)
DURATION=$((T1 - T0))

echo ""
echo "Pipeline complete -- $(date '+%Y-%m-%d %H:%M') (${DURATION}s)"

# ── Slack notification
STATUS_EMOJI="OK"
STATUS_TEXT="Scrape OK"
if [ -n "$ERRORS" ]; then
  STATUS_EMOJI="WARN"
  STATUS_TEXT="Completed with errors"
fi

SLACK_MSG="${STATUS_EMOJI} *RE Scraper -- $(date '+%d/%m %H:%M')*  |  ${STATUS_TEXT}\n\n"
SLACK_MSG="${SLACK_MSG}*New listings*\n"
SLACK_MSG="${SLACK_MSG}  ZP: ${ZP_NEW} new, ${ZP_REFRESHED} refreshed\n"
SLACK_MSG="${SLACK_MSG}  AP: ${AP_NEW} new\n"
SLACK_MSG="${SLACK_MSG}  ML: ${ML_NEW} new\n\n"
SLACK_MSG="${SLACK_MSG}*Processing*\n"
SLACK_MSG="${SLACK_MSG}  ZP enriched: ${ZP_ENRICHED}\n"
SLACK_MSG="${SLACK_MSG}  Stale removed: ${STALE_COUNT}\n"
SLACK_MSG="${SLACK_MSG}  Dedup merged: ${DEDUP_COUNT}\n\n"
SLACK_MSG="${SLACK_MSG}*Totals*\n"
SLACK_MSG="${SLACK_MSG}  Active: ${TOTAL_ACTIVE}  |  Price drops: ${TOTAL_DROPS}  |  Events: ${TOTAL_EVENTS}\n"
SLACK_MSG="${SLACK_MSG}  Duration: ${DURATION}s"

if [ -n "$ERRORS" ]; then
  SLACK_MSG="${SLACK_MSG}\n\n*Errors:* ${ERRORS}"
fi

if [ -n "$SLACK_WEBHOOK" ]; then
  curl -s -X POST "$SLACK_WEBHOOK" \
    -H 'Content-Type: application/json' \
    -d "{\"text\":\"${SLACK_MSG}\"}" > /dev/null
fi

echo "$SLACK_MSG"
