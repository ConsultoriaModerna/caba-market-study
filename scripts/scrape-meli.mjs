// scrape-meli.mjs — MercadoLibre scraper for CABA casas
// Usage: node scripts/scrape-meli.mjs [maxPages]
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const MAX_PAGES = parseInt(process.argv[2] || '20');
const RESULTS_PER_PAGE = 50;
const CATEGORY = 'MLA1493';
const STATE = 'TUxBUENBUGw3M2E1';
const PROPERTY_TYPE = '242062';

function extractAttr(attrs, id) {
  const attr = (attrs || []).find(a => a.id === id);
  return attr?.value_name || null;
}

function parseNum(val) {
  if (!val) return null;
  const n = parseFloat(val.replace(/[^0-9.]/g, ''));
  return isNaN(n) ? null : n;
}

function extractKeywords(title, attrs) {
  const kw = [];
  const t = title.toLowerCase();
  const map = {
    'jardin': 'jardin', 'patio': 'patio', 'terraza': 'terraza',
    'pileta': 'pileta', 'cochera': 'cochera', 'garage': 'cochera',
    'parrilla': 'parrilla', 'quincho': 'quincho',
    'refaccionar': 'a refaccionar', 'reciclada': 'reciclada', 'reciclado': 'reciclada',
    'escritura': 'escritura', 'apto credito': 'apto credito',
    'ph': 'ph', 'duplex': 'duplex', 'triplex': 'triplex',
    'lote': 'lote propio',
  };
  for (const [key, val] of Object.entries(map)) {
    if (t.includes(key)) kw.push(val);
  }
  const cond = extractAttr(attrs, 'ITEM_CONDITION');
  if (cond) {
    if (cond.toLowerCase().includes('refaccion')) kw.push('a refaccionar');
    if (cond.toLowerCase().includes('recicl')) kw.push('reciclada');
  }
  return [...new Set(kw)];
}

function determineSegment(kw) {
  if (kw.includes('a refaccionar')) return 'refac';
  if (kw.includes('reciclada')) return 'recic';
  return 'general';
}

async function main() {
  const startTime = Date.now();
  console.log(`[SCRAPE] Starting ML scrape, max ${MAX_PAGES} pages (${MAX_PAGES * RESULTS_PER_PAGE} results)...`);

  // Get token
  const { data: tokenRow } = await supabase
    .from('ml_tokens')
    .select('access_token, saved_at, expires_in')
    .eq('id', 'default')
    .single();

  if (!tokenRow?.access_token) {
    console.error('[SCRAPE] No ML token found!');
    process.exit(1);
  }

  const savedAt = Number(tokenRow.saved_at);
  const tokenAge = (Date.now() - savedAt) / 1000;
  if (tokenAge > Number(tokenRow.expires_in) - 300) {
    console.error(`[SCRAPE] Token expired (age: ${Math.round(tokenAge)}s)`);
    process.exit(1);
  }

  const token = tokenRow.access_token;
  let totalFetched = 0;
  let totalUpserted = 0;
  const errors = [];

  for (let page = 0; page < MAX_PAGES; page++) {
    const offset = page * RESULTS_PER_PAGE;
    const searchUrl = `https://api.mercadolibre.com/sites/MLA/search?category=${CATEGORY}&state=${STATE}&PROPERTY_TYPE=${PROPERTY_TYPE}&OPERATION=242075&limit=${RESULTS_PER_PAGE}&offset=${offset}`;

    try {
      // Try with auth first
      let resp = await fetch(searchUrl, {
        headers: { 'Authorization': `Bearer ${token}` },
      });

      // Fallback: try without auth
      if (resp.status === 403) {
        resp = await fetch(searchUrl);
      }

      if (!resp.ok) {
        const errText = await resp.text();
        errors.push(`P${page}: ${resp.status}`);
        console.error(`[SCRAPE] Page ${page} failed: ${resp.status} ${errText.substring(0, 100)}`);
        if (resp.status === 401) break;
        continue;
      }

      const data = await resp.json();
      const results = data.results || [];

      if (results.length === 0) {
        console.log(`[SCRAPE] No more results at page ${page}`);
        break;
      }

      totalFetched += results.length;
      console.log(`[SCRAPE] Page ${page + 1}/${MAX_PAGES}: ${results.length} results (total: ${totalFetched})`);

      const rows = results.map(item => {
        const totalArea = parseNum(extractAttr(item.attributes, 'TOTAL_AREA'));
        const covArea = parseNum(extractAttr(item.attributes, 'COVERED_AREA'));
        const kw = extractKeywords(item.title, item.attributes);
        const beds = parseNum(extractAttr(item.attributes, 'BEDROOMS'));
        const baths = parseNum(extractAttr(item.attributes, 'BATHROOMS'));
        const rooms = parseNum(extractAttr(item.attributes, 'ROOMS'));

        return {
          id: 'ml_' + item.id.replace('MLA', '').toLowerCase(),
          title: item.title,
          price: item.price,
          currency: item.currency_id,
          operation: 'venta',
          property_type: 'casa',
          total_area: totalArea,
          covered_area: covArea,
          bedrooms: beds !== null ? Math.round(beds) : null,
          bathrooms: baths !== null ? Math.round(baths) : null,
          ambientes: rooms !== null ? Math.round(rooms) : null,
          neighborhood: item.location?.neighborhood?.name || null,
          city: item.location?.city?.name || 'Capital Federal',
          state: 'Capital Federal',
          latitude: item.location?.latitude || null,
          longitude: item.location?.longitude || null,
          permalink: item.permalink,
          thumbnail: item.thumbnail,
          keywords: kw,
          segment: determineSegment(kw),
          source: 'mercadolibre',
          slug: item.id,
          price_per_sqm: (item.price && totalArea && totalArea > 0) ? Math.round(item.price / totalArea) : null,
          is_active: true,
          last_seen_at: new Date().toISOString(),
          scraped_at: new Date().toISOString(),
        };
      });

      // Upsert in batches of 50
      const { error: upsertErr } = await supabase
        .from('properties')
        .upsert(rows, { onConflict: 'id', ignoreDuplicates: false });

      if (upsertErr) {
        errors.push(`Upsert p${page}: ${upsertErr.message}`);
        console.error(`[SCRAPE] Upsert error:`, upsertErr.message);
      } else {
        totalUpserted += rows.length;
      }

      // Rate limit: 400ms between pages
      if (page < MAX_PAGES - 1) {
        await new Promise(r => setTimeout(r, 400));
      }
    } catch (err) {
      errors.push(`P${page}: ${err.message}`);
      console.error(`[SCRAPE] Page ${page} error:`, err.message);
    }
  }

  const duration = Date.now() - startTime;

  // Log to scrape_runs
  await supabase.from('scrape_runs').insert({
    source: 'mercadolibre',
    segment: 'all',
    total_scraped: totalFetched,
    total_new: 0,
    total_updated: totalUpserted,
    total_deactivated: 0,
    duration_ms: duration,
    error_message: errors.length > 0 ? errors.join('; ') : null,
    metadata: { pages: MAX_PAGES, runner: 'github-actions', errors_count: errors.length },
    started_at: new Date(startTime).toISOString(),
    completed_at: new Date().toISOString(),
  });

  console.log('\n[SCRAPE] === DONE ===');
  console.log(`  Fetched: ${totalFetched}`);
  console.log(`  Upserted: ${totalUpserted}`);
  console.log(`  Duration: ${Math.round(duration / 1000)}s`);
  console.log(`  Errors: ${errors.length}`);

  if (errors.length > 0 && totalFetched === 0) {
    process.exit(1);
  }
}

main();
