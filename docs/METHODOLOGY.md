# Metodología de Análisis

## Fuentes de datos
- **ZonaProp**: scraping DOM via fetch+DOMParser desde Chrome (4,570 propiedades, ~260 páginas)
- **MercadoLibre**: scraping DOM via fetch+DOMParser desde Chrome (1,919 propiedades, ~40 páginas)
- Fecha de extracción: 19 de marzo de 2026

## Selectores DOM utilizados
### ZonaProp
- Cards: `[data-qa="posting PROPERTY"]`
- Precio: `[data-qa="POSTING_CARD_PRICE"]`
- Features: `[data-qa="POSTING_CARD_FEATURES"]`
- Ubicación: `[data-qa="POSTING_CARD_LOCATION"]`
- Descripción: `[data-qa="POSTING_CARD_DESCRIPTION"]`
- Link: `a[href*="/propiedades/"]`

### MercadoLibre
- Cards: `.ui-search-layout__item`
- Precio: `.andes-money-amount__fraction`
- Moneda: `.andes-money-amount__currency-symbol`
- Link: `a[href*="mercadolibre"]`

## Extracción de keywords
38 keywords inmobiliarias en español extraídas de las descripciones:
- Exterior: jardín, patio, terraza, balcón, pileta, parrilla, quincho, pérgola, galería, solarium, deck, fondo, contrafrente
- Estacionamiento: garage, cochera
- Interior: suite, vestidor, lavadero, altillo, entrepiso, sótano
- Cualidad: luminoso/a, amplio/a
- Estructura: lote, PH, planta baja, planta alta
- Comercial: local, comercio, taller, depósito, apto profesional
- Estado: refaccionar, reciclada/o, a estrenar, oportunidad, retasada
- Legal/Servicios: escritura, apto crédito, gas natural, cloacas

## Clasificación de estado (independiente del precio)
- **A refaccionar**: keyword 'refaccionar' present OR slug contains 'refaccionar'
- **Reciclada**: keyword 'reciclada' OR 'reciclado' present OR slug contains 'reciclad'
- **A estrenar**: keyword 'a estrenar' present OR slug contains 'estrenar'
- **Sin clasificar**: ninguno de los anteriores (~75% del dataset)

## Detección de outliers
Z-score por barrio: `(media_barrio - precio_propiedad) / stddev_barrio`
Se requiere ≥10 propiedades en el barrio para calcular estadísticas confiables.
Outlier = Z-score > 1.0 (más de 1 desviación estándar bajo la media)

## Conversión EUR/USD
Tasa utilizada: 1 USD = 0.92 EUR (aproximada marzo 2026)

## Limitaciones
- ZonaProp limita paginación a ~260 páginas (~5,200 de 5,600 listadas)
- MercadoLibre limita paginación a ~2,000 resultados de 4,563
- 75% de las casas no mencionan estado explícitamente en la descripción
- No hay deduplicación entre fuentes (una casa puede estar en ZP y ML)
- Precios publicados ≠ precio de cierre (generalmente 10-20% de margen de negociación)
