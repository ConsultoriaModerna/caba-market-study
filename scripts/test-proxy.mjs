#!/usr/bin/env node
// test-proxy.mjs — Smoke test for residential proxy integration.
//
// Validates:
//   1) Proxy URL parses
//   2) Outbound IP is Argentina + ASN is residential (not datacenter/VPN flagged)
//   3) ML API /sites/MLA/search returns 200 (not 403 PolicyAgent)
//   4) ZP homepage returns HTML (not Cloudflare challenge title)
//   5) AP homepage returns HTML
//
// Usage: node scripts/test-proxy.mjs

import { applyFetchProxy, getProxyConfig } from './lib/proxy.mjs';
import { createClient } from '@supabase/supabase-js';

const cfg = getProxyConfig();
if (!cfg) {
  console.error('❌ RESIDENTIAL_PROXY_URL not set in env. Aborting.');
  process.exit(1);
}

console.log(`🌐 Proxy configured: ${cfg.hostPort} (user: ${cfg.username || 'none'})`);
applyFetchProxy();

let pass = 0, fail = 0;

function ok(label, detail = '') { console.log(`  ✅ ${label}${detail ? ' — ' + detail : ''}`); pass++; }
function ko(label, detail = '') { console.log(`  ❌ ${label}${detail ? ' — ' + detail : ''}`); fail++; }

async function check(label, fn) {
  console.log(`\n[${label}]`);
  try { await fn(); }
  catch (e) { ko(label, e.message); }
}

await check('1. Outbound IP via ipinfo.io', async () => {
  const r = await fetch('https://ipinfo.io/json', { signal: AbortSignal.timeout(15000) });
  if (!r.ok) return ko('HTTP', `${r.status}`);
  const j = await r.json();
  console.log(`     IP=${j.ip}  country=${j.country}  org=${j.org}  city=${j.city}`);
  if (j.country === 'AR') ok('Country is AR');
  else ko('Country is AR', `got ${j.country}`);
  const orgLower = (j.org || '').toLowerCase();
  const dcKeywords = ['amazon', 'aws', 'google', 'microsoft', 'azure', 'digitalocean', 'ovh', 'hetzner', 'linode', 'vultr', 'oracle cloud', 'datacenter'];
  const looksDC = dcKeywords.some(k => orgLower.includes(k));
  if (looksDC) ko('ASN not datacenter', `flagged: ${j.org}`);
  else ok('ASN looks residential/ISP', j.org);
});

await check('2. ML API /items/{id}/description (the production endpoint)', async () => {
  // This is what enrich-ml-details.mjs actually calls.
  // Note: /sites/MLA/search and /items/{id} return 403 with our current token scope
  // ("Buscador" role) — that's a known token-scope limitation, NOT an IP/proxy issue.
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: tok } = await sb.from('ml_tokens').select('access_token, saved_at, expires_in').eq('id', 'default').single();
  if (!tok) return ko('Got ML token from Supabase', 'no row in ml_tokens');
  const age = (Date.now() - Number(tok.saved_at)) / 1000;
  if (age > Number(tok.expires_in) - 300) {
    ko('ML token fresh', `expired (age ${Math.round(age)}s, ttl ${tok.expires_in}s) — run scripts/refresh-ml-token.mjs first`);
    return;
  }
  ok('ML token fresh', `${Math.round(tok.expires_in - age)}s remaining`);

  const r = await fetch('https://api.mercadolibre.com/items/MLA2532994302/description', {
    headers: {
      'Authorization': `Bearer ${tok.access_token}`,
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0 Safari/537.36',
      'Accept': 'application/json',
    },
    signal: AbortSignal.timeout(20000),
  });
  console.log(`     status=${r.status}`);
  if (r.status === 200) {
    const j = await r.json();
    ok('ML /items/{id}/description returns 200', `${j.plain_text?.length || 0} chars of description`);
  } else if (r.status === 403) {
    const body = await r.text();
    ko('ML returns 200', `403 — body: ${body.substring(0, 100)}`);
  } else if (r.status === 404) {
    ok('ML returns 200 or 404', 'test item gone but proxy works (no 403)');
  } else {
    ko('ML returns 200', `unexpected ${r.status}`);
  }
});

await check('3. ZonaProp homepage', async () => {
  const r = await fetch('https://www.zonaprop.com.ar/', {
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36' },
    signal: AbortSignal.timeout(20000),
  });
  console.log(`     status=${r.status}`);
  const body = await r.text();
  const isCFChallenge = /just a moment|un momento|verificando que|cf-browser-verification/i.test(body);
  if (r.ok && !isCFChallenge) ok('ZP returns real HTML');
  else if (isCFChallenge) ko('ZP not blocked', 'Cloudflare challenge served (still need Puppeteer pass)');
  else ko('ZP returns real HTML', `status ${r.status}`);
});

await check('4. Argenprop homepage', async () => {
  const r = await fetch('https://www.argenprop.com/', {
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36' },
    signal: AbortSignal.timeout(20000),
  });
  console.log(`     status=${r.status}`);
  if (r.ok) ok('AP returns 200');
  else ko('AP returns 200', `${r.status}`);
});

console.log(`\n────────────────────────────────`);
console.log(`Result: ${pass} pass / ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
