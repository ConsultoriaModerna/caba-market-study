#!/usr/bin/env node
// check-dead-listings.mjs — Verify if active listings are still live on portal
// Visits permalink URLs and marks is_active=false if listing was removed
//
// Usage: node scripts/vps/check-dead-listings.mjs [batchSize] [--source=zonaprop|argenprop|mercadolibre|all]
// Default: 200 oldest active listings across all sources

import { createClient } from '@supabase/supabase-js';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { looksLikeProxyError, getPuppeteerProxyArgs, authenticatePuppeteerProxy, enableAssetBlocking, incrementBudget, logBudgetSummary } from '../lib/proxy.mjs';

// 13/09/2026: este script salia con `fetch` proxeado plano. Cloudflare deja
// pasar scan/enrich (puppeteer + stealth + Chrome real) pero bloquea un fetch
// crudo, incluso via el mismo proxy residencial: cada ficha de ZP volvia 403
// y caia en "unknown" (fix del 27/08), asi que el chequeo nunca podia
// confirmar una baja real, solo acumulaba "sin respuesta" noche tras noche.
// Reescrito para navegar con el mismo Chrome+stealth que scan-zp-headless.mjs
// y enrich-zp-puppeteer.mjs, que si pasan Cloudflare.
puppeteer.use(StealthPlugin());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const BATCH_SIZE = parseInt(process.argv[2] || '200');
const sourceArg = process.argv.find(a => a.startsWith('--source='))?.split('=')[1] || 'all';
const PROFILE_DIR = '/opt/caba-market-study/.chrome-profile';
const BASE_DELAY = 2000;

// Circuit breaker — misma logica que enrich-zp-puppeteer.mjs. Un bloqueo de CF
// o del proxy a mitad de corrida no es distinto acá que en el enrich: hay que
// frenar antes de gastar el batch entero contra una pared.
const CB = {
  consecutiveCf: 0,
  totalCf: 0,
  consecutiveProxyDown: 0,
  consecutiveErrors: 0,
  currentDelay: BASE_DELAY,
  MAX_CONSECUTIVE_CF: 3,
  MAX_TOTAL_CF: 5,
  MAX_CONSECUTIVE_PROXY_DOWN: 3,
  MAX_CONSECUTIVE_ERRORS: 10,

  onSuccess() { this.consecutiveCf = 0; this.consecutiveProxyDown = 0; this.consecutiveErrors = 0; this.currentDelay = BASE_DELAY; },
  onCf() {
    this.consecutiveCf++; this.totalCf++;
    this.currentDelay = Math.min(this.currentDelay * 2, 20000);
    console.log(`  [CB] CF hit #${this.totalCf} (consecutive: ${this.consecutiveCf})`);
  },
  onProxyDown() {
    this.consecutiveProxyDown++;
    console.log(`  [CB] Proxy down #${this.consecutiveProxyDown}`);
  },
  onError() { this.consecutiveErrors++; this.currentDelay = Math.min(this.currentDelay * 1.5, 15000); },
  shouldPause() { return this.consecutiveCf >= this.MAX_CONSECUTIVE_CF; },
  shouldAbort() {
    return this.totalCf >= this.MAX_TOTAL_CF
      || this.consecutiveProxyDown >= this.MAX_CONSECUTIVE_PROXY_DOWN
      || this.consecutiveErrors >= this.MAX_CONSECUTIVE_ERRORS;
  }
};

// Detection patterns per portal. Trabajan sobre innerText ya renderizado por
// Chrome (no HTML crudo), asi que ven el mismo texto que veria un usuario.
const DEAD_PATTERNS = {
  zonaprop: {
    isDead: (status, body) => {
      if (status === 404) return 'http_404';
      if (body.includes('ya no est') || body.includes('no encontramos')) return 'removed_text';
      if (body.includes('Publicación pausada') || body.includes('publicacion pausada')) return 'paused';
      return null;
    }
  },
  argenprop: {
    isDead: (status, body) => {
      if (status === 404) return 'http_404';
      if (body.includes('no existe') || body.includes('fue eliminad')) return 'removed_text';
      if (body.includes('Error 404') || body.includes('pagina no encontrada') || body.includes('página no encontrada')) return 'page_404';
      return null;
    }
  },
  mercadolibre: {
    isDead: (status, body) => {
      if (status === 404) return 'http_404';
      if (body.includes('finalizada') || body.includes('no existe') || body.includes('ya no est')) return 'removed_text';
      return null;
    }
  }
};

async function checkListing(page, permalink, propId, sourceKey) {
  incrementBudget('dead-check');
  let resp;
  try {
    resp = await page.goto(permalink, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (e) {
    return { outcome: 'error', reason: e.message };
  }

  // CF JS challenge can take 10-25s to auto-pass, same wait as scan/enrich.
  await page.waitForFunction(() => !document.title.includes('moment'), { timeout: 20000 }).catch(() => {});

  const finalUrl = page.url();
  const title = await page.title().catch(() => '');
  const body = await page.evaluate(() => document.body?.innerText?.slice(0, 3000) || '').catch(() => '');
  const status = resp && typeof resp.status === 'function' ? resp.status() : 0;

  if (looksLikeProxyError(finalUrl, title, body)) return { outcome: 'proxy_down' };
  if (title.includes('moment')) return { outcome: 'cf_blocked' };

  // El id numerico (ej. "59309052" de "zp_59309052") va incrustado en el
  // permalink original. Si la pagina final ya no lo trae, nos mandaron a otro
  // lado (home, busqueda, u otra ficha): es una baja, no un cambio de slug.
  const numericId = propId.replace(/^[a-z]+_/, '');
  const samePage = finalUrl.includes(numericId);

  const detector = DEAD_PATTERNS[sourceKey];
  if (!detector) return { outcome: 'skip' };

  if (!samePage) return { outcome: 'dead', reason: 'redirect' };

  const reason = detector.isDead(status, body);
  if (reason) return { outcome: 'dead', reason };
  return { outcome: 'alive' };
}

async function main() {
  console.log(`Dead listing checker -- batch ${BATCH_SIZE}, source: ${sourceArg}`);

  let query = supabase.from('properties')
    .select('id, permalink, source, neighborhood, title, last_seen_at')
    .eq('is_active', true)
    .is('canonical_id', null)
    .not('permalink', 'is', null)
    .order('last_seen_at', { ascending: true })
    .limit(BATCH_SIZE);

  if (sourceArg !== 'all') {
    query = query.eq('source', sourceArg);
  }

  const { data: props, error } = await query;
  if (error) { console.error('Fetch error:', error.message); process.exit(1); }
  if (!props.length) { console.log('No properties to check.'); return; }

  console.log(`Checking ${props.length} listings...`);

  console.log('Launching Chrome...');
  const browser = await puppeteer.launch({
    headless: false, // Needs xvfb on Linux for Cloudflare
    executablePath: '/usr/bin/google-chrome',
    userDataDir: PROFILE_DIR,
    protocolTimeout: 60000,
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
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'es-AR,es;q=0.9,en;q=0.8' });
  await enableAssetBlocking(page);
  await page.setViewport({ width: 1280, height: 800 });

  // Preflight en zonaprop.com.ar antes de gastar el batch, mismo criterio que
  // scan-zp-headless.mjs / enrich-zp-puppeteer.mjs: distinguir "no llegue" de
  // "la fuente no tiene resultados" ANTES de tocar la base. Fijo en ZP porque
  // hoy es la unica fuente con activas (AP y ML en 0); si eso cambia, esto
  // deberia preflightear por source en vez de asumir ZP para todos.
  console.log('Testing Cloudflare...');
  await page.goto('https://www.zonaprop.com.ar', { waitUntil: 'networkidle2', timeout: 30000 });
  const preTitle = await page.title();
  const preUrl = page.url();
  const preBody = await page.evaluate(() => document.body?.innerText?.slice(0, 2000) || '').catch(() => '');
  if (looksLikeProxyError(preUrl, preTitle, preBody)) {
    console.error(`❌ No hay salida a internet: el proxy no responde (url=${preUrl}, title="${preTitle}").`);
    console.error('   Abortando para no marcar nada como muerto ni como vivo sin haber podido verificar.');
    await browser.close();
    process.exit(1);
  }
  if (preTitle.includes('moment')) {
    await page.waitForFunction(() => !document.title.includes('moment'), { timeout: 30000 }).catch(() => {});
    if ((await page.title()).includes('moment')) {
      console.error('❌ Cloudflare blocked on preflight.');
      await browser.close();
      process.exit(1);
    }
  }
  console.log('✅ Cloudflare passed\n');

  let dead = 0, alive = 0, errors = 0, skipped = 0, unknown = 0;
  const deadList = [];

  for (let i = 0; i < props.length; i++) {
    const p = props[i];
    if (!DEAD_PATTERNS[p.source]) { skipped++; continue; }

    if (CB.shouldAbort()) {
      console.log(`\n[CB] ABORT -- too many blocks (${CB.totalCf} CF, ${CB.consecutiveProxyDown} proxy-down, ${CB.consecutiveErrors} errors). Stopping to protect IP.`);
      break;
    }
    if (CB.shouldPause()) {
      console.log(`  [CB] ${CB.consecutiveCf} consecutive CF hits. Pausing 120s...`);
      await new Promise(r => setTimeout(r, 120000));
      CB.consecutiveCf = 0;
    }

    const result = await checkListing(page, p.permalink, p.id, p.source);

    if (result.outcome === 'error') {
      errors++;
      CB.onError();
    } else if (result.outcome === 'proxy_down') {
      // 27/08/2026 (heredado): un chequeo que no llega a la fuente NO es un
      // chequeo con resultado negativo. No se toca is_active ni last_seen_at.
      unknown++;
      CB.onProxyDown();
    } else if (result.outcome === 'cf_blocked') {
      unknown++;
      CB.onCf();
    } else if (result.outcome === 'dead') {
      dead++;
      deadList.push({ id: p.id, source: p.source, neighborhood: p.neighborhood, reason: result.reason });
      const { error: upErr } = await supabase.from('properties')
        .update({ is_active: false, deactivation_reason: result.reason, updated_at: new Date().toISOString() })
        .eq('id', p.id);
      if (upErr) console.log(`  Error deactivating ${p.id}: ${upErr.message}`);
      CB.onSuccess();
    } else if (result.outcome === 'alive') {
      alive++;
      await supabase.from('properties')
        .update({ last_seen_at: new Date().toISOString() })
        .eq('id', p.id);
      CB.onSuccess();
    }

    if ((i + 1) % 25 === 0 || i === props.length - 1) {
      console.log(`  ${i + 1}/${props.length} -- alive:${alive} dead:${dead} unknown:${unknown} err:${errors}`);
    }

    await new Promise(r => setTimeout(r, CB.currentDelay));
  }

  await browser.close();
  logBudgetSummary();

  console.log(`\nDone: ${props.length} checked, ${dead} dead, ${alive} alive, ${unknown} unknown, ${errors} errors, ${skipped} skipped`);
  if (unknown > props.length / 2) {
    console.log(`\n[!] ${unknown}/${props.length} sin respuesta concluyente: la fuente nos esta bloqueando, no es que las propiedades sigan vivas.`);
  }
  if (deadList.length) {
    console.log('\nDead listings:');
    deadList.forEach(d => console.log(`  ${d.id} (${d.source}) ${d.neighborhood} -- ${d.reason}`));
  }
}

main().catch(e => { console.error('💀 Fatal:', e.message); process.exit(1); });
