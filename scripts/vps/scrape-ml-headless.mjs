#!/usr/bin/env node
// scrape-ml-headless.mjs -- MercadoLibre scraper via Puppeteer (no API, no account)
// Browses ML search pages anonymously, extracts listing data from HTML
// Normalizes output to match API format for consistency with existing pipeline
//
// Usage: node scripts/vps/scrape-ml-headless.mjs [maxPages] [--zone=caba|gba-norte|all]
// Runs on VPS with Chrome + Xvfb

import { createClient } from '@supabase/supabase-js';
import puppeteer from 'puppeteer';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const MAX_PAGES = parseInt(process.argv[2] || '10');
const PROFILE_DIR = '/opt/caba-market-study/.chrome-profile-ml';
const DELAY_MS = 4000;

const zoneArg = process.argv.find(a => a.startsWith('--zone='))?.split('=')[1] || 'all';

// ML search URLs by zone (public, no auth needed)
const ML_ZONES = [
  {
    id: 'caba',
    name: 'Capital Federal',
    state: 'CABA',
    url: 'https://inmuebles.mercadolibre.com.ar/casas/venta/capital-federal/',
  },
  {
    id: 'gba-norte',
    name: 'GBA Norte',
    state: 'Buenos Aires',
    url: 'https://inmuebles.mercadolibre.com.ar/casas/venta/bs-as-gba-norte/',
  },
];

function getZones() {
  if (zoneArg === 'all') return ML_ZONES;
  return ML_ZONES.filter(z => z.id === zoneArg);
}

// Extract listing data from ML search page via browser JS
const EXTRACT_JS = `(() => {
  const items = document.querySelectorAll('.ui-search-layout__item, .ui-search-result');
  const results = [];
  items.forEach(item => {
    try {
      const linkEl = item.querySelector('a.ui-search-link, a[href*="/MLA-"]');
      const href = linkEl ? linkEl.href : '';
      const idMatch = href.match(/MLA-?(\\d+)/);
      if (!idMatch) return;

      const titleEl = item.querySelector('.ui-search-item__title, .poly-component__title, h2');
      const priceEl = item.querySelector('.andes-money-amount__fraction, .price-tag-fraction');
      const currencyEl = item.querySelector('.andes-money-amount__currency-symbol');
      const attrsEls = item.querySelectorAll('.ui-search-card-attributes__attribute, .poly-component__attributes li');

      let totalArea = null, rooms = null, bedrooms = null, bathrooms = null;
      attrsEls.forEach(attr => {
        const t = attr.textContent.trim().toLowerCase();
        const numMatch = t.match(/(\\d+)/);
        if (!numMatch) return;
        const num = parseInt(numMatch[1]);
        if (t.includes('m²') || t.includes('m2')) totalArea = num;
        else if (t.includes('amb')) rooms = num;
        else if (t.includes('dorm') || t.includes('rec')) bedrooms = num;
        else if (t.includes('baño')) bathrooms = num;
      });

      const locEl = item.querySelector('.ui-search-item__location, .poly-component__location, .ui-search-item__group__element--location');
      const thumbEl = item.querySelector('img.ui-search-result-image__element, img[src*="http"]');

      const priceText = priceEl ? priceEl.textContent.replace(/\\./g, '').trim() : '';
      const currency = currencyEl ? (currencyEl.textContent.includes('U') ? 'USD' : 'ARS') : 'USD';

      results.push({
        ml_id: 'MLA' + idMatch[1],
        title: titleEl ? titleEl.textContent.trim() : '',
        price: priceText ? parseInt(priceText) : null,
        currency: currency,
        permalink: href.split('?')[0],
        total_area: totalArea,
        ambientes: rooms,
        bedrooms: bedrooms,
        bathrooms: bathrooms,
        location: locEl ? locEl.textContent.trim() : '',
        thumbnail: thumbEl ? thumbEl.src : null
      });
    } catch(e) {}
  });
  return { count: results.length, results, title: document.title };
})()`;

// Determine segment from title keywords
function determineSegment(title) {
  const t = (title || '').toLowerCase();
  if (t.includes('refaccionar') || t.includes('a reciclar') || t.includes('para reciclar')) return 'refac';
  if (t.includes('reciclada') || t.includes('reciclado') || t.includes('refaccionada') || t.includes('a estrenar') || t.includes('a nuevo')) return 'recic';
  return 'general';
}

// Extract keywords from title
function extractKeywords(title) {
  const kw = [];
  const t = (title || '').toLowerCase();
  const map = {
    'jardin': 'jardin', 'patio': 'patio', 'terraza': 'terraza',
    'pileta': 'pileta', 'cochera': 'cochera', 'garage': 'cochera',
    'parrilla': 'parrilla', 'quincho': 'quincho',
    'refaccionar': 'a refaccionar', 'reciclada': 'reciclada', 'reciclado': 'reciclada',
    'escritura': 'escritura', 'apto credito': 'apto credito',
    'ph': 'ph', 'duplex': 'duplex', 'triplex': 'triplex',
    'lote': 'lote propio', 'a estrenar': 'a estrenar',
  };
  for (const [key, val] of Object.entries(map)) {
    if (t.includes(key)) kw.push(val);
  }
  return [...new Set(kw)];
}

// Extract neighborhood from location text
function extractNeighborhood(locText) {
  if (!locText) return null;
  const parts = locText.split(',').map(s => s.trim());
  // ML format: "Barrio, Ciudad" or "Barrio"
  return parts[0] || null;
}

async function scrapeZone(page, zone) {
  console.log(`\n--- ${zone.name} (${zone.id}) ---`);
  let totalScraped = 0;
  let totalNew = 0;

  for (let pg = 1; pg <= MAX_PAGES; pg++) {
    // ML pagination: page 1 = base URL, page 2+ = _Desde_49, _Desde_97, etc
    const offset = (pg - 1) * 48;
    const url = pg === 1 ? zone.url : `${zone.url}_Desde_${offset + 1}`;

    try {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

      // Check for captcha or block
      const title = await page.title();
      if (title.includes('captcha') || title.includes('blocked')) {
        console.log(`  Page ${pg}: blocked/captcha, stopping`);
        break;
      }

      // Wait for results to load
      await page.waitForSelector('.ui-search-layout__item, .ui-search-result, .poly-card', { timeout: 8000 }).catch(() => {});

      const data = await page.evaluate(EXTRACT_JS);

      if (!data || data.count === 0) {
        console.log(`  Page ${pg}: no results`);
        break;
      }

      // Upsert to DB
      const rows = data.results.map(item => {
        const id = 'ml_' + item.ml_id.replace('MLA', '').toLowerCase();
        const kw = extractKeywords(item.title);
        const neighborhood = extractNeighborhood(item.location);
        const area = item.total_area;

        return {
          id,
          title: item.title,
          price: item.price,
          currency: item.currency,
          operation: 'venta',
          property_type: 'casa',
          total_area: area,
          bedrooms: item.bedrooms,
          bathrooms: item.bathrooms,
          ambientes: item.ambientes,
          neighborhood,
          city: zone.name,
          state: zone.state,
          permalink: item.permalink,
          thumbnail: item.thumbnail,
          keywords: kw,
          segment: determineSegment(item.title),
          source: 'mercadolibre',
          slug: item.ml_id,
          price_per_sqm: (item.price && area && area > 0) ? Math.round(item.price / area) : null,
          is_active: true,
          last_seen_at: new Date().toISOString(),
          scraped_at: new Date().toISOString(),
        };
      });

      const { error } = await supabase
        .from('properties')
        .upsert(rows, { onConflict: 'id', ignoreDuplicates: false });

      if (error) {
        console.log(`  Page ${pg}: upsert error: ${error.message}`);
      } else {
        totalScraped += data.count;
        // Count truly new (approximation)
        totalNew += rows.length;
        console.log(`  Page ${pg}: ${data.count} listings scraped`);
      }
    } catch (e) {
      console.log(`  Page ${pg}: ${e.message.substring(0, 80)}`);
    }

    await new Promise(r => setTimeout(r, DELAY_MS));
  }

  return { zone: zone.id, scraped: totalScraped, new: totalNew };
}

async function main() {
  const t0 = Date.now();
  const zones = getZones();
  console.log(`ML Headless Scraper -- ${zones.length} zone(s), ${MAX_PAGES} pages each`);

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

  // Warm up
  console.log('Warming up...');
  await page.goto('https://www.mercadolibre.com.ar', { waitUntil: 'networkidle2', timeout: 20000 });
  await new Promise(r => setTimeout(r, 2000));

  let grandTotal = { scraped: 0, new: 0 };

  for (const zone of zones) {
    const result = await scrapeZone(page, zone);
    grandTotal.scraped += result.scraped;
    grandTotal.new += result.new;
  }

  await browser.close();

  const dur = Math.round((Date.now() - t0) / 1000);
  console.log(`\nDone: ${grandTotal.scraped} scraped, ${grandTotal.new} upserted (${dur}s)`);

  await supabase.from('scrape_runs').insert({
    source: 'mercadolibre', segment: zoneArg + '-headless',
    total_scraped: grandTotal.scraped, total_new: grandTotal.new,
    total_updated: grandTotal.new, total_deactivated: 0,
    duration_ms: Date.now() - t0,
    metadata: { pages: MAX_PAGES, zones: zones.map(z => z.id), runner: 'vps-puppeteer' },
    started_at: new Date(t0).toISOString(),
    completed_at: new Date().toISOString(),
  });

  // Slack notification
  if (process.env.SLACK_WEBHOOK) {
    const msg = `🔍 *ML Headless Scrape -- ${new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })}*\n` +
      zones.map(z => `• ${z.name}`).join('\n') + '\n' +
      `📊 ${grandTotal.scraped} scraped, ${grandTotal.new} upserted (${dur}s)`;
    await fetch(process.env.SLACK_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: msg }),
    }).catch(() => {});
  }
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
