# Estudio de Mercado CABA — Casas en Venta
## Análisis Completo | Marzo 2026

### Dataset
- **6,489 casas** (4,570 ZonaProp + 1,919 MercadoLibre)
- **6,019 activas** (470 PHs excluidos)
- **80 barrios** cubiertos
- Datos scrapeados el 19 de marzo de 2026

---

## Metodología Corregida: Precio × Estado como Ejes Independientes

El primer approach mezclaba segmentos de precio (cheap ≤150k) con segmentos de estado (refaccionar, reciclada). Esto es incorrecto porque una casa puede ser barata Y reciclada, o cara Y a refaccionar. Son dimensiones independientes.

**Clasificación de estado** (basada en keywords extraídos de descripciones):
- **A refaccionar**: descripción contiene "refaccionar"
- **Reciclada**: descripción contiene "reciclada" o "reciclado"
- **A estrenar**: descripción contiene "a estrenar"
- **Sin clasificar**: no menciona estado explícitamente (~75% del dataset)

**Rangos de precio**: 0-100k | 100-150k | 150-200k | 200-300k | 300k+

---

## Estadísticas Globales por Segmento de Estado

| Métrica | A refaccionar (377) | Reciclada (312) | Sin clasificar (5,126) |
|---|---|---|---|
| Media USD/m² | 1,243 | 1,839 | — |
| Mediana USD/m² | 1,086 | 1,521 | — |
| Desviación std | 600 | 1,190 | — |
| CV (dispersión) | 48% | 65% | — |
| Q1 (percentil 25) | 833 | 1,130 | — |
| Q3 (percentil 75) | 1,475 | 2,077 | — |

**Gap en medianas (refac → recic): +40%**
Este es el número más conservador y realista.

---

## Matriz Precio × Estado (Mediana USD/m²)

Controlando por rango de precio, el gap real se modera:

| Rango de precio | Refaccionar (mediana USD/m²) | N refac | Reciclada (mediana USD/m²) | N recic | Gap % |
|---|---|---|---|---|---|
| 0-100k USD | 597 | 24 | — | — | — |
| 100-150k USD | 759 | 83 | 944 | 13 | +24% |
| 150-200k USD | 881 | 89 | 1,069 | 34 | +21% |
| 200-300k USD | 1,207 | 94 | 1,361 | 93 | +13% |
| 300k+ USD | 1,401 | 87 | 1,737 | 172 | +24% |

**Conclusión clave**: El gap refac→recic controlado por precio es **13-24%**, no 50-100% como sugería el análisis cruzado. Aún así, un 21-24% de upside post-renovación es sólido.

---

## Análisis por Barrio — Tu Universo (≤200k, ≥120m², con patio/jardín)

784 casas cumplen estos criterios. Estadísticas con mediana y dispersión:

| Barrio | N | Media USD | Mediana USD | σ precio | USD/m² media | USD/m² mediana | σ USD/m² | Dispersión% | Sesgo% |
|---|---|---|---|---|---|---|---|---|---|
| Villa Lugano | 115 | 153k | 154k | 31k | 747 | 699 | 273 | 37% | -0.5% |
| Pompeya | 68 | 138k | 137k | 35k | 647 | 639 | 185 | 29% | +0.8% |
| Liniers | 66 | 166k | 170k | 25k | 1,014 | 1,016 | 216 | 21% | -2.5% |
| Mataderos | 61 | 152k | 150k | 31k | 767 | 732 | 281 | 37% | +1.6% |
| Flores | 51 | 161k | 160k | 28k | 885 | 828 | 241 | 27% | +0.8% |
| Barracas | 43 | 144k | 140k | 37k | 718 | 667 | 214 | 30% | +3.0% |
| Parque Chacabuco | 42 | 165k | 177k | 29k | 895 | 849 | 248 | 28% | -6.8% |
| Villa Soldati | 38 | 138k | 137k | 33k | 656 | 579 | 244 | 37% | +0.2% |
| Parque Avellaneda | 37 | 158k | 165k | 29k | 828 | 792 | 229 | 28% | -4.6% |
| Parque Patricios | 30 | 154k | 150k | 24k | 754 | 731 | 197 | 26% | +3.0% |
| Floresta | 18 | 162k | 167k | 25k | 794 | 744 | 232 | 29% | -2.9% |
| Villa Luro | 15 | 182k | 185k | 14k | 905 | 857 | 169 | 19% | -1.8% |
| Villa Devoto | 13 | 181k | 189k | 15k | 1,063 | 1,063 | 175 | 16% | -4.5% |

**Lectura de la dispersión**:
- Villa Lugano, Mataderos, Villa Soldati: CV 37% → mucha dispersión → más chance de encontrar outliers baratos
- Liniers, Villa Luro, Villa Devoto: CV 16-21% → precios más homogéneos → menos sorpresas
- Barracas: sesgo +3% (media > mediana) → hay casas caras tirando la media para arriba, la mediana es tu referencia real

---

## Detección de Outliers Estadísticos (Z-Score)

Identificamos propiedades cuyo USD/m² está >1 desviación estándar por debajo de la media de su barrio. Estas son anomalías estadísticas reales, no simplemente "baratas porque el barrio es barato".

Un Z-score de 2.0 = propiedad 2 desviaciones estándar bajo la media del barrio.

### Top 5 Mejores Oportunidades (Z-Score más alto)

1. **Parque Patricios** — USD 150,000 (€138,000) — 531m² — USD 282/m² (€259/m²)
   - Z-score: 2.00 | 71% bajo media del barrio
   - 6 amb, patio, terraza, cochera, parrilla, quincho, local, lote propio
   - Zona Distrito Tecnológico en reconversión
   - [Link ZonaProp](https://www.zonaprop.com.ar/propiedades/clasificado/veclcain-casa-multifamiliar-6-amb.-c-local-patios-terraza-52810216.html)

2. **Parque Patricios** — USD 115,000 (€105,800) — 360m² — USD 319/m² (€293/m²)
   - Z-score: 1.90 | 68% bajo media del barrio
   - Jardín, patio, terraza, cochera, parrilla, quincho, oportunidad
   - [Link ZonaProp](https://www.zonaprop.com.ar/propiedades/clasificado/veclcain-casa-venta-56921049.html)

3. **Liniers** — USD 150,000 (€138,000) — 279m² — USD 538/m² (€495/m²)
   - Z-score: 1.83 | 58% bajo media del barrio
   - 5 amb, patio, terraza, cochera, quincho, a refaccionar, con escritura
   - [Link ZonaProp](https://www.zonaprop.com.ar/propiedades/clasificado/veclcain-venta-casa-5-ambientes-patio-terraza-liniers-58596131.html)

4. **Liniers** — USD 180,000 (€165,600) — 320m² — USD 563/m² (€518/m²)
   - Z-score: 1.77 | 56% bajo media del barrio
   - 7 amb, patio, terraza, cochera, parrilla, lote propio, lavadero
   - [Link ZonaProp](https://www.zonaprop.com.ar/propiedades/clasificado/veclcain-casa-7-ambientes-c-cochera-para-2-autos-ideal-2-52128679.html)

5. **Vélez Sarsfield** — USD 180,000 (€165,600) — 371m² — USD 485/m² (€446/m²)
   - Z-score: 1.67 | 61% bajo media del barrio
   - 4 amb, patio, terraza, suite, vestidor, escritura, lote propio
   - [Link ZonaProp](https://www.zonaprop.com.ar/propiedades/clasificado/veclcain-venta-casa-4-amb-con-2-locales-velez-sarfield-58597432.html)

---

## Tesis de Inversión

### Perfil del inversor
No busca flip profesional de 5 años. Busca casa para vivir con estudio/sala de producción musical, renovada por equipo contratado (no mano de obra propia). Presupuesto total ≤ 200k USD.

### Estrategia recomendada
- **Compra**: casa a refaccionar o sin clasificar en rango 100-180k USD
- **Renovación**: USD 300-500/m² con equipo contratado (30-50k USD total)
- **Inversión total**: 130-230k USD (120-212k EUR)
- **Upside post-reno**: 21-24% en USD/m² (basado en gap controlado por precio)
- **Valor post-renovación estimado**: 160-280k USD dependiendo del barrio

### Barrios recomendados para este perfil
1. **Parque Patricios**: gap 37% en el barrio, Distrito Tecnológico en reconversión, mucho stock ≤150k
2. **Floresta**: gap 50%, precios de entrada bajos (95-170k), casas con lote propio
3. **Parque Chacabuco**: gap 23%, bien conectado, stock variado
4. **Liniers**: dispersión baja (21%), precios predecibles, buenas oportunidades estadísticas
5. **Flores**: gran volumen (51 casas en filtro), barrio consolidado

### Factores críticos
- Lote propio (evitar PH y consorcios)
- Escritura al día
- Espacio suficiente para estudio (≥200m² total preferible)
- Acceso a transporte (subte, colectivos)
- Zona con catalizadores de valorización (reconversión urbana, nuevo subte, desarrollo comercial)

---

## Próximos pasos
- [ ] Re-autorizar API MercadoLibre para datos enriquecidos (fotos, contactos)
- [ ] Automatizar scraping semanal con Edge Function
- [ ] Detectar bajadas de precio (price_snapshots)
- [ ] Sistema de contacto automatizado (10 propietarios/día)
- [ ] Cruzar con datos de Google Maps (infraestructura, transporte)

---

*Generado por Consultoría Moderna | Marzo 2026*
*Dataset: 6,489 casas | Supabase project: ysynltkotzizayjtoujf*
*Dashboard: https://caba-market-study.vercel.app*
