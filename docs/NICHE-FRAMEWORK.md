# Framework de Niches — Definición y Metodología

## Concepto

Un **niche** NO es un filtro fijo (ej: "casas con jardín"). Un niche es la **combinación natural de atributos más frecuentes** dentro de una categoría de precio, filtrada hasta que el grupo resultante represente aproximadamente el **10% del total de la categoría** (o un mínimo de 10-30 propiedades).

Cada categoría de precio tiene su propio niche orgánico. El jardín puede o no ser parte de ese niche — depende de lo que los datos muestren como la combinación más recurrente.

## Regla de Dimensionamiento

- El niche debe contener **mínimo 10 propiedades** (hard floor)
- Idealmente **~30 propiedades** o el **10% de la categoría**, lo que sea mayor
- Se llega al niche combinando filtros progresivamente (keywords, m², barrio, etc.) hasta alcanzar ese tamaño
- Si un filtro adicional reduce el grupo por debajo de 10, se descarta ese filtro

## Proceso de Descubrimiento de Niches

1. Definir categoría de precio (ej: ≤150k, ≤200k)
2. Contar keywords más frecuentes en esa categoría
3. Combinar los top keywords hasta que el grupo resultante sea ~10% del total
4. Esa combinación ES el niche de esa categoría
5. Calcular estadísticas del niche (media, mediana, stddev USD/m²)
6. Rankear propiedades por desviación porcentual vs la media del niche

## Métricas por Propiedad

Cada propiedad en un ranking debe tener:

| Columna | Descripción |
|---|---|
| USD | Precio en dólares |
| EUR | Precio en euros (×0.92) |
| m² total | Superficie total |
| m² cubiertos | Superficie cubierta (informada o estimada al 65%) |
| USD/m² total | Precio dividido superficie total |
| USD/m² cubierto | Precio dividido superficie cubierta |
| EUR/m² total | Idem en euros |
| EUR/m² cubierto | Idem en euros |
| Desv categoría % | Desviación porcentual del USD/m² vs la media de TODA la categoría de precio |
| Desv niche % | Desviación porcentual del USD/m² vs la media del niche (combinación de atributos más frecuentes que da ~10% del total) |

La columna **Desv niche %** es la más valiosa: compara la propiedad contra su competencia directa más refinada.

## Tooltip/Razonamiento

Cada propiedad debe incluir un tooltip que explique:
- A qué niche pertenece (qué combinación de atributos define ese niche)
- Cuántas propiedades tiene el niche (N)
- Cuál es la media USD/m² del niche
- Cuánto se desvía esta propiedad de esa media
- Por qué es una anomalía estadística (o no)

---

## Categorías Definidas

### Categoría A: ≤ USD 200k | ≥ 200m² totales | Con jardín
- **91 casas** en esta categoría
- Media USD/m² total: 630 | Mediana: 624
- Niche = categoría completa (91 ya es ~10% de cheap+mid)

### Categoría B: ≤ USD 150k | ≥ 150m² totales
- **361 casas** en esta categoría
- Media USD/m² total: 647 | Mediana: 638
- Niche con patio/jardín: 236 casas (65% de la categoría, media: 627)

### Próximo paso: descubrir niches orgánicos por categoría
En vez de imponer filtros (jardín, patio), descubrir qué combinación de atributos aparece naturalmente en cada categoría y usarla como niche.

---

## Top 10 — Categoría A (≤200k, ≥200m², jardín)

| # | Barrio | USD | EUR | m² tot | m² cub | USD/m² tot | EUR/m² tot | USD/m² cub | EUR/m² cub | Desv cat% | Desv niche% | Keywords |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | P. Patricios | 115k | 106k | 360 | 234 | 319 | 293 | 491 | 452 | -49% | -49% | jardín, patio, terraza, cochera, parrilla, quincho |
| 2 | San Nicolás | 119k | 109k | 340 | 221 | 350 | 322 | 538 | 495 | -44% | -44% | jardín, cochera, luminosa, suite, lote |
| 3 | V. Lugano | 170k | 156k | 452 | 294 | 376 | 346 | 578 | 532 | -40% | -40% | jardín, patio, quincho, taller, suite, lote |
| 4 | V. Soldati | 120k | 110k | 303 | 197 | 396 | 364 | 609 | 560 | -37% | -37% | jardín, patio, cochera, quincho, escritura, vestidor |
| 5 | V. Lugano | 199k | 183k | 497 | 323 | 400 | 368 | 616 | 567 | -37% | -37% | jardín, patio, cochera, quincho, luminoso, escritura, lote |
| 6 | V. Lugano | 150k | 138k | 370 | 241 | 405 | 373 | 622 | 573 | -36% | -36% | jardín, terraza, cochera, quincho, fondo, lote |
| 7 | Pompeya | 145k | 133k | 350 | 228 | 414 | 381 | 636 | 585 | -34% | -34% | jardín, patio, terraza, cochera, parrilla, refaccionar, suite |
| 8 | Barracas | 109k | 100k | 260 | 169 | 419 | 385 | 645 | 593 | -34% | -34% | jardín, patio, cochera, local, fondo, lote |
| 9 | V. Lugano | 200k | 184k | 464 | 302 | 431 | 397 | 662 | 609 | -32% | -32% | jardín, garage, luminoso, escritura |
| 10 | Pompeya | 200k | 184k | 461 | 300 | 434 | 399 | 667 | 613 | -31% | -31% | jardín, quincho, fondo, lote |

## Top 10 — Categoría B (≤150k, ≥150m²)

| # | Barrio | USD | EUR | m² tot | m² cub | USD/m² tot | EUR/m² tot | USD/m² cub | EUR/m² cub | Desv cat% | Desv niche% | Keywords |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | La Boca | 69k | 63k | 441 | 287 | 156 | 144 | 240 | 221 | -76% | -75% | — |
| 2 | Constitución | 90k | 83k | 350 | 228 | 257 | 236 | 395 | 363 | -60% | -59% | local, lote, oportunidad |
| 3 | P. Patricios | 150k | 138k | 531 | 345 | 282 | 259 | 435 | 400 | -56% | -55% | patio, terraza, cochera, parrilla, quincho, local, lote |
| 4 | Almagro (ML) | 102k | 94k | 335 | 218 | 304 | 280 | 468 | 430 | -53% | -52% | — |
| 5 | P. Patricios | 115k | 106k | 360 | 234 | 319 | 293 | 491 | 452 | -51% | -49% | jardín, patio, terraza, cochera, parrilla, quincho |
| 6 | Pompeya (ML) | 145k | 133k | 447 | 291 | 324 | 298 | 498 | 458 | -50% | -48% | — |
| 7 | Barracas | 85k | 78k | 260 | 169 | 327 | 301 | 503 | 463 | -50% | -48% | terraza, cochera, fondo |
| 8 | Pompeya | 85k | 78k | 250 | 163 | 340 | 313 | 521 | 480 | -47% | -46% | patio, terraza, parrilla, escritura |
| 9 | Pompeya | 120k | 110k | 344 | 224 | 349 | 321 | 536 | 493 | -46% | -44% | terraza, fondo, lote |
| 10 | San Nicolás | 119k | 109k | 340 | 221 | 350 | 322 | 538 | 495 | -46% | -44% | jardín, cochera, luminosa, suite, lote |

---

*Nota: m² cubiertos estimados al 65% del total cuando no viene informado en el listing.*
*EUR/USD: 0.92 (marzo 2026)*
*Última actualización: 20 marzo 2026*
