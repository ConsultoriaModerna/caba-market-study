// scrape-meli v5 — public search (no auth needed for ML search API)
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.3";

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

const CATEGORY = 'MLA1493';
const STATE = 'TUxBUENBUGw3M2E1';
const PROPERTY_TYPE = '242062';
const RESULTS_PER_PAGE = 50;
const DEFAULT_MAX_PAGES = 5;

interface MLResult {
  id: string;
  title: string;
  price: number;
  currency_id: string;
  permalink: string;
  thumbnail: string;
  location?: { neighborhood?: { name?: string }; city?: { name?: string }; latitude?: number; longitude?: number };
  attributes?: Array<{ id: string; name: string; value_name: string | null }>;
}

function extractAttr(attrs: MLResult['attributes'], id: string): string | null {
  const attr = (attrs || []).find(a => a.id === id);
  return attr?.value_name || null;
}

function parseNum(val: string | null): number | null {
  if (!val) return null;
  const n = parseFloat(val.replace(/[^0-9.]/g, ''));
  return isNaN(n) ? null : n;
}

function extractKeywords(title: string, attrs: MLResult['attributes']): string[] {
  const kw: string[] = [];
  const t = title.toLowerCase();
  const map: Record<string, string> = {
    'jardin': 'jardin', 'patio': 'patio', 'terraza': 'terraza',
    'pileta': 'pileta', 'cochera': 'cochera', 'garage': 'cochera',
    'parrilla': 'parrilla', 'quincho': 'quincho',
    'refaccionar': 'a refaccionar', 'reciclada': 'reciclada', 'reciclado': 'reciclada',
    'ph': 'ph', 'duplex': 'duplex',
  };
  for (const [key, val] of Object.entries(map)) {
    if (t.includes(key)) kw.push(val);
  }
  const cond = extractAttr(attrs, 'ITEM_CONDITION');
  if (cond) {
    if (cond.toLowerCase().includes('refaccion')) kw.push('a refaccionar');
    if (cond.toLowerCase().includes('recicl')) kw.push('reciclada');
  }
  return [...new Set(kw)];
}

function determineSegment(kw: string[]): string {
  if (kw.includes('a refaccionar')) return 'refac';
  if (kw.includes('reciclada')) return 'recic';
  return 'general';
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
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

  try {
    const url = new URL(req.url);
    const maxPages = Math.min(parseInt(url.searchParams.get('pages') || String(DEFAULT_MAX_PAGES)), 40);
    const startTime = Date.now();

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Try to get token (optional for search, required for some endpoints)
    const { data: tokenRow } = await supabase
      .from('ml_tokens')
      .select('access_token, saved_at, expires_in')
      .eq('id', 'default')
      .single();

    let token: string | null = null;
    if (tokenRow?.access_token) {
      const savedAt = Number(tokenRow.saved_at);
      const expiresIn = Number(tokenRow.expires_in);
      const tokenAge = (Date.now() - savedAt) / 1000;
      if (tokenAge < expiresIn - 300) {
        token = tokenRow.access_token;
      }
    }

    let totalFetched = 0;
    let totalUpserted = 0;
    const errors: string[] = [];
    let usedAuth = false;

    for (let page = 0; page < maxPages; page++) {
      const offset = page * RESULTS_PER_PAGE;
      const searchUrl = `https://api.mercadolibre.com/sites/MLA/search?category=${CATEGORY}&state=${STATE}&PROPERTY_TYPE=${PROPERTY_TYPE}&OPERATION=242075&limit=${RESULTS_PER_PAGE}&offset=${offset}`;

      try {
        // First try without auth (public endpoint)
        const headers: Record<string, string> = { 'Accept': 'application/json' };
        
        let resp = await fetch(searchUrl, { headers });
        
        // If 403 without auth, retry with auth
        if (!resp.ok && resp.status === 403 && token && !usedAuth) {
          headers['Authorization'] = `Bearer ${token}`;
          resp = await fetch(searchUrl, { headers });
          if (resp.ok) usedAuth = true;
        }
        
        // If still 403 with auth, try without auth and different user agent
        if (!resp.ok && resp.status === 403) {
          resp = await fetch(searchUrl);
        }

        if (!resp.ok) {
          const errText = await resp.text();
          errors.push(`P${page}: ${resp.status} ${errText.substring(0, 120)}`);
          if (resp.status === 401) break;
          continue;
        }

        const data = await resp.json();
        const results: MLResult[] = data.results || [];
        if (results.length === 0) break;

        totalFetched += results.length;

        const rows = results.map((item: MLResult) => {
          const totalArea = parseNum(extractAttr(item.attributes, 'TOTAL_AREA'));
          const covArea = parseNum(extractAttr(item.attributes, 'COVERED_AREA'));
          const kw = extractKeywords(item.title, item.attributes);
          const beds = parseNum(extractAttr(item.attributes, 'BEDROOMS'));
          const baths = parseNum(extractAttr(item.attributes, 'BATHROOMS'));
          const rooms = parseNum(extractAttr(item.attributes, 'ROOMS'));

          return {
            id: 'ml_' + item.id.replace('MLA', '').toLowerCase(),
            title: item.title,
            price: item.price,
            currency: item.currency_id,
            operation: 'venta',
            property_type: 'casa',
            total_area: totalArea,
            covered_area: covArea,
            bedrooms: beds !== null ? Math.round(beds) : null,
            bathrooms: baths !== null ? Math.round(baths) : null,
            ambientes: rooms !== null ? Math.round(rooms) : null,
            neighborhood: item.location?.neighborhood?.name || null,
            city: item.location?.city?.name || 'Capital Federal',
            state: 'Capital Federal',
            latitude: item.location?.latitude || null,
            longitude: item.location?.longitude || null,
            permalink: item.permalink,
            thumbnail: item.thumbnail,
            keywords: kw,
            segment: determineSegment(kw),
            source: 'mercadolibre',
            slug: item.id,
            price_per_sqm: (item.price && totalArea && totalArea > 0) ? Math.round(item.price / totalArea) : null,
            is_active: true,
            last_seen_at: new Date().toISOString(),
            scraped_at: new Date().toISOString(),
          };
        });

        const { error: upsertErr } = await supabase
          .from('properties')
          .upsert(rows, { onConflict: 'id', ignoreDuplicates: false });

        if (upsertErr) {
          errors.push(`Upsert p${page}: ${upsertErr.message}`);
        } else {
          totalUpserted += rows.length;
        }

        if (page < maxPages - 1) await new Promise(r => setTimeout(r, 300));
      } catch (pageErr) {
        errors.push(`P${page}: ${String(pageErr)}`);
      }
    }

    const duration = Date.now() - startTime;

    const { error: logErr } = await supabase.from('scrape_runs').insert({
      source: 'mercadolibre',
      segment: 'all',
      total_scraped: totalFetched,
      total_new: 0,
      total_updated: totalUpserted,
      total_deactivated: 0,
      duration_ms: duration,
      error_message: errors.length > 0 ? errors.join('; ') : null,
      metadata: { pages: maxPages, errors_count: errors.length, used_auth: usedAuth },
      started_at: new Date(startTime).toISOString(),
      completed_at: new Date().toISOString(),
    });
    if (logErr) console.error('Log error:', logErr.message);

    return json({
      success: errors.length === 0 || totalFetched > 0,
      fetched: totalFetched,
      upserted: totalUpserted,
      pages: maxPages,
      duration_ms: duration,
      used_auth: usedAuth,
      errors: errors.length > 0 ? errors : undefined,
    });

  } catch (e: unknown) {
    return json({ success: false, error: String(e), stack: (e instanceof Error) ? e.stack : undefined }, 500);
  }
});
