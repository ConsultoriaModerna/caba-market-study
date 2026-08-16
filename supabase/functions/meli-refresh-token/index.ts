// meli-refresh-token v2 — Reads refresh_token from ml_tokens table (not secrets)
// Can be called by cron or manually to keep tokens fresh

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.3";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || '';
const MELI_APP_ID = Deno.env.get("MELI_APP_ID") || '';
const MELI_CLIENT_SECRET = Deno.env.get("MELI_CLIENT_SECRET") || '';

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
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
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  if (req.method !== 'POST') {
    return json({ success: false, error: 'Method not allowed' }, 405);
  }

  console.log('Starting token refresh from DB...');

  if (!MELI_APP_ID || !MELI_CLIENT_SECRET) {
    return json({ success: false, error: 'Missing MELI_APP_ID or MELI_CLIENT_SECRET' }, 500);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Read current refresh token from ml_tokens table
  const { data: tokenRow, error: readError } = await supabase
    .from('ml_tokens')
    .select('refresh_token, access_token, saved_at')
    .eq('id', 'default')
    .single();

  if (readError || !tokenRow || !tokenRow.refresh_token) {
    console.error('No refresh token found in ml_tokens:', readError);
    return json({ success: false, error: 'No refresh token in ml_tokens. Re-authorize at /functions/v1/meli-oauth-callback' }, 500);
  }

  console.log('Found refresh token, saved_at:', tokenRow.saved_at);

  try {
    const refreshParams = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: MELI_APP_ID,
      client_secret: MELI_CLIENT_SECRET,
      refresh_token: tokenRow.refresh_token,
    });

    const tokenResp = await fetch('https://api.mercadolibre.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
      body: refreshParams.toString(),
    });

    const responseText = await tokenResp.text();
    console.log('ML refresh response status:', tokenResp.status);

    if (!tokenResp.ok) {
      console.error('Refresh failed:', responseText);
      return json({
        success: false,
        error: 'ML refresh failed: ' + tokenResp.status + ' - ' + responseText,
        hint: 'Refresh token may be expired. Re-authorize at /functions/v1/meli-oauth-callback'
      }, 502);
    }

    const tokens = JSON.parse(responseText);
    const accessToken = tokens.access_token;
    const newRefreshToken = tokens.refresh_token;
    const expiresIn = tokens.expires_in;
    const userId = tokens.user_id;

    if (!accessToken) {
      return json({ success: false, error: 'No access_token in ML response' }, 502);
    }

    // Update ml_tokens with new tokens
    const { error: updateError } = await supabase
      .from('ml_tokens')
      .update({
        access_token: accessToken,
        refresh_token: newRefreshToken || tokenRow.refresh_token,
        expires_in: expiresIn || 21600,
        user_id: userId || null,
        saved_at: Date.now(),
      })
      .eq('id', 'default');

    if (updateError) {
      console.error('DB update error:', updateError);
      // Still return tokens even if DB update fails
      return json({
        success: true,
        warning: 'Tokens refreshed but DB update failed: ' + updateError.message,
        access_token: accessToken,
        expires_in: expiresIn,
      });
    }

    console.log('Token refresh successful! Expires in:', expiresIn, 'seconds');

    return json({
      success: true,
      expires_in: expiresIn,
      user_id: userId,
      refreshed_at: new Date().toISOString(),
    });

  } catch (err) {
    console.error('Unexpected error:', err);
    return json({ success: false, error: 'Unexpected: ' + String(err) }, 500);
  }
});
