#!/bin/bash
# run-scrape.sh — Correr scraping ML desde tu Mac (IP residencial)
# Uso: ./run-scrape.sh [páginas]  (default: 20 = 1000 resultados)

cd "$(dirname "$0")"

# Cargar variables (editá con tus valores la primera vez)
export SUPABASE_URL="https://ysynltkotzizayjtoujf.supabase.co"
export SUPABASE_SERVICE_ROLE_KEY="${SUPABASE_SERVICE_ROLE_KEY:-PONE_TU_SERVICE_ROLE_KEY_ACA}"
export ML_APP_ID="${ML_APP_ID:-PONE_TU_ML_APP_ID_ACA}"
export ML_CLIENT_SECRET="${ML_CLIENT_SECRET:-PONE_TU_ML_CLIENT_SECRET_ACA}"

PAGES=${1:-20}

echo "🏠 CABA Market Study — ML Scraper"
echo "================================="
echo "Pages: $PAGES ($(($PAGES * 50)) results max)"
echo ""

# Instalar deps si no existen
if [ ! -d "node_modules" ]; then
  echo "📦 Installing dependencies..."
  npm install @supabase/supabase-js
fi

# 1. Refresh token
echo "🔑 Refreshing ML token..."
node scripts/refresh-ml-token.mjs

# 2. Scrape
echo "🔍 Scraping MercadoLibre..."
node scripts/scrape-meli.mjs $PAGES

# 3. Trigger detection (desde Supabase, no necesita IP residencial)
echo "📊 Triggering price drop detection..."
curl -s -X POST "${SUPABASE_URL}/functions/v1/detect-price-drops" \
  -H 'Content-Type: application/json' \
  -d '{}' && echo " ✅ Detection triggered"

echo ""
echo "✅ Done! Check dashboard at caba-market-study.vercel.app"
