// segment.mjs — Single source of truth for property segment classification.
// Used by every scraper that upserts into `properties.segment` so ZP and AP
// tag listings the same way. `detect-price-drops` reads this column to flag
// good_deal / high_gap opportunities on 'refac' listings.

export function determineSegment(title) {
  const t = (title || '').toLowerCase();
  if (t.includes('refaccionar') || t.includes('a reciclar') || t.includes('para reciclar')) return 'refac';
  if (t.includes('reciclada') || t.includes('reciclado') || t.includes('refaccionada') || t.includes('a estrenar') || t.includes('a nuevo')) return 'recic';
  return 'general';
}
