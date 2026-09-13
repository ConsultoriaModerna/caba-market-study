import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ─────────────────────────────────────────────────────────────────────────────
// request-enrich (RE, 13/09/2026)
//
// Por que existe: el enrich de ZP corria todas las noches sobre el 100% de las
// activas (proxy residencial, ~$30-40/mes al ritmo actual), enriqueciera Nico
// algo o no. El nightly deja de hacer eso. En cambio, cada ficha se enriquece
// solo si alguien la abrio en el dashboard: esta funcion no visita nada por su
// cuenta, solo anota "esto se pidio" (enrich_requested_at) y un cron chico en
// el VPS (cada pocos minutos) procesa esa cola con Puppeteer. Si la cola esta
// vacia, ese cron no lanza Chrome ni gasta un solo byte de proxy.
//
// Mismo patron de gate que admin-write/intel-query: token embebido en una
// pagina estatica (no es secreto), mas cap diario via check_and_increment_usage
// para poner un techo real al gasto aunque el token se filtre.
// ─────────────────────────────────────────────────────────────────────────────

const ENRICH_TOKEN = Deno.env.get('ENRICH_REQUEST_TOKEN');
const ALLOWED_ORIGIN = Deno.env.get('INTEL_ALLOWED_ORIGIN') ?? 'https://inmofindr.vercel.app';

const SB_URL = Deno.env.get('SUPABASE_URL')!;
const SB_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const sb = createClient(SB_URL, SB_KEY);

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

  if (!ENRICH_TOKEN || req.headers.get('x-intel-token') !== ENRICH_TOKEN) {
    return json(req, { error: 'unauthorized' }, 401);
  }

  // Cap diario propio, separado del de intel-query/analyze-property: esto pide
  // una visita real con proxy (plata), asi que el techo tiene que ser chico
  // aunque el token se filtre. 200/dia cubre de sobra a una sola persona
  // navegando el dashboard y deja el peor caso en unos pocos dolares.
  const { data: underCap, error: capError } = await sb.rpc('check_and_increment_usage', {
    p_fn: 'request-enrich', p_max: 200,
  });
  if (capError) return json(req, { error: 'rate limit check failed' }, 500);
  if (!underCap) return json(req, { error: 'daily limit reached, try again tomorrow' }, 429);

  let payload: Record<string, unknown>;
  try {
    payload = await req.json();
  } catch {
    return json(req, { error: 'invalid json body' }, 400);
  }

  const id = payload.id;
  if (typeof id !== 'string' || !id.trim()) return json(req, { error: 'missing id' }, 400);

  const { data: prop, error: fetchErr } = await sb.from('properties')
    .select('id, source, is_active, description, covered_area, bedrooms, bathrooms, enrichment_level')
    .eq('id', id)
    .maybeSingle();

  if (fetchErr) return json(req, { error: fetchErr.message }, 500);
  if (!prop) return json(req, { error: 'not found' }, 404);
  if (!prop.is_active) return json(req, { ok: true, queued: false, reason: 'inactive' });

  const alreadyEnriched = prop.enrichment_level === 1
    && prop.description && prop.covered_area && prop.bedrooms && prop.bathrooms;
  if (alreadyEnriched) return json(req, { ok: true, queued: false, reason: 'already_enriched' });

  if (prop.source !== 'zonaprop') {
    // Solo ZP tiene un enricher vivo hoy (AP/ML muertos, ver CLAUDE.md).
    return json(req, { ok: true, queued: false, reason: 'no_enricher_for_source' });
  }

  const { error: upErr } = await sb.from('properties')
    .update({ enrich_requested_at: new Date().toISOString() })
    .eq('id', id);
  if (upErr) return json(req, { error: upErr.message }, 500);

  return json(req, { ok: true, queued: true });
});
