#!/usr/bin/env node
// scrape-meli-local.mjs — Scraper ML via API REST desde IP local
// Uso: node scrape-meli-local.mjs [maxPages]
// Datos completos: precio, m², m² cubierto, coords, barrio, atributos, etc.

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const MAX_PAGES = parseInt(process.argv[2] || '20');
const PER_PAGE = 50;
const CATEGORY = 'MLA1493';
const STATE = 'TUxBUENBUGw3M2E1';

function attr(attrs, id) {
  return (attrs || []).find(a => a.id === id)?.value_name || null;
}

function num(v) {
  if (!v) return null;
  const n = parseFloat(v.replace(/[^0-9.]/g, ''));
  return isNaN(n) ? null : n;
}

function keywords(title, attrs) {
  const kw = [];
  const t = title.toLowerCase();
  const map = {
    'jardin': 'jardin', 'patio': 'patio', 'terraza': 'terraza',
    'pileta': 'pileta', 'cochera': 'cochera', 'garage': 'cochera',
    'parrilla': 'parrilla', 'quincho': 'quincho',
    'refaccionar': 'a refaccionar', 'reciclada': 'reciclada', 'reciclado': 'reciclada',
    'escritura': 'escritura', 'apto credito': 'apto credito',
    'ph': 'ph', 'duplex': 'duplex', 'triplex': 'triplex', 'lote': 'lote propio',
  };
  for (const [k, v] of Object.entries(map)) if (t.includes(k)) kw.push(v);
  const cond = attr(attrs, 'ITEM_CONDITION');
  if (cond?.toLowerCase().includes('refaccion')) kw.push('a refaccionar');
  if (cond?.toLowerCase().includes('recicl')) kw.push('reciclada');
  return [...new Set(kw)];
}

function segment(kw) {
  if (kw.includes('a refaccionar')) return 'refac';
  if (kw.includes('reciclada')) return 'recic';
  return 'general';
}

async function main() {
  const t0 = Date.now();

  // Token from Supabase
  const { data: tok } = await supabase
    .from('ml_tokens').select('access_token, saved_at, expires_in')
    .eq('id', 'default').single();

  if (!tok?.access_token) { console.error('❌ No token'); process.exit(1); }

  const age = (Date.now() - Number(tok.saved_at)) / 1000;
  if (age > Number(tok.expires_in) - 300) {
    console.error(`❌ Token expirado (${Math.round(age)}s)`);
    process.exit(1);
  }

  console.log(`🔑 Token OK (${Math.round(age)}s de ${tok.expires_in}s)`);
  console.log(`🔍 Scraping ${MAX_PAGES} pages × ${PER_PAGE} = ${MAX_PAGES * PER_PAGE} max results\n`);

  let fetched = 0, upserted = 0, errors = 0;

  for (let p = 0; p < MAX_PAGES; p++) {
    const url = `https://api.mercadolibre.com/sites/MLA/search?category=${CATEGORY}&state=${STATE}&PROPERTY_TYPE=242062&OPERATION=242075&limit=${PER_PAGE}&offset=${p * PER_PAGE}`;

    try {
      const r = await fetch(url, {
        headers: { 'Authorization': `Bearer ${tok.access_token}` }
      });

      if (!r.ok) {
        // Retry sin auth
        const r2 = await fetch(url);
        if (!r2.ok) {
          console.error(`  ❌ P${p}: ${r.status}/${r2.status}`);
          errors++;
          if (r.status === 401) break;
          continue;
        }
        var data = await r2.json();
      } else {
        var data = await r.json();
      }

      const results = data.results || [];
      if (!results.length) { console.log(`  📭 P${p}: sin resultados, fin`); break; }

      fetched += results.length;

      const rows = results.map(i => {
        const ta = num(attr(i.attributes, 'TOTAL_AREA'));
        const ca = num(attr(i.attributes, 'COVERED_AREA'));
        const kw = keywords(i.title, i.attributes);
        const beds = num(attr(i.attributes, 'BEDROOMS'));
        const baths = num(attr(i.attributes, 'BATHROOMS'));
        const rooms = num(attr(i.attributes, 'ROOMS'));

        return {
          id: 'ml_' + i.id.replace('MLA', '').toLowerCase(),
          title: i.title, price: i.price, currency: i.currency_id,
          operation: 'venta', property_type: 'casa',
          total_area: ta, covered_area: ca,
          bedrooms: beds != null ? Math.round(beds) : null,
          bathrooms: baths != null ? Math.round(baths) : null,
          ambientes: rooms != null ? Math.round(rooms) : null,
          neighborhood: i.location?.neighborhood?.name || null,
          city: i.location?.city?.name || 'Capital Federal',
          state: 'Capital Federal',
          latitude: i.location?.latitude || null,
          longitude: i.location?.longitude || null,
          permalink: i.permalink, thumbnail: i.thumbnail,
          keywords: kw, segment: segment(kw),
          source: 'mercadolibre', slug: i.id,
          price_per_sqm: (i.price && ta > 0) ? Math.round(i.price / ta) : null,
          is_active: true,
          last_seen_at: new Date().toISOString(),
          scraped_at: new Date().toISOString(),
        };
      });

      const { error } = await supabase
        .from('properties')
        .upsert(rows, { onConflict: 'id', ignoreDuplicates: false });

      if (error) { console.error(`  ❌ Upsert P${p}:`, error.message); errors++; }
      else { upserted += rows.length; }

      const segs = rows.reduce((a, r) => { a[r.segment] = (a[r.segment]||0)+1; return a; }, {});
      console.log(`  ✅ P${p+1}/${MAX_PAGES}: ${results.length} props (${Object.entries(segs).map(([k,v])=>`${k}:${v}`).join(' ')})`);

      if (p < MAX_PAGES - 1) await new Promise(r => setTimeout(r, 400));
    } catch (e) {
      console.error(`  ❌ P${p}:`, e.message);
      errors++;
    }
  }

  const dur = Math.round((Date.now() - t0) / 1000);

  // Log
  await supabase.from('scrape_runs').insert({
    source: 'mercadolibre', segment: 'all',
    total_scraped: fetched, total_new: 0, total_updated: upserted,
    total_deactivated: 0, duration_ms: Date.now() - t0,
    error_message: errors > 0 ? `${errors} errors` : null,
    metadata: { pages: MAX_PAGES, runner: 'local-mac' },
    started_at: new Date(t0).toISOString(),
    completed_at: new Date().toISOString(),
  });

  console.log(`\n🏁 ${fetched} fetched, ${upserted} upserted, ${errors} errors, ${dur}s`);
  if (errors > 0 && fetched === 0) process.exit(1);
}

main();
