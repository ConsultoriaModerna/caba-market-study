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

await check('2. ML API search (the 403 test)', async () => {
  const r = await fetch('https://api.mercadolibre.com/sites/MLA/search?category=MLA1459&limit=1', {
    signal: AbortSignal.timeout(20000),
  });
  console.log(`     status=${r.status}`);
  if (r.status === 200) {
    const j = await r.json();
    ok('ML API returns 200', `${j.results?.length || 0} results, total ${j.paging?.total}`);
  } else if (r.status === 403) {
    ko('ML API returns 200', 'still 403 PolicyAgent → IP not residential enough');
  } else {
    ko('ML API returns 200', `unexpected ${r.status}`);
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
