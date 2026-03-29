#!/usr/bin/env node
// scan-argenprop.mjs -- Argenprop grid scanner via Chrome AppleScript (Mac)
// Same pattern as scan-zp-grid.mjs: navigate with AppleScript, extract with JS file
//
// Usage: node scripts/scan-argenprop.mjs [maxPages] [--zone=caba|gba-norte|all]

import { createClient } from '@supabase/supabase-js';
import { writeFileSync } from 'fs';
import { execSync } from 'child_process';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const MAX_PAGES = parseInt(process.argv[2] || '15');
const SCRIPT_FILE = '/tmp/ap-nav.scpt';
const JS_FILE = '/tmp/ap-extract.js';
const zoneArg = process.argv.find(a => a.startsWith('--zone='))?.split('=')[1] || 'all';

const AP_ZONES = [
  { id: 'caba', name: 'Capital Federal', state: 'CABA', slug: 'casas/venta/capital-federal' },
  { id: 'gba-norte', name: 'GBA Norte', state: 'Buenos Aires', slug: 'casas/venta/zona-norte-gba' },
];

function getZones() {
  if (zoneArg === 'all') return AP_ZONES;
  return AP_ZONES.filter(z => z.id === zoneArg);
}

function runAppleScript(script) {
  try {
    writeFileSync(SCRIPT_FILE, script, 'utf8');
    return execSync(`osascript ${SCRIPT_FILE}`, { timeout: 30000, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 }).trim();
  } catch (e) { return null; }
}

function writeExtractJS() {
  const js = `(function(){
  var cards = document.querySelectorAll('a.card[data-item-card], a[data-item-card]');
  var results = [];
  cards.forEach(function(card) {
    try {
      var id = card.getAttribute('data-item-card');
      var href = card.getAttribute('href') || '';
      var price = parseInt(card.getAttribute('montonormalizado') || '0');
      var currencyId = card.getAttribute('idmoneda');
      var currency = currencyId === '2' ? 'USD' : 'ARS';
      var dorms = parseInt(card.getAttribute('dormitorios') || '0') || null;
      var ambientes = parseInt(card.getAttribute('ambientes') || '0') || null;

      var addrEl = card.querySelector('.card__address');
      var address = addrEl ? addrEl.textContent.trim() : '';
      var titleEl = card.querySelector('.card__title');
      var title = titleEl ? titleEl.textContent.trim() : '';

      var featEls = card.querySelectorAll('.card__main-features li span');
      var totalArea = null, coveredArea = null, bathrooms = null;
      featEls.forEach(function(f) {
        var t = f.textContent.trim().toLowerCase();
        var m = t.match(/(\\d+)/);
        if (!m) return;
        var num = parseInt(m[1]);
        if (t.indexOf('tot') > -1) totalArea = num;
        else if (t.indexOf('cub') > -1) coveredArea = num;
        else if (t.indexOf('ba') > -1 && t.indexOf('o') > -1) bathrooms = num;
        else if (t.indexOf('m') > -1 && !totalArea) totalArea = num;
      });

      var imgEl = card.querySelector('img[src*="argenprop"]');
      var thumbnail = imgEl ? imgEl.src : null;

      if (id && price > 0) {
        results.push({
          ap_id: id, href: href, title: title, address: address,
          price: price, currency: currency, totalArea: totalArea,
          coveredArea: coveredArea, dorms: dorms, ambientes: ambientes,
          bathrooms: bathrooms, thumbnail: thumbnail
        });
      }
    } catch(e) {}
  });
  var nextBtn = document.querySelector('a[rel="next"], .pagination__page-link--next');
  return JSON.stringify({ count: results.length, results: results, hasNext: !!nextBtn, title: document.title });
})()`;
  writeFileSync(JS_FILE, js, 'utf8');
}

function buildNavScript(url) {
  return `tell application "Google Chrome"
  tell active tab of window 1
    set URL to "${url}"
  end tell
end tell`;
}

function buildExtractScript() {
  return `tell application "Google Chrome"
  tell active tab of window 1
    set jsCode to do shell script "cat ${JS_FILE}"
    set pageData to execute javascript jsCode
    return pageData
  end tell
end tell`;
}

function determineSegment(title) {
  const t = (title || '').toLowerCase();
  if (t.includes('refaccionar') || t.includes('a reciclar')) return 'refac';
  if (t.includes('reciclada') || t.includes('reciclado') || t.includes('refaccionada') || t.includes('a estrenar')) return 'recic';
  return 'general';
}

function extractKeywords(title) {
  const kw = [];
  const t = (title || '').toLowerCase();
  const map = {
    'jardin': 'jardin', 'patio': 'patio', 'terraza': 'terraza',
    'pileta': 'pileta', 'cochera': 'cochera', 'garage': 'cochera',
    'parrilla': 'parrilla', 'quincho': 'quincho',
    'refaccionar': 'a refaccionar', 'reciclada': 'reciclada',
    'escritura': 'escritura', 'apto credito': 'apto credito',
    'ph': 'ph', 'duplex': 'duplex', 'lote': 'lote propio',
    'luminoso': 'luminoso', 'suite': 'suite', 'balcon': 'balcon',
  };
  for (const [key, val] of Object.entries(map)) {
    if (t.includes(key)) kw.push(val);
  }
  return [...new Set(kw)];
}

function extractNeighborhood(href) {
  // href: /casa-en-venta-en-villa-devoto-4-ambientes--19301642
  const m = href.match(/venta-en-([a-z-]+?)(?:-\d+-amb|--\d)/);
  if (m) {
    const raw = m[1].split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    return raw;
  }
  return null;
}

async function scanZone(zone) {
  console.log(`\n--- ${zone.name} (${zone.slug}) ---`);

  const { data: existing } = await supabase
    .from('properties').select('id').eq('source', 'argenprop').limit(10000);
  const existingIds = new Set((existing || []).map(p => p.id));

  let totalScraped = 0, totalNew = 0;

  for (let pg = 1; pg <= MAX_PAGES; pg++) {
    const url = pg === 1
      ? `https://www.argenprop.com/${zone.slug}`
      : `https://www.argenprop.com/${zone.slug}?pagina-${pg}`;

    runAppleScript(buildNavScript(url));
    await new Promise(r => setTimeout(r, 5000));

    const raw = runAppleScript(buildExtractScript());
    if (!raw) { console.log(`  Page ${pg}: extraction failed`); continue; }

    try {
      const data = JSON.parse(raw);
      if (data.title?.includes('ERROR') || data.title?.includes('403')) {
        console.log(`  Page ${pg}: blocked`); break;
      }
      if (data.count === 0) { console.log(`  Page ${pg}: no results`); break; }
      // Argenprop pagination by URL works even without next button

      let pageNew = 0;
      for (const item of data.results) {
        const id = 'ap_' + item.ap_id;
        const neighborhood = extractNeighborhood(item.href) || zone.name;
        const area = item.coveredArea || item.totalArea;
        const kw = extractKeywords(item.title);

        const row = {
          id, title: item.title || `Casa en ${neighborhood}`,
          price: item.price, currency: item.currency,
          operation: 'venta', property_type: 'casa',
          total_area: item.totalArea, covered_area: item.coveredArea,
          bedrooms: item.dorms, bathrooms: item.bathrooms, ambientes: item.ambientes,
          neighborhood, address_text: item.address,
          city: zone.name, state: zone.state,
          permalink: 'https://www.argenprop.com' + item.href,
          thumbnail: item.thumbnail, keywords: kw,
          segment: determineSegment(item.title), source: 'argenprop',
          slug: item.href,
          price_per_sqm: (item.price && area > 0) ? Math.round(item.price / area) : null,
          is_active: true, enrichment_level: 0,
          first_seen_at: existingIds.has(id) ? undefined : new Date().toISOString(),
          last_seen_at: new Date().toISOString(),
          scraped_at: new Date().toISOString(),
        };
        if (row.first_seen_at === undefined) delete row.first_seen_at;

        const { error } = await supabase.from('properties').upsert(row, { onConflict: 'id', ignoreDuplicates: false });
        if (!error && !existingIds.has(id)) pageNew++;
      }

      totalScraped += data.count;
      totalNew += pageNew;
      console.log(`  Page ${pg}: ${data.count} listings, ${pageNew} new`);

      // Don't rely on hasNext - Argenprop pagination works by URL, stop when 0 results
    } catch (e) {
      console.log(`  Page ${pg}: parse error`);
    }

    await new Promise(r => setTimeout(r, 3000));
  }

  return { scraped: totalScraped, new: totalNew };
}

async function main() {
  const t0 = Date.now();
  writeExtractJS();
  const zones = getZones();
  console.log(`Argenprop Scanner -- ${zones.length} zone(s), ${MAX_PAGES} pages each\n`);

  let grandTotal = { scraped: 0, new: 0 };
  for (const zone of zones) {
    const r = await scanZone(zone);
    grandTotal.scraped += r.scraped;
    grandTotal.new += r.new;
  }

  const dur = Math.round((Date.now() - t0) / 1000);
  console.log(`\nDone: ${grandTotal.scraped} scraped, ${grandTotal.new} new (${dur}s)`);

  await supabase.from('scrape_runs').insert({
    source: 'argenprop', segment: zoneArg,
    total_scraped: grandTotal.scraped, total_new: grandTotal.new,
    total_updated: grandTotal.scraped, total_deactivated: 0,
    duration_ms: Date.now() - t0,
    metadata: { pages: MAX_PAGES, zones: zones.map(z => z.id), runner: 'local-mac' },
    started_at: new Date(t0).toISOString(),
    completed_at: new Date().toISOString(),
  });
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
