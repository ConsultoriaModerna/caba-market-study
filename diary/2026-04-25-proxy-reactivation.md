# 2026-04-25 — Reactivation: residential proxy + ML/ZP/AP unblock

## Context entering session

Pipeline de scraping estaba parado:
- ML API: 403 PolicyAgent global (lockdown abril 2025, IPs no residenciales bloqueadas).
- ZP: Cloudflare bloqueando.
- AP: CloudFront bloqueando.
- Bright Data KYC rechazado el 2026-04-06 — no había proxy residencial AR funcional.
- DB: 0 ML active, 315 AP active, 2,126 ZP active. ML totalmente inactivado por falta de re-scrape.

Dashboard (frontend Vercel) seguía evolucionando (sidebar colapsable, filter bar, density 2D, treemap labels) pero sin nueva data ingresando.

## Decisiones tomadas

1. **Provider:** ProxyEmpire residential PAYG ($3.50/GB, sin compromiso mensual).
   - Descartado SOAX por mínimo $90/mes.
   - Descartado Bright Data por KYC rechazado + mínimo alto.
   - Bright Data Scraper API ZP queda como **fallback** si anti-bot nos derrota.
2. **Bright Data Scraper API (ZP, $1.5/1K records, KYC light)** evaluado pero pospuesto. Año 1 DIY proxy ~$21 vs hybrid BD ~$95.
3. **Asset blocking en ZP/AP** vía Puppeteer setRequestInterception → 4x menos bandwidth.
4. **Bigger ML scope NO aplicar ahora** — current scope cubre `/items/{id}/description` que es lo único que necesitamos. Aplicar cuando `project_bi_vision` (perfilar inmobiliarias) sea milestone.

## Trabajo hecho

### Branch 1: feat/residential-proxy-integration → main (commit 9d7a15f)
- `scripts/lib/proxy.mjs`: helper único (applyFetchProxy, getPuppeteerProxyArgs, authenticatePuppeteerProxy, enableAssetBlocking).
- Integrado en: enrich-ml-details.mjs, vps/scrape-ml-headless.mjs, enrich-zp-cdp.mjs, vps/scrape-argenprop.mjs, refresh-ml-token.mjs.
- `scripts/test-proxy.mjs`: smoke test (IP country, ASN check, ML API 200, ZP/AP HTML).
- `.env.example` documenta `RESIDENTIAL_PROXY_URL`.
- Deps: undici@^8.1.0, @supabase/supabase-js@^2.104.1, puppeteer-core (instalado en sesión).

### Branch 2: feat/proxy-budget-cap → main (commit 793c865)
- Budget cap en proxy.mjs: incrementBudget(label) + logBudgetSummary() + getBudgetStatus().
- Default cap 5000 requests/process, override con PROXY_MAX_REQUESTS env.
- Soft warn 80%, hard abort exit code 2 al exceder.
- Cableado en los 5 scripts. Cada uno usa label distinto (ml-description, zp-listing, ml-search-page, ap-search-page, ml-oauth-refresh).

### Smoke test ProxyEmpire
- Trial 100 MB activo. Endpoint v2.proxyempire.io:5000 con sticky session vía sid.
- Validado:
  - IP de salida 190.105.75.122, AS27984 Ver TV S.A. (José C. Paz).
  - Country=AR, ASN residencial real (cable TV).
  - ML /oauth/token: 200 (token refrescado vía proxy).
  - ML /items/{id}/description: 200 con texto real.
  - ZP homepage: 200 sin Cloudflare challenge.
  - AP homepage: 200.
- 6/6 checks pasaron. Endpoints `/sites/MLA/search` y `/items/{id}` siguen 403 pero es scope del token "Buscador", no problema de IP.

## Hallazgos de DB (estado real entrando a smoke #2)

```
                  total    active    sin description    unenriched
  mercadolibre    2,878        0                 0             0
  argenprop       2,682      315               315           315
  zonaprop        6,944    2,126             2,054           840
```

**ML está 100% inactivo** — el job de discovery lleva tantos días parado que todas las propiedades se marcaron `is_active=false`. **El paso correcto NO es enriquecer ML primero; es re-descubrir.** Ejecutar `vps/scrape-ml-headless.mjs` para repopular active.

## Cambios para correr ML scraper desde Mac (sesión actual)

`scripts/vps/scrape-ml-headless.mjs` reescrito como cross-platform:
- `os.platform()` detecta Mac vs Linux.
- Mac: Chrome path `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`, profile en `~/.cache/caba-ml-chrome-profile`, ventana `--start-minimized`.
- Linux/VPS: paths originales `/usr/bin/google-chrome`, `/opt/caba-market-study/.chrome-profile-ml`, sin `--start-minimized` (Xvfb).
- Switch de `puppeteer` (full, descarga Chromium) a `puppeteer-core` (usa Chrome del sistema). Más liviano, ya hay Chrome instalado.

## Defensa en profundidad: budget caps

Implementados ambos lados:
- **Code-side:** `PROXY_MAX_REQUESTS` con abort hard.
- **Dashboard-side:** ProxyEmpire **NO soporta spending limit** (verificado en su panel Subscriptions). Mitigation: keep auto-top-up OFF, comprar en porciones de $3.50 (1 GB) cuando se agote.
- **Memory-side:** `feedback_budget_caps.md` registra el patrón cross-service para próximas integraciones (OpenAI, Maps, Supabase, etc).
- **PA tasked:** posted a `#task` Slack pidiendo monitor centralizado en My Central — link a la propuesta + reference al commit.

## Lección operativa

ML lockdown desde abril 2025 es **estructural**: no hay vuelta atrás a IP datacenter. Todas las recurrencias automatizadas (incluyendo nightly cron en VPS) van a depender del proxy residencial de ahora en más. Eso convierte al proxy en componente crítico, no opcional. Por eso la inversión en doble límite (code + manual top-up) y por eso el monitor centralizado en My Central.

## Pending al cerrar sesión

1. Nico resetea Chrome (cierra todas las instancias, reabre, refresca cookies de ZP y ML, cierra de nuevo).
2. Smoke test #2 ML discovery: 1 página de casas Capital Federal vía proxy, validar que aparecen rows nuevos en `properties` con `source='mercadolibre'`, `is_active=true`.
3. Si OK → escalar a 5 páginas, después nightly en VPS.
4. Después: smoke test ZP enrichment con cap de 20 listings.
5. Eventualmente: deploy del branch a VPS (`git pull` + `npm install` + actualizar `.env` con `RESIDENTIAL_PROXY_URL`), correr `scripts/test-proxy.mjs` desde allá, activar `ML_ENABLED=true` en `vps/run-nightly.sh`.

---

## Update post-pausa (Nico reinicia computadora)

### Concern arquitectónico que detectó Nico — cookie/IP mismatch

Nico señaló: si abre Chrome regular para "warmup" de cookies (visitar ZP/ML antes de correr el smoke), ese Chrome sale por su IP real (España, no AR), entonces las cookies quedan atadas a sesión española. Cuando después Puppeteer las copia y navega vía proxy AR, hay mismatch IP+cookie+TLS fingerprint → riesgo de quemar la sesión / cookie en Cloudflare.

**Dictamen:** correcto, pero solo aplica al flow de `enrich-zp-cdp.mjs` (que copia profile real). Para el smoke ML que vamos a correr ahora **no aplica**, porque `vps/scrape-ml-headless.mjs` usa profile vacío en `~/.cache/caba-ml-chrome-profile` y Puppeteer genera cookies desde cero a través del proxy AR. No hay mismatch.

**Aclaración importante para fresh-me:** el proxy NO es system-wide. Solo afecta al Chrome que Puppeteer lanza con `--proxy-server=`. El Chrome regular del usuario sale por su IP real (España actualmente). curl/fetch del shell también. Solo los scripts vía nuestro `proxy.mjs` helper rutean por AR.

### Instrucciones corregidas que le pasé a Nico

**OLVIDAR el "warmup manual de Chrome" que sugerí antes (era pensado para enrich-zp-cdp).** Para el smoke ML solo necesita:

```bash
# 1. Cerrar Chrome
osascript -e 'quit app "Google Chrome"' 2>/dev/null
sleep 2; killall "Google Chrome" 2>/dev/null; echo ok

# 2. Limpiar profile temp del scraper (opcional pero recomendado en primer run)
rm -rf "$HOME/.cache/caba-ml-chrome-profile"

# 3. Correr smoke (1 página = ~48 listings ML, casas Capital Federal)
cd /Users/nico/AI/PROJECTS/real-estate
git pull origin main
set -a && source .env && set +a
PROXY_MAX_REQUESTS=20 node scripts/vps/scrape-ml-headless.mjs 1 --zone=caba --type=casa
```

### TODO pendiente que se generó en esta tanda

**[BLOQUEO ARQUITECTÓNICO ZP]** Antes de correr smoke ZP enrichment, hay que decidir:
- **Opción A (preferida):** modificar `enrich-zp-cdp.mjs` para NO copiar cookies del Chrome real. Que Puppeteer pase Cloudflare por sí mismo desde IP AR (puede tomar 10-30s la primera vez, después cookies van a `/tmp/zp-chrome-profile` y se reusan en runs siguientes).
- **Opción B:** crear `scripts/warmup-zp-via-proxy.mjs` que abre ZP via Puppeteer+proxy una vez, deja cookies en el profile temp. Después `enrich-zp-cdp.mjs` reusa.

A no ser que Nico tenga preferencia, **arrancar con A** cuando llegue el momento.

### Resume point para fresh-me

**Estado al pausar (Nico va a reiniciar su Mac y relanzar Claude Code):**

- Branch `main` al commit `00990ea` (cross-platform ML scraper + diary inicial).
- `.env` tiene `RESIDENTIAL_PROXY_URL` con credenciales ProxyEmpire trial (100 MB, AR sticky session). VERIFICADO funciona: AS27984 Ver TV S.A.
- ML token fresh (refrescado ~30min atrás vía proxy, 6h TTL).
- Smoke test #1 (cap mechanism) ya validado por test inline.
- Smoke test #2 (ML discovery con 1 página CABA casas) **listo para correr, esperando que Nico reinicie y lance el comando**.

**Cuando vuelva Nico con output:**
1. Revisar exit code y logs.
2. Verificar en Supabase: `SELECT count(*) FROM properties WHERE source='mercadolibre' AND is_active=true AND last_seen_at > NOW() - INTERVAL '1 hour';` debería ser ~48.
3. Verificar bandwidth en ProxyEmpire dashboard (esperado: ~5-10 MB para 1 página completa con assets).
4. Si OK → smoke #3 con 5 páginas, después decidir si seguimos en local o pasamos a VPS.
5. Si falla → diagnosticar (captcha, selectores cambiados, proxy timeout, etc) antes de escalar.

**Cuando volvamos a tocar ZP:** primero resolver el bloqueo arquitectónico (ver TODO arriba). NO correr `enrich-zp-cdp.mjs` con cookies copiadas del Chrome España.
