import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ─────────────────────────────────────────────────────────────────────────────
// Gate (PA, 16/08/2026 — protocolo §23: "el gate del consumidor no es el gate
// del endpoint"). Hasta hoy esta función corría con verify_jwt=false, CORS `*`
// y sin ninguna credencial: cualquiera con la URL mandaba una pregunta libre,
// Haiku le escribía el SQL y se ejecutaba con service_role, y encima gastaba
// tokens de Anthropic de la casa sin techo. El password gate del dashboard es
// client-side (auth.js, con el hash en el propio fuente): protege el render,
// nunca la API.
//
// El token va embebido en el dashboard, que es una página estática, así que no
// es un secreto de verdad y no pretende serlo: mueve la barra de "cualquiera
// con la URL" a "cualquiera que además pasó el gate del dashboard", que es la
// decisión que ya estaba tomada para esa página. El CORS deja de ser `*` y
// queda en el origen del dashboard.
// ─────────────────────────────────────────────────────────────────────────────
const INTEL_TOKEN = Deno.env.get('INTEL_QUERY_TOKEN');
const ALLOWED_ORIGIN = Deno.env.get('INTEL_ALLOWED_ORIGIN') ?? 'https://inmofindr.vercel.app';

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('origin');
  return {
    'Access-Control-Allow-Origin': origin === ALLOWED_ORIGIN ? origin : ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey, x-intel-token',
    'Vary': 'Origin',
  };
}

const ANTHROPIC_KEY = Deno.env.get('ANTHROPIC_API_KEY')!;
// 29/08/2026: las claves personales de esta cuenta son identity-linked
// (alcance "todos los espacios de trabajo"), asi que cada request necesita
// decir en que workspace actua. El de Default no tiene un wrkspc_... visible
// en la consola (a diferencia de "Claude Code", que si lo tiene); su slug de
// URL es literalmente "default", que es lo que probamos aca.
const ANTHROPIC_WORKSPACE_ID = Deno.env.get('ANTHROPIC_WORKSPACE_ID')!;
const anthropicHeaders = {
  'x-api-key': ANTHROPIC_KEY,
  'anthropic-version': '2023-06-01',
  'anthropic-workspace-id': ANTHROPIC_WORKSPACE_ID,
  'Content-Type': 'application/json',
};
const SB_URL = Deno.env.get('SUPABASE_URL')!;
const SB_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const sb = createClient(SB_URL, SB_KEY);

const MODELS: Record<string, string> = {
  haiku: 'claude-haiku-4-5-20251001',
  // 27/08/2026 (RE, cerrando el aviso de PA del 16/08): los dos IDs anteriores
  // (claude-sonnet-4-5-20241022 y claude-opus-4-0-20250514) no son de familias
  // vigentes, la API los rechazaba y la cadena de fallback terminaba siempre en
  // Haiku: el boton "Opus" del dashboard servia Haiku y decia que era Opus.
  // Se pasan a los IDs vigentes. Son consultas on-demand, disparadas a mano
  // desde el dashboard, no hay ninguna en el nightly.
  sonnet: 'claude-sonnet-5',
  opus: 'claude-opus-5',
};

const SCHEMA = `Tables available (Supabase PostgreSQL):

1. properties (10K+ rows) - real estate listings
   id text PK, title text, price numeric, currency text (USD/ARS), price_per_sqm numeric,
   price_per_covered_sqm numeric, total_area numeric, covered_area numeric,
   ambientes int, bedrooms int, bathrooms int, cocheras int,
   neighborhood text, address_text text, latitude numeric, longitude numeric,
   segment text (refac/recic/general/cheap), source text (zonaprop/mercadolibre/argenprop),
   property_type text (casa/ph/departamento),
   keywords text[], description text, permalink text, is_active boolean,
   livability_score int (0-100), first_seen_at timestamp, smp text,
   covered_ratio numeric, contact_phone text, contact_name text

2. codigo_urbanistico (318K rows) - zoning/FOT per parcel
   smp text PK, barrio text, comuna text, fot_em numeric, fot_pl numeric,
   fot_sl numeric, distrito text, uso_1 text (1=resid,2=comerc,3=equip,4=indust),
   tipo_manzana text, alicuota numeric, microcentro boolean, catalogado boolean

3. usos_suelo (417K rows) - current land use per address
   id int PK, smp text, barrio text, tipo1 text, tipo2 text, estado text,
   pisos int, calle text, puerta text, anio text

4. precios_historicos (3K rows) - historical neighborhood prices
   id int, barrio text, anio int (2015-2019), usd_m2 numeric

5. espacios_culturales (3K rows) - cultural venues
   id int, nombre text, tipo text, barrio text, direccion text,
   lat numeric, lon numeric

6. demografico_barrios - demographic data by neighborhood
   barrio text, poblacion int, densidad numeric, superficie numeric

JOIN keys: properties.smp = codigo_urbanistico.smp = usos_suelo.smp
properties.neighborhood ~ codigo_urbanistico.barrio (case-insensitive)

IMPORTANT:
- Only SELECT queries, never INSERT/UPDATE/DELETE
- Limit results to 50 rows max
- Use ILIKE for text comparisons (barrio names vary in case)
- price_per_sqm can have outliers, filter > 100 AND < 10000 for valid data
- is_active = true for current listings
- canonical_id IS NULL to exclude duplicates`;

Deno.serve(async (req: Request) => {
  const cors = corsHeaders(req);

  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: cors });
  }

  // Fail-closed, y en este orden a propósito: si falta la env var la función
  // cierra, no abre. Un `if (token && ...)` desaparece justo cuando hace falta.
  if (!INTEL_TOKEN) {
    return new Response(JSON.stringify({ error: 'gate not configured' }), {
      status: 503, headers: { 'Content-Type': 'application/json', ...cors },
    });
  }
  if (req.headers.get('x-intel-token') !== INTEL_TOKEN) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401, headers: { 'Content-Type': 'application/json', ...cors },
    });
  }

  // 29/08/2026: cap de gasto (auditoria RE+Fable+GPT-Sol, FA-07). El token va
  // embebido en el bundle publico (ver comentario arriba); si se filtra, esto
  // pone un techo diario al gasto de Anthropic, no solo el gate de auth.
  const { data: underCap, error: capError } = await sb.rpc('check_and_increment_usage', {
    p_fn: 'intel-query', p_max: 150,
  });
  if (capError) {
    return new Response(JSON.stringify({ error: 'rate limit check failed' }), {
      status: 500, headers: { 'Content-Type': 'application/json', ...cors },
    });
  }
  if (!underCap) {
    return new Response(JSON.stringify({ error: 'daily limit reached, try again tomorrow' }), {
      status: 429, headers: { 'Content-Type': 'application/json', ...cors },
    });
  }

  try {
    const { question, context, model: modelKey } = await req.json();
    if (!question) throw new Error('No question provided');

    if (modelKey === 'opus') {
      const { data: underOpusCap } = await sb.rpc('check_and_increment_usage', {
        p_fn: 'intel-query-opus', p_max: 20,
      });
      if (!underOpusCap) {
        return new Response(JSON.stringify({ error: 'opus daily limit reached, try sonnet or haiku' }), {
          status: 429, headers: { 'Content-Type': 'application/json', ...cors },
        });
      }
    }

    const sqlModel = MODELS.haiku;
    // For analysis: try requested model, fallback chain opus -> sonnet -> haiku
    const analysisModel = MODELS[modelKey] || MODELS.haiku;

    // Step 1: Ask Claude to generate SQL (always haiku - cheap)
    const sqlResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: anthropicHeaders,
      body: JSON.stringify({
        model: sqlModel,
        max_tokens: 500,
        system: `You are a SQL expert for a Buenos Aires real estate database. Generate a single PostgreSQL SELECT query to answer the user's question. Return ONLY the raw SQL, no markdown fences, no explanation.\nIf the question doesn't need a database query, return exactly: SELECT 'no_query' as result;\n\n${SCHEMA}`,
        messages: [{ role: 'user', content: question }]
      })
    });

    if (!sqlResp.ok) throw new Error(`SQL gen failed: ${sqlResp.status} ${await sqlResp.text()}`);
    const sqlData = await sqlResp.json();
    let sql = (sqlData.content?.[0]?.text || '').trim();
    sql = sql.replace(/```sql\n?/gi, '').replace(/```\n?/g, '').trim();
    // 16/08/2026 (PA): sacar el punto y coma final. `exec_readonly_sql` mete el
    // SQL dentro de un subquery (`SELECT jsonb_agg(...) FROM (<sql>) t`), asi que
    // un `;` al final lo rompe con 42601, y el LLM lo pone casi siempre. Probado:
    // la misma consulta con y sin `;` da 1.292 filas o error de sintaxis. El panel
    // Intel venia devolviendo "error en la consulta" por esto, no por el gate.
    sql = sql.replace(/;\s*$/, '').trim();

    if (!sql.toUpperCase().startsWith('SELECT')) {
      throw new Error('Only SELECT queries allowed');
    }

    // Step 2: Execute SQL via RPC
    let queryResult = null;
    let queryError = null;
    if (!sql.includes("'no_query'")) {
      const { data, error } = await sb.rpc('exec_readonly_sql', { query_text: sql });
      if (error) {
        queryError = error.message;
      } else {
        queryResult = data;
      }
    }

    // Step 3: Analyze results (uses requested model, with fallback)
    const analysisPrompt = `Eres un analista de inteligencia urbana de Buenos Aires. El usuario pregunto:\n"${question}"\n\n${context ? 'Contexto del dashboard:\n' + context.substring(0, 2000) + '\n\n' : ''}${sql && !sql.includes("'no_query'") ? 'SQL ejecutado:\n' + sql + '\n\n' : ''}${queryResult ? 'Resultados (JSON):\n' + JSON.stringify(queryResult).substring(0, 4000) + '\n\n' : ''}${queryError ? 'Error en consulta: ' + queryError + '. Responde con lo que puedas del contexto.\n\n' : ''}Responde en espanol, conciso, con datos concretos. Usa los numeros reales de los resultados. Si hay multiples filas, formatea como tabla legible. No inventes datos.`;

    // Try requested model, fallback to sonnet if opus fails
    let analysisResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: anthropicHeaders,
      body: JSON.stringify({
        model: analysisModel,
        max_tokens: modelKey === 'opus' ? 4000 : 1500,
        messages: [{ role: 'user', content: analysisPrompt }]
      })
    });

    let usedModel = analysisModel;
    // Fallback: if opus/sonnet fails, try next in chain
    if (!analysisResp.ok && modelKey === 'opus') {
      usedModel = MODELS.sonnet;
      analysisResp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: anthropicHeaders,
        body: JSON.stringify({ model: usedModel, max_tokens: 3000, messages: [{ role: 'user', content: analysisPrompt }] })
      });
    }
    if (!analysisResp.ok && usedModel !== MODELS.haiku) {
      usedModel = MODELS.haiku;
      analysisResp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: anthropicHeaders,
        body: JSON.stringify({ model: usedModel, max_tokens: 1500, messages: [{ role: 'user', content: analysisPrompt }] })
      });
    }

    if (!analysisResp.ok) throw new Error(`Analysis failed: ${analysisResp.status}`);
    const analysisData = await analysisResp.json();
    const analysis = analysisData.content?.[0]?.text || 'Sin resultado';
    const usage = analysisData.usage || {};

    return new Response(JSON.stringify({
      analysis,
      sql: sql.includes("'no_query'") ? null : sql,
      row_count: Array.isArray(queryResult) ? queryResult.length : 0,
      model: usedModel,
      tokens: usage.input_tokens && usage.output_tokens ? `${usage.input_tokens}in/${usage.output_tokens}out` : null
    }), {
      headers: { 'Content-Type': 'application/json', ...cors }
    });

  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...cors }
    });
  }
});
