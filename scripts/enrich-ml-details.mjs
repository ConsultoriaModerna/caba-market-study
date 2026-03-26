#!/usr/bin/env node
// enrich-ml-details.mjs — Fetch ML descriptions via /items/{id}/description
// The /items/{id} endpoint returns 403 with current token scope,
// but /items/{id}/description works and returns plain_text.
// Usage: node scripts/enrich-ml-details.mjs [delayMs]

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const DELAY = parseInt(process.argv[2] || '500');

function extractMlaId(permalink, slug) {
  // Try permalink first: "https://...MLA-3060393220-..."
  const m = permalink?.match(/MLA-?(\d+)/);
  if (m) return `MLA${m[1]}`;
  // Fallback to slug: "MLA2532994302"
  const s = slug?.match(/MLA-?(\d+)/);
  if (s) return `MLA${s[1]}`;
  return null;
}

async function getToken() {
  const { data: tok } = await supabase
    .from('ml_tokens').select('access_token, saved_at, expires_in')
    .eq('id', 'default').single();

  if (!tok?.access_token) throw new Error('No token found');

  const age = (Date.now() - Number(tok.saved_at)) / 1000;
  if (age > Number(tok.expires_in) - 300) {
    throw new Error(`Token expired (age=${Math.round(age)}s, ttl=${tok.expires_in}s)`);
  }

  console.log(`🔑 Token OK (${Math.round(age)}s / ${tok.expires_in}s)`);
  return tok.access_token;
}

async function fetchDesc(mlaId, token) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(
        `https://api.mercadolibre.com/items/${mlaId}/description`,
        { headers: { 'Authorization': `Bearer ${token}` } }
      );
      if (r.status === 404) return null;
      if (r.status === 429) {
        console.log('  ⏳ Rate limited, waiting 10s...');
        await new Promise(r => setTimeout(r, 10000));
        continue;
      }
      if (!r.ok) {
        if (attempt < 2) { await new Promise(r => setTimeout(r, 2000)); continue; }
        return null;
      }
      const data = await r.json();
      return data.plain_text || null;
    } catch (e) {
      if (attempt < 2) { await new Promise(r => setTimeout(r, 2000)); continue; }
      return null;
    }
  }
  return null;
}

async function main() {
  const t0 = Date.now();
  const token = await getToken();

  // Get all ML properties without description
  const { data: props, error: fetchErr } = await supabase
    .from('properties')
    .select('id, permalink, slug')
    .eq('source', 'mercadolibre')
    .eq('is_active', true)
    .is('description', null)
    .limit(3000);

  if (fetchErr) { console.error('❌ Fetch error:', fetchErr.message); process.exit(1); }

  console.log(`📦 ${props.length} ML properties without description\n`);
  if (!props.length) { console.log('Nothing to do.'); return; }

  let enriched = 0, noDesc = 0, errors = 0;

  for (let i = 0; i < props.length; i++) {
    const prop = props[i];
    const mlaId = extractMlaId(prop.permalink, prop.slug);

    if (!mlaId) { noDesc++; continue; }

    const desc = await fetchDesc(mlaId, token);

    if (desc && desc.trim().length > 10) {
      const { error: upErr } = await supabase
        .from('properties')
        .update({
          description: desc.substring(0, 10000),
          enrichment_level: 1,
          enriched_at: new Date().toISOString(),
        })
        .eq('id', prop.id);

      if (upErr) {
        console.error(`  ❌ ${prop.id}: ${upErr.message}`);
        errors++;
      } else {
        enriched++;
      }
    } else {
      noDesc++;
    }

    if ((i + 1) % 100 === 0 || i === props.length - 1) {
      const pct = Math.round(((i + 1) / props.length) * 100);
      const elapsed = Math.round((Date.now() - t0) / 1000);
      const eta = Math.round(((Date.now() - t0) / (i + 1)) * (props.length - i - 1) / 1000);
      console.log(`  📊 ${i + 1}/${props.length} (${pct}%) — got: ${enriched}, empty: ${noDesc}, err: ${errors} [${elapsed}s elapsed, ~${eta}s ETA]`);
    }

    await new Promise(r => setTimeout(r, DELAY));
  }

  const dur = Math.round((Date.now() - t0) / 1000);
  console.log(`\n🏁 ML descriptions: ${enriched} enriched, ${noDesc} empty, ${errors} errors (${dur}s)`);

  await supabase.from('scrape_runs').insert({
    source: 'mercadolibre', segment: 'enrich-descriptions',
    total_scraped: props.length, total_new: 0, total_updated: enriched,
    total_deactivated: 0, duration_ms: Date.now() - t0,
    error_message: errors > 0 ? `${errors} errors` : null,
    metadata: { type: 'enrich-descriptions', runner: 'local-mac', delay_ms: DELAY },
    started_at: new Date(t0).toISOString(),
    completed_at: new Date().toISOString(),
  });
}

main().catch(e => { console.error('💀 Fatal:', e.message); process.exit(1); });
