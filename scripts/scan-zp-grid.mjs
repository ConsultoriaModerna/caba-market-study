#!/usr/bin/env node
// scan-zp-grid.mjs — Fast scan of ZP listing grid pages via Chrome AppleScript
// Navigates ZP search results pages, extracts listing IDs + basic data
// Compares against DB to detect new listings and mark missing ones
// Does NOT visit individual property pages — that's enrich-zp-chrome.mjs
//
// Usage: node scripts/scan-zp-grid.mjs [maxPages]
// ~2 minutes for 20 pages (~400 listings scanned)

import { createClient } from '@supabase/supabase-js';
import { writeFileSync } from 'fs';
import { execSync } from 'child_process';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const MAX_PAGES = parseInt(process.argv[2] || '20');
const SCRIPT_FILE = '/tmp/zp-grid.scpt';
const BASE_URL = 'https://www.zonaprop.com.ar/casas-venta-capital-federal';

function runAppleScript(script) {
  try {
    writeFileSync(SCRIPT_FILE, script, 'utf8');
    return execSync(`osascript ${SCRIPT_FILE}`, {
      timeout: 30000,
      encoding: 'utf8',
      maxBuffer: 2 * 1024 * 1024
    }).trim();
  } catch (e) {
    return null;
  }
}

function buildGridScript(url) {
  const js = `(function(){
    var cards = document.querySelectorAll('[data-qa="posting PROPERTY"]');
    if (!cards.length) cards = document.querySelectorAll('.postingCard, [data-posting-type]');
    var results = [];
    cards.forEach(function(card) {
      var link = card.querySelector('a[href*="/propiedades/"]');
      var priceEl = card.querySelector('[data-qa="POSTING_CARD_PRICE"], .firstPrice, [class*="price"]');
      var locEl = card.querySelector('[data-qa="POSTING_CARD_LOCATION"], .postingAddress, [class*="location"]');
      var featEl = card.querySelector('[data-qa="POSTING_CARD_FEATURES"], .postingMainFeatures, [class*="feature"]');
      if (link) {
        var href = link.getAttribute('href') || '';
        var idMatch = href.match(/(\\d{6,})\\.html/);
        results.push({
          slug: href,
          zp_id: idMatch ? idMatch[1] : null,
          price_text: priceEl ? priceEl.innerText.trim() : null,
          location_text: locEl ? locEl.innerText.trim() : null,
          features_text: featEl ? featEl.innerText.trim() : null,
          title: link.getAttribute('title') || card.querySelector('h2,h3')?.innerText?.trim() || null
        });
      }
    });
    var nextBtn = document.querySelector('[data-qa="PAGING_NEXT"], a.next, [class*="next"]');
    return JSON.stringify({ count: results.length, results: results, hasNext: !!nextBtn, title: document.title });
  })()`.replace(/"/g, '\\"');

  return `tell application "Google Chrome"
  tell active tab of window 1
    set URL to "${url}"
  end tell
  delay 5
  tell active tab of window 1
    set pageData to execute javascript "${js}"
    return pageData
  end tell
end tell`;
}

function parsePrice(text) {
  if (!text) return { price: null, currency: null };
  const usdMatch = text.match(/USD\s*([\d.]+)/i);
  if (usdMatch) return { price: parseFloat(usdMatch[1].replace(/\./g, '')), currency: 'USD' };
  const arsMatch = text.match(/\$\s*([\d.]+)/);
  if (arsMatch) return { price: parseFloat(arsMatch[1].replace(/\./g, '')), currency: 'ARS' };
  return { price: null, currency: null };
}

function parseFeatures(text) {
  if (!text) return {};
  const area = text.match(/(\d+)\s*m²/);
  const amb = text.match(/(\d+)\s*amb/i);
  const dorm = text.match(/(\d+)\s*dorm/i);
  return {
    total_area: area ? parseInt(area[1]) : null,
    ambientes: amb ? parseInt(amb[1]) : null,
    bedrooms: dorm ? parseInt(dorm[1]) : null
  };
}

function extractNeighborhood(locText) {
  if (!locText) return null;
  const parts = locText.split(',').map(s => s.trim());
  return parts.length >= 2 ? parts[parts.length - 2] : parts[0];
}

async function main() {
  const t0 = Date.now();
  console.log(`🔍 ZP Grid Scanner — scanning ${MAX_PAGES} pages\n`);

  // Get existing ZP IDs for comparison
  const { data: existing } = await supabase
    .from('properties')
    .select('slug')
    .eq('source', 'zonaprop')
    .limit(10000);

  const existingSlugs = new Set((existing || []).map(p => p.slug));

  let allScanned = [];
  let seenSlugs = new Set();

  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = page === 1 ? `${BASE_URL}.html` : `${BASE_URL}-pagina-${page}.html`;

    const script = buildGridScript(url);
    const raw = runAppleScript(script);

    if (!raw) {
      console.log(`  ❌ Page ${page}: AppleScript failed`);
      continue;
    }

    try {
      const data = JSON.parse(raw);

      if (data.title?.includes('moment')) {
        console.log(`  ⚠️ Page ${page}: Cloudflare challenge`);
        await new Promise(r => setTimeout(r, 10000));
        continue;
      }

      for (const item of data.results) {
        if (item.slug) seenSlugs.add(item.slug);
        allScanned.push(item);
      }

      const newOnPage = data.results.filter(r => r.slug && !existingSlugs.has(r.slug)).length;
      console.log(`  📄 Page ${page}: ${data.count} listings, ${newOnPage} new`);

      if (!data.hasNext) {
        console.log('  📭 No more pages');
        break;
      }
    } catch (e) {
      console.log(`  ❌ Page ${page}: parse error`);
    }

    await new Promise(r => setTimeout(r, 3000));
  }

  // Insert new properties
  let newCount = 0;
  for (const item of allScanned) {
    if (!item.slug || existingSlugs.has(item.slug)) continue;
    if (!item.zp_id) continue;

    const { price, currency } = parsePrice(item.price_text);
    const features = parseFeatures(item.features_text);
    const neighborhood = extractNeighborhood(item.location_text);
    const id = 'zp_' + item.zp_id;

    const { error } = await supabase.from('properties').upsert({
      id,
      slug: item.slug,
      permalink: 'https://www.zonaprop.com.ar' + item.slug,
      title: item.title || `Casa en ${neighborhood || 'CABA'}`,
      price, currency,
      total_area: features.total_area,
      ambientes: features.ambientes,
      bedrooms: features.bedrooms,
      neighborhood,
      source: 'zonaprop',
      operation: 'venta',
      property_type: 'casa',
      state: 'CABA',
      is_active: true,
      enrichment_level: 0,
      first_seen_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
      scraped_at: new Date().toISOString(),
    }, { onConflict: 'id', ignoreDuplicates: true });

    if (!error) newCount++;
  }

  // Update last_seen_at for existing ones we saw
  let updatedCount = 0;
  for (const item of allScanned) {
    if (!item.slug || !existingSlugs.has(item.slug)) continue;
    if (!item.zp_id) continue;
    const id = 'zp_' + item.zp_id;
    await supabase.from('properties')
      .update({ last_seen_at: new Date().toISOString(), is_active: true })
      .eq('id', id);
    updatedCount++;
  }

  const dur = Math.round((Date.now() - t0) / 1000);
  console.log(`\n🏁 Grid scan: ${allScanned.length} scanned, ${newCount} new, ${updatedCount} refreshed (${dur}s)`);
  console.log(`   New listings need enrichment: run enrich-zp-chrome.mjs`);

  await supabase.from('scrape_runs').insert({
    source: 'zonaprop', segment: 'grid-scan',
    total_scraped: allScanned.length, total_new: newCount,
    total_updated: updatedCount, total_deactivated: 0,
    duration_ms: Date.now() - t0,
    metadata: { pages: MAX_PAGES, runner: 'local-mac' },
    started_at: new Date(t0).toISOString(),
    completed_at: new Date().toISOString(),
  });
}

main().catch(e => { console.error('💀', e.message); process.exit(1); });
