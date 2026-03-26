#!/usr/bin/env node
// enrich-zp-chrome.mjs — Enrich ZonaProp properties via Chrome AppleScript
// Uses the real Chrome browser (bypasses Cloudflare) to extract property data
// Usage: node scripts/enrich-zp-chrome.mjs [delayMs] [batchSize]

import { createClient } from '@supabase/supabase-js';
import { execSync } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const DELAY = parseInt(process.argv[2] || '3000');
const BATCH_SIZE = parseInt(process.argv[3] || '500');
const SCRIPT_FILE = '/tmp/zp-scrape.scpt';

function runAppleScript(script) {
  try {
    writeFileSync(SCRIPT_FILE, script, 'utf8');
    return execSync(`osascript ${SCRIPT_FILE}`, {
      timeout: 30000,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024
    }).trim();
  } catch (e) {
    return null;
  }
}

function extractFromBody(body) {
  const data = {};

  // Total area: "360 m² tot."
  const totMatch = body.match(/(\d[\d.,]+)\s*m²\s*tot/i);
  if (totMatch) data.total_area = parseFloat(totMatch[1].replace(',', '.'));

  // Covered area: "160 m² cub."
  const cubMatch = body.match(/(\d[\d.,]+)\s*m²\s*cub/i);
  if (cubMatch) data.covered_area = parseFloat(cubMatch[1].replace(',', '.'));

  // Bedrooms: "3 dorm."
  const dormMatch = body.match(/(\d+)\s*dorm/i);
  if (dormMatch) data.bedrooms = parseInt(dormMatch[1]);

  // Bathrooms: "1 baño" or "2 baños"
  const bathMatch = body.match(/(\d+)\s*baño/i);
  if (bathMatch) data.bathrooms = parseInt(bathMatch[1]);

  // Parking: "1 coch."
  const cochMatch = body.match(/(\d+)\s*coch/i);
  if (cochMatch) data.cocheras = parseInt(cochMatch[1]);

  // Age: "51 años"
  const ageMatch = body.match(/(\d+)\s*años?\b/i);
  if (ageMatch) data.age = parseInt(ageMatch[1]);

  // Price: "Venta USD 115.000"
  const priceMatch = body.match(/(?:Venta|USD)\s*(?:USD\s*)?([\d.]+)/i);
  if (priceMatch) data.price_check = parseFloat(priceMatch[1].replace(/\./g, ''));

  // Publisher name: appears after "Contactar por WhatsApp\n" and before phone/digits
  const pubMatch = body.match(/(?:Contactar por WhatsApp|Contactar)\n([A-ZÁÉÍÓÚÑa-záéíóúñ][\w\s.&áéíóúñÁÉÍÓÚÑ-]{3,60})\n/);
  if (pubMatch) data.contact_name = pubMatch[1].trim();

  // Description: after title line (Venta/Casa...) look for substantial text block
  const descMatch = body.match(/(?:Descripción:\n|(?:Casa|Venta|PH)\s+(?:Venta|Alquiler|—)[^\n]*\n)([\s\S]{50,?})(?:\nLeer descripción completa|\n¿Cómo evitar|\nVer más en |\nPropiedades en barrios|$)/);
  if (descMatch) data.description = descMatch[1].trim().substring(0, 10000);

  // Fallback: grab everything between the features block and footer
  if (!data.description) {
    const fallback = body.match(/(?:\d+\s*(?:dorm|baño|coch|amb|toilette|años)\w*\.?\n)+(?:[A-Z][^\n]*\n)?([\s\S]{80,?})(?:\n¿Cómo evitar|\nVer más en |\nPropiedades similares|$)/);
    if (fallback) data.description = fallback[1].trim().substring(0, 10000);
  }

  return data;
}

function buildAppleScript(permalink) {
  // Use AppleScript's quoted form and separate JS string to avoid escaping hell
  const js = `(function(){
    var ld = document.querySelectorAll('script[type="application/ld+json"]');
    var house = null;
    for (var i = 0; i < ld.length; i++) {
      try { var j = JSON.parse(ld[i].textContent); if (j['@type'] === 'House' || j['@type'] === 'Apartment') house = j; } catch(e) {}
    }
    var body = document.body.innerText.substring(0, 5000);
    var title = document.title;
    return JSON.stringify({house: house, body: body, title: title});
  })()`.replace(/"/g, '\\"');

  return `tell application "Google Chrome"
  tell active tab of window 1
    set URL to "${permalink}"
  end tell
  delay 5
  tell active tab of window 1
    set pageData to execute javascript "${js}"
    return pageData
  end tell
end tell`;
}

async function scrapePage(permalink) {
  const navScript = buildAppleScript(permalink);
  const raw = runAppleScript(navScript);
  if (!raw) return null;

  try {
    const data = JSON.parse(raw);

    if (data.title?.includes('moment') || data.body?.includes('security verification')) {
      console.log('  ⚠️ Cloudflare challenge, waiting 15s...');
      await new Promise(r => setTimeout(r, 15000));
      const retry = runAppleScript(navScript);
      if (retry) return JSON.parse(retry);
      return null;
    }

    return data;
  } catch {
    return null;
  }
}

async function main() {
  const t0 = Date.now();

  // Get ZP properties never visited (enrichment_level is null or 0)
  const { data: props, error } = await supabase
    .from('properties')
    .select('id, permalink, description, covered_area, bedrooms, bathrooms, price')
    .eq('source', 'zonaprop')
    .eq('is_active', true)
    .not('permalink', 'is', null)
    .or('enrichment_level.is.null,enrichment_level.eq.0')
    .limit(BATCH_SIZE);

  if (error) { console.error('❌', error.message); process.exit(1); }

  console.log(`📦 ${props.length} ZP properties to enrich (delay: ${DELAY}ms)\n`);
  if (!props.length) { console.log('Nothing to do.'); return; }

  let enriched = 0, skipped = 0, errors = 0;

  for (let i = 0; i < props.length; i++) {
    const prop = props[i];
    if (!prop.permalink) { skipped++; continue; }

    const pageData = await scrapePage(prop.permalink);

    if (!pageData) {
      errors++;
      if ((i + 1) % 25 === 0) console.log(`  📊 ${i + 1}/${props.length} — enriched: ${enriched}, skip: ${skipped}, err: ${errors}`);
      await new Promise(r => setTimeout(r, DELAY));
      continue;
    }

    const fromBody = extractFromBody(pageData.body || '');
    const house = pageData.house || {};

    // Build update
    const update = {};

    if (!prop.description && fromBody.description) {
      update.description = fromBody.description;
    }

    if (!prop.covered_area && fromBody.covered_area) {
      update.covered_area = fromBody.covered_area;
    }

    // Also update total_area from page if we got a more precise value
    if (fromBody.total_area) {
      update.total_area = fromBody.total_area;
    }

    if (!prop.bedrooms) {
      update.bedrooms = fromBody.bedrooms || house.numberOfBedrooms || null;
    }

    if (!prop.bathrooms) {
      update.bathrooms = fromBody.bathrooms || house.numberOfBathroomsTotal || null;
    }

    if (fromBody.cocheras) update.cocheras = fromBody.cocheras;

    // Address from JSON-LD
    if (house.address?.streetAddress) {
      update.address_text = house.address.streetAddress;
    }

    // Contact
    if (house.telephone) {
      update.contact_phone = house.telephone;
    }
    if (fromBody.contact_name) {
      update.contact_name = fromBody.contact_name;
    }

    // Image
    if (house.image) {
      update.thumbnail = house.image;
    }

    // Price per sqm recalc if we have new area
    if (update.total_area && prop.price) {
      update.price_per_sqm = Math.round(Number(prop.price) / update.total_area);
    }

    update.enrichment_level = 1;
    update.enriched_at = new Date().toISOString();

    if (Object.keys(update).length > 2) {
      const { error: upErr } = await supabase
        .from('properties')
        .update(update)
        .eq('id', prop.id);

      if (upErr) { errors++; }
      else { enriched++; }
    } else {
      skipped++;
    }

    if ((i + 1) % 25 === 0 || i === props.length - 1) {
      const elapsed = Math.round((Date.now() - t0) / 1000);
      const eta = Math.round(((Date.now() - t0) / (i + 1)) * (props.length - i - 1) / 1000);
      console.log(`  📊 ${i + 1}/${props.length} — enriched: ${enriched}, skip: ${skipped}, err: ${errors} [${elapsed}s, ~${eta}s ETA]`);
    }

    await new Promise(r => setTimeout(r, DELAY));
  }

  const dur = Math.round((Date.now() - t0) / 1000);
  console.log(`\n🏁 ZP enrichment: ${enriched} enriched, ${skipped} skipped, ${errors} errors (${dur}s)`);

  await supabase.from('scrape_runs').insert({
    source: 'zonaprop', segment: 'enrich-chrome',
    total_scraped: props.length, total_new: 0, total_updated: enriched,
    total_deactivated: 0, duration_ms: Date.now() - t0,
    error_message: errors > 0 ? `${errors} errors` : null,
    metadata: { type: 'enrich-chrome-applescript', runner: 'local-mac', delay_ms: DELAY },
    started_at: new Date(t0).toISOString(),
    completed_at: new Date().toISOString(),
  });
}

main().catch(e => { console.error('💀 Fatal:', e.message); process.exit(1); });
