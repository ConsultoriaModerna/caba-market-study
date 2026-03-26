#!/bin/bash
# enrich-ml-all.sh — Run ML enrichment in batches until all done
# Each batch handles up to 1000 props (Supabase default limit)
# Usage: bash scripts/enrich-ml-all.sh

export $(cat .env | xargs)

echo "🌙 ML Full Enrichment — $(date '+%Y-%m-%d %H:%M:%S')"
echo ""

BATCH=1
while true; do
  echo "━━━ Batch $BATCH ━━━"
  node scripts/enrich-ml-details.mjs 400 2>&1

  EXIT_CODE=$?
  if [ $EXIT_CODE -ne 0 ]; then
    echo "⚠️ Batch $BATCH exited with code $EXIT_CODE"
    break
  fi

  # Check if there are more to process
  REMAINING=$(node -e "
    import { createClient } from '@supabase/supabase-js';
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { count } = await sb.from('properties')
      .select('id', { count: 'exact', head: true })
      .eq('source', 'mercadolibre').eq('is_active', true).is('description', null);
    console.log(count || 0);
  " --input-type=module 2>/dev/null)

  echo "📋 Remaining without description: $REMAINING"

  if [ "$REMAINING" -eq 0 ] || [ "$REMAINING" -lt 10 ]; then
    echo "✅ All done!"
    break
  fi

  BATCH=$((BATCH + 1))
  echo "⏳ Cooling down 5s before next batch..."
  sleep 5
  echo ""
done

echo ""
echo "🏁 Complete — $(date '+%Y-%m-%d %H:%M:%S')"
