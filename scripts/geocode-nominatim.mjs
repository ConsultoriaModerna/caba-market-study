#!/usr/bin/env node
/**
 * Geocode properties using Nominatim (OpenStreetMap)
 * Rate limit: 1 request/second (Nominatim policy)
 *
 * Usage: node scripts/geocode-nominatim.mjs [--limit N] [--target-only] [--retry-failed]
 *   --target-only: only geocode properties <=200k USD and >=120m2
 *   --limit N: max properties to geocode (default: 500)
 *   --retry-failed: also retry properties that failed before (address-based)
 */

const SUPABASE_URL = 'https://ysynltkotzizayjtoujf.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlzeW5sdGtvdHppemF5anRvdWpmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjU2MzM1MjksImV4cCI6MjA4MTIwOTUyOX0.-rSFZIILSIwPWIRW-frMm27_wRsIOK79Txz5alE6QUE';

const args = process.argv.slice(2);
const targetOnly = args.includes('--target-only');
const retryFailed = args.includes('--retry-failed');
const limitIdx = args.indexOf('--limit');
const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1]) : 500;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// CABA + GBA Norte bounding box
const VIEWBOX = '-58.60,-34.45,-58.30,-34.72';

// Build address variants for better Nominatim matching
function buildAddressVariants(addr, neighborhood, city) {
  const variants = [];
  if (!addr && !neighborhood) return variants;

  // Clean the raw address
  const clean = (addr || '')
    .replace(/\bal\s+/gi, '')           // "al 1400" -> "1400"
    .replace(/\bNº?\s*/gi, '')          // "Nº 1400" -> "1400"
    .replace(/\s+/g, ' ')
    .replace(/\.\s*Entre\s+.+$/i, '')   // Remove cross-street
    .replace(/\s*e\/.+$/i, '')          // "e/ Cesar Diaz y..."
    .replace(/\s*entre\s+.+$/i, '')     // "entre X y Y"
    .replace(/,\s*$/,'')
    .trim();

  const loc = city && city !== 'Capital Federal' ? city : 'Buenos Aires';
  const barrio = neighborhood || '';

  // Variant 1: full address with barrio and city
  if (clean) {
    variants.push(`${clean}, ${barrio}, ${loc}, Argentina`);
  }

  // Variant 2: without barrio (sometimes confuses Nominatim)
  if (clean) {
    variants.push(`${clean}, ${loc}, Argentina`);
  }

  // Variant 3: street name + number only (extract from "Pasaje Tokio 2000" etc)
  if (clean) {
    const match = clean.match(/^(.+?)\s+(\d{2,5})\s*$/);
    if (match) {
      variants.push(`${match[1]} ${match[2]}, ${barrio}, ${loc}, Argentina`);
    }
  }

  // Variant 4: just barrio (fallback for centroid)
  if (barrio) {
    variants.push(`${barrio}, ${loc}, Argentina`);
  }

  return variants;
}

// Geocode trying multiple variants
async function geocodeWithVariants(variants) {
  for (const address of variants) {
    const result = await geocodeSingle(address);
    if (result) {
      // Determine precision based on which variant matched
      const isBarrioOnly = address === variants[variants.length - 1] && variants.length > 1;
      if (isBarrioOnly) {
        result.precision = 'barrio';
      }
      return result;
    }
    await sleep(1100);
  }
  return null;
}

// Geocode a single address via Nominatim
async function geocodeSingle(address) {
  const url = `https://nominatim.openstreetmap.org/search?` + new URLSearchParams({
    q: address,
    format: 'json',
    limit: '1',
    countrycodes: 'ar',
    viewbox: VIEWBOX,
    bounded: '0' // Don't strictly bound, but prefer results in viewbox
  });

  const resp = await fetch(url, {
    headers: { 'User-Agent': 'InmoFindr/1.0 (geocoding for real estate analysis)' }
  });

  if (!resp.ok) {
    throw new Error(`Nominatim HTTP ${resp.status}`);
  }

  const results = await resp.json();
  if (results.length === 0) return null;

  const r = results[0];
  const lat = parseFloat(r.lat);
  const lon = parseFloat(r.lon);

  // Validate: must be in greater Buenos Aires area
  if (lat < -35.0 || lat > -34.3 || lon < -58.7 || lon > -58.2) return null;

  return {
    lat,
    lng: lon,
    display: r.display_name,
    type: r.type,
    precision: ['house', 'building'].includes(r.type) ? 'exact'
      : ['road', 'street', 'residential'].includes(r.type) ? 'address'
      : 'barrio'
  };
}

// Update property in Supabase
async function updateProperty(id, lat, lng, precision) {
  const enrichLevel = precision === 'exact' ? 2 : precision === 'address' ? 2 : 3;
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
      enrichment_level: enrichLevel,
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
  let filters = 'is_active=eq.true&latitude=is.null';

  if (targetOnly) {
    filters += '&price=lte.200000&total_area=gte.120';
  }

  // Properties with address OR neighborhood (we can geocode by barrio as fallback)
  const url = `${SUPABASE_URL}/rest/v1/properties?select=id,address_text,neighborhood,city,state&${filters}&order=price_per_sqm.asc&limit=${limit}`;

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
  console.log('Nominatim Geocoder for InmoFindr');
  console.log(`  Mode: ${targetOnly ? 'Target profile (<=200k, >=120m2)' : 'All without GPS'}`);
  console.log(`  Limit: ${limit}`);

  const properties = await fetchProperties();
  console.log(`  Found ${properties.length} properties to geocode\n`);

  if (properties.length === 0) {
    console.log('Nothing to geocode');
    return;
  }

  let success = 0, failed = 0, notFound = 0;
  const startTime = Date.now();

  for (let i = 0; i < properties.length; i++) {
    const p = properties[i];
    const variants = buildAddressVariants(p.address_text, p.neighborhood, p.city);

    if (variants.length === 0) {
      notFound++;
      continue;
    }

    const progress = `[${i + 1}/${properties.length}]`;
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);

    try {
      const result = await geocodeWithVariants(variants);

      if (result) {
        await updateProperty(p.id, result.lat, result.lng, result.precision);
        success++;
        console.log(`${progress} OK ${p.address_text || p.neighborhood} -> ${result.lat.toFixed(5)}, ${result.lng.toFixed(5)} [${result.precision}] (${elapsed}s)`);
      } else {
        notFound++;
        console.log(`${progress} -- ${p.address_text || p.neighborhood} -> not found (${elapsed}s)`);
      }
    } catch (err) {
      failed++;
      console.log(`${progress} ERR ${p.address_text || p.neighborhood} -> ${err.message}`);
    }

    await sleep(1100);
  }

  const totalTime = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log(`\nDone in ${totalTime} min`);
  console.log(`  Geocoded: ${success}`);
  console.log(`  Not found: ${notFound}`);
  console.log(`  Failed: ${failed}`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
