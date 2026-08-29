import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ANTHROPIC_KEY = Deno.env.get('ANTHROPIC_API_KEY')!;
// 29/08/2026: clave identity-linked, exige este header o la API devuelve 400.
const ANTHROPIC_WORKSPACE_ID = Deno.env.get('ANTHROPIC_WORKSPACE_ID')!;

const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);


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
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
      }
    });
  }

  // 29/08/2026: cap de gasto (auditoria RE+Fable+GPT-Sol, FA-07/GS-01).
  const { data: underCap, error: capError } = await sb.rpc('check_and_increment_usage', {
    p_fn: 'analyze-property', p_max: 150,
  });
  if (capError) {
    return new Response(JSON.stringify({ error: 'rate limit check failed' }), {
      status: 500, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
  if (!underCap) {
    return new Response(JSON.stringify({ error: 'daily limit reached, try again tomorrow' }), {
      status: 429, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }

  try {
    const { property, comparables, barrio_median } = await req.json();
    if (!property) throw new Error('No property data');

    const p = property;
    const extPct = p.covered_ratio ? Math.round((1 - p.covered_ratio) * 100) : null;
    const vsMedian = (barrio_median && p.price_per_sqm) ? Math.round((p.price_per_sqm - barrio_median) / barrio_median * 100) : null;

    const prompt = `Sos un analista de inversiones inmobiliarias en Buenos Aires, Argentina. Analiza esta propiedad y da tu opinion profesional en espanol.

PROPIEDAD:
- Titulo: ${p.title || 'N/A'}
- Barrio: ${p.neighborhood || 'N/A'}
- Precio: USD ${p.price?.toLocaleString() || 'N/A'}
- USD/m2 total: $${p.price_per_sqm || 'N/A'}
- USD/m2 cubierto: $${p.price_per_covered_sqm || 'N/A'}
- Superficie total: ${p.total_area || 'N/A'} m2
- Superficie cubierta: ${p.covered_area || 'N/A'} m2
- Espacio exterior: ${extPct ? extPct + '%' : 'N/A'}
- Dormitorios: ${p.bedrooms || 'N/A'} | Banos: ${p.bathrooms || 'N/A'} | Cocheras: ${p.cocheras || 'N/A'}
- Segmento: ${p.segment === 'refac' ? 'A refaccionar' : p.segment === 'recic' ? 'Reciclada' : 'General'}
- Fuente: ${p.source || 'N/A'}
- Mediana del barrio: $${barrio_median || 'N/A'}/m2 ${vsMedian !== null ? '(' + (vsMedian > 0 ? '+' : '') + vsMedian + '% vs mediana)' : ''}
${p.description ? '- Descripcion: ' + p.description.substring(0, 1500) : ''}

${comparables?.length ? 'COMPARABLES EN EL BARRIO:\n' + comparables.map((c: any) => `- ${c.segment}: $${c.price_per_sqm}/m2, ${c.total_area}m2, USD ${c.price?.toLocaleString()}`).join('\n') : ''}

Da tu analisis en 4 secciones cortas:
1. VEREDICTO (1 linea: oportunidad / fair price / sobrevaluada)
2. FORTALEZAS (2-3 bullets)
3. RIESGOS (2-3 bullets)
4. ESTRATEGIA (que harias con esta propiedad: comprar para vivir, refaccionar y vender, alquilar, pasar)`;

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-workspace-id': ANTHROPIC_WORKSPACE_ID,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 800,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Anthropic error ${resp.status}: ${err}`);
    }

    const data = await resp.json();
    const analysis = data.content?.[0]?.text || 'No analysis generated';

    return new Response(JSON.stringify({ analysis }), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });

  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
});
