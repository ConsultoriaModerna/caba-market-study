# 2026-05-09 (parte B) — Anti-bot calibration ZP/AP via stealth plugin

Continuación de `2026-05-09-vps-proxy-deploy.md`. Nico re-abrió la sesión para atacar la task #6 que había quedado pendiente.

## Hipótesis y descartes

Llegamos al smoke con: VPS proxy verde, scripts cableados, pero ZP property pages devuelven CF challenge 5/5 y AP scan tira navigation timeouts. Iteramos:

1. **`enableAssetBlocking` off** — request interception sospechoso de causar frame-detached en AP. Confirmado: AP pasó de 0/0 timeouts a *20/20 scraped en 36s* sin asset blocking. Para ZP no movió la aguja (sigue 5/5 CF).
2. **CF wait extendido (10s → 30s)** — ZP property pages siguieron 5/5. CF NO está auto-pasando con tiempo, está respondiendo 403 directo.
3. **Direct fetch `https://www.zonaprop.com.ar/propiedades/...`** — confirmó: status 403, body 5997 chars, title "Just a moment...", CF en body. ZP tiene CF Managed Challenge habilitado específicamente sobre `/propiedades/*`.
4. **Fingerprint hide manual** (`navigator.webdriver=undefined`, `languages`, `plugins`) — debug previo había mostrado `webdriver=true`, así que parecía smoking gun. Pero el smoke siguió 5/5 fail. CF está chequeando más signals.
5. **`puppeteer-extra-plugin-stealth`** — patch de ~20 vectores (canvas, WebGL, audioContext, codecs, chrome.runtime, etc). Smoke: *5/5 enriched en 66s, 0 errors*. ✅ Stealth pasa CF.

## Decisión clave: stealth plugin como engine canónico

Replicado a los otros 3 scripts puppeteer del VPS:
- `scan-zp-headless.mjs`
- `scrape-argenprop.mjs`
- `scrape-ml-headless.mjs`

Patch de import:
```js
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
puppeteer.use(StealthPlugin());
```

Engine sigue siendo `puppeteer-core` (instalado como dep aparte). Stealth no requiere puppeteer full.

## Trade-off del stealth: latencia

Stealth añade overhead de runtime patches → networkidle2 demora más. Tuve que bumpear timeouts:
- `scan-zp-headless.mjs`: 30000ms → 60000ms en los 3 gotos.
- `scrape-argenprop.mjs`: warmup 20000ms → 60000ms; goto loop 30000ms → 60000ms.
- `enrich-zp-puppeteer.mjs`: ya estaba en 30000ms goto + 30000ms CF wait, OK con stealth (usa `domcontentloaded` no `networkidle2`).

## Resultados smoke final (post-stealth)

| Script | Resultado | Duración |
|---|---|---|
| ZP enrich | 5/5 enriched, 0 errors | 66s |
| ZP scan p1 | 26 listings, 26 new | ~75s |
| ZP scan p2-3 | timeout 60s | (CF re-challenge) |
| AP scan | 20 scraped, 20 upserted | 49s |

ZP scan pagination (pages 2+) tira timeouts incluso con stealth. Hipótesis: CF re-challenge al cambiar `?page=N`, o el sticky session del proxy rota mid-run. *No es bloqueante*: 26 listings/zona/noche vs 0 anterior es ganancia neta. Registrada como task #7 separada.

## Estado de los archivos en VPS

- `dependencies` actualizadas: `puppeteer-extra@^3.3.6`, `puppeteer-extra-plugin-stealth@^2.11.2`.
- `.chrome-profile` limpiado entre smokes (cookies viejas confunden CF).
- Engine Chrome: `/usr/bin/google-chrome` (Ubuntu nodesource), no Chromium bundled.
- `RESIDENTIAL_PROXY_URL` activo, `PROXY_MAX_REQUESTS=5000` default.

## Predicción para cron 03:00 ARG del 2026-05-10

Con stealth + 60s timeouts:
- AP scan: ~20 listings/run × 3 tipos × N zonas. Probablemente verde.
- ZP scan: ~26 listings page 1 por zona × tipos. Pages 2+ pueden seguir timing out, pero CB no se dispara al primer warning.
- ZP enrich: ahora sí debería procesar batches (testeado 5/5).
- ML scan: sigue `ML_ENABLED=false`. Decisión de Nico re-activar — ML tiene su propio rate-limit del 04-27, stealth puede o no ayudar.

Slack #webhooks debería empezar a reportar runs *sin* "Errors:" o con errores menores tipo "ZP scan (departamento) page 2 timeout" en vez de "0 new" total.

## Pending

1. **ZP scan pagination** (task #7): page 2+ timeouts. Probar `rotatePuppeteerProxySession` entre pages, o retry con backoff exponencial.
2. **ML re-enable** (`ML_ENABLED=true` en VPS `.env`): sigue dependiendo del work paused del 04-27. Ahora con stealth puede ser más viable. Decisión de Nico.
3. **Re-enable `enableAssetBlocking`**: lo dejé off para descartar como factor. Volver a habilitarlo (con whitelist más fina si rompe AP iframes) ahorra 4x bandwidth proxy.
4. **`scrape-meli-local.mjs`** (root del repo): script viejo que el LaunchAgent local 8 AM corre, sigue sin proxy. Token refresh ya OK pero los endpoints `/sites/MLA/search` necesitan IP residencial. Considerar deprecar o cablear proxy.

## Memoria actualizada

- `project_brightdata.md` reescrito: BD descartado totalmente (KYC bloquea Scraper API también, no solo Residential Proxy). ProxyEmpire es el único vendor de proxy/anti-bot.

## Resume point para fresh-me

Pipeline está *funcionalmente unblocked* en VPS:
- AP: full pass.
- ZP enrich: full pass.
- ZP scan: page 1 pass (~26 listings/zona/tipo).
- ZP scan pages 2+: pendiente fix (task #7).
- ML: paused.

Los webhooks de #webhooks empezando con la corrida del 2026-05-10 03:00 ARG deberían mostrar el cambio.

Commits clave:
- `2aa6ea7` — disable enableAssetBlocking
- `2c98a37` — extend CF wait 30s
- `5e6bd2b` — manual fingerprint hide (rolled back)
- `418a7a8` — stealth plugin in enrich-zp-puppeteer
- `b1f1064` — stealth applied to scan-zp, scrape-argenprop, scrape-ml-headless
- `7771e1e` — bump networkidle2 timeouts to 60s
