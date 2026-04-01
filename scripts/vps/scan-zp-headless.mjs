#!/usr/bin/env node
// scan-zp-headless.mjs — ZP grid scanner via Puppeteer on Linux VPS
// Replaces AppleScript-based scan-zp-grid.mjs for headless environments
// Uses real Chrome + xvfb to bypass Cloudflare
//
// Usage: node scripts/vps/scan-zp-headless.mjs [maxPages] [--zone=caba|gba-norte|all]
// Cron: runs as part of nightly-update.sh

import { createClient } from '@supabase/supabase-js';
import puppeteer from 'puppeteer';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const MAX_PAGES = parseInt(process.argv[2] || '20');
const PROFILE_DIR = '/opt/caba-market-study/.chrome-profile';
const BASE_DELAY_MS = 4000;
const COOLDOWN_BETWEEN_ZONES_MS = 30000;

// Circuit breaker: detect blocks early, never escalate
const CB = {
  consecutiveFails: 0,    // timeouts + CF challenges + empty pages in a row
  totalCfHits: 0,         // total CF challenges across all zones
  zonesAborted: 0,        // zones abandoned due to blocks
  MAX_CONSECUTIVE: 3,     // abort zone after 3 consecutive fails
  MAX_CF_TOTAL: 5,        // abort entirely after 5 CF hits
  MAX_ZONES_ABORTED: 2,   // abort entirely after 2 zones fail
  BACKOFF_PAUSE_MS: 60000, // 60s pause when hitting limit
  currentDelay: 4000,     // dynamic delay, increases after warnings

  onSuccess() {
    this.consecutiveFails = 0;
    this.currentDelay = BASE_DELAY_MS;
  },
  onWarning(reason) {
    this.consecutiveFails++;
    this.currentDelay = Math.min(this.currentDelay * 1.5, 15000);
    console.log(`  [CB] Warning #${this.consecutiveFails}: ${reason} (delay now ${Math.round(this.currentDelay)}ms)`);
  },
  onCfHit() {
    this.totalCfHits++;
    this.onWarning(`Cloudflare challenge (${this.totalCfHits} total)`);
  },
  shouldAbortZone() {
    return this.consecutiveFails >= this.MAX_CONSECUTIVE;
  },
  shouldAbortAll() {
    return this.totalCfHits >= this.MAX_CF_TOTAL || this.zonesAborted >= this.MAX_ZONES_ABORTED;
  },
  abortZone(zoneName) {
    this.zonesAborted++;
    this.consecutiveFails = 0;
    console.log(`  [CB] ABORT zone ${zoneName} (${this.zonesAborted} zones aborted)`);
  }
};

// Parse --zone and --type flags
const zoneArg = process.argv.find(a => a.startsWith('--zone='))?.split('=')[1] || 'all';
const typeArg = process.argv.find(a => a.startsWith('--type='))?.split('=')[1] || 'casa';

import { getZPLocations, PROPERTY_TYPES } from '../zones-config.mjs';

const ZP_LOCATIONS = getZPLocations(typeArg);
const PROP_TYPE_LABEL = PROPERTY_TYPES.find(t => t.id === typeArg)?.label || typeArg;

function getLocations() {
  if (zoneArg === 'all') return ZP_LOCATIONS;
  if (zoneArg === 'caba') return ZP_LOCATIONS.filter(l => l.state === 'CABA');
  if (zoneArg === 'gba-norte') return ZP_LOCATIONS.filter(l => l.state === 'Buenos Aires');
  const match = ZP_LOCATIONS.filter(l => l.slug.includes(zoneArg));
  return match.length ? match : ZP_LOCATIONS;
}

const EXTRACT_JS = `(() => {
  const cards = document.querySelectorAll('[data-qa="posting PROPERTY"]');
  const fallback = cards.length ? cards : document.querySelectorAll('.postingCard, [data-posting-type]');
  const results = [];
  fallback.forEach(card => {
    const link = card.querySelector('a[href*="/propiedades/"]');
    const priceEl = card.querySelector('[data-qa="POSTING_CARD_PRICE"], .firstPrice, [class*="price"]');
    const locEl = card.querySelector('[data-qa="POSTING_CARD_LOCATION"], .postingAddress, [class*="location"]');
    const featEl = card.querySelector('[data-qa="POSTING_CARD_FEATURES"], .postingMainFeatures, [class*="feature"]');
    if (link) {
      const href = link.getAttribute('href') || '';
      const idMatch = href.match(/(\\d{6,})\\.html/);
      results.push({
        slug: href,
        zp_id: idMatch ? idMatch[1] : null,
        price_text: priceEl ? priceEl.innerText.trim() : null,
        location_text: locEl ? locEl.innerText.trim() : null,
        features_text: featEl ? featEl.innerText.trim() : null,
        title: link.getAttribute('title') || (card.querySelector('h2,h3') ? card.querySelector('h2,h3').innerText.trim() : null)
      });
    }
  });
  const nextBtn = document.querySelector('[data-qa="PAGING_NEXT"], a.next, [class*="next"]');
  return { count: results.length, results, hasNext: !!nextBtn, title: document.title };
})()`;

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
  const cleaned = locText.includes('\n') ? locText.split('\n').pop() : locText;
  const parts = cleaned.split(',').map(s => s.trim());
  return parts.length >= 2 ? parts[parts.length - 2] : parts[0];
}

async function scanLocation(page, location) {
  const baseUrl = `https://www.zonaprop.com.ar/${location.slug}`;
  console.log(`\n--- ${location.city} (${location.slug}) ---`);

  const { data: existing } = await supabase
    .from('properties')
    .select('slug')
    .eq('source', 'zonaprop')
    .limit(15000);

  const existingSlugs = new Set((existing || []).map(p => p.slug));
  let allScanned = [];

  for (let pg = 1; pg <= MAX_PAGES; pg++) {
    // Circuit breaker: check before each page
    if (CB.shouldAbortZone()) {
      CB.abortZone(location.city);
      break;
    }

    const url = pg === 1 ? `${baseUrl}.html` : `${baseUrl}-pagina-${pg}.html`;

    try {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

      // Check for Cloudflare
      const title = await page.title();
      if (title.includes('moment') || title.includes('Cloudflare')) {
        CB.onCfHit();
        if (CB.shouldAbortZone()) break;
        console.log(`  Page ${pg}: CF challenge, backing off ${CB.BACKOFF_PAUSE_MS / 1000}s...`);
        await new Promise(r => setTimeout(r, CB.BACKOFF_PAUSE_MS));
        await page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
        const t2 = await page.title();
        if (t2.includes('moment') || t2.includes('Cloudflare')) {
          CB.onCfHit();
          break; // Still blocked after pause, abort zone
        }
      }

      // Wait for listings to load
      await page.waitForSelector('[data-qa="posting PROPERTY"], .postingCard', { timeout: 10000 }).catch(() => {});

      const data = await page.evaluate(EXTRACT_JS);

      if (!data || data.count === 0) {
        CB.onWarning('empty page');
        console.log(`  Page ${pg}: no listings found`);
        break;
      }

      // Success -- reset circuit breaker
      CB.onSuccess();

      for (const item of data.results) {
        allScanned.push(item);
      }

      const newOnPage = data.results.filter(r => r.slug && !existingSlugs.has(r.slug)).length;
      console.log(`  Page ${pg}: ${data.count} listings, ${newOnPage} new`);

      if (!data.hasNext) {
        console.log('  No more pages');
        break;
      }
    } catch (e) {
      CB.onWarning(e.message.substring(0, 60));
      console.log(`  Page ${pg}: ${e.message.substring(0, 80)}`);
      if (CB.shouldAbortZone()) break;
    }

    await new Promise(r => setTimeout(r, CB.currentDelay));
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
      title: item.title || `${PROP_TYPE_LABEL} en ${neighborhood || location.city}`,
      price, currency,
      total_area: features.total_area,
      ambientes: features.ambientes,
      bedrooms: features.bedrooms,
      neighborhood,
      source: 'zonaprop',
      operation: 'venta',
      property_type: location.property_type || typeArg,
      state: location.state,
      city: location.city,
      is_active: true,
      enrichment_level: 0,
      first_seen_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
      scraped_at: new Date().toISOString(),
    }, { onConflict: 'id', ignoreDuplicates: true });

    if (!error) newCount++;
  }

  // Update existing: refresh last_seen_at + detect price changes
  let updatedCount = 0;
  for (const item of allScanned) {
    if (!item.slug || !existingSlugs.has(item.slug)) continue;
    if (!item.zp_id) continue;
    const { price, currency } = parsePrice(item.price_text);
    const features = parseFeatures(item.features_text);
    const update = {
      last_seen_at: new Date().toISOString(),
      is_active: true,
    };
    // Update price + area if available from grid (detect-price-drops will compare snapshots)
    if (price) { update.price = price; update.currency = currency; }
    if (features.total_area) update.total_area = features.total_area;
    if (features.ambientes) update.ambientes = features.ambientes;
    if (features.bedrooms) update.bedrooms = features.bedrooms;
    // Recalc price_per_sqm
    if (price && features.total_area) update.price_per_sqm = Math.round(price / features.total_area);

    await supabase.from('properties')
      .update(update)
      .eq('id', 'zp_' + item.zp_id);
    updatedCount++;
  }

  console.log(`  Result: ${allScanned.length} scanned, ${newCount} new, ${updatedCount} refreshed`);
  return { location: location.city, scanned: allScanned.length, newCount, updatedCount };
}

async function main() {
  const t0 = Date.now();
  const locations = getLocations();
  console.log(`ZP Headless Scanner -- ${locations.length} location(s), ${MAX_PAGES} pages each`);

  console.log('Launching Chrome...');
  const browser = await puppeteer.launch({
    headless: false,
    executablePath: '/usr/bin/google-chrome',
    userDataDir: PROFILE_DIR,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--window-size=1280,800'
    ]
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36');

  // Warm up with ZP home to pass Cloudflare
  console.log('Warming up Cloudflare...');
  await page.goto('https://www.zonaprop.com.ar', { waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise(r => setTimeout(r, 3000));

  let grandTotal = { scanned: 0, new: 0, updated: 0 };

  for (const loc of locations) {
    if (CB.shouldAbortAll()) {
      console.log(`\n[CB] ABORT ALL -- too many blocks (${CB.totalCfHits} CF hits, ${CB.zonesAborted} zones aborted). Stopping to avoid escalation.`);
      break;
    }
    const result = await scanLocation(page, loc);
    grandTotal.scanned += result.scanned;
    grandTotal.new += result.newCount;
    grandTotal.updated += result.updatedCount;

    // Cooldown between zones
    if (locations.indexOf(loc) < locations.length - 1) {
      console.log(`  Cooldown ${COOLDOWN_BETWEEN_ZONES_MS / 1000}s before next zone...`);
      await new Promise(r => setTimeout(r, COOLDOWN_BETWEEN_ZONES_MS));
    }
  }

  await browser.close();

  const dur = Math.round((Date.now() - t0) / 1000);
  console.log(`\nGrid scan complete: ${grandTotal.scanned} scanned, ${grandTotal.new} new, ${grandTotal.updated} refreshed (${dur}s)`);

  await supabase.from('scrape_runs').insert({
    source: 'zonaprop', segment: zoneArg,
    total_scraped: grandTotal.scanned, total_new: grandTotal.new,
    total_updated: grandTotal.updated, total_deactivated: 0,
    duration_ms: Date.now() - t0,
    metadata: { pages: MAX_PAGES, locations: locations.map(l => l.city), runner: 'vps-headless' },
    started_at: new Date(t0).toISOString(),
    completed_at: new Date().toISOString(),
  });

  // Slack notification
  if (process.env.SLACK_WEBHOOK) {
    const msg = `🔍 *ZP Grid Scan — ${new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })}*\n\n` +
      locations.map(l => {
        const r = grandTotal;
        return `• ${l.city}`;
      }).join('\n') + '\n\n' +
      `📊 Total: \`${grandTotal.scanned}\` scanned, \`${grandTotal.new}\` new, \`${grandTotal.updated}\` refreshed\n` +
      `⏱️ Duration: \`${dur}s\``;

    await fetch(process.env.SLACK_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: msg }),
    }).catch(() => {});
  }
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
