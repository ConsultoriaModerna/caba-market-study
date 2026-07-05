-- opportunity_scan — Radar de oportunidades para /oportunidades
--
-- Below-barrio-median active casas (USD), valued on covered m2
-- (price_per_covered_sqm, generated column) to avoid lot-area distortion that
-- plagues price_per_sqm (total_area is often the lot, not covered area).
-- Layers barrio market-velocity context from turnover_metrics_weekly.
--
-- opportunity_score = capped gap (>=50% treated as suspicious, not "better")
--                     x area-confidence weight (unverified area penalized)
--                     x barrio-liquidity weight (more discovery = more tradeable)
--
-- Read-only view; `properties` is already anon-readable by the dashboard.
-- Applied to Supabase project inmofindr (ysynltkotzizayjtoujf) 2026-07-05.
-- Migration name in Supabase history: create_opportunity_scan_view.

create or replace view public.opportunity_scan as
with base as (
  select
    id, title, neighborhood, segment, price, currency,
    covered_area, total_area, bedrooms, permalink, source,
    price_per_covered_sqm,
    case when covered_area < total_area then 'verified' else 'lot_fallback' end as area_confidence
  from properties
  where is_active = true
    and canonical_id is null
    and property_type = 'casa'
    and currency = 'USD'
    and price >= 30000
    and price_per_covered_sqm > 100 and price_per_covered_sqm < 20000
    and covered_area between 30 and 1000
    and (covered_ratio is null or covered_ratio <= 1.05)
),
barrio_stats as (
  select neighborhood,
         count(*) as barrio_n,
         percentile_cont(0.5) within group (order by price_per_covered_sqm) as barrio_median_ppcs
  from base
  group by neighborhood
  having count(*) >= 5
),
turnover as (
  select neighborhood,
         sum(discovered) as discovered_12w,
         avg(nullif(median_days_on_market, 0)) as dom
  from turnover_metrics_weekly
  where property_type = 'casa'
    and week_start >= (current_date - interval '120 days')
  group by neighborhood
)
select
  b.id, b.title, b.neighborhood, b.segment, b.price, b.currency,
  b.covered_area, b.total_area, b.bedrooms, b.permalink, b.source,
  round(b.price_per_covered_sqm::numeric, 0) as price_per_covered_sqm,
  round(s.barrio_median_ppcs::numeric, 0) as barrio_median_ppcs,
  round(((b.price_per_covered_sqm - s.barrio_median_ppcs) / s.barrio_median_ppcs * 100)::numeric, 1) as gap_pct,
  b.area_confidence,
  s.barrio_n,
  t.discovered_12w,
  round(t.dom::numeric, 0) as dom,
  round((
    least(greatest((s.barrio_median_ppcs - b.price_per_covered_sqm) / s.barrio_median_ppcs * 100, 0), 50)
    * (case when b.area_confidence = 'verified' then 1.0 else 0.55 end)
    * (0.6 + least(coalesce(t.discovered_12w, 0) / 200.0, 0.6))
  )::numeric, 1) as opportunity_score
from base b
join barrio_stats s on s.neighborhood = b.neighborhood
left join turnover t on t.neighborhood = b.neighborhood
where b.price_per_covered_sqm < s.barrio_median_ppcs
order by opportunity_score desc;

grant select on public.opportunity_scan to anon, authenticated;
