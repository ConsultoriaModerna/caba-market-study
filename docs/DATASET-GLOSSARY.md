# InmoFindr Dataset Glossary

Total: 72 files, ~2.5 GB
Source folder: `/Users/nico/Desktop/AGENTS/RE/CABA/`

## Urban / Catastral

| Dataset | Format | Size | Records | Key Fields |
|---|---|---|---|---|
| parcelas_catastrales | SHP+DBF | 310 MB | 318,046 | smp, barrio, comuna, geometry |
| frentes-parcelas | SHP+CSV | 1.8 GB | ~500K | smp, frente (calle), num_dom, sup |
| certificados_urbanisticos | CSV | 123 KB | 1,412 | smp, barrio, comuna, obra, fecha |

## Noise / Environmental

| Dataset | Format | Size | Records | Key Fields |
|---|---|---|---|---|
| medicion_de_ruido_diurno | CSV+SHP | 122 MB | 181 | dba_low, dba_high, comuna, geometry |
| medicion_de_ruido_nocturno | XLSX+SHP | 30 MB | ~150 | dba ranges, geometry |
| sitios_anegamiento_2019 | CSV+SHP | 1.1 MB | 129 | WKT, comuna, clasificacion (critico/monitorear) |
| sitios_anegamiento_2014 | CSV | 790 KB | ~120 | WKT, comuna, clasificacion |
| sitios_anegamiento_2003 | SHP | 120 KB | ~100 | geometry, clasificacion |

## Social / Demographic

| Dataset | Format | Size | Records | Key Fields |
|---|---|---|---|---|
| barrios_populares_manzanas | CSV+SHP | 1.7 MB | 468 | nombre, barrio, geometry (polygons) |
| barrios_populares_poligono | XLSX | 84 KB | ~20 | barrio-level polygons |

## Transport

| Dataset | Format | Size | Records | Key Fields |
|---|---|---|---|---|
| etapas_transporte | CSV | 98 MB | 744,717 | modo_etapa, linea, lat/lon origen/destino, rango_horario |

## Financial / Personal (not for DB)

| Dataset | Format | Size | Notes |
|---|---|---|---|
| 2026 Credito.xls | XLS | 224 KB | Personal banking |
| 2026 Debito.xls | XLS | 69 KB | Personal banking |
| movements-2932026.pdf | PDF | 1 MB | Bank movements |
| informe-2/3/4/5.pdf | PDF | ~320 KB each | Reports |
| AnaliticasAPM-1/2.pdf | PDF | ~280 KB each | Analytics |
| ParteIncapacidadTemporal-2/3/4.pdf | PDF | ~125 KB each | Health |
| RelacionIncapacidadesLaborales.pdf | PDF | 479 KB | Health |
| RelacionProblemasSalud-2.pdf | PDF | 479 KB | Health |

## Processed (in public/data/)

| File | Size | Source | Used In |
|---|---|---|---|
| ruido_diurno.geojson | 9.4 MB | medicion_de_ruido_diurno | Map: Ruido layer |
| anegamiento.geojson | 63 KB | sitios_anegamiento_2019 | Map: Anegamiento layer |
| villas.json | 229 KB | barrios_populares_manzanas | Map: Villas layer |
| crime_barrios.json | 3.5 KB | GCBA delitos_2023 | Bivariate choropleth |
| crime_heatmap.json | 325 KB | GCBA delitos_2023 | Map: Delitos heatmap |
| transporte_heatmap.json | 319 KB | etapas_transporte | Map: Transporte layer |
| barrios_caba.geojson | 671 KB | GCBA barrios | Choropleth base |
| subte.geojson | ~5 KB | GCBA estaciones | Map: Subte lines |
| subte_stations.json | ~8 KB | GCBA estaciones | Map: Subte stations |
| railways.geojson | 366 KB | OSM | Map: Tren layer |
| religious.json | 76 KB | OSM | Map: Culto layer |
| zona_microcentro.geojson | ~1 KB | Manual | Map: Ley 6508 zone |
| iso_palermo_car.geojson | ~50 KB | ORS API | Map: Isocronas auto |
| iso_palermo_walk.geojson | ~15 KB | ORS API | Map: Isocronas pie |

## External APIs (not stored, queried live)

| API | Endpoint | Data |
|---|---|---|
| EPOK Catastro | epok.buenosaires.gob.ar/catastro/parcela/ | SMP, superficie, pisos, puertas |
| USIG Geocoder | servicios.usig.buenosaires.gob.ar/normalizar/ | Direccion -> coordenadas |
| Nominatim | nominatim.openstreetmap.org | Fallback geocoding |
| OpenRouteService | api.openrouteservice.org | Isocronas de tiempo de viaje |
| ArgentinaDatos | api.argentinadatos.com | Dolar, inflacion, riesgo pais |
