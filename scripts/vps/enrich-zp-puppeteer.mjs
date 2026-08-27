#!/usr/bin/env node
// enrich-zp-puppeteer.mjs — ZP enrichment via Puppeteer on Linux VPS
// Uses real Chrome + xvfb to bypass Cloudflare
// Usage: node scripts/vps/enrich-zp-puppeteer.mjs [delayMs] [batchSize]

import { createClient } from '@supabase/supabase-js';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { looksLikeProxyError, getPuppeteerProxyArgs, authenticatePuppeteerProxy, enableAssetBlocking, incrementBudget, logBudgetSummary } from '../lib/proxy.mjs';

puppeteer.use(StealthPlugin());

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
  // ZP renders "Descripción\n\n<body>" (NO colon, double newline) — the old
  // /Descripción:\n/ never matched, which silently starved every description.
  const descMatch = body.match(/Descripci[oó]n\s*\n+([\s\S]+?)(?:\n(?:Superficie|Caracter[ií]sticas|Ambientes|Servicios|Ubicaci[oó]n|Leer descripci[oó]n|Ver m[aá]s|¿C[oó]mo evitar|Compartir)\b|$)/i);
  if (descMatch) data.description = descMatch[1].trim().substring(0, 10000);
  return data;
}

async function main() {
  const t0 = Date.now();

  console.log('Launching Chrome...');
  const browser = await puppeteer.launch({
    headless: false, // Needs xvfb on Linux for Cloudflare
    executablePath: '/usr/bin/google-chrome',
    userDataDir: PROFILE_DIR,
    protocolTimeout: 60000, // VPS+stealth+proxy can spike CDP latency over the 30s default
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--window-size=1280,800',
      ...getPuppeteerProxyArgs(),
    ]
  });

  const page = await browser.newPage();
  await authenticatePuppeteerProxy(page);
  // puppeteer-extra-plugin-stealth handles webdriver, languages, plugins,
  // chrome.runtime, WebGL/canvas/audio fingerprints, and several more signals.
  // Manual evaluateOnNewDocument patches removed in favor of the plugin.
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'es-AR,es;q=0.9,en;q=0.8' });
  // Block image/media/font (CSS kept — see proxy.mjs note). Cuts bandwidth ~3x.
  await enableAssetBlocking(page);
  await page.setViewport({ width: 1280, height: 800 });

  // Test Cloudflare — navigate to ZP home first
  console.log('Testing Cloudflare...');
  await page.goto('https://www.zonaprop.com.ar', { waitUntil: 'networkidle2', timeout: 30000 });
  const title = await page.title();

  // 27/08/2026: este chequeo daba "✅ Cloudflare passed" durante 45 noches contra
  // una pagina de error de Chrome. Con el proxy caido (407) Chrome no lanza
  // excepcion: pinta chrome-error://chromewebdata/ y pone el hostname como
  // <title>, asi que title.includes('moment') era false y el script seguia
  // adelante visitando 300 paginas de error por noche y escribiendo nulls.
  const cfUrl = page.url();
  const cfBody = await page.evaluate(() => document.body?.innerText?.slice(0, 2000) || '').catch(() => '');
  if (looksLikeProxyError(cfUrl, title, cfBody)) {
    console.error(`❌ No hay salida a internet: el proxy no responde (url=${cfUrl}, title="${title}").`);
    console.error('   Esto NO es Cloudflare ni fichas vacias: no llegamos a la fuente. Abortando para no escribir nulls.');
    await browser.close();
    process.exit(1);
  }

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
    // 27/08/2026: sin ORDER BY, PostgREST devolvia siempre el mismo primer tramo,
    // asi que las 3 tandas de cada noche masticaban las MISMAS 100 filas y
    // "Remaining: 553" no se movia nunca. Ordenar por enriched_at (nulls primero)
    // hace que la cola avance: lo nunca visitado va primero, y lo ya visitado
    // vuelve recien cuando es lo mas viejo.
    .order('enriched_at', { ascending: true, nullsFirst: true })
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
      await page.goto(prop.permalink, { waitUntil: 'domcontentloaded', timeout: 30000 });
      // CF JS challenge can take 10-25s to auto-pass. Wait up to 30s.
      await page.waitForFunction(() => !document.title.includes('moment'), { timeout: 30000 }).catch(() => {});
      // ZP renders the description section client-side and lazily; nudge it with a
      // scroll, then wait for the section to carry the full body. The class varies
      // across templates (section-description vs article-section-description), so
      // match by substring. >200 chars distinguishes the body from the ~150-char teaser.
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
      await page.waitForFunction(() => {
        const el = document.querySelector('[class*="section-description" i]');
        return el && el.innerText && el.innerText.trim().length > 200;
      }, { timeout: 8000 }).catch(() => {});

      const pageData = await page.evaluate(() => {
        const ld = document.querySelectorAll('script[type="application/ld+json"]');
        let house = null;
        for (const el of ld) {
          try { const j = JSON.parse(el.textContent); if (j['@type'] === 'House' || j['@type'] === 'Apartment') house = j; } catch {}
        }
        // Primary description source: the dedicated section, cleaned of a leading
        // "Descripción" header. Class varies across templates → match by substring.
        // ld+json.description is only a ~150-char teaser, so it is not used here.
        let description = '';
        const secEl = document.querySelector('[class*="section-description" i]');
        if (secEl) {
          const t = (secEl.innerText || '').trim();
          const m = t.match(/Descripci[oó]n\s*\n+([\s\S]+)$/i);
          description = (m ? m[1] : t).trim();
        }
        return {
          house,
          description,
          body: document.body.innerText.substring(0, 8000),
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

      // DOM section first, innerText regex as fallback.
      const desc = (pageData.description || fromBody.description || '').trim();
      if (!prop.description && desc) update.description = desc.substring(0, 10000);
      if (!prop.covered_area && fromBody.covered_area) update.covered_area = fromBody.covered_area;
      if (fromBody.total_area) update.total_area = fromBody.total_area;
      // 27/08/2026: estas dos lineas terminaban en `|| null`, asi que cuando la
      // ficha no traia el dato se metia igual la clave con valor null. Sumada a
      // enrichment_level y enriched_at, el update superaba el umbral de >2 claves
      // de abajo y la fila se contaba como "enriched" habiendo escrito nada util.
      // De ahi salia el "70 enriched, 0 errors" de todas las noches sobre paginas
      // de error. Si no hay dato, no va la clave.
      const bed = fromBody.bedrooms || house.numberOfBedrooms;
      const bath = fromBody.bathrooms || house.numberOfBathroomsTotal;
      if (!prop.bedrooms && bed) update.bedrooms = bed;
      if (!prop.bathrooms && bath) update.bathrooms = bath;
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
    metadata: { type: 'enrich-puppeteer-vps', runner: 'vps', delay_ms: BASE_DELAY },
    started_at: new Date(t0).toISOString(),
    completed_at: new Date().toISOString(),
  });
}

main().catch(e => { console.error('💀 Fatal:', e.message); process.exit(1); });
