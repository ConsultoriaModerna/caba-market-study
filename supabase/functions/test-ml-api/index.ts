// test-ml-api v2 — minimal diagnostic
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.3";

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';


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
  const r: Record<string, unknown> = {};
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data: t } = await supabase.from('ml_tokens').select('access_token').eq('id', 'default').single();
  const token = t?.access_token;

  // Test 1: public search (phones)
  try {
    const resp = await fetch('https://api.mercadolibre.com/sites/MLA/search?q=iphone&limit=1');
    r.t1_public = resp.status;
  } catch (e) { r.t1_public = String(e); }

  // Test 2: real estate WITHOUT auth
  try {
    const resp = await fetch('https://api.mercadolibre.com/sites/MLA/search?category=MLA1493&limit=1');
    r.t2_re_noauth = resp.status;
  } catch (e) { r.t2_re_noauth = String(e); }

  // Test 3: real estate WITH auth
  try {
    const resp = await fetch('https://api.mercadolibre.com/sites/MLA/search?category=MLA1493&limit=1', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const d = await resp.json();
    r.t3_re_auth = { s: resp.status, total: d.paging?.total, err: d.error };
  } catch (e) { r.t3_re_auth = String(e); }

  // Test 4: general items with auth  
  try {
    const resp = await fetch('https://api.mercadolibre.com/sites/MLA/search?q=casa+capital+federal&limit=1', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const d = await resp.json();
    r.t4_query_auth = { s: resp.status, total: d.paging?.total, err: d.error };
  } catch (e) { r.t4_query_auth = String(e); }

  return new Response(JSON.stringify(r), { headers: { 'Content-Type': 'application/json' } });
});
