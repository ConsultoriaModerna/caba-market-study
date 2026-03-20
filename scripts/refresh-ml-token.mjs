// refresh-ml-token.mjs — Refreshes ML OAuth token before scraping
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function main() {
  console.log('[TOKEN] Fetching current token...');
  
  const { data: tokenRow, error } = await supabase
    .from('ml_tokens')
    .select('*')
    .eq('id', 'default')
    .single();

  if (error || !tokenRow) {
    console.error('[TOKEN] No token found:', error?.message);
    process.exit(1);
  }

  const savedAt = Number(tokenRow.saved_at);
  const expiresIn = Number(tokenRow.expires_in);
  const age = (Date.now() - savedAt) / 1000;

  console.log(`[TOKEN] Age: ${Math.round(age)}s, Expires in: ${expiresIn}s`);

  // Refresh if > 50% of lifetime used
  if (age < expiresIn * 0.5) {
    console.log('[TOKEN] Still fresh, skipping refresh');
    return;
  }

  console.log('[TOKEN] Refreshing...');
  const resp = await fetch('https://api.mercadolibre.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: process.env.ML_APP_ID,
      client_secret: process.env.ML_CLIENT_SECRET,
      refresh_token: tokenRow.refresh_token,
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    console.error(`[TOKEN] Refresh failed: ${resp.status}`, err);
    process.exit(1);
  }

  const tokens = await resp.json();
  
  const { error: updateErr } = await supabase
    .from('ml_tokens')
    .update({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_in: tokens.expires_in,
      saved_at: Date.now(),
    })
    .eq('id', 'default');

  if (updateErr) {
    console.error('[TOKEN] Update failed:', updateErr.message);
    process.exit(1);
  }

  console.log(`[TOKEN] Refreshed! New expiry: ${tokens.expires_in}s`);
}

main();
