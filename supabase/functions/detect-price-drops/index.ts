// detect-price-drops v2 — Snapshots current prices and detects drops
// Called after each scraping run. Compares current prices vs last snapshot.
// Generates opportunity_events for significant drops.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.3";

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

const MIN_DROP_PCT = 5;
const HIGH_DROP_PCT = 15;
const BATCH_SIZE = 500;

interface Property {
  id: string;
  title: string;
  price: number;
  currency: string;
  price_per_sqm: number | null;
  neighborhood: string | null;
  segment: string | null;
  permalink: string;
  total_area: number | null;
}


// ── Gate (PA, 16/08/2026 — protocolo §23) ───────────────────────────────────
// Esta funcion no la llama un humano: la disparan pg_cron y los scripts del
// nocturno. Dos credenciales aceptadas y nada mas:
//   1. x-cron-token, que pg_cron saca del Vault en cada corrida. El valor se
//      genero DENTRO de la base y no existe fuera de ella: aca se compara con
//      check_cron_token(), que es SECURITY DEFINER y solo devuelve true/false.
//   2. Authorization: Bearer <service_role>, que es lo que ya mandaban
//      nightly-update.sh y run-nightly.sh, para no romperlos.
// Fail-closed en los dos caminos.
const SB_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
async function gateOk(req: Request): Promise<boolean> {
  const t = req.headers.get('x-cron-token');
  if (t) {
    try {
      const gate = createClient(Deno.env.get('SUPABASE_URL')!, SB_SERVICE_KEY);
      const { data, error } = await gate.rpc('check_cron_token', { t });
      if (!error && data === true) return true;
    } catch { /* sigue al camino del bearer */ }
  }
  // Camino 2, por capacidad y no por igualdad de string. Comparar contra
  // SUPABASE_SERVICE_ROLE_KEY no sirve: el runtime de la edge function trae la
  // key nueva (sb_secret_) y los scripts del nocturno mandan la JWT legacy, que
  // tambien es service_role. Son dos strings distintos con el mismo poder. Asi
  // que se prueba el poder: check_cron_token solo tiene EXECUTE para service_role,
  // de modo que si la credencial del que llama puede ejecutarla, es service_role.
  const bearer = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!bearer) return false;
  try {
    const asCaller = createClient(Deno.env.get('SUPABASE_URL')!, bearer);
    const { error } = await asCaller.rpc('check_cron_token', { t: 'probe-de-capacidad' });
    return !error;
  } catch { return false; }
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== 'OPTIONS' && !(await gateOk(req))) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401, headers: { 'Content-Type': 'application/json' },
    });
  }
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*' } });
  }

  const startTime = Date.now();
  console.log('[DETECT] Starting price drop detection...');

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // 1. Get all active properties with prices
  let allProperties: Property[] = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await supabase
      .from('properties')
      .select('id, title, price, currency, price_per_sqm, neighborhood, segment, permalink, total_area')
      .eq('is_active', true)
      .not('price', 'is', null)
      .gt('price', 0)
      .range(from, from + pageSize - 1);

    if (error) {
      console.error('[DETECT] Error fetching properties:', error);
      return json({ success: false, error: error.message }, 500);
    }
    if (!data || data.length === 0) break;
    allProperties = allProperties.concat(data as Property[]);
    if (data.length < pageSize) break;
    from += pageSize;
  }

  console.log(`[DETECT] Processing ${allProperties.length} active properties`);

  // 2. Get latest snapshot per property via DISTINCT ON
  const { data: latestSnapshots, error: snapError } = await supabase
    .rpc('get_latest_snapshots');

  // Fallback: manual query if RPC doesn't exist
  let lastPriceMap = new Map<string, number>();
  if (snapError) {
    console.log('[DETECT] RPC not found, using manual snapshot lookup');
    // Get all snapshots and dedupe in memory (not ideal but works)
    let allSnaps: Array<{property_id: string; price: number; recorded_at: string}> = [];
    let snapFrom = 0;
    while (true) {
      const { data: snaps } = await supabase
        .from('price_snapshots')
        .select('property_id, price, recorded_at')
        .order('recorded_at', { ascending: false })
        .range(snapFrom, snapFrom + 2000 - 1);
      if (!snaps || snaps.length === 0) break;
      allSnaps = allSnaps.concat(snaps);
      if (snaps.length < 2000) break;
      snapFrom += 2000;
    }
    for (const snap of allSnaps) {
      if (!lastPriceMap.has(snap.property_id)) {
        lastPriceMap.set(snap.property_id, Number(snap.price));
      }
    }
  } else if (latestSnapshots) {
    for (const snap of latestSnapshots) {
      lastPriceMap.set(snap.property_id, Number(snap.price));
    }
  }

  console.log(`[DETECT] Found ${lastPriceMap.size} existing snapshots to compare`);

  // 3. Compare and detect
  const newSnapshots: Array<{
    property_id: string;
    price: number;
    currency: string;
    price_per_sqm: number | null;
    source: string;
  }> = [];

  const events: Array<{
    property_id: string;
    event_type: string;
    severity: string;
    title: string;
    details: Record<string, unknown>;
  }> = [];

  let dropsDetected = 0;
  let newListings = 0;

  for (const prop of allProperties) {
    const lastPrice = lastPriceMap.get(prop.id);

    if (lastPrice === undefined) {
      newListings++;
      // Flag cheap refac listings
      if (prop.segment === 'refac' && prop.price_per_sqm && prop.price_per_sqm < 900) {
        events.push({
          property_id: prop.id,
          event_type: 'good_deal',
          severity: 'high',
          title: `Nueva casa a refaccionar barata: USD ${prop.price_per_sqm}/m\u00b2 en ${prop.neighborhood || 'CABA'}`,
          details: {
            price: prop.price,
            price_per_sqm: prop.price_per_sqm,
            neighborhood: prop.neighborhood,
            segment: prop.segment,
            total_area: prop.total_area,
            permalink: prop.permalink,
          },
        });
      }
    } else if (prop.price < lastPrice) {
      const dropPct = ((lastPrice - prop.price) / lastPrice) * 100;

      if (dropPct >= MIN_DROP_PCT) {
        dropsDetected++;
        const severity = dropPct >= HIGH_DROP_PCT ? 'high' : dropPct >= 10 ? 'medium' : 'info';

        events.push({
          property_id: prop.id,
          event_type: 'price_drop',
          severity,
          title: `Baja -${dropPct.toFixed(1)}%: ${prop.title?.substring(0, 60)}`,
          details: {
            prev_price: lastPrice,
            new_price: prop.price,
            drop_pct: parseFloat(dropPct.toFixed(1)),
            drop_abs: lastPrice - prop.price,
            neighborhood: prop.neighborhood,
            segment: prop.segment,
            price_per_sqm: prop.price_per_sqm,
            permalink: prop.permalink,
          },
        });

        if (prop.segment === 'refac' && dropPct >= 10) {
          events.push({
            property_id: prop.id,
            event_type: 'high_gap',
            severity: 'high',
            title: `Oportunidad refac con baja -${dropPct.toFixed(1)}%: ${prop.neighborhood || 'CABA'}`,
            details: {
              prev_price: lastPrice,
              new_price: prop.price,
              drop_pct: parseFloat(dropPct.toFixed(1)),
              price_per_sqm: prop.price_per_sqm,
              permalink: prop.permalink,
            },
          });
        }
      }
    }

    // Record new snapshot
    newSnapshots.push({
      property_id: prop.id,
      price: prop.price,
      currency: prop.currency || 'USD',
      price_per_sqm: prop.price_per_sqm,
      source: 'auto_detect',
    });
  }

  // 4. Batch insert snapshots
  let snapshotsInserted = 0;
  for (let i = 0; i < newSnapshots.length; i += BATCH_SIZE) {
    const batch = newSnapshots.slice(i, i + BATCH_SIZE);
    const { error: insertError } = await supabase
      .from('price_snapshots')
      .insert(batch);

    if (insertError) {
      console.error(`[DETECT] Snapshot batch ${i} error:`, insertError.message);
    } else {
      snapshotsInserted += batch.length;
    }
  }

  // 5. Insert opportunity events
  let eventsInserted = 0;
  if (events.length > 0) {
    for (let i = 0; i < events.length; i += BATCH_SIZE) {
      const batch = events.slice(i, i + BATCH_SIZE);
      const { error: evtError } = await supabase
        .from('opportunity_events')
        .insert(batch);

      if (evtError) {
        console.error(`[DETECT] Events batch error:`, evtError.message);
      } else {
        eventsInserted += batch.length;
      }
    }
  }

  const duration = Math.round((Date.now() - startTime) / 1000);

  const result = {
    success: true,
    properties_processed: allProperties.length,
    snapshots_inserted: snapshotsInserted,
    price_drops: dropsDetected,
    new_listings: newListings,
    events_created: eventsInserted,
    duration_seconds: duration,
  };

  console.log('[DETECT] Done!', JSON.stringify(result));
  return json(result);
});

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}
