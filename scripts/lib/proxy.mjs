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

// Block heavy assets on Puppeteer page to drop bandwidth ~4x on HTML-heavy targets
// (ZP, AP). Call AFTER authenticatePuppeteerProxy and BEFORE first navigation.
export async function enableAssetBlocking(page, { blockTypes = ['image', 'media', 'font', 'stylesheet'] } = {}) {
  await page.setRequestInterception(true);
  page.on('request', req => {
    if (blockTypes.includes(req.resourceType())) {
      req.abort().catch(() => {});
    } else {
      req.continue().catch(() => {});
    }
  });
}
