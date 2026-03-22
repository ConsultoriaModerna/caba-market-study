#!/bin/bash
# scrape-local.sh — Scraping ML desde tu Mac (2 min, gratis, datos completos)
# Uso: ./scrape-local.sh

cd "$(dirname "$0")"

# Load .env
if [ -f .env ]; then
  export $(grep -v '^#' .env | xargs)
fi

echo "🏠 Scrape ML → Supabase (local, IP residencial)"
echo "================================================"

# Deps
[ -f node_modules/.package-lock.json ] || npm install @supabase/supabase-js 2>/dev/null

# Scrape 20 pages = 1000 props (podés subir a 40 = 2000)
node scrape-meli-local.mjs 20

echo ""
echo "📊 Triggering price drop detection..."
curl -s -X POST "${SUPABASE_URL}/functions/v1/detect-price-drops" \
  -H 'Content-Type: application/json' -d '{}' | node -e "
  process.stdin.on('data',d=>{
    const r=JSON.parse(d);
    console.log('  Props:', r.properties_processed, '| Drops:', r.price_drops, '| Events:', r.events_created);
  })
" 2>/dev/null || echo "  (detection triggered async)"

echo "✅ Done"
