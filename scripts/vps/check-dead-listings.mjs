#!/usr/bin/env node
// check-dead-listings.mjs — Verify if active listings are still live on portal
// Visits permalink URLs and marks is_active=false if listing was removed
//
// Usage: node scripts/vps/check-dead-listings.mjs [batchSize] [--source=zonaprop|argenprop|mercadolibre|all]
// Default: 200 oldest active listings across all sources

import { createClient } from '@supabase/supabase-js';
import { applyFetchProxy, incrementBudget } from '../lib/proxy.mjs';

// 27/08/2026: este script salia DIRECTO por la IP del VPS, que ZonaProp bloquea.
// Por eso cada ficha devolvia 403 y (antes del fix de abajo) se contaba como
// "viva". Aun con el 403 ya tratado como "unknown", saliendo directo el chequeo
// no puede verificar nada nunca: el padron no se depura y stale no caduca. Sale
// por el mismo proxy residencial que el resto del pipeline. Son requests HEAD-ish
// de una pagina, el consumo es bajo comparado con el scan.
applyFetchProxy();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const BATCH_SIZE = parseInt(process.argv[2] || '200');
const sourceArg = process.argv.find(a => a.startsWith('--source='))?.split('=')[1] || 'all';

const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const DELAY_MS = 2000;

// Detection patterns per portal
const DEAD_PATTERNS = {
  zonaprop: {
    // ZP redirects to search or shows "no encontramos" for dead listings
    isDead: (status, url, body) => {
      if (status === 404) return 'http_404';
      if (status === 301 || status === 302) return 'redirect';
      // ZP returns 200 but with "esta publicacion ya no esta disponible" or redirects to home
      if (body.includes('ya no est') || body.includes('no encontramos')) return 'removed_text';
      if (body.includes('Publicaci\u00f3n pausada') || body.includes('publicacion pausada')) return 'paused';
      return null;
    }
  },
  argenprop: {
    isDead: (status, url, body) => {
      if (status === 404) return 'http_404';
      if (status === 301 || status === 302) return 'redirect';
      if (body.includes('no existe') || body.includes('fue eliminad')) return 'removed_text';
      if (body.includes('Error 404') || body.includes('pagina no encontrada')) return 'page_404';
      return null;
    }
  },
  mercadolibre: {
    isDead: (status, url, body) => {
      if (status === 404) return 'http_404';
      // ML shows "publicacion finalizada" or redirects
      if (body.includes('finalizada') || body.includes('no existe') || body.includes('ya no est')) return 'removed_text';
      if (status === 302 || status === 301) return 'redirect';
      return null;
    }
  }
};

async function checkUrl(permalink) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    incrementBudget('dead-check');
    const resp = await fetch(permalink, {
      headers: { 'User-Agent': USER_AGENT },
      redirect: 'manual',  // Don't follow redirects, we want to detect them
      signal: controller.signal
    });
    clearTimeout(timeout);

    const status = resp.status;
    // For redirects, check Location header
    if (status === 301 || status === 302) {
      const location = resp.headers.get('location') || '';
      // If redirect goes to home or search page, it's dead
      if (location === '/' || location.includes('/buscar') || location.includes('?') || !location.includes('/propiedades/')) {
        return { status, body: '', redirectTo: location };
      }
      // Redirect to another property page might be a slug change, not dead
      return { status, body: '', redirectTo: location, isSlugChange: true };
    }

    const body = await resp.text().catch(() => '');
    return { status, body: body.substring(0, 5000) };
  } catch (e) {
    if (e.name === 'AbortError') return { status: 0, body: '', error: 'timeout' };
    return { status: 0, body: '', error: e.message };
  }
}

async function main() {
  console.log(`Dead listing checker -- batch ${BATCH_SIZE}, source: ${sourceArg}`);

  // Fetch oldest active listings with permalinks
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

  let dead = 0, alive = 0, errors = 0, skipped = 0, unknown = 0;
  const deadList = [];

  for (let i = 0; i < props.length; i++) {
    const p = props[i];
    const detector = DEAD_PATTERNS[p.source];
    if (!detector) { skipped++; continue; }

    const result = await checkUrl(p.permalink);

    if (result.error) {
      errors++;
      if (i % 50 === 0) console.log(`  ${i}/${props.length} -- alive:${alive} dead:${dead} err:${errors}`);
      await sleep(DELAY_MS);
      continue;
    }

    if (result.isSlugChange) {
      alive++;
      await sleep(DELAY_MS);
      continue;
    }

    // 27/08/2026 — el bug que fabricaba el padron.
    //
    // isDead() solo devuelve motivo con 404/301/302 o textos de baja. Un 403
    // (Cloudflare, CloudFront, rate-limit) caia en `return null` y el listing
    // se contaba VIVO y encima se le refrescaba last_seen_at. Como este script
    // corre sin proxy y la IP del VPS esta bloqueada, desde el 13/07 las 200
    // fichas de cada noche devolvian 403 y las 200 se marcaban vivas. Efecto
    // combinado: la ventana stale de 7 dias no vencio ni una vez en 45 noches
    // (el propio checker le rearmaba el reloj a todo el padron cada 6,5 dias) y
    // las "1.290 activas" pasaron a ser un censo congelado del 12-jul que nadie
    // habia verificado.
    //
    // Un chequeo que no llega a la fuente NO es un chequeo con resultado
    // negativo. Ante 403 / 429 / 5xx / red caida no se toca nada: ni se da de
    // baja ni se refresca el reloj. Que expire por stale es la respuesta
    // correcta cuando llevamos semanas sin poder verificar.
    if (result.status === 403 || result.status === 429 || result.status >= 500 || result.status === 0) {
      unknown++;
      if ((i + 1) % 50 === 0) {
        console.log(`  ${i + 1}/${props.length} -- alive:${alive} dead:${dead} unknown:${unknown} err:${errors}`);
      }
      await sleep(DELAY_MS);
      continue;
    }

    const reason = detector.isDead(result.status, p.permalink, result.body);
    if (reason) {
      dead++;
      deadList.push({ id: p.id, source: p.source, neighborhood: p.neighborhood, reason });

      // Mark inactive + persist reason for UI / debugging
      const { error: upErr } = await supabase.from('properties')
        .update({ is_active: false, deactivation_reason: reason, updated_at: new Date().toISOString() })
        .eq('id', p.id);

      if (upErr) console.log(`  Error deactivating ${p.id}: ${upErr.message}`);
    } else {
      alive++;
      // Update last_seen_at to refresh the stale timer
      await supabase.from('properties')
        .update({ last_seen_at: new Date().toISOString() })
        .eq('id', p.id);
    }

    if ((i + 1) % 50 === 0) {
      console.log(`  ${i + 1}/${props.length} -- alive:${alive} dead:${dead} unknown:${unknown} err:${errors}`);
    }

    await sleep(DELAY_MS);
  }

  console.log(`\nDone: ${props.length} checked, ${dead} dead, ${alive} alive, ${unknown} unknown, ${errors} errors, ${skipped} skipped`);
  if (unknown > props.length / 2) {
    console.log(`\n[!] ${unknown}/${props.length} sin respuesta concluyente: la fuente nos esta bloqueando, no es que las propiedades sigan vivas.`);
  }
  if (deadList.length) {
    console.log('\nDead listings:');
    deadList.forEach(d => console.log(`  ${d.id} (${d.source}) ${d.neighborhood} -- ${d.reason}`));
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
