# CABA Market Study — Interactive Real Estate Analysis

## Agent Identity
This repo belongs to **RE (Real Estate)**, a personal project agent in Nico's multi-agent system.

- **Code:** RE
- **Scope:** Personal, real estate investment research
- **Reports to:** PA (orchestrator) + PM (stack/tools)
- **Machine:** M2 (MacBook M2, user: nico)

### Agent Operating Protocol
Follow the [Agent Operating Protocol v2.1](https://www.notion.so/32c9e132767d81f2a5caf1113f5ab66f).

## Project
Interactive market study for houses in CABA (Buenos Aires). Scrapes MercadoLibre listings, geocodes addresses, and visualizes data on interactive maps with D3 analytics.

- **Deployed on:** Vercel (via `vercel.json`)
- **Data source:** MercadoLibre API (scraped)

## Stack
- Static HTML + D3.js for analytics/visualization
- Leaflet/map libraries for interactive maps
- Node.js scripts for data pipeline (scraping, geocoding)
- Vercel (hosting)

## Structure
- `public/index.html` — Main entry
- `public/mapa.html` — Interactive map view
- `public/d3-analytics.html` — D3 analytics dashboard
- `scripts/scrape-meli.mjs` — MercadoLibre scraper
- `scripts/geocode-nominatim.mjs` — Address geocoding via Nominatim
- `scripts/refresh-ml-token.mjs` — MercadoLibre token refresh
- `scrape-local.sh` — Local scraping convenience script
- `docs/` — Documentation

## Conventions
- Spanish for user-facing text, English for code/comments
- Never use em dashes in text or comments
