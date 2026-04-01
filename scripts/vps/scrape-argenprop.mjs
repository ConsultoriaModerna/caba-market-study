#!/usr/bin/env node
// scrape-argenprop.mjs -- Argenprop scraper via Puppeteer on VPS
// Extracts casas en venta from Argenprop search pages
// Data attributes on card anchors provide structured data
//
// Usage: node scripts/vps/scrape-argenprop.mjs [maxPages] [--zone=caba|gba-norte|all]

import { createClient } from '@supabase/supabase-js';
import puppeteer from 'puppeteer';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const MAX_PAGES = parseInt(process.argv[2] || '15');
const PROFILE_DIR = '/opt/caba-market-study/.chrome-profile-ap';
const BASE_DELAY_MS = 4000;
const COOLDOWN_BETWEEN_ZONES_MS = 20000;
const zoneArg = process.argv.find(a => a.startsWith('--zone='))?.split('=')[1] || 'all';
const typeArg = process.argv.find(a => a.startsWith('--type='))?.split('=')[1] || 'casa';

import { getAPZones, PROPERTY_TYPES } from '../zones-config.mjs';
const PROP_TYPE_LABEL = PROPERTY_TYPES.find(t => t.id === typeArg)?.label || typeArg;

// Circuit breaker
const CB = {
  consecutiveFails: 0,
  totalFails: 0,
  zonesAborted: 0,
  currentDelay: BASE_DELAY_MS,
  MAX_CONSECUTIVE: 3,
  MAX_ZONES_ABORTED: 2,

  onSuccess() { this.consecutiveFails = 0; this.currentDelay = BASE_DELAY_MS; },
  onFail(reason) {
    this.consecutiveFails++;
    this.totalFails++;
    this.currentDelay = Math.min(this.currentDelay * 1.5, 15000);
    console.log(`  [CB] Fail #${this.consecutiveFails}: ${reason} (delay now ${Math.round(this.currentDelay)}ms)`);
  },
  shouldAbortZone() { return this.consecutiveFails >= this.MAX_CONSECUTIVE; },
  shouldAbortAll() { return this.zonesAborted >= this.MAX_ZONES_ABORTED; },
  abortZone(name) { this.zonesAborted++; this.consecutiveFails = 0; console.log(`  [CB] ABORT zone ${name}`); }
};

const AP_ZONES_CONFIG = getAPZones(typeArg);

function getZones() {
  if (zoneArg === 'all') return AP_ZONES_CONFIG;
  return AP_ZONES_CONFIG.filter(z => z.id === zoneArg);
}

// Extract listing data from Argenprop page via browser JS
const EXTRACT_JS = `(() => {
  const cards = document.querySelectorAll('a.card[data-item-card]');
  const results = [];
  cards.forEach(card => {
    try {
      const id = card.getAttribute('data-item-card');
      const href = card.getAttribute('href') || '';
      const price = parseInt(card.getAttribute('montonormalizado') || '0');
      const currencyId = card.getAttribute('idmoneda');
      const currency = currencyId === '2' ? 'USD' : 'ARS';
      const dorms = parseInt(card.getAttribute('dormitorios') || '0') || null;
      const ambientes = parseInt(card.getAttribute('ambientes') || '0') || null;

      // Address
      const addrEl = card.querySelector('.card__address');
      const address = addrEl ? addrEl.textContent.trim() : '';

      // Title
      const titleEl = card.querySelector('.card__title');
      const title = titleEl ? titleEl.textContent.trim() : '';

      // Features (m2, bathrooms, etc)
      const featEls = card.querySelectorAll('.card__main-features li span');
      let totalArea = null, coveredArea = null, bathrooms = null;
      featEls.forEach(f => {
        const t = f.textContent.trim().toLowerCase();
        if (t.includes('m\\u00b2 tot') || t.includes('m2 tot')) {
          const m = t.match(/(\\d+)/);
          if (m) totalArea = parseInt(m[1]);
        } else if (t.includes('m\\u00b2 cub') || t.includes('m2 cub')) {
          const m = t.match(/(\\d+)/);
          if (m) coveredArea = parseInt(m[1]);
        } else if (t.includes('ba\\u00f1o') || t.includes('bano')) {
          const m = t.match(/(\\d+)/);
          if (m) bathrooms = parseInt(m[1]);
        } else if (t.includes('m\\u00b2') || t.includes('m2')) {
          const m = t.match(/(\\d+)/);
          if (m && !totalArea) totalArea = parseInt(m[1]);
        }
      });

      // Image
      const imgEl = card.querySelector('img[src*="argenprop"]');
      const thumbnail = imgEl ? imgEl.src : null;

      if (id && price > 0) {
        results.push({
          ap_id: id, href, title, address, price, currency,
          totalArea, coveredArea, dorms, ambientes, bathrooms, thumbnail
        });
      }
    } catch(e) {}
  });

  const nextBtn = document.querySelector('a.pagination__page-link--next, a[rel="next"]');
  return { count: results.length, results, hasNext: !!nextBtn, title: document.title };
})()`;

function determineSegment(title) {
  const t = (title || '').toLowerCase();
  if (t.includes('refaccionar') || t.includes('a reciclar') || t.includes('para reciclar')) return 'refac';
  if (t.includes('reciclada') || t.includes('reciclado') || t.includes('refaccionada') || t.includes('a estrenar') || t.includes('a nuevo')) return 'recic';
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
    'ph': 'ph', 'duplex': 'duplex', 'triplex': 'triplex',
    'lote': 'lote propio', 'a estrenar': 'a estrenar',
    'luminoso': 'luminoso', 'suite': 'suite', 'balcon': 'balcon',
  };
  for (const [key, val] of Object.entries(map)) {
    if (t.includes(key)) kw.push(val);
  }
  return [...new Set(kw)];
}

function extractNeighborhood(href, address) {
  // href format: /casa-en-venta-en-villa-devoto-4-ambientes--19301642
  const m = href.match(/en-([a-z-]+?)(?:-\d+-amb|--\d)/);
  if (m) {
    return m[1].split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  }
  // Fallback: last part of address
  if (address) {
    const parts = address.split(',').map(s => s.trim());
    return parts[parts.length - 1] || null;
  }
  return null;
}

async function scrapeZone(page, zone) {
  console.log(`\n--- ${zone.name} (${zone.slug}) ---`);
  let totalScraped = 0;
  let totalNew = 0;

  for (let pg = 1; pg <= MAX_PAGES; pg++) {
    if (CB.shouldAbortZone()) { CB.abortZone(zone.name); break; }

    const url = pg === 1
      ? `https://www.argenprop.com/${zone.slug}`
      : `https://www.argenprop.com/${zone.slug}?pagina-${pg}`;

    try {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

      // Check for blocks (captcha, 403, etc)
      const title = await page.title();
      if (title.includes('403') || title.includes('blocked') || title.includes('captcha')) {
        CB.onFail(`blocked: ${title.substring(0, 40)}`);
        if (CB.shouldAbortZone()) break;
        console.log(`  Page ${pg}: blocked, pausing 60s...`);
        await new Promise(r => setTimeout(r, 60000));
        continue;
      }

      await page.waitForSelector('a.card[data-item-card], .card[data-item-card]', { timeout: 10000 }).catch(() => {});

      const data = await page.evaluate(EXTRACT_JS);

      if (!data || data.count === 0) {
        CB.onFail('empty page');
        console.log(`  Page ${pg}: no results`);
        break;
      }

      CB.onSuccess();

      const rows = data.results.map(item => {
        const id = 'ap_' + item.ap_id;
        const kw = extractKeywords(item.title);
        const neighborhood = extractNeighborhood(item.href, item.address);
        const area = item.coveredArea || item.totalArea;

        return {
          id,
          title: item.title || `${PROP_TYPE_LABEL} en ${neighborhood || zone.name}`,
          price: item.price,
          currency: item.currency,
          operation: 'venta',
          property_type: zone.property_type || typeArg,
          total_area: item.totalArea,
          covered_area: item.coveredArea,
          bedrooms: item.dorms,
          bathrooms: item.bathrooms,
          ambientes: item.ambientes,
          neighborhood,
          address_text: item.address,
          city: zone.name,
          state: zone.state,
          permalink: 'https://www.argenprop.com' + item.href,
          thumbnail: item.thumbnail,
          keywords: kw,
          segment: determineSegment(item.title),
          source: 'argenprop',
          slug: item.href,
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
        totalNew += rows.length;
        console.log(`  Page ${pg}: ${data.count} listings`);
      }

      if (!data.hasNext) {
        console.log('  No more pages');
        break;
      }
    } catch (e) {
      CB.onFail(e.message.substring(0, 60));
      console.log(`  Page ${pg}: ${e.message.substring(0, 80)}`);
      if (CB.shouldAbortZone()) break;
    }

    await new Promise(r => setTimeout(r, CB.currentDelay));
  }

  return { zone: zone.id, scraped: totalScraped, new: totalNew };
}

async function main() {
  const t0 = Date.now();
  const zones = getZones();
  console.log(`Argenprop Scraper -- ${zones.length} zone(s), ${MAX_PAGES} pages each`);

  const browser = await puppeteer.launch({
    headless: false,
    executablePath: '/usr/bin/google-chrome',
    userDataDir: PROFILE_DIR,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--window-size=1280,800']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36');

  // Warm up
  console.log('Warming up...');
  await page.goto('https://www.argenprop.com', { waitUntil: 'networkidle2', timeout: 20000 });
  await new Promise(r => setTimeout(r, 3000));

  let grandTotal = { scraped: 0, new: 0 };
  for (const zone of zones) {
    if (CB.shouldAbortAll()) {
      console.log(`\n[CB] ABORT ALL -- ${CB.zonesAborted} zones failed. Stopping.`);
      break;
    }
    const result = await scrapeZone(page, zone);
    grandTotal.scraped += result.scraped;
    grandTotal.new += result.new;

    if (zones.indexOf(zone) < zones.length - 1) {
      console.log(`  Cooldown ${COOLDOWN_BETWEEN_ZONES_MS / 1000}s before next zone...`);
      await new Promise(r => setTimeout(r, COOLDOWN_BETWEEN_ZONES_MS));
    }
  }

  await browser.close();
  const dur = Math.round((Date.now() - t0) / 1000);
  console.log(`\nDone: ${grandTotal.scraped} scraped, ${grandTotal.new} upserted (${dur}s)`);

  await supabase.from('scrape_runs').insert({
    source: 'argenprop', segment: zoneArg,
    total_scraped: grandTotal.scraped, total_new: grandTotal.new,
    total_updated: grandTotal.new, total_deactivated: 0,
    duration_ms: Date.now() - t0,
    metadata: { pages: MAX_PAGES, zones: zones.map(z => z.id), runner: 'vps-puppeteer' },
    started_at: new Date(t0).toISOString(),
    completed_at: new Date().toISOString(),
  });

  if (process.env.SLACK_WEBHOOK) {
    const msg = `🔍 *Argenprop Scrape -- ${new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })}*\n` +
      zones.map(z => `• ${z.name}`).join('\n') + '\n' +
      `📊 ${grandTotal.scraped} scraped, ${grandTotal.new} upserted (${dur}s)`;
    await fetch(process.env.SLACK_WEBHOOK, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: msg }),
    }).catch(() => {});
  }
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
