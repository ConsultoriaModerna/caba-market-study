import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ─────────────────────────────────────────────────────────────────────────────
// admin-write (RE, 27/08/2026)
//
// Por qué existe: la tabla `properties` tenía una política RLS `anon_update_geocoding`
// con `cmd: UPDATE, using: true, with_check: true` para el rol anon. La anon key
// viaja dentro del dashboard público, así que cualquier visitante podía editar o
// desactivar las 16.829 filas con un solo fetch. La política estaba ahí para que
// funcionaran dos cosas legítimas: el botón "Baja" de mapa.html y la edición
// manual de index.html.
//
// En vez de matar esas dos features, sus escrituras pasan por acá: la función
// escribe con service_role (que nunca sale al browser) y solo acepta las
// columnas de la allowlist de abajo. La política anon de UPDATE queda eliminada.
//
// Honestidad sobre el gate: el token va embebido en una página estática, igual
// que en intel-query, así que no es un secreto. Lo que compra es que la mesa de
// escritura deje de ser el endpoint REST genérico de Supabase (enumerable por
// cualquier escáner de claves anon) y pase a ser una superficie chica, con
// allowlist de columnas y de operaciones. El arreglo de verdad es auth real.
// ─────────────────────────────────────────────────────────────────────────────

const INTEL_TOKEN = Deno.env.get('INTEL_QUERY_TOKEN');
const ALLOWED_ORIGIN = Deno.env.get('INTEL_ALLOWED_ORIGIN') ?? 'https://inmofindr.vercel.app';

const SB_URL = Deno.env.get('SUPABASE_URL')!;
const SB_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const sb = createClient(SB_URL, SB_KEY);

// Solo estas columnas se pueden tocar desde el dashboard. Nada de is_active por
// la vía de `update`: dar de baja tiene su propia operación, con motivo obligatorio.
const EDITABLE = new Set([
  'price', 'currency', 'total_area', 'covered_area', 'price_per_sqm',
  'ambientes', 'bedrooms', 'bathrooms', 'cocheras',
  'neighborhood', 'address_text', 'property_type', 'segment',
  'latitude', 'longitude', 'contact_phone', 'contact_name',
]);

const REASONS = new Set([
  'sold', 'rented', 'withdrawn', 'duplicate', 'misleading',
  'wrong_data', 'listing_down', 'manual', 'stale_7d',
]);

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('origin');
  return {
    'Access-Control-Allow-Origin': origin === ALLOWED_ORIGIN ? origin : ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey, x-intel-token',
    'Vary': 'Origin',
  };
}

const json = (req: Request, body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), 'Content-Type': 'application/json' },
  });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) });
  if (req.method !== 'POST') return json(req, { error: 'method not allowed' }, 405);

  if (!INTEL_TOKEN || req.headers.get('x-intel-token') !== INTEL_TOKEN) {
    return json(req, { error: 'unauthorized' }, 401);
  }

  let payload: Record<string, unknown>;
  try {
    payload = await req.json();
  } catch {
    return json(req, { error: 'invalid json body' }, 400);
  }

  const op = payload.op;
  const id = payload.id;
  if (typeof id !== 'string' || !id.trim()) return json(req, { error: 'missing id' }, 400);

  if (op === 'deactivate') {
    const reason = String(payload.reason ?? 'manual');
    if (!REASONS.has(reason)) return json(req, { error: `unknown reason: ${reason}` }, 400);

    const { error } = await sb.from('properties')
      .update({ is_active: false, deactivation_reason: reason })
      .eq('id', id);
    if (error) return json(req, { error: error.message }, 500);
    return json(req, { ok: true, id, reason });
  }

  if (op === 'update') {
    const fields = (payload.fields ?? {}) as Record<string, unknown>;
    const update: Record<string, unknown> = {};
    const rejected: string[] = [];

    for (const [k, v] of Object.entries(fields)) {
      if (EDITABLE.has(k)) update[k] = v;
      else rejected.push(k);
    }
    if (!Object.keys(update).length) {
      return json(req, { error: 'no editable fields', rejected }, 400);
    }

    const { error } = await sb.from('properties').update(update).eq('id', id);
    if (error) return json(req, { error: error.message }, 500);
    return json(req, { ok: true, id, updated: Object.keys(update), rejected });
  }

  return json(req, { error: `unknown op: ${String(op)}` }, 400);
});
