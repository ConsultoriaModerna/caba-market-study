import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

const OPENAI_KEY = Deno.env.get('OPENAI_API_KEY')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;


// ── Gate (PA, 16/08/2026 — protocolo §23) ───────────────────────────────────
// Esta funcion la llama el dashboard, que es una pagina estatica: el token va
// embebido y no es un secreto, sube la barra de "cualquiera con la URL" a
// "cualquiera que ya paso el gate del dashboard". Fail-closed: si falta la env
// var, cierra. Un `if (token && ...)` desaparece justo cuando hace falta.
const INTEL_TOKEN = Deno.env.get('INTEL_QUERY_TOKEN');
async function gateOk(req: Request): Promise<boolean> {
  if (!INTEL_TOKEN) return false;
  return req.headers.get('x-intel-token') === INTEL_TOKEN;
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'OPTIONS' && !(await gateOk(req))) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401, headers: { 'Content-Type': 'application/json' },
    });
  }
  // CORS
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
      }
    });
  }

  try {
    const { query, match_count = 20 } = await req.json();
    if (!query || query.trim().length < 3) {
      return new Response(JSON.stringify({ error: 'Query too short' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    // Get embedding from OpenAI
    const embResp = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'text-embedding-3-small',
        input: query.trim()
      })
    });

    if (!embResp.ok) {
      const err = await embResp.text();
      throw new Error(`OpenAI error: ${err}`);
    }

    const embData = await embResp.json();
    const embedding = embData.data[0].embedding;

    // Hybrid search: pgvector match + full-text fallback (semantic_search_hybrid).
    // Passes the raw query text so props without an embedding still surface.
    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
    const { data, error } = await supabase.rpc('semantic_search_hybrid', {
      query_embedding: JSON.stringify(embedding),
      query_text: query.trim(),
      match_count: Math.min(match_count, 50)
    });

    if (error) throw new Error(`DB error: ${error.message}`);

    return new Response(JSON.stringify(data), {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });

  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
});
