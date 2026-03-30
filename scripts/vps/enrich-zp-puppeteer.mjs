#!/usr/bin/env node
// enrich-zp-puppeteer.mjs — ZP enrichment via Puppeteer on Linux VPS
// Uses real Chrome + xvfb to bypass Cloudflare
// Usage: node scripts/vps/enrich-zp-puppeteer.mjs [delayMs] [batchSize]

import { createClient } from '@supabase/supabase-js';
import puppeteer from 'puppeteer';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const BASE_DELAY = parseInt(process.argv[2] || '3000');
const BATCH_SIZE = parseInt(process.argv[3] || '500');
const PROFILE_DIR = '/opt/caba-market-study/.chrome-profile';

// Circuit breaker for enrichment
const CB = {
  consecutiveCf: 0,
  totalCf: 0,
  consecutiveErrors: 0,
  currentDelay: BASE_DELAY,
  MAX_CONSECUTIVE_CF: 3,
  MAX_TOTAL_CF: 5,
  MAX_CONSECUTIVE_ERRORS: 10,

  onSuccess() {
    this.consecutiveCf = 0;
    this.consecutiveErrors = 0;
    this.currentDelay = BASE_DELAY;
  },
  onCf() {
    this.consecutiveCf++;
    this.totalCf++;
    this.currentDelay = Math.min(this.currentDelay * 2, 20000);
    console.log(`  [CB] CF hit #${this.totalCf} (consecutive: ${this.consecutiveCf}, delay now ${Math.round(this.currentDelay)}ms)`);
  },
  onError() {
    this.consecutiveErrors++;
    this.currentDelay = Math.min(this.currentDelay * 1.5, 15000);
  },
  shouldPause() {
    return this.consecutiveCf >= this.MAX_CONSECUTIVE_CF;
  },
  shouldAbort() {
    return this.totalCf >= this.MAX_TOTAL_CF || this.consecutiveErrors >= this.MAX_CONSECUTIVE_ERRORS;
  }
};

function extractFromBody(body) {
  const data = {};
  const totMatch = body.match(/(\d[\d.,]+)\s*m²\s*tot/i);
  if (totMatch) data.total_area = parseFloat(totMatch[1].replace(',', '.'));
  const cubMatch = body.match(/(\d[\d.,]+)\s*m²\s*cub/i);
  if (cubMatch) data.covered_area = parseFloat(cubMatch[1].replace(',', '.'));
  const dormMatch = body.match(/(\d+)\s*dorm/i);
  if (dormMatch) data.bedrooms = parseInt(dormMatch[1]);
  const bathMatch = body.match(/(\d+)\s*baño/i);
  if (bathMatch) data.bathrooms = parseInt(bathMatch[1]);
  const cochMatch = body.match(/(\d+)\s*coch/i);
  if (cochMatch) data.cocheras = parseInt(cochMatch[1]);
  const descMatch = body.match(/Descripción:\n([\s\S]+?)(?:\nLeer descripción completa|\nVer más\s*\n|\n¿Cómo evitar|\nCompartir\n|$)/);
  if (descMatch) data.description = descMatch[1].trim().substring(0, 10000);
  if (!data.description) {
    const altDesc = body.match(/Casa (?:Venta|Alquiler)\n([\s\S]{50,})(?:\nLeer descripción|\n¿Cómo evitar|$)/);
    if (altDesc) data.description = altDesc[1].trim().substring(0, 10000);
  }
  return data;
}

async function main() {
  const t0 = Date.now();

  console.log('Launching Chrome...');
  const browser = await puppeteer.launch({
    headless: false, // Needs xvfb on Linux for Cloudflare
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

  // Test Cloudflare — navigate to ZP home first
  console.log('Testing Cloudflare...');
  await page.goto('https://www.zonaprop.com.ar', { waitUntil: 'networkidle2', timeout: 30000 });
  const title = await page.title();
  if (title.includes('moment')) {
    console.log('⏳ Cloudflare challenge... waiting 15s for manual solve or auto-pass');
    await page.waitForFunction(() => !document.title.includes('moment'), { timeout: 30000 }).catch(() => {});
    const t2 = await page.title();
    if (t2.includes('moment')) {
      console.error('❌ Cloudflare blocked. Run seed-cloudflare.sh first.');
      await browser.close();
      process.exit(1);
    }
  }
  console.log('✅ Cloudflare passed\n');

  // Get ZP properties needing enrichment
  const { data: props, error } = await supabase
    .from('properties')
    .select('id, permalink, description, covered_area, bedrooms, bathrooms, price')
    .eq('source', 'zonaprop')
    .eq('is_active', true)
    .not('permalink', 'is', null)
    .or('description.is.null,covered_area.is.null,bedrooms.is.null,bathrooms.is.null')
    .limit(BATCH_SIZE);

  if (error) { console.error('❌', error.message); await browser.close(); process.exit(1); }
  console.log(`📦 ${props.length} ZP properties to enrich\n`);

  let enriched = 0, skipped = 0, errors = 0;

  for (let i = 0; i < props.length; i++) {
    const prop = props[i];
    if (!prop.permalink) { skipped++; continue; }

    // Circuit breaker checks
    if (CB.shouldAbort()) {
      console.log(`\n[CB] ABORT -- too many blocks (${CB.totalCf} CF, ${CB.consecutiveErrors} consecutive errors). Stopping to protect IP.`);
      break;
    }
    if (CB.shouldPause()) {
      console.log(`  [CB] ${CB.consecutiveCf} consecutive CF hits. Pausing 120s...`);
      await new Promise(r => setTimeout(r, 120000));
      CB.consecutiveCf = 0; // Reset consecutive after pause
    }

    try {
      await page.goto(prop.permalink, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForFunction(() => !document.title.includes('moment'), { timeout: 10000 }).catch(() => {});

      const pageData = await page.evaluate(() => {
        const ld = document.querySelectorAll('script[type="application/ld+json"]');
        let house = null;
        for (const el of ld) {
          try { const j = JSON.parse(el.textContent); if (j['@type'] === 'House' || j['@type'] === 'Apartment') house = j; } catch {}
        }
        return {
          house,
          body: document.body.innerText.substring(0, 5000),
          title: document.title
        };
      });

      if (pageData.title.includes('moment')) {
        CB.onCf();
        errors++;
        continue;
      }

      const fromBody = extractFromBody(pageData.body || '');
      const house = pageData.house || {};
      const update = {};

      if (!prop.description && fromBody.description) update.description = fromBody.description;
      if (!prop.covered_area && fromBody.covered_area) update.covered_area = fromBody.covered_area;
      if (fromBody.total_area) update.total_area = fromBody.total_area;
      if (!prop.bedrooms) update.bedrooms = fromBody.bedrooms || house.numberOfBedrooms || null;
      if (!prop.bathrooms) update.bathrooms = fromBody.bathrooms || house.numberOfBathroomsTotal || null;
      if (fromBody.cocheras) update.cocheras = fromBody.cocheras;
      if (house.address?.streetAddress) update.address_text = house.address.streetAddress;
      if (house.telephone) update.contact_phone = house.telephone;
      if (house.image) update.thumbnail = house.image;

      update.enrichment_level = 1;
      update.enriched_at = new Date().toISOString();

      if (Object.keys(update).length > 2) {
        const { error: upErr } = await supabase.from('properties').update(update).eq('id', prop.id);
        if (upErr) { errors++; CB.onError(); }
        else { enriched++; CB.onSuccess(); }
      } else {
        skipped++;
        CB.onSuccess();
      }
    } catch (e) {
      errors++;
      CB.onError();
    }

    if ((i + 1) % 25 === 0 || i === props.length - 1) {
      const elapsed = Math.round((Date.now() - t0) / 1000);
      const eta = Math.round(((Date.now() - t0) / (i + 1)) * (props.length - i - 1) / 1000);
      console.log(`  ${i + 1}/${props.length} -- enriched: ${enriched}, skip: ${skipped}, err: ${errors}, cf: ${CB.totalCf} [${elapsed}s, ~${eta}s ETA]`);
    }

    await new Promise(r => setTimeout(r, CB.currentDelay));
  }

  await browser.close();
  const dur = Math.round((Date.now() - t0) / 1000);
  console.log(`\n🏁 ZP enrichment: ${enriched} enriched, ${skipped} skipped, ${errors} errors (${dur}s)`);

  await supabase.from('scrape_runs').insert({
    source: 'zonaprop', segment: 'enrich-puppeteer',
    total_scraped: props.length, total_new: 0, total_updated: enriched,
    total_deactivated: 0, duration_ms: Date.now() - t0,
    error_message: errors > 0 ? `${errors} errors` : null,
    metadata: { type: 'enrich-puppeteer-vps', runner: 'vps', delay_ms: DELAY },
    started_at: new Date(t0).toISOString(),
    completed_at: new Date().toISOString(),
  });
}

main().catch(e => { console.error('💀 Fatal:', e.message); process.exit(1); });
