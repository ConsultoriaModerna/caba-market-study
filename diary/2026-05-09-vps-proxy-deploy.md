# 2026-05-09 — VPS proxy deploy + bug fixes (response to PA task)

## Trigger

PA tasked RE via #task: 5 noches consecutivas (05-may a 09-may) reportando "Completed with errors" en #webhooks. Síntomas: ZP+AP scan 0 new, ZP enrich batch 1 failed, total active estancado en 2654-2655.

## Lectura clave entrando

PA pensó que el origen era el LaunchAgent local de las 02:30. No: ese LaunchAgent (`com.inmofindr.ml-validate`) fue one-shot del 2026-04-28, ya pasado. Las alertas vienen del cron `nightly-update.sh` corriendo en el droplet DigitalOcean a las 06:00 UTC = 03:00 ARG.

## Hallazgos consolidados

1. **VPS sin código del proxy.** Branch en VPS quedó en `dd207c4` (early April). Los commits del 25-abr (`c0741d3` proxy integration, `793c865` budget cap) nunca se deployaron. `.env` del VPS no tenía `RESIDENTIAL_PROXY_URL`. Diary 04-27 lo había marcado como pending pero nunca se hizo.
2. **Local nightly silenciosamente roto** desde antes del proxy work: `node: command not found` (cron PATH no incluye `/opt/homebrew/bin`) + `grep -P` BSD-incompat. 2 noches con brief vacío.
3. **ML token expirado** hace ~12 días → 8 AM `scrape-local.sh` venía abortando.
4. **`undici@^8.1.0` rompe en Node 20** del VPS por `webidl.util.markAsUncloneable` (solo en Node 22+). Pin a `^6.21.0` salva — proxy.mjs solo usa `ProxyAgent` y `setGlobalDispatcher`, ambas estables en 6.x.
5. **3 scripts VPS importaban `puppeteer` (full)**, no `puppeteer-core`. Como el package canonical solo lista `puppeteer-core`, el `npm install` post-deploy los dejaba sin dep. Eran ya scripts que pasan `executablePath: '/usr/bin/google-chrome'`, así que el switch a `puppeteer-core` fue 1-liner cada uno.
6. **`enrich-zp-puppeteer` y `scan-zp-headless` no estaban cableados al proxy.** Solo `scrape-argenprop` y `scrape-ml-headless` lo tenían. Esa es la causa real de "ZP enrich batch 1 failed" + "ZP scan 0 new" en producción — outbound salía por IP del droplet contra Cloudflare.
7. **Bug `DELAY is not defined`** en `enrich-zp-puppeteer.mjs` línea 213 (metadata de `scrape_runs`). Identifier stale post-refactor. Tira al final de cada run.

## Trabajo hecho

### Local (commits ab1c1e0, 30faf5d, 9db7482, e1758bf, 2bc97e6)
- `nightly-local.sh`: PATH export + grep -P → grep -E.
- `package.json`: undici pin `^6.21.0`.
- 3 scripts VPS: `puppeteer` → `puppeteer-core`.
- `enrich-zp-puppeteer.mjs` + `scan-zp-headless.mjs`: import + use de `getPuppeteerProxyArgs`, `authenticatePuppeteerProxy`, `enableAssetBlocking`.
- `enrich-zp-puppeteer.mjs`: `DELAY` → `BASE_DELAY`.

### VPS (104.236.250.126)
- Reset de `package.json`/`package-lock.json` dirty (ya backupeados a `/tmp/*.vps-pre-deploy`).
- `git pull` → HEAD ahora en `2bc97e6`.
- `npm install` → `undici@6.21.x`, `puppeteer-core@24.x`, `@anthropic-ai/sdk` instalados.
- `.env` actualizado: agregadas `RESIDENTIAL_PROXY_URL` y `PROXYEMPIRE_API_KEY`.
- `.chrome-profile` limpiado (cookies viejas atadas a IP del droplet).
- `scripts/test-proxy.mjs` desde el VPS: 6/6 verde. Outbound IP=186.139.82.236 AS7303 Telecom Argentina (residencial AR).

### ML token
- Refrescado vía proxy desde local (commit 9d7a15f del 25-abr ya hace eso). 21600s nuevos.

## Smoke tests post-deploy (resultados mixtos)

### ZP enrich (5 listings)
- Cloudflare warmup en homepage: ✅ pass.
- 5/5 property pages: ❌ CF challenges. Mismo patrón que ML 04-27 (fingerprinting más allá de IP+cookies).
- Tras fix de DELAY, el script ya no fatal-error al final.

### AP scan (3 pages)
- Navigation timeout 30000ms en Capital Federal page 1.
- "Navigating frame was detached" en pages 2-3.
- Hipótesis: `enableAssetBlocking` (request interception block stylesheet/image/media/font) choca con iframes de AP. Probar sin asset blocking primero.

### Conclusión smokes
Proxy en sí funciona (test-proxy.mjs 6/6, homepages OK). El problema ahora son las property pages individuales — anti-bot dinámico. Misma familia de calibración que el trabajo del 04-27 con ML (rotate session, warmup browse, ajustar fingerprint).

## Predicción para cron 03:00 ARG del 2026-05-10

- Scripts no van a romper por config (proxy ok, undici ok, deps ok).
- ZP enrich va a fallar en CF challenges → "ZP enrich batch X failed" persiste.
- AP scan va a fallar en timeouts/frames → "AP scan failed" persiste.
- Webhook "Completed with errors" sigue.
- Mejora vs antes: ahora los errores son *anti-bot* documentables, no *config* invisible. Próxima sesión puede atacar el problema real.

## Pending al cerrar

1. **Calibrar anti-bot ZP property pages** (task #6 abierta). Aproximaciones:
   - Quitar `enableAssetBlocking` en enrich-zp para descartar request interception como factor.
   - Re-seed Cloudflare cookies vía VNC con proxy activo (`scripts/vps/seed-cloudflare.sh`).
   - Per-page rotación de sticky session (función `rotatePuppeteerProxySession` ya existe).
   - Warmup browse pattern: home → search results → property (no jump directo a `/propiedades/casa-X.html`).

2. **AP scan stability**: probar sin `enableAssetBlocking` o con whitelist más fina. Revisar si selectores cambiaron.

3. **ML re-enable**: `ML_ENABLED=false` en VPS `.env`. Decisión de Nico cuándo re-activar (depende de si el rotation work del 04-27 está confiable).

4. **ProxyEmpire usage script**: sigue bloqueado en endpoint público (diary 04-27 líneas 80-87). Necesito Nico saque path desde DevTools.

5. **Fix temporal sugerido si Nico quiere acallar las webhooks ya:** cambiar el cron del VPS a un runner que solo corre dead-listing-check (paso que sí funciona) hasta que terminemos calibración. Trade-off: perdés churn detection + price drops.

## Resume point para fresh-me

VPS está en estado funcional para que la *infraestructura* (proxy, deps, scripts) corra sin errors de config. Lo que falta es calibración anti-bot a nivel sitio. Cualquier sesión próxima debe arrancar leyendo este diary + el de 04-27, y tener claro que el problema central es el cat-and-mouse con Cloudflare/CloudFront, no infra.

VPS ssh: `ssh root@104.236.250.126`. Key: `~/.ssh/id_ed25519`. Cron en `crontab -l`. Logs en `/var/log/caba-nightly.log`.

Backup de los `package.json` originales del VPS (pre-deploy) en `/tmp/package.json.vps-pre-deploy` y `/tmp/package-lock.json.vps-pre-deploy` en el droplet, por si hace falta rollback.
