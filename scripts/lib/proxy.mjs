// proxy.mjs — Single source of truth for residential proxy config.
//
// Reads RESIDENTIAL_PROXY_URL from env (format: http://user:pass@host:port).
// If unset, all helpers no-op so scripts run direct (dev mode, will hit 403 on
// production sources like ML API or Cloudflare-gated pages).
//
// Usage in fetch-based scripts:
//   import { applyFetchProxy } from './lib/proxy.mjs';
//   applyFetchProxy();  // call once at top of main()
//
// Usage in Puppeteer scripts:
//   import { getPuppeteerProxyArgs, authenticatePuppeteerProxy } from './lib/proxy.mjs';
//   const browser = await puppeteer.launch({ args: [...baseArgs, ...getPuppeteerProxyArgs()] });
//   const page = await browser.newPage();
//   await authenticatePuppeteerProxy(page);

import { ProxyAgent, setGlobalDispatcher } from 'undici';

let _cachedConfig;

export function getProxyConfig() {
  if (_cachedConfig !== undefined) return _cachedConfig;
  const url = process.env.RESIDENTIAL_PROXY_URL?.trim();
  if (!url) { _cachedConfig = null; return null; }
  try {
    const u = new URL(url);
    _cachedConfig = {
      url,
      server: `${u.protocol}//${u.host}`,
      hostPort: u.host,
      username: decodeURIComponent(u.username || ''),
      password: decodeURIComponent(u.password || ''),
    };
    return _cachedConfig;
  } catch (e) {
    console.warn(`⚠️  Invalid RESIDENTIAL_PROXY_URL: ${e.message}`);
    _cachedConfig = null;
    return null;
  }
}

let _dispatcherApplied = false;

export function applyFetchProxy() {
  if (_dispatcherApplied) return false;
  const cfg = getProxyConfig();
  if (!cfg) {
    console.log('🌐 Proxy: not configured, fetch runs direct');
    return false;
  }
  setGlobalDispatcher(new ProxyAgent(cfg.url));
  _dispatcherApplied = true;
  console.log(`🌐 Proxy: fetch routed via ${cfg.hostPort}`);
  return true;
}

export function getPuppeteerProxyArgs() {
  const cfg = getProxyConfig();
  if (!cfg) return [];
  return [`--proxy-server=${cfg.server}`];
}

export async function authenticatePuppeteerProxy(page) {
  const cfg = getProxyConfig();
  if (!cfg || !cfg.username) return false;
  await page.authenticate({ username: cfg.username, password: cfg.password });
  return true;
}

// ──────────────────────────────────────────────────────────────────────────
// Preflight — comprobar que el proxy CONTESTA antes de gastar una corrida.
//
// 27/08/2026. Esto no existia y costo 45 noches de apagon silencioso. El 13/07
// ProxyEmpire empezo a devolver 407 (credencial rechazada, saldo agotado o
// sub-user dado de baja) y NADA en el pipeline se entero, porque Chrome con un
// --proxy-server muerto no tira excepcion: renderiza una pagina de error cuyo
// <title> es el propio hostname. Los checks de Cloudflare buscaban la palabra
// "moment" en el titulo, no la encontraban, y concluian "Cloudflare passed".
// Despues no habia tarjetas en el DOM y se logueaba "empty page" / "no listings
// found". Tres detectores leyendo una pagina de error 407 como una pagina
// normal y vacia, todas las noches, durante mes y medio.
//
// La leccion: un scraper tiene que distinguir "la fuente no tiene resultados"
// de "no llegue a la fuente". Son estados opuestos y aca se veian iguales.
export async function preflightProxy({ testUrl = 'https://api.ipify.org', timeoutMs = 20000 } = {}) {
  const cfg = getProxyConfig();
  if (!cfg) return { ok: true, skipped: true, reason: 'proxy no configurado, corriendo directo' };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const { ProxyAgent } = await import('undici');
    const resp = await fetch(testUrl, { dispatcher: new ProxyAgent(cfg.url), signal: ctrl.signal });
    if (resp.status === 407) {
      return { ok: false, status: 407, reason: 'proxy rechaza la credencial (407): saldo agotado o sub-user dado de baja' };
    }
    if (!resp.ok) {
      return { ok: false, status: resp.status, reason: `proxy devolvio HTTP ${resp.status}` };
    }
    const exitIp = (await resp.text()).trim().slice(0, 45);
    return { ok: true, exitIp, reason: `proxy vivo, IP de salida ${exitIp}` };
  } catch (e) {
    const msg = e.name === 'AbortError' ? `timeout de ${timeoutMs}ms` : e.message;
    return { ok: false, reason: `no se pudo establecer el tunel: ${msg}` };
  } finally {
    clearTimeout(timer);
  }
}

// ¿Esta pagina es en realidad el error de Chrome por proxy caido, y no la web?
// Chrome pinta chrome-error://chromewebdata/ y pone el hostname como <title>,
// que es exactamente lo que hacia pasar el error por "pagina vacia".
export function looksLikeProxyError(url, title, body) {
  const u = String(url || '');
  if (u.startsWith('chrome-error://')) return true;
  const t = `${title || ''} ${String(body || '').slice(0, 2000)}`;
  return /ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_CONNECTION_FAILED|HTTP ERROR 407|Proxy Authentication Required/i.test(t);
}

// Rotate the ProxyEmpire sticky session ID, getting a fresh residential IP.
// Username format: ...-sid-XXXX-... — we swap the sid token for a random one.
// Use between page batches to avoid anti-bot rate counters tied to a single IP.
export async function rotatePuppeteerProxySession(page) {
  const cfg = getProxyConfig();
  if (!cfg || !cfg.username) return null;
  const newSid = Math.random().toString(36).slice(2, 10);
  const newUsername = cfg.username.replace(/sid-[a-z0-9]+/i, `sid-${newSid}`);
  if (newUsername === cfg.username) return null;
  await page.authenticate({ username: newUsername, password: cfg.password });
  return newSid;
}

// Block heavy assets on Puppeteer page to drop bandwidth ~3x on HTML-heavy targets.
// Default deliberately keeps stylesheet — blocking CSS triggered "frame detached"
// errors on AP search pages (iframes for ads/analytics) during 2026-05-09
// calibration and broke ML render at the same time. Image/media/font is plenty.
// Call AFTER authenticatePuppeteerProxy and BEFORE first navigation.
export async function enableAssetBlocking(page, { blockTypes = ['image', 'media', 'font'] } = {}) {
  await page.setRequestInterception(true);
  page.on('request', req => {
    if (blockTypes.includes(req.resourceType())) {
      req.abort().catch(() => {});
    } else {
      req.continue().catch(() => {});
    }
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Budget cap — safety net for ALL proxy-routed scripts.
//
// Purpose: hard ceiling on requests per run, defending against runaway loops,
// retry storms, or accidentally large batchSize args that would burn proxy GB
// (and our wallet) on ProxyEmpire. Independent from ProxyEmpire's own
// dashboard limit — defense in depth.
//
// Default: 5,000 requests per process. Override via PROXY_MAX_REQUESTS env.
// Set PROXY_MAX_REQUESTS=0 to disable (NOT recommended in production).
// ──────────────────────────────────────────────────────────────────────────

let _budgetUsed = 0;
const _budgetMax = parseInt(process.env.PROXY_MAX_REQUESTS || '5000', 10);
const _budgetByLabel = new Map();

export function incrementBudget(label = 'request') {
  _budgetUsed++;
  _budgetByLabel.set(label, (_budgetByLabel.get(label) || 0) + 1);
  if (_budgetMax > 0 && _budgetUsed > _budgetMax) {
    console.error(`\n🛑 PROXY BUDGET EXCEEDED: ${_budgetUsed} / ${_budgetMax} requests`);
    console.error(`   By label: ${[..._budgetByLabel.entries()].map(([k,v]) => `${k}=${v}`).join(', ')}`);
    console.error(`   Aborting to protect wallet. Override with PROXY_MAX_REQUESTS env if intentional.\n`);
    process.exit(2);
  }
  // Soft warning at 80%
  if (_budgetMax > 0 && _budgetUsed === Math.floor(_budgetMax * 0.8)) {
    console.warn(`⚠️  Proxy budget at 80%: ${_budgetUsed} / ${_budgetMax} requests`);
  }
  return _budgetUsed;
}

export function getBudgetStatus() {
  return {
    used: _budgetUsed,
    max: _budgetMax,
    remaining: _budgetMax > 0 ? Math.max(0, _budgetMax - _budgetUsed) : Infinity,
    byLabel: Object.fromEntries(_budgetByLabel),
  };
}

export function logBudgetSummary() {
  const s = getBudgetStatus();
  if (s.used === 0) return;
  console.log(`\n💰 Proxy budget used: ${s.used}${s.max > 0 ? ` / ${s.max}` : ''} requests`);
  if (Object.keys(s.byLabel).length > 1) {
    for (const [label, count] of Object.entries(s.byLabel)) {
      console.log(`     ${label}: ${count}`);
    }
  }
}
