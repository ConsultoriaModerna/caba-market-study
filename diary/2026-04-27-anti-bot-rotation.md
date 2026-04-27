# 2026-04-27 — ML anti-bot rotation investigation (WIP, paused)

## Quick context for fresh-me

Sesión arrancó preguntando "¿qué teníamos?". Diary previo (2026-04-25) cerraba con smoke #2 listo para correr. Lo corrimos hoy → 48 listings OK. Después smoke #3 con 5 páginas → falló raro: `Page 3: no results` y stop. Yo dije equivocado "ML CABA solo tiene 96 casas". Nico (con razón) preguntó si era posible.

**Verificación directa: ML reporta 4,588 casas activas en CABA.** El "no results" del scraper era un bug.

## Lo descubierto

Con debug logging metido en el path `count=0`, el siguiente run mostró que página 3 NO está vacía — ML redirige a:

```
https://www.mercadolibre.com.ar/gz/account-verification?go=...
"¡Hola! Para continuar, ingresa a tu cuenta"
```

Es un anti-bot challenge. Threshold determinado experimentalmente: **2 search-page hits por sesión IP+cookies** dispara el challenge.

## Lo intentado en orden

1. `enableAssetBlocking({ blockTypes: ['image','media','font','stylesheet'] })` — rompió el render (bodyLen 358). Quitado.
2. `enableAssetBlocking({ blockTypes: ['image','media','font'] })` — sigue rompiendo (bodyLen 262). Quitado.
3. `domcontentloaded` en search pages — page 1 vacía. Revertido a `networkidle2`.
4. Profile sucio entre runs → limpiar profile antes de cada run = page 1 funciona.
5. **Rotar sticky session ID en ProxyEmpire** vía `rotatePuppeteerProxySession()` (cambia `sid-XXXX` en username). Solo: page 4 sigue fallando.
6. Rotar + clear cookies/cache vía CDP. Mejor: pages 1-2-3 OK, page 4 falla.
7. Rotar + clear cookies, sin warmup hit en cada rotation: same behavior, page 4 falla.

Patrón confirmado: cualquier sesión (IP+cookies) tolera **exactamente 2 hits a páginas de search**. Tercer hit = challenge.

## Estado del código (commit dc8b74e)

- `proxy.mjs`: nueva función `rotatePuppeteerProxySession(page)` exportada.
- `scrape-ml-headless.mjs`:
  - `DELAY_MS = 8000` (era 4000).
  - `ROTATE_EVERY = 1` (rotar antes de cada página — pending validación).
  - Search page goto: `networkidle2`, timeout 45s.
  - Warmup inicial: `domcontentloaded`, 30s.
  - Rotación: `rotatePuppeteerProxySession` + `Network.clearBrowserCookies` + `Network.clearBrowserCache` vía CDP.
  - Diagnóstico en path `count=0`: título, URL, primeros 400 chars del body.
  - Retry once en `count=0` si DOM tiene items pero extractor falló.

## Próximo paso al volver

**Validar `ROTATE_EVERY = 1`** corriendo el smoke con 5 páginas:

```bash
osascript -e 'quit app "Google Chrome"' 2>/dev/null; sleep 2; killall "Google Chrome" 2>/dev/null
rm -rf "$HOME/.cache/caba-ml-chrome-profile"
cd /Users/nico/AI/PROJECTS/real-estate
git pull origin main
set -a && source .env && set +a
PROXY_MAX_REQUESTS=200 node scripts/vps/scrape-ml-headless.mjs 5 --zone=caba --type=casa
```

Resultados esperados:
- Si `ROTATE_EVERY=1` funciona: 5 páginas × 48 = ~240 listings. 5/200 fetch budget. ~25 MB bandwidth.
- Si NO funciona: ML está fingerprinting más allá de IP+cookies (TLS, headers, viewport). Próximo paso sería relaunch del browser entero entre páginas.

## Cost trade-off pendiente decisión Nico

A 5 MB / página y 96 páginas para inventario completo CABA casas = **480 MB** = casi 5x el trial 100 MB de ProxyEmpire.

Opciones:
- **A.** Top-up trial con 1 GB ($3.50 PAYG) → cubre run completo + margen. Sin compromiso.
- **B.** Snapshot parcial (primeras 20 páginas = 960 listings = ~100 MB). Sub-óptimo pero gratis con el trial.
- **C.** Mover a VPS y correr 1 página por día como nightly (96 días para inventario completo, 5 MB/día = 150 MB/mes). Trial alcanza 20 días.

Memory `feedback_budget_caps.md` aplica — necesitamos cap dual (code + dashboard) antes de top-up. ProxyEmpire dashboard NO tiene spending limit, así que el cap es manual: comprar en porciones de $3.50 cuando se agote.

## Manual browsing safety

Nico preguntó si podía abrir ML manualmente desde su Spain VPN. Respuesta: **sí, no afecta al scraper**. Browser regular sale por su IP real, es un proceso separado. Solo los scripts que usan `proxy.mjs` rutean por AR. Cookies y sesiones aisladas.

Confirmado funcional: durante esta sesión Nico abrió ML en su Chrome regular (España) y nuestro scraper siguió funcionando vía proxy AR sin problemas.

## ProxyEmpire API token

Nico pasó token `OMz7iXmQoMsqaA9qWuxm0i6LQ0aVTwJE7X6yOqPr` (en `.env` como `PROXYEMPIRE_API_KEY`, en `.env.example` como placeholder). Pero los endpoints públicos no están documentados. Probé con curl muchas combinaciones — `api.proxyempire.io` no resuelve, `panel.proxyempire.io/api/*` da 404, `/openapi.json` y `/swagger.json` existen pero 403. Cloudflare challenge en panel root.

**Bloqueado.** Necesitamos que Nico:
1. Saque el endpoint de la página donde se crea el token (suele tener curl example).
2. O abra DevTools en panel logueado y tome el path desde Network tab.
3. O pregunte al chat 24/7 de ProxyEmpire.

Una vez con el endpoint, son 30 min: `getProxyUsage()` en proxy.mjs + script CLI thin + handoff a PA vía Slack #task para integrar en My Central spend tracking.

## Otros TODOs vivos

- AP unblock — 315 listings sin description, proxy AR debería pasar el CloudFront block (smoke #1 mostró HTML 200). Independiente del problema actual de ML rate limits.
- ZP refactor — todavía bloqueado por cookie/IP mismatch en `enrich-zp-cdp.mjs`. Aplicar Opción A del diary anterior cuando llegue el momento.
- VPS deploy — pasar el scraper validado a DigitalOcean nightly cron. Una vez ML rotation esté verde y AP funcione.

## Feature shipped (verde)

`feat: novedades banner — "X casas nuevas desde tu última visita"` (commit bc0531f). Vercel debería estar live. Banner aparece bajo la barra de filtros globales en index.html, hidden por default, visible si `inmofindrIsNewProp` cuenta > 0.
