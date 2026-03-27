#!/usr/bin/env node
// generate-embeddings.mjs — Generate OpenAI embeddings for property descriptions
// Only processes properties with description but no embedding (incremental)
// Usage: node scripts/generate-embeddings.mjs [batchSize]
// Cost: ~$0.01 for 3,000 descriptions

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const OPENAI_KEY = process.env.OPENAI_API_KEY;
const MODEL = 'text-embedding-3-small';
const BATCH_SIZE = parseInt(process.argv[2] || '100');

if (!OPENAI_KEY) {
  console.error('Missing OPENAI_API_KEY in .env');
  process.exit(1);
}

function buildEmbeddingText(p) {
  // Combine description + structured data for richer embeddings
  const parts = [];
  if (p.title) parts.push(p.title);
  if (p.neighborhood) parts.push(`Barrio: ${p.neighborhood}`);
  if (p.segment === 'refac') parts.push('A refaccionar');
  if (p.segment === 'recic') parts.push('Reciclada');
  if (p.total_area) parts.push(`${p.total_area}m² totales`);
  if (p.covered_area) parts.push(`${p.covered_area}m² cubiertos`);
  if (p.bedrooms) parts.push(`${p.bedrooms} dormitorios`);
  if (p.bathrooms) parts.push(`${p.bathrooms} baños`);
  if (p.cocheras) parts.push(`${p.cocheras} cocheras`);
  if (p.keywords?.length) parts.push(`Keywords: ${p.keywords.join(', ')}`);
  if (p.description) parts.push(p.description.substring(0, 2000));
  return parts.join('. ');
}

async function getEmbeddings(texts) {
  const resp = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ model: MODEL, input: texts })
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`OpenAI API error ${resp.status}: ${err}`);
  }

  const data = await resp.json();
  return data.data.map(d => d.embedding);
}

async function main() {
  const t0 = Date.now();
  console.log(`🧠 Generating embeddings (model: ${MODEL})\n`);

  let totalProcessed = 0, totalEmbedded = 0, totalTokens = 0;

  while (true) {
    // Get batch of properties needing embeddings
    const { data: props, error } = await supabase
      .from('properties')
      .select('id, title, neighborhood, segment, total_area, covered_area, bedrooms, bathrooms, cocheras, keywords, description')
      .eq('is_active', true)
      .is('canonical_id', null)
      .is('embedding', null)
      .not('description', 'is', null)
      .limit(BATCH_SIZE);

    if (error) { console.error('DB error:', error.message); break; }
    if (!props.length) { console.log('No more properties to embed.'); break; }

    // Build texts
    const texts = props.map(buildEmbeddingText);

    try {
      // Get embeddings from OpenAI (batch call)
      const embeddings = await getEmbeddings(texts);

      // Store in DB
      let batchOk = 0;
      for (let i = 0; i < props.length; i++) {
        const { error: upErr } = await supabase
          .from('properties')
          .update({ embedding: JSON.stringify(embeddings[i]) })
          .eq('id', props[i].id);

        if (upErr) console.error(`  ❌ ${props[i].id}:`, upErr.message);
        else batchOk++;
      }

      totalProcessed += props.length;
      totalEmbedded += batchOk;
      const elapsed = Math.round((Date.now() - t0) / 1000);
      console.log(`  📊 ${totalProcessed} processed, ${totalEmbedded} embedded (${elapsed}s)`);

    } catch (e) {
      console.error('  ❌ Batch failed:', e.message);
      break;
    }

    // Small delay to respect rate limits
    await new Promise(r => setTimeout(r, 500));
  }

  const dur = Math.round((Date.now() - t0) / 1000);
  console.log(`\n🏁 Embeddings: ${totalEmbedded} generated in ${dur}s`);
}

main().catch(e => { console.error('💀', e.message); process.exit(1); });
