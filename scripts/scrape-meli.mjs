// scrape-meli.mjs — MercadoLibre scraper for properties (multi-zone, multi-type)
// Usage: node scripts/scrape-meli.mjs [maxPages] [--zone=caba|gba-norte|all] [--type=casa|local|departamento]
import { createClient } from '@supabase/supabase-js';
import { getActiveZones, PROPERTY_TYPES } from './zones-config.mjs';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const MAX_PAGES = parseInt(process.argv[2] || '20');
const RESULTS_PER_PAGE = 50;
const CATEGORY = 'MLA1493';

// Parse --type flag: use ml_type from zones-config
const typeArg = process.argv.find(a => a.startsWith('--type='))?.split('=')[1] || 'casa';
const propTypeConfig = PROPERTY_TYPES.find(t => t.id === typeArg);
const PROPERTY_TYPE = propTypeConfig?.ml_type || '242062';
const PROP_TYPE_LABEL = propTypeConfig?.label || typeArg;

// Parse --zone flag
const zoneArg = process.argv.find(a => a.startsWith('--zone='))?.split('=')[1] || 'all';

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
    'refaccionar': 'a refaccionar', 'a reciclar': 'a refaccionar', 'para reciclar': 'a refaccionar',
    'reciclada': 'reciclada', 'reciclado': 'reciclada', 'reciclado a nuevo': 'reciclada', 'refaccionada': 'reciclada',
    'a estrenar': 'a estrenar', 'a nuevo': 'a estrenar',
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
  if (kw.includes('a estrenar')) return 'recic'; // a estrenar = top condition
  return 'general';
}

async function scrapeZone(zone, token) {
  console.log(`\n━━━ ${zone.name} (${zone.id}) ━━━`);
  let totalFetched = 0;
  let totalUpserted = 0;
  const errors = [];

  let consecutive403 = 0;
  let backoffMs = 400;

  for (let page = 0; page < MAX_PAGES; page++) {
    const offset = page * RESULTS_PER_PAGE;
    const searchUrl = `https://api.mercadolibre.com/sites/MLA/search?category=${CATEGORY}&state=${zone.ml_state}&PROPERTY_TYPE=${PROPERTY_TYPE}&OPERATION=242075&limit=${RESULTS_PER_PAGE}&offset=${offset}`;

    try {
      let resp = await fetch(searchUrl, {
        headers: { 'Authorization': `Bearer ${token}` },
      });

      // 403 handling: exponential backoff with max 3 retries per page
      if (resp.status === 403) {
        consecutive403++;
        if (consecutive403 >= 5) {
          console.log(`  5 consecutive 403s, stopping zone ${zone.id}. Will retry next run.`);
          break;
        }
        const waitSec = Math.min(30, 5 * Math.pow(2, consecutive403 - 1));
        console.log(`  403 on page ${page}, backoff ${waitSec}s (attempt ${consecutive403}/5)...`);
        await new Promise(r => setTimeout(r, waitSec * 1000));
        // Retry this page
        resp = await fetch(searchUrl, {
          headers: { 'Authorization': `Bearer ${token}` },
        });
        if (resp.status === 403) {
          errors.push(`P${page}: 403 after backoff`);
          continue;
        }
      }

      if (resp.ok) {
        consecutive403 = 0;
        backoffMs = 400;
      }

      if (!resp.ok) {
        const errText = await resp.text();
        errors.push(`P${page}: ${resp.status}`);
        console.error(`  Page ${page} failed: ${resp.status} ${errText.substring(0, 100)}`);
        if (resp.status === 401) break;
        continue;
      }

      const data = await resp.json();
      const results = data.results || [];

      if (results.length === 0) {
        console.log(`  No more results at page ${page}`);
        break;
      }

      totalFetched += results.length;
      console.log(`  Page ${page + 1}/${MAX_PAGES}: ${results.length} results (total: ${totalFetched})`);

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
          property_type: typeArg,
          total_area: totalArea,
          covered_area: covArea,
          bedrooms: beds !== null ? Math.round(beds) : null,
          bathrooms: baths !== null ? Math.round(baths) : null,
          ambientes: rooms !== null ? Math.round(rooms) : null,
          neighborhood: item.location?.neighborhood?.name || null,
          city: item.location?.city?.name || zone.name,
          state: zone.state,
          latitude: item.location?.latitude || null,
          longitude: item.location?.longitude || null,
          permalink: item.permalink,
          thumbnail: item.thumbnail,
          keywords: kw,
          segment: determineSegment(kw),
          source: 'mercadolibre',
          slug: item.id,
          price_per_sqm: (item.price && (covArea || totalArea)) ? Math.round(item.price / (covArea || totalArea)) : null,
          published_at: item.date_created || null,
          is_active: true,
          last_seen_at: new Date().toISOString(),
          scraped_at: new Date().toISOString(),
        };
      });

      const { error: upsertErr } = await supabase
        .from('properties')
        .upsert(rows, { onConflict: 'id', ignoreDuplicates: false });

      if (upsertErr) {
        errors.push(`Upsert p${page}: ${upsertErr.message}`);
        console.error(`  Upsert error:`, upsertErr.message);
      } else {
        totalUpserted += rows.length;
      }

      if (page < MAX_PAGES - 1) {
        await new Promise(r => setTimeout(r, 400));
      }
    } catch (err) {
      errors.push(`P${page}: ${err.message}`);
      console.error(`  Page ${page} error:`, err.message);
    }
  }

  return { zone: zone.id, totalFetched, totalUpserted, errors };
}

async function main() {
  const startTime = Date.now();

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
  const zones = getActiveZones().filter(z => zoneArg === 'all' || z.id === zoneArg);

  if (zones.length === 0) {
    console.error(`[SCRAPE] No zones matched "${zoneArg}". Available: ${getActiveZones().map(z => z.id).join(', ')}`);
    process.exit(1);
  }

  console.log(`[SCRAPE] ML scrape — ${PROP_TYPE_LABEL} (${PROPERTY_TYPE}) — ${zones.length} zone(s), max ${MAX_PAGES} pages each`);

  let grandTotal = { fetched: 0, upserted: 0, errors: [] };

  for (const zone of zones) {
    const result = await scrapeZone(zone, token);
    grandTotal.fetched += result.totalFetched;
    grandTotal.upserted += result.totalUpserted;
    grandTotal.errors.push(...result.errors);
  }

  const duration = Date.now() - startTime;

  await supabase.from('scrape_runs').insert({
    source: 'mercadolibre',
    segment: zoneArg,
    total_scraped: grandTotal.fetched,
    total_new: 0,
    total_updated: grandTotal.upserted,
    total_deactivated: 0,
    duration_ms: duration,
    error_message: grandTotal.errors.length > 0 ? grandTotal.errors.join('; ') : null,
    metadata: { pages: MAX_PAGES, zones: zones.map(z => z.id), runner: 'local', errors_count: grandTotal.errors.length },
    started_at: new Date(startTime).toISOString(),
    completed_at: new Date().toISOString(),
  });

  console.log('\n[SCRAPE] === DONE ===');
  console.log(`  Zones: ${zones.map(z => z.name).join(', ')}`);
  console.log(`  Fetched: ${grandTotal.fetched}`);
  console.log(`  Upserted: ${grandTotal.upserted}`);
  console.log(`  Duration: ${Math.round(duration / 1000)}s`);
  console.log(`  Errors: ${grandTotal.errors.length}`);

  if (grandTotal.errors.length > 0 && grandTotal.fetched === 0) {
    process.exit(1);
  }
}

main();
