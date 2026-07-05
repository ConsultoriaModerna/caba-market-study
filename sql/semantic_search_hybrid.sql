-- semantic_search_hybrid — v2 of the /search "Semántica" mode.
--
-- The original semantic_search() is pure pgvector and only matches props with an
-- embedding (~7% of active, since embeddings need a description and ZP enrichment
-- was down for 2 months). This hybrid adds a full-text fallback over the generated
-- `fts` tsvector so the other ~93% still surface. Vector hits rank first (higher
-- quality); OR-ified full-text hits (recall-oriented) fill below them.
--
-- Additive: leaves semantic_search() untouched (trivial revert of the edge fn).
-- Called by the semantic-search edge function with query_embedding + query_text.
-- Applied to Supabase project inmofindr (ysynltkotzizayjtoujf) 2026-07-05.

create or replace function public.semantic_search_hybrid(
  query_embedding vector,
  query_text text default '',
  match_count integer default 20,
  min_similarity double precision default 0.3
)
returns table(
  id text, title text, neighborhood text, price numeric, currency text,
  total_area numeric, covered_area numeric, covered_ratio numeric,
  bedrooms integer, bathrooms integer, cocheras integer,
  description text, address_text text, permalink text, source text,
  segment text, price_per_sqm numeric, price_per_covered_sqm numeric,
  similarity double precision, match_type text
)
language plpgsql stable
as $function$
#variable_conflict use_column
declare
  tsq tsquery;
begin
  -- OR-ify the sanitized query so the text fallback favors recall (ts_rank still
  -- ranks by term relevance). websearch handles sanitization; swap '&' for '|'.
  tsq := nullif(replace(websearch_to_tsquery('spanish', coalesce(query_text, ''))::text, '&', '|'), '')::tsquery;
  return query
  with vec as (
    select p.id as pid, 1 - (p.embedding <=> query_embedding) as score
    from properties p
    where p.is_active = true and p.canonical_id is null and p.embedding is not null
      and 1 - (p.embedding <=> query_embedding) >= min_similarity
    order by p.embedding <=> query_embedding
    limit match_count
  ),
  txt as (
    select p.id as pid, ts_rank(p.fts, tsq) as rank
    from properties p
    where tsq is not null and p.is_active = true and p.canonical_id is null
      and p.fts @@ tsq
      and p.id not in (select pid from vec)
    order by ts_rank(p.fts, tsq) desc
    limit match_count
  ),
  merged as (
    select pid, score, 'vector'::text as mt from vec
    union all
    select pid, least(0.55, 0.30 + (rank * 4.0)) as score, 'text'::text as mt from txt
  )
  select
    p.id, p.title, p.neighborhood, p.price, p.currency,
    p.total_area, p.covered_area, p.covered_ratio,
    p.bedrooms, p.bathrooms, p.cocheras,
    left(p.description, 500), p.address_text, p.permalink, p.source,
    p.segment, p.price_per_sqm, p.price_per_covered_sqm,
    m.score as similarity, m.mt as match_type
  from merged m
  join properties p on p.id = m.pid
  order by (case when m.mt = 'vector' then 0 else 1 end), m.score desc
  limit match_count;
end;
$function$;
