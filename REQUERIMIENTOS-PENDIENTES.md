# Real Estate CABA — Requerimientos Pendientes

> Capturados el 20/03/2026 desde chat anterior (excedido por longitud)

---

## 1. % Cubierto sobre m² totales
- **Qué:** Columna calculada `ratio_cubierto = m2_cubiertos / m2_totales`
- **Dónde se muestra:** Debajo de m² totales (NO de m² cubiertos)
- **Para qué:** Filtrar propiedades por proporción cubierto/descubierto
- **Criterio general:** Se busca que al menos un 20% sea descubierto
- **Implementar en:** Supabase (columna generada o calculada) + Dashboard
- **Estado:** ✅ Columna `covered_ratio` ya existe como generated column en Supabase. Falta: mostrar en dashboard + agregar filtro. Blocker: solo 21 props (ML) tienen covered_area — necesita scraping de fichas individuales ZP

## 2. Gráficos D3.js + Planetarios
- **Qué:** Migrar/complementar las visualizaciones actuales (Chart.js) con D3.js
- **Tipo:** Gráficos planetarios (bubble charts, radial layouts, force-directed)
- **Para qué:** Visualizaciones más ricas e interactivas de barrios, precios, distribuciones

## 3. %Gap intra-gráfico en USD/m² por estado
- **Qué:** En el gráfico de USD/m² promedio por estado de conservación, anotar el delta % entre categorías
- **Ejemplo:** A Refaccionar (USD 1,200/m²) → Reciclado (USD 1,800/m²) = **+50%**
- **Para qué:** Visualizar de un vistazo cuánto es "ganable" al cambiar de estado

## 4. Calculadora de inversión máxima
- **Qué:** Dado el %gap entre estados, recomendar el tope invertible
- **Desglose:** Materia prima + Mano de obra (propia)
- **Lógica:** Factor de seguridad sobre el gap bruto
  - Ejemplo: Gap = 50% → Inversión máxima recomendada = ~30% del valor original
  - El resto queda como margen de ganancia neto
- **Parámetros configurables:** % seguridad, split materia prima / mano de obra

## 5. Página Notion — Real Estate Buenos Aires
- **Dónde:** Life HQ > Finanzas Personales
- **Estado:** ✅ Creada: https://www.notion.so/3299e132767d8193a5bbc88c6daf86a7

## 6. Carpeta local del proyecto
- **Estado:** ✅ Creada en `~/AI/PROJECTS/real-estate`

---

> **Próximos pasos:** Priorizar e implementar en orden.

---

## Trabajo realizado — 24 marzo 2026 (sesión nocturna)

### Data Quality
- **ML descriptions enrichment** — Script `scripts/enrich-ml-details.mjs` enriquece ~2,800 props ML via API `/items/{id}/description`. Batch running, ~99.9% hit rate
- **ZP descriptions cleanup** — 3,663 descripciones ZP eran basura JS del page scrape. Nulleadas. Solo 65 ZP tienen descripción real
- **Outliers limpiados** — 51 props con total_area > 2,000m² nulleadas (max era 3.5M m²)
- **price_per_sqm recalculado** para props que lo tenían en 0

### Hallazgos de data quality

| Campo | ZonaProp (4,556) | MercadoLibre (2,878) |
|---|---|---|
| Descripción | 65 (1.4%) — necesita scraping individual | ~2,800 (97%) — via API |
| GPS | 1,246 (27%) | 1 (0%) — API no devuelve coords |
| Covered area | 0 (0%) — necesita scraping individual | 21 (0.7%) |

### Bloqueantes identificados
- **ZonaProp anti-bot (Cloudflare)** — No se puede scraper programáticamente (ni curl, ni Puppeteer headless, ni stealth). Requiere sesión Chrome manual o explorar API interna
- **ML /items/{id} endpoint devuelve 403** — Token actual no tiene scope suficiente. Solo /items/{id}/description funciona
- **covered_area casi inexistente** — El Req #1 (ratio cubierto) depende de scraping individual de fichas ZP

### Scripts creados
- `scripts/enrich-ml-details.mjs` — Enrichment de descripciones ML via API
- `scripts/enrich-ml-all.sh` — Wrapper que corre enrichment en batches hasta completar
- `scripts/cleanup-and-enrich.mjs` — Limpieza ZP + outliers + derived fields
- `scripts/overnight-pipeline.sh` — Pipeline maestro
