#!/bin/bash
# nightly-local.sh — Nightly enrichment on local Mac via Chrome AppleScript
# Runs at 3 AM, enriches ZP properties, generates morning brief, posts to Slack
# Cron: 0 3 * * * caffeinate -i bash /Users/nico/AI/PROJECTS/real-estate/scripts/nightly-local.sh >> /tmp/nightly-local.log 2>&1

set -euo pipefail
cd /Users/nico/AI/PROJECTS/real-estate
set -a && source .env && set +a

T0=$(date +%s)
DATE=$(date '+%Y-%m-%d')
BRIEF_DIR="reports"
BRIEF_FILE="${BRIEF_DIR}/nightly-brief-${DATE}.md"
mkdir -p "$BRIEF_DIR"

echo ""
echo "========================================"
echo "  Local Nightly — ${DATE} $(date '+%H:%M')"
echo "========================================"

# ── Ensure Chrome is open with a window
CHROME_WINDOWS=$(osascript -e 'tell application "Google Chrome" to count windows' 2>/dev/null || echo "0")
OPENED_CHROME=false
if [ "$CHROME_WINDOWS" = "0" ]; then
  echo "Opening Chrome window..."
  osascript -e 'tell application "Google Chrome" to make new window' 2>/dev/null || true
  sleep 3
  OPENED_CHROME=true
fi

# ── Step 1: ZP Enrichment via Chrome AppleScript (batch 500)
echo "--- [1/3] ZP Chrome Enrichment ---"
ZP_OUT=$(node scripts/enrich-zp-chrome.mjs 3000 500 2>&1) || true
echo "$ZP_OUT"
ZP_ENRICHED=$(echo "$ZP_OUT" | grep -oP '(\d+) enriched' | grep -oP '\d+' || echo "0")
ZP_ERRORS=$(echo "$ZP_OUT" | grep -oP '(\d+) errors' | grep -oP '\d+' || echo "0")
ZP_TOTAL=$(echo "$ZP_OUT" | grep -oP '(\d+) ZP properties' | grep -oP '\d+' || echo "0")

# ── Step 2: Query DB stats for brief
echo "--- [2/3] Generating brief ---"
STATS=$(node --input-type=module -e "
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Active by source
const sources = ['zonaprop', 'mercadolibre', 'argenprop'];
const counts = {};
for (const s of sources) {
  const { count } = await sb.from('properties').select('id', { count: 'exact', head: true }).eq('source', s).eq('is_active', true);
  counts[s] = count || 0;
}

// New in last 24h
const yesterday = new Date(Date.now() - 86400000).toISOString();
const { count: new24h } = await sb.from('properties').select('id', { count: 'exact', head: true }).gte('created_at', yesterday);

// Enrichment backlog (ZP active without enrichment)
const { count: zpBacklog } = await sb.from('properties').select('id', { count: 'exact', head: true })
  .eq('source', 'zonaprop').eq('is_active', true).not('permalink', 'is', null)
  .or('enrichment_level.is.null,enrichment_level.eq.0');

// Properties with descriptions
const { count: withDesc } = await sb.from('properties').select('id', { count: 'exact', head: true })
  .eq('is_active', true).not('description', 'is', null);

// Properties with GPS
const { count: withGps } = await sb.from('properties').select('id', { count: 'exact', head: true })
  .eq('is_active', true).not('latitude', 'is', null);

// Total active
const totalActive = Object.values(counts).reduce((a, b) => a + b, 0);

// Price drops last 7d
const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
const { count: drops7d } = await sb.from('price_drops').select('property_id', { count: 'exact', head: true }).gte('detected_at', weekAgo);

// Deactivated last 24h
const { count: deactivated24h } = await sb.from('properties').select('id', { count: 'exact', head: true })
  .eq('is_active', false).gte('updated_at', yesterday);

console.log(JSON.stringify({
  zp: counts.zonaprop, ml: counts.mercadolibre, ap: counts.argenprop,
  totalActive, new24h: new24h || 0, zpBacklog: zpBacklog || 0,
  withDesc: withDesc || 0, withGps: withGps || 0,
  drops7d: drops7d || 0, deactivated24h: deactivated24h || 0
}));
" 2>/dev/null)

echo "Stats: $STATS"

# ── Step 3: AI trends analysis via Haiku
echo "--- [3/3] Haiku trends analysis ---"
TRENDS=$(node --input-type=module -e "
import { createClient } from '@supabase/supabase-js';
import Anthropic from '@anthropic-ai/sdk';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Get recent data for analysis
const { data: recentProps } = await sb.from('properties')
  .select('source, price, total_area, covered_area, barrio, property_type, created_at')
  .eq('is_active', true)
  .gte('created_at', new Date(Date.now() - 7 * 86400000).toISOString())
  .order('created_at', { ascending: false })
  .limit(200);

const { data: priceDrops } = await sb.from('price_drops')
  .select('old_price, new_price, drop_pct, detected_at')
  .gte('detected_at', new Date(Date.now() - 7 * 86400000).toISOString())
  .order('detected_at', { ascending: false })
  .limit(50);

// Barrio price averages
const { data: barrioStats } = await sb.rpc('exec_sql', { query: \`
  SELECT barrio, count(*) as n, round(avg(price)) as avg_price, round(avg(price_per_sqm)) as avg_psqm
  FROM properties WHERE is_active = true AND price > 0 AND barrio IS NOT NULL
  GROUP BY barrio HAVING count(*) >= 5 ORDER BY avg_price ASC LIMIT 20
\` }).catch(() => ({ data: null }));

const context = JSON.stringify({
  new_listings_7d: recentProps?.length || 0,
  sample: recentProps?.slice(0, 50),
  price_drops: priceDrops,
  cheapest_barrios: barrioStats
});

const client = new Anthropic();
const msg = await client.messages.create({
  model: 'claude-haiku-4-5-20251001',
  max_tokens: 500,
  messages: [{
    role: 'user',
    content: \`Sos un analista inmobiliario de Buenos Aires. Analiza estos datos de la ultima semana y da un brief de 5-7 bullets con trends, oportunidades, y alertas. Focus en casas. Datos: \${context}

Formato: bullets concisos en espanol, sin intro ni cierre. Incluir numeros concretos.\`
  }]
});

console.log(msg.content[0].text);
" 2>/dev/null) || TRENDS="(Haiku analysis unavailable)"

echo "$TRENDS"

# ── Generate brief markdown
T1=$(date +%s)
DURATION=$((T1 - T0))

cat > "$BRIEF_FILE" << BRIEF
# Nightly Brief — ${DATE}

## Enrichment (Chrome AppleScript)
- **Batch:** ${ZP_TOTAL} properties processed
- **Enriched:** ${ZP_ENRICHED} | **Errors:** ${ZP_ERRORS}
- **Duration:** ${DURATION}s

## Database Status
$(node --input-type=module -e "
const s = ${STATS};
console.log('| Source | Active |');
console.log('|---|---|');
console.log('| ZonaProp | ' + s.zp + ' |');
console.log('| MercadoLibre | ' + s.ml + ' |');
console.log('| Argenprop | ' + s.ap + ' |');
console.log('| **Total** | **' + s.totalActive + '** |');
console.log('');
console.log('- New (24h): ' + s.new24h);
console.log('- Deactivated (24h): ' + s.deactivated24h);
console.log('- ZP enrichment backlog: ' + s.zpBacklog);
console.log('- With description: ' + s.withDesc);
console.log('- With GPS: ' + s.withGps);
console.log('- Price drops (7d): ' + s.drops7d);
" 2>/dev/null)

## Market Trends (Haiku)
${TRENDS}

---
Generated $(date '+%H:%M') | Duration: ${DURATION}s
BRIEF

echo ""
echo "Brief saved to: ${BRIEF_FILE}"

# ── Close Chrome if we opened it
if [ "$OPENED_CHROME" = "true" ]; then
  osascript -e 'tell application "Google Chrome" to close window 1' 2>/dev/null || true
fi

echo "Done. (${DURATION}s)"
