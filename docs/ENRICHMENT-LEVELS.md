# Niveles de Scraping y Enriquecimiento

## Principio
No scrapear todo de golpe. Enriquecer en capas según prioridad.
Cada propiedad tiene un `enrichment_level` (0-3) y un `geo_precision` (exact/address/barrio/city).

## Nivel 0 — Listado (ya completado)
- Fuente: listado de búsqueda (ZonaProp/ML)
- Datos: precio, m², barrio, ambientes, keywords del snippet, link
- Geo precision: `barrio` (centroide del barrio)
- Status: **6,000 casas completadas**

## Nivel 1 — Detalle de publicación
- Fuente: entrar a cada URL individual
- Datos adicionales:
  - Dirección textual (si está visible)
  - Coordenadas del mapa embebido (data-lat/data-lng, JSON-LD, iframe Google Maps)
  - Fotos (URLs de las imágenes)
  - Teléfono/contacto del vendedor
  - Descripción completa
  - m² cubiertos reales (no estimados)
  - Antigüedad
  - Expensas
- Geo precision: `exact` (si tiene mapa) o `address` (si tiene dirección texto)
- Trigger: aplicar a las top ~50-100 propiedades según ranking

## Nivel 2 — Geocoding
- Fuente: Nominatim (OSM, gratis, 1 req/seg)
- Para propiedades con dirección texto pero sin coordenadas
- Input: dirección + "Buenos Aires, Argentina"
- Output: lat, lng
- Geo precision: `address`

## Nivel 3 — Barrio centroide con offset
- Para propiedades que solo tienen barrio
- Posicionar dentro del polígono del barrio con offset determinístico
- Geo precision: `barrio`
- Ya implementado por defecto con coordenadas de la tabla `neighborhoods`

## Jerarquía de precisión
`exact` (mapa embebido) > `address` (geocodeado) > `barrio` (centroide) > `city` (solo CABA)

## Schema Supabase
```sql
-- Columnas de enrichment en properties:
enrichment_level integer DEFAULT 0,  -- 0=listado, 1=detalle, 2=geocodeado, 3=centroide
geo_precision text DEFAULT 'barrio', -- exact/address/barrio/city
address_text text,                   -- dirección textual scrapeada
photos jsonb DEFAULT '[]',           -- URLs de fotos
contact_phone text,                  -- teléfono del vendedor
contact_name text,                   -- nombre del vendedor/inmobiliaria
enriched_at timestamptz              -- cuándo se enriqueció
```

## Regla de no-desperdicio
- No scrapear la publicación individual de las 6,000
- Solo enriquecer (Nivel 1) las que pasan filtros de interés
- Si no tiene dirección exacta → suma al globo del barrio en el mapa
- Si tiene dirección pero no coordenadas → geocodear (Nivel 2)
- Cada nivel agrega valor sin requerir completar el anterior
