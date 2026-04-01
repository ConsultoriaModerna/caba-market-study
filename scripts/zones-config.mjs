// zones-config.mjs — Shared zone configuration for all scrapers
// Each zone defines scraping targets for both ZP and ML

export const ZONES = [
  {
    id: 'caba',
    name: 'Capital Federal',
    state: 'CABA',
    ml_state: 'TUxBUENBUGw3M2E1',
    active: true,
  },
  {
    id: 'gba-norte',
    name: 'GBA Norte',
    state: 'Buenos Aires',
    ml_state: 'TUxBUEdSQWU4ZDkz',
    active: true,
  },
];

// Property types with portal-specific slugs/params
export const PROPERTY_TYPES = [
  {
    id: 'casa',
    label: 'Casa',
    zp_slug: 'casas-venta',          // ZP URL: casas-venta-{zone}
    ap_slug: 'casas/venta',          // AP URL: casas/venta/{zone}
    ml_type: '242062',               // ML PROPERTY_TYPE param
    active: true,
  },
  {
    id: 'ph',
    label: 'PH',
    zp_slug: 'ph-venta',
    ap_slug: 'ph/venta',
    ml_type: '242062',               // ML groups PH under houses, filter by title
    active: true,
  },
  {
    id: 'departamento',
    label: 'Departamento',
    zp_slug: 'departamentos-venta',
    ap_slug: 'departamentos/venta',
    ml_type: '242060',               // ML: Apartments
    active: true,
  },
  {
    id: 'local',
    label: 'Local comercial',
    zp_slug: 'locales-comerciales-venta',
    ap_slug: 'locales-comerciales/venta',
    ml_type: '242069',               // ML: Commercial
    active: true,
  },
  {
    id: 'oficina',
    label: 'Oficina',
    zp_slug: 'oficinas-venta',
    ap_slug: 'oficinas/venta',
    ml_type: '242064',               // ML: Offices
    active: false,                   // Phase 2
  },
];

// Individual municipalities for ZP (more granular URLs)
// Slug prefix is prepended from PROPERTY_TYPES[].zp_slug
export const ZP_CITIES = [
  { zone: 'capital-federal', state: 'CABA', city: 'Capital Federal' },
  { zone: 'vicente-lopez', state: 'Buenos Aires', city: 'Vicente Lopez' },
  { zone: 'martinez-san-isidro', state: 'Buenos Aires', city: 'Martinez' },
  { zone: 'san-isidro', state: 'Buenos Aires', city: 'San Isidro' },
];

// AP zone slugs
export const AP_ZONES = [
  { id: 'caba', name: 'Capital Federal', state: 'CABA', zone_slug: 'capital-federal' },
  { id: 'gba-norte', name: 'GBA Norte', state: 'Buenos Aires', zone_slug: 'zona-norte-gba' },
];

// Build ZP location URLs for a given property type
export function getZPLocations(typeId = 'casa') {
  const pt = PROPERTY_TYPES.find(t => t.id === typeId);
  if (!pt) return [];
  return ZP_CITIES.map(c => ({
    slug: `${pt.zp_slug}-${c.zone}`,
    state: c.state,
    city: c.city,
    property_type: typeId,
  }));
}

// Build AP zone configs for a given property type
export function getAPZones(typeId = 'casa') {
  const pt = PROPERTY_TYPES.find(t => t.id === typeId);
  if (!pt) return [];
  return AP_ZONES.map(z => ({
    ...z,
    slug: `${pt.ap_slug}/${z.zone_slug}`,
    property_type: typeId,
  }));
}

// Legacy compat: ZP_LOCATIONS as before (casas only)
export const ZP_LOCATIONS = getZPLocations('casa');

export function getActiveZones() {
  return ZONES.filter(z => z.active);
}

export function getActivePropertyTypes() {
  return PROPERTY_TYPES.filter(t => t.active);
}

export function getMLStates() {
  return getActiveZones().map(z => ({
    state_code: z.ml_state,
    state_name: z.state,
    zone_name: z.name,
  }));
}
