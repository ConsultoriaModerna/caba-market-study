#!/usr/bin/env node
/**
 * Geocode properties using Nominatim (OpenStreetMap)
 * Rate limit: 1 request/second (Nominatim policy)
 *
 * Usage: node scripts/geocode-nominatim.mjs [--limit N] [--target-only]
 *   --target-only: only geocode properties ≤200k USD and ≥120m²
 *   --limit N: max properties to geocode (default: all)
 */

const SUPABASE_URL = 'https://ysynltkotzizayjtoujf.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlzeW5sdGtvdHppemF5anRvdWpmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjU2MzM1MjksImV4cCI6MjA4MTIwOTUyOX0.-rSFZIILSIwPWIRW-frMm27_wRsIOK79Txz5alE6QUE';

const args = process.argv.slice(2);
const targetOnly = args.includes('--target-only');
const limitIdx = args.indexOf('--limit');
const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1]) : null;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Clean address for geocoding
function cleanAddress(addr, neighborhood) {
  let clean = addr
    .replace(/\bal\b/gi, '')         // "al 1400" → "1400"
    .replace(/\s+/g, ' ')
    .replace(/\. Entre .+$/i, '')    // Remove cross-street info
    .replace(/e\/.+$/i, '')          // "e/ Cesar Diaz y..."
    .trim();

  return `${clean}, ${neighborhood}, Buenos Aires, Argentina`;
}

// Geocode a single address via Nominatim
async function geocode(address) {
  const url = `https://nominatim.openstreetmap.org/search?` + new URLSearchParams({
    q: address,
    format: 'json',
    limit: '1',
    countrycodes: 'ar',
    viewbox: '-58.55,-34.52,-58.33,-34.71', // CABA bounding box
    bounded: '1'
  });

  const resp = await fetch(url, {
    headers: { 'User-Agent': 'CABAMarketStudy/1.0 (geocoding for real estate analysis)' }
  });

  if (!resp.ok) {
    throw new Error(`Nominatim HTTP ${resp.status}`);
  }

  const results = await resp.json();
  if (results.length === 0) return null;

  return {
    lat: parseFloat(results[0].lat),
    lng: parseFloat(results[0].lon),
    display: results[0].display_name,
    type: results[0].type,
    importance: results[0].importance
  };
}

// Update property in Supabase
async function updateProperty(id, lat, lng, precision) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/properties?id=eq.${id}`, {
    method: 'PATCH',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal'
    },
    body: JSON.stringify({
      latitude: lat,
      longitude: lng,
      geo_precision: precision,
      enrichment_level: 2,
      enriched_at: new Date().toISOString()
    })
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Supabase update failed: ${err}`);
  }
}

// Fetch properties to geocode
async function fetchProperties() {
  let filters = 'is_active=eq.true&address_text=not.is.null&latitude=is.null';

  if (targetOnly) {
    filters += '&price=lte.200000&total_area=gte.120';
  }

  const queryLimit = limit || 5000;
  const url = `${SUPABASE_URL}/rest/v1/properties?select=id,address_text,neighborhood&${filters}&order=price_per_sqm.asc&limit=${queryLimit}`;

  const resp = await fetch(url, {
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`
    }
  });

  if (!resp.ok) throw new Error('Failed to fetch properties');
  return resp.json();
}

// Main
async function main() {
  console.log('🗺️  Nominatim Geocoder for CABA Market Study');
  console.log(`   Mode: ${targetOnly ? 'Target profile (≤200k, ≥120m²)' : 'All with address'}`);
  if (limit) console.log(`   Limit: ${limit}`);

  const properties = await fetchProperties();
  console.log(`   Found ${properties.length} properties to geocode\n`);

  if (properties.length === 0) {
    console.log('✅ Nothing to geocode');
    return;
  }

  let success = 0, failed = 0, notFound = 0;
  const startTime = Date.now();

  for (let i = 0; i < properties.length; i++) {
    const p = properties[i];
    const addr = cleanAddress(p.address_text, p.neighborhood);

    const progress = `[${i + 1}/${properties.length}]`;
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    const eta = i > 0 ? Math.round(((Date.now() - startTime) / i * (properties.length - i)) / 1000) : '?';

    try {
      const result = await geocode(addr);

      if (result) {
        // Determine precision based on Nominatim type
        const precision = ['house', 'building'].includes(result.type) ? 'exact'
          : ['road', 'street'].includes(result.type) ? 'address'
          : 'barrio';

        await updateProperty(p.id, result.lat, result.lng, precision);
        success++;
        console.log(`${progress} ✅ ${p.address_text} → ${result.lat.toFixed(5)}, ${result.lng.toFixed(5)} [${precision}] (${elapsed}s, ETA ${eta}s)`);
      } else {
        notFound++;
        console.log(`${progress} ⚠️  ${p.address_text} → not found (${elapsed}s)`);
      }
    } catch (err) {
      failed++;
      console.log(`${progress} ❌ ${p.address_text} → ${err.message}`);
    }

    // Rate limit: 1 req/sec for Nominatim
    await sleep(1100);
  }

  const totalTime = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log(`\n📊 Done in ${totalTime} min`);
  console.log(`   ✅ Geocoded: ${success}`);
  console.log(`   ⚠️  Not found: ${notFound}`);
  console.log(`   ❌ Failed: ${failed}`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
