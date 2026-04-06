#!/usr/bin/env node
// enrich-zp-cdp.mjs — Enrich ZonaProp properties via Chrome CDP (background, non-blocking)
// Uses a separate Chrome instance with copied cookies — does NOT interfere with user's Chrome
// Usage: node scripts/enrich-zp-cdp.mjs [batchSize] [delayMs]

import puppeteer from 'puppeteer-core';
import { createClient } from '@supabase/supabase-js';
import { execSync } from 'child_process';
import { existsSync, mkdirSync } from 'fs';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const BATCH_SIZE = parseInt(process.argv[2] || '500');
const DELAY = parseInt(process.argv[3] || '3000');
const CF_WAIT = 12000; // wait for Cloudflare challenge to resolve
const NAV_TIMEOUT = 30000;

const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const REAL_PROFILE = `${process.env.HOME}/Library/Application Support/Google/Chrome`;
const TMP_PROFILE = '/tmp/zp-chrome-profile';

// Circuit breaker: abort after N consecutive errors
const MAX_CONSECUTIVE_ERRORS = 10;

function copyProfile() {
  if (existsSync(TMP_PROFILE)) {
    execSync(`rm -rf "${TMP_PROFILE}"`);
  }
  mkdirSync(`${TMP_PROFILE}/Default`, { recursive: true });
  execSync(`cp "${REAL_PROFILE}/Default/Cookies" "${TMP_PROFILE}/Default/Cookies" 2>/dev/null || true`);
  execSync(`cp "${REAL_PROFILE}/Default/Preferences" "${TMP_PROFILE}/Default/Preferences" 2>/dev/null || true`);
  execSync(`cp "${REAL_PROFILE}/Local State" "${TMP_PROFILE}/Local State" 2>/dev/null || true`);
  execSync(`rm -f "${TMP_PROFILE}/SingletonLock" "${TMP_PROFILE}/SingletonSocket" "${TMP_PROFILE}/SingletonCookie" 2>/dev/null || true`);
}

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
  const ageMatch = body.match(/(\d+)\s*años?\b/i);
  if (ageMatch) data.age = parseInt(ageMatch[1]);
  const priceMatch = body.match(/(?:Venta|USD)\s*(?:USD\s*)?([\d.]+)/i);
  if (priceMatch) data.price_check = parseFloat(priceMatch[1].replace(/\./g, ''));
  const pubMatch = body.match(/(?:Contactar por WhatsApp|Contactar)\n([A-ZÁÉÍÓÚÑa-záéíóúñ][\w\s.&áéíóúñÁÉÍÓÚÑ-]{3,60})\n/);
  if (pubMatch) data.contact_name = pubMatch[1].trim();
  const descMatch = body.match(/(?:Descripción:\n|(?:Casa|Venta|PH)\s+(?:Venta|Alquiler|—)[^\n]*\n)([\s\S]{50,?})(?:\nLeer descripción completa|\n¿Cómo evitar|\nVer más en |\nPropiedades en barrios|$)/);
  if (descMatch) data.description = descMatch[1].trim().substring(0, 10000);
  if (!data.description) {
    const fallback = body.match(/(?:\d+\s*(?:dorm|baño|coch|amb|toilette|años)\w*\.?\n)+(?:[A-Z][^\n]*\n)?([\s\S]{80,?})(?:\n¿Cómo evitar|\nVer más en |\nPropiedades similares|$)/);
    if (fallback) data.description = fallback[1].trim().substring(0, 10000);
  }
  return data;
}

async function scrapePage(page, permalink) {
  try {
    const response = await page.goto(permalink, { waitUntil: 'networkidle2', timeout: NAV_TIMEOUT });
    const status = response?.status();
    const title = await page.title();
    console.log(`    → status=${status} title="${title.substring(0, 60)}"`);

    // Check for Cloudflare challenge (can appear as 403 initially)
    if (status === 403 || title.toLowerCase().includes('momento') || title.toLowerCase().includes('moment')) {
      console.log(`    → CF challenge, waiting up to 30s for resolution...`);
      try {
        await page.waitForFunction(
          () => !document.title.toLowerCase().includes('momento') && !document.title.toLowerCase().includes('moment'),
          { timeout: 30000 }
        );
        const title2 = await page.title();
        console.log(`    → resolved: "${title2.substring(0, 60)}"`);
      } catch {
        const title2 = await page.title();
        console.log(`    → still blocked: "${title2.substring(0, 60)}"`);
        if (title2.toLowerCase().includes('momento') || title2.toLowerCase().includes('moment') ||
            title2.toLowerCase().includes('security') || title2.toLowerCase().includes('verificación')) {
          return null;
        }
      }
    }

    const data = await page.evaluate(() => {
      const ldScripts = document.querySelectorAll('script[type="application/ld+json"]');
      let house = null;
      for (const s of ldScripts) {
        try {
          const j = JSON.parse(s.textContent);
          if (j['@type'] === 'House' || j['@type'] === 'Apartment') house = j;
        } catch {}
      }
      const body = document.body.innerText.substring(0, 5000);
      const title = document.title;
      return { house, body, title };
    });

    if (data.body?.includes('security verification') || data.body?.includes('Verificación de seguridad')) {
      return null;
    }

    return data;
  } catch {
    return null;
  }
}

async function main() {
  const t0 = Date.now();

  // Get properties to enrich
  const { data: props, error } = await supabase
    .from('properties')
    .select('id, permalink, description, covered_area, bedrooms, bathrooms, price')
    .eq('source', 'zonaprop')
    .eq('is_active', true)
    .not('permalink', 'is', null)
    .or('enrichment_level.is.null,enrichment_level.eq.0')
    .limit(BATCH_SIZE);

  if (error) { console.error('❌ DB error:', error.message); process.exit(1); }
  console.log(`📦 ${props.length} ZP properties to enrich (delay: ${DELAY}ms, CDP mode)\n`);
  if (!props.length) { console.log('Nothing to do.'); return; }

  // Copy profile and launch browser
  console.log('🔧 Copying Chrome profile...');
  copyProfile();

  console.log('🚀 Launching background Chrome...');
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: false,
    userDataDir: TMP_PROFILE,
    args: [
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--remote-debugging-port=9223',
      '--window-size=800,600',
      '--start-minimized',
    ],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });

  // Warmup: pass Cloudflare challenge once on ZP homepage
  console.log('🔥 Warmup: passing Cloudflare challenge...');
  await page.goto('https://www.zonaprop.com.ar', { waitUntil: 'networkidle2', timeout: NAV_TIMEOUT });
  let warmupTitle = await page.title();
  if (warmupTitle.toLowerCase().includes('momento')) {
    console.log('   CF challenge detected, waiting...');
    for (let attempt = 0; attempt < 5; attempt++) {
      await new Promise(r => setTimeout(r, 5000));
      warmupTitle = await page.title();
      console.log(`   Attempt ${attempt + 1}: "${warmupTitle.substring(0, 50)}"`);
      if (!warmupTitle.toLowerCase().includes('momento')) break;
    }
  }
  if (warmupTitle.toLowerCase().includes('momento')) {
    console.log('❌ Could not pass Cloudflare challenge. Aborting.');
    await browser.close();
    execSync(`rm -rf "${TMP_PROFILE}"`);
    process.exit(1);
  }
  console.log(`✅ Cloudflare passed: "${warmupTitle.substring(0, 50)}"\n`);

  let enriched = 0, skipped = 0, errors = 0, consecutiveErrors = 0;

  for (let i = 0; i < props.length; i++) {
    const prop = props[i];
    if (!prop.permalink) { skipped++; continue; }

    const pageData = await scrapePage(page, prop.permalink);

    if (!pageData) {
      errors++;
      consecutiveErrors++;
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        console.log(`\n🛑 Circuit breaker: ${MAX_CONSECUTIVE_ERRORS} consecutive errors. Aborting.`);
        break;
      }
      if ((i + 1) % 25 === 0) {
        const elapsed = Math.round((Date.now() - t0) / 1000);
        console.log(`  📊 ${i + 1}/${props.length} — enriched: ${enriched}, skip: ${skipped}, err: ${errors} [${elapsed}s]`);
      }
      await new Promise(r => setTimeout(r, DELAY));
      continue;
    }

    consecutiveErrors = 0;
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
    if (fromBody.contact_name) update.contact_name = fromBody.contact_name;
    if (house.image) update.thumbnail = house.image;
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
      // Mark as visited even if no new data
      await supabase.from('properties').update({
        enrichment_level: 1,
        enriched_at: new Date().toISOString()
      }).eq('id', prop.id);
      skipped++;
    }

    if ((i + 1) % 25 === 0 || i === props.length - 1) {
      const elapsed = Math.round((Date.now() - t0) / 1000);
      const eta = Math.round(((Date.now() - t0) / (i + 1)) * (props.length - i - 1) / 1000);
      console.log(`  📊 ${i + 1}/${props.length} — enriched: ${enriched}, skip: ${skipped}, err: ${errors} [${elapsed}s, ~${eta}s ETA]`);
    }

    await new Promise(r => setTimeout(r, DELAY));
  }

  await browser.close();
  execSync(`rm -rf "${TMP_PROFILE}"`);

  const dur = Math.round((Date.now() - t0) / 1000);
  console.log(`\n🏁 ZP CDP enrichment: ${enriched} enriched, ${skipped} skipped, ${errors} errors (${dur}s)`);

  await supabase.from('scrape_runs').insert({
    source: 'zonaprop', segment: 'enrich-cdp',
    total_scraped: props.length, total_new: 0, total_updated: enriched,
    total_deactivated: 0, duration_ms: Date.now() - t0,
    error_message: errors > 0 ? `${errors} errors` : null,
    metadata: { type: 'enrich-cdp-background', runner: 'local-mac', delay_ms: DELAY, batch_size: BATCH_SIZE },
    started_at: new Date(t0).toISOString(),
    completed_at: new Date().toISOString(),
  });
}

main().catch(e => { console.error('💀 Fatal:', e.message); process.exit(1); });
