# CABA Market Study

Estudio de mercado inmobiliario interactivo para casas en venta en Capital Federal, Buenos Aires.

## Features

- Dashboard interactivo con 8 secciones
- Mapa Leaflet.js con barrios, villas (1km buffer), catalizadores urbanos
- Análisis USD/m² por barrio con 480+ propiedades scrapeadas
- Gap analysis: refaccionar vs reciclada
- Tendencia histórica de precios 2017-2026
- Catalizadores: Línea F, TramBus, Distrito Tech, Cárcel Devoto
- Calculadora de inversión Buy & Reno
- Links directos a ZonaProp por barrio

## Stack

- HTML/CSS/JS vanilla (single-page app)
- Chart.js para visualizaciones
- Leaflet.js para mapa interactivo
- Datos scrapeados de ZonaProp (Marzo 2026)

## Deploy

Hosteado en Vercel como static site. La carpeta `public/` contiene el `index.html`.

## Roadmap

- [ ] Scraper automático con Supabase backend
- [ ] API para datos actualizados en tiempo real
- [ ] Alertas por email para nuevas propiedades
- [ ] Análisis de m² disponibles por barrio/CP
- [ ] Comparador de propiedades individuales
- [ ] Integración con datos de escrituras (DNRPI)
