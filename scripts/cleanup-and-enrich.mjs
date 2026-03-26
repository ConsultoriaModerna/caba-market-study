#!/usr/bin/env node
// cleanup-and-enrich.mjs — Clean ZP descriptions, fix outliers, compute covered_ratio
// Usage: node scripts/cleanup-and-enrich.mjs

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ── Step 1: Clean ZP descriptions (remove HTML/JS junk) ──

function cleanDescription(raw) {
  if (!raw) return null;

  // If it starts with common JS patterns, it's junk from page scrape
  if (raw.trim().startsWith(',') || raw.trim().startsWith('{') || raw.includes('viewMore:') || raw.includes('viewLess:')) {
    // Try to extract real description buried in the junk
    // Some have real text after the JS blob
    const patterns = [
      /¡[^!]+!/,  // starts with exclamation
      /(?:Propiedad|Casa|Hermosa|Excelente|Oportunidad|Ubicad[ao]|Venta|Gran)[^{}<>]+/i,
    ];
    for (const p of patterns) {
      const m = raw.match(p);
      if (m && m[0].length > 50) {
        return cleanDescription(m[0] + raw.substring(raw.indexOf(m[0]) + m[0].length));
      }
    }
    return null; // pure junk, no salvageable text
  }

  // Clean HTML artifacts
  let clean = raw
    .replace(/\t+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/Leer descripción completa/g, '')
    .replace(/Leer menos/g, '')
    .replace(/Ver más\s*(en\s+\w+)?/g, '')
    .replace(/Ver menos/g, '')
    .replace(/¿Cómo evitar fraudes inmobiliarios\?/g, '')
    .replace(/¡Quiero conocer más de [^!]+!/g, '')
    .replace(/Te compartimos información sobre este barrio[^.]+\./g, '')
    .replace(/Performance and Security by Cloudflare/g, '')
    .replace(/Zonaprop/g, '')
    .replace(/Casa\s+en\s+(Venta|Alquiler)/g, '')
    .replace(/Comprar\s*Capital Federal/g, '')
    .replace(/Casas\s+en\s+(Venta|Alquiler)[^.]+/g, '')
    .replace(/Departamentos\s+en\s+(Venta|Alquiler)[^.]+/g, '')
    .replace(/Oficinas comerciales\s+en\s+(Venta|Alquiler)[^.]+/g, '')
    .replace(/Propiedades en barrios cercanos/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  // If what remains is too short, it's not useful
  if (clean.length < 30) return null;

  return clean;
}

async function cleanZpDescriptions() {
  console.log('═══ Step 1: Cleaning ZP descriptions ═══\n');

  const { data: props, error } = await supabase
    .from('properties')
    .select('id, description')
    .eq('source', 'zonaprop')
    .not('description', 'is', null)
    .limit(5000);

  if (error) { console.error('❌', error.message); return; }

  let cleaned = 0, nulled = 0, unchanged = 0;

  for (const prop of props) {
    const clean = cleanDescription(prop.description);

    if (clean === null && prop.description) {
      // Was junk, set to null
      await supabase.from('properties').update({ description: null }).eq('id', prop.id);
      nulled++;
    } else if (clean && clean !== prop.description) {
      await supabase.from('properties').update({ description: clean }).eq('id', prop.id);
      cleaned++;
    } else {
      unchanged++;
    }
  }

  console.log(`  ✅ ${cleaned} cleaned, ${nulled} nulled (junk), ${unchanged} unchanged`);
  console.log(`  Total ZP with valid description after cleanup: ${cleaned + unchanged}\n`);
}

// ── Step 2: Fix outlier areas ──

async function fixOutliers() {
  console.log('═══ Step 2: Fixing area outliers ═══\n');

  // Properties with absurdly large areas (> 2000 m² for a house in CABA is almost certainly wrong)
  const { data: outliers, error } = await supabase
    .from('properties')
    .select('id, title, total_area, neighborhood, price')
    .gt('total_area', 2000)
    .limit(200);

  if (error) { console.error('❌', error.message); return; }

  console.log(`  Found ${outliers.length} properties with total_area > 2000 m²`);

  let fixed = 0;
  for (const prop of outliers) {
    // Null out the absurd area and recalculate price_per_sqm
    const { error: upErr } = await supabase
      .from('properties')
      .update({ total_area: null, price_per_sqm: null })
      .eq('id', prop.id);

    if (!upErr) fixed++;
    else console.error(`  ❌ ${prop.id}: ${upErr.message}`);
  }

  console.log(`  ✅ ${fixed} outlier areas nulled\n`);

  // Also fix cases where covered_area > total_area (swap)
  const { data: swapped } = await supabase
    .from('properties')
    .select('id, total_area, covered_area')
    .not('covered_area', 'is', null)
    .not('total_area', 'is', null)
    .gt('covered_area', 0);

  let swapCount = 0;
  for (const prop of (swapped || [])) {
    if (Number(prop.covered_area) > Number(prop.total_area)) {
      await supabase.from('properties')
        .update({ total_area: prop.covered_area, covered_area: prop.total_area })
        .eq('id', prop.id);
      swapCount++;
    }
  }
  if (swapCount) console.log(`  🔄 ${swapCount} properties had covered > total (swapped)\n`);
}

// ── Step 3: Update covered_ratio and recalculate price_per_sqm ──

async function updateDerivedFields() {
  console.log('═══ Step 3: Computing derived fields ═══\n');

  // covered_ratio = covered_area / total_area
  const { count: ratioCount, error: e1 } = await supabase.rpc('exec_sql', {
    sql: `
      UPDATE properties
      SET covered_ratio = ROUND(covered_area / NULLIF(total_area, 0), 3)
      WHERE covered_area IS NOT NULL
        AND total_area IS NOT NULL
        AND total_area > 0
        AND (covered_ratio IS NULL OR covered_ratio != ROUND(covered_area / NULLIF(total_area, 0), 3))
    `
  });

  // Recalculate price_per_sqm where missing but calculable
  const { error: e2 } = await supabase.rpc('exec_sql', {
    sql: `
      UPDATE properties
      SET price_per_sqm = ROUND(price / NULLIF(total_area, 0))
      WHERE price IS NOT NULL
        AND total_area IS NOT NULL
        AND total_area > 0
        AND price > 0
        AND (price_per_sqm IS NULL OR price_per_sqm = 0)
    `
  });

  // If RPC not available, do it client-side
  if (e1 || e2) {
    console.log('  RPC not available, using direct SQL via client...');
    await updateDerivedFieldsClientSide();
    return;
  }

  console.log('  ✅ Derived fields updated via SQL\n');
}

async function updateDerivedFieldsClientSide() {
  // Fetch properties that need covered_ratio
  const { data: props } = await supabase
    .from('properties')
    .select('id, total_area, covered_area, price, price_per_sqm')
    .not('total_area', 'is', null)
    .gt('total_area', 0)
    .limit(8000);

  let ratioUpdates = 0, psmUpdates = 0;

  for (const prop of (props || [])) {
    const update = {};
    const ta = Number(prop.total_area);
    const ca = prop.covered_area ? Number(prop.covered_area) : null;
    const price = prop.price ? Number(prop.price) : null;

    if (ca && ta > 0) {
      const ratio = Math.round((ca / ta) * 1000) / 1000;
      update.covered_ratio = ratio;
      ratioUpdates++;
    }

    if (price && ta > 0 && (!prop.price_per_sqm || Number(prop.price_per_sqm) === 0)) {
      update.price_per_sqm = Math.round(price / ta);
      psmUpdates++;
    }

    if (Object.keys(update).length > 0) {
      await supabase.from('properties').update(update).eq('id', prop.id);
    }
  }

  console.log(`  ✅ covered_ratio: ${ratioUpdates} updated`);
  console.log(`  ✅ price_per_sqm: ${psmUpdates} recalculated\n`);
}

// ── Step 4: Rebuild FTS for updated descriptions ──

async function rebuildFts() {
  console.log('═══ Step 4: Rebuilding full-text search index ═══\n');

  // Update FTS vector for all properties with description
  const { error } = await supabase.rpc('exec_sql', {
    sql: `
      UPDATE properties
      SET fts = to_tsvector('spanish', COALESCE(title, '') || ' ' || COALESCE(description, '') || ' ' || COALESCE(neighborhood, ''))
      WHERE description IS NOT NULL
        AND (fts IS NULL OR fts != to_tsvector('spanish', COALESCE(title, '') || ' ' || COALESCE(description, '') || ' ' || COALESCE(neighborhood, '')))
    `
  });

  if (error) {
    console.log('  ⚠️ RPC not available for FTS rebuild — will need manual SQL');
    console.log('  Run this in Supabase SQL editor:');
    console.log("  UPDATE properties SET fts = to_tsvector('spanish', COALESCE(title,'') || ' ' || COALESCE(description,'') || ' ' || COALESCE(neighborhood,'')) WHERE description IS NOT NULL;");
  } else {
    console.log('  ✅ FTS vectors rebuilt\n');
  }
}

// ── Main ──

async function main() {
  const t0 = Date.now();

  await cleanZpDescriptions();
  await fixOutliers();
  await updateDerivedFields();
  await rebuildFts();

  // Summary stats
  const { data: stats } = await supabase
    .from('properties')
    .select('source', { count: 'exact', head: true });

  const { data: descStats } = await supabase.rpc('exec_sql', {
    sql: `
      SELECT source,
        count(*) as total,
        count(CASE WHEN description IS NOT NULL AND length(description) > 30 THEN 1 END) as with_desc,
        count(CASE WHEN latitude IS NOT NULL THEN 1 END) as with_gps,
        count(CASE WHEN covered_ratio IS NOT NULL THEN 1 END) as with_ratio
      FROM properties GROUP BY source
    `
  });

  const dur = Math.round((Date.now() - t0) / 1000);
  console.log(`\n═══ Done in ${dur}s ═══`);
}

main().catch(e => { console.error('💀 Fatal:', e.message); process.exit(1); });
