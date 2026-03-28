// zones-config.mjs — Shared zone configuration for all scrapers
// Each zone defines scraping targets for both ZP and ML

export const ZONES = [
  {
    id: 'caba',
    name: 'Capital Federal',
    state: 'CABA',
    ml_state: 'TUxBUENBUGw3M2E1',
    zp_slug: 'casas-venta-capital-federal',
    active: true,
  },
  {
    id: 'gba-norte',
    name: 'GBA Norte',
    state: 'Buenos Aires',
    ml_state: 'TUxBUEdSQWU4ZDkz',
    zp_slug: 'casas-venta-gba-norte-zona-norte',
    active: true,
  },
];

// Individual municipalities for ZP (more granular URLs)
export const ZP_LOCATIONS = [
  // CABA
  { slug: 'casas-venta-capital-federal', state: 'CABA', city: 'Capital Federal' },
  // GBA Norte - individual municipalities
  { slug: 'casas-venta-vicente-lopez', state: 'Buenos Aires', city: 'Vicente Lopez' },
  { slug: 'casas-venta-martinez-san-isidro', state: 'Buenos Aires', city: 'Martinez' },
  { slug: 'casas-venta-san-isidro', state: 'Buenos Aires', city: 'San Isidro' },
];

export function getActiveZones() {
  return ZONES.filter(z => z.active);
}

export function getMLStates() {
  return getActiveZones().map(z => ({
    state_code: z.ml_state,
    state_name: z.state,
    zone_name: z.name,
  }));
}
