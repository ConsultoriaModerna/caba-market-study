#!/usr/bin/env node
// incremental-update.mjs — Detect new listings + mark removed ones
// Only scrapes the first N pages of results (newest listings)
// New IDs get flagged for Chrome enrichment
// IDs not seen in 14 days get marked inactive
//
// Usage: node scripts/incremental-update.mjs [maxPages]
// Designed for nightly cron: only takes ~5-10 minutes

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const MAX_PAGES = parseInt(process.argv[2] || '10');
const PER_PAGE = 50;
const STALE_DAYS = 14;

// ── Step 1: ML — Scrape search results, detect new ──

async function scanML() {
  console.log('━━━ ML Scan ━━━');
  const { data: tok } = await supabase
    .from('ml_tokens').select('access_token, saved_at, expires_in')
    .eq('id', 'default').single();

  if (!tok?.access_token) { console.log('  ⚠️ No ML token'); return { new: 0, updated: 0 }; }

  const age = (Date.now() - Number(tok.saved_at)) / 1000;
  if (age > Number(tok.expires_in) - 300) { console.log('  ⚠️ ML token expired'); return { new: 0, updated: 0 }; }

  let seenIds = new Set();
  let newCount = 0, updatedCount = 0;

  for (let p = 0; p < MAX_PAGES; p++) {
    const url = `https://api.mercadolibre.com/sites/MLA/search?category=MLA1493&state=TUxBUENBUGw3M2E1&PROPERTY_TYPE=242062&OPERATION=242075&limit=${PER_PAGE}&offset=${p * PER_PAGE}&sort=date_desc`;

    try {
      const r = await fetch(url, { headers: { 'Authorization': `Bearer ${tok.access_token}` } });
      if (!r.ok) break;
      const data = await r.json();
      if (!data.results?.length) break;

      for (const item of data.results) {
        const id = 'ml_' + item.id.replace('MLA', '').toLowerCase();
        seenIds.add(id);

        // Check if exists
        const { data: existing } = await supabase
          .from('properties').select('id').eq('id', id).single();

        if (!existing) {
          newCount++;
          // Will be picked up by enrich-ml-details.mjs (description IS NULL)
        }

        // Update last_seen_at
        await supabase.from('properties').upsert({
          id,
          title: item.title,
          price: item.price,
          currency: item.currency_id,
          source: 'mercadolibre',
          is_active: true,
          last_seen_at: new Date().toISOString(),
        }, { onConflict: 'id', ignoreDuplicates: false });

        updatedCount++;
      }

      await new Promise(r => setTimeout(r, 400));
    } catch (e) {
      console.log(`  ❌ Page ${p}:`, e.message);
    }
  }

  console.log(`  ✅ ML: ${seenIds.size} scanned, ${newCount} new, ${updatedCount} updated`);
  return { new: newCount, updated: updatedCount, seen: seenIds };
}

// ── Step 2: Mark stale listings as inactive ──

async function markStale() {
  console.log('━━━ Mark Stale ━━━');
  const cutoff = new Date(Date.now() - STALE_DAYS * 86400000).toISOString();

  // Properties not seen in STALE_DAYS days
  const { data: stale } = await supabase
    .from('properties')
    .select('id')
    .eq('is_active', true)
    .lt('last_seen_at', cutoff)
    .limit(1000);

  if (stale?.length) {
    const ids = stale.map(p => p.id);
    // Mark inactive in batches
    for (let i = 0; i < ids.length; i += 100) {
      const batch = ids.slice(i, i + 100);
      await supabase
        .from('properties')
        .update({ is_active: false })
        .in('id', batch);
    }
    console.log(`  ✅ ${stale.length} listings marked inactive (not seen in ${STALE_DAYS} days)`);
  } else {
    console.log('  ✅ No stale listings');
  }

  return stale?.length || 0;
}

// ── Step 3: Summary ──

async function main() {
  const t0 = Date.now();
  console.log(`🔄 Incremental Update — ${new Date().toISOString()}\n`);

  const ml = await scanML();
  const staleCount = await markStale();

  // Count what needs enrichment
  const { count: mlNeedDesc } = await supabase
    .from('properties').select('id', { count: 'exact', head: true })
    .eq('source', 'mercadolibre').eq('is_active', true).is('description', null);

  const { count: zpNeedEnrich } = await supabase
    .from('properties').select('id', { count: 'exact', head: true })
    .eq('source', 'zonaprop').eq('is_active', true)
    .or('enrichment_level.is.null,enrichment_level.eq.0');

  const dur = Math.round((Date.now() - t0) / 1000);
  console.log(`\n━━━ Summary (${dur}s) ━━━`);
  console.log(`  ML: ${ml.new} new listings detected`);
  console.log(`  Stale: ${staleCount} marked inactive`);
  console.log(`  Pending enrichment: ${mlNeedDesc || 0} ML descriptions, ${zpNeedEnrich || 0} ZP pages`);

  await supabase.from('scrape_runs').insert({
    source: 'incremental', segment: 'delta-scan',
    total_scraped: ml.updated || 0, total_new: ml.new || 0,
    total_updated: ml.updated || 0, total_deactivated: staleCount,
    duration_ms: Date.now() - t0,
    metadata: { pages: MAX_PAGES, stale_days: STALE_DAYS },
    started_at: new Date(t0).toISOString(),
    completed_at: new Date().toISOString(),
  });
}

main().catch(e => { console.error('💀', e.message); process.exit(1); });
