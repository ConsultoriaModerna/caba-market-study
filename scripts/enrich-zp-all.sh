#!/bin/bash
# enrich-zp-all.sh — Run ZP Chrome enrichment in batches until all done
# Usage: bash scripts/enrich-zp-all.sh

export $(cat .env | xargs)

echo "🌙 ZP Full Enrichment — $(date '+%Y-%m-%d %H:%M:%S')"
echo ""

BATCH=1
while true; do
  echo "━━━ Batch $BATCH ━━━"
  node scripts/enrich-zp-chrome.mjs 3000 500 2>&1

  EXIT_CODE=$?
  if [ $EXIT_CODE -ne 0 ]; then
    echo "⚠️ Batch $BATCH exited with code $EXIT_CODE"
    break
  fi

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

  echo "📋 Remaining: $REMAINING"

  if [ "$REMAINING" -eq 0 ] || [ "$REMAINING" -lt 10 ]; then
    echo "✅ All done!"
    break
  fi

  BATCH=$((BATCH + 1))
  echo "⏳ Cooling 10s..."
  sleep 10
  echo ""
done

echo ""
echo "🏁 Complete — $(date '+%Y-%m-%d %H:%M:%S')"
