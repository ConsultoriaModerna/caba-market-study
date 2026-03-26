import { useState, useEffect, useMemo, useCallback } from "react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell, ScatterChart, Scatter, ZAxis, PieChart, Pie } from "recharts";
import { Search, TrendingDown, Home, MapPin, DollarSign, Ruler, Filter, Star, AlertTriangle, ChevronDown, ChevronUp, X, Sparkles, RefreshCw } from "lucide-react";

const SUPA_URL = "https://ysynltkotzizayjtoujf.supabase.co";
const SUPA_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlzeW5sdGtvdHppemF5anRvdWpmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjU2MzM1MjksImV4cCI6MjA4MTIwOTUyOX0.-rSFZIILSIwPWIRW-frMm27_wRsIOK79Txz5alE6QUE";

const headers = { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` };

async function supaFetch(table, params = "") {
  const r = await fetch(`${SUPA_URL}/rest/v1/${table}?${params}`, { headers });
  return r.json();
}

const ZONES = {
  Norte: { color: "#4ade80", barrios: ["Belgrano","Belgrano R","Núñez","Saavedra","Coghlan","Villa Urquiza","Colegiales","Palermo","Palermo Chico"] },
  Centro: { color: "#60a5fa", barrios: ["Caballito","Almagro","Boedo","San Cristóbal","San Cristobal","Balvanera","Abasto","Recoleta","Barrio Norte","San Telmo","Monserrat","San Nicolás","Constitución","Once"] },
  Oeste: { color: "#fb923c", barrios: ["Villa Devoto","Villa del Parque","Villa Del Parque","Monte Castro","Floresta","Vélez Sársfield","Velez Sarsfield","Versalles","Villa Luro","Liniers","Villa Pueyrredón","Villa Real","Villa Santa Rita","Agronomía","Paternal"] },
  Sur: { color: "#f472b6", barrios: ["Flores","Mataderos","Parque Chacabuco","Parque Avellaneda","Barracas","La Boca","Pompeya","Villa Lugano","Villa Soldati","Parque Patricios","Villa Riachuelo"] },
};

function getZone(n) {
  for (const [z, d] of Object.entries(ZONES)) if (d.barrios.includes(n)) return z;
  return "Otro";
}
function getZoneColor(n) {
  const z = getZone(n);
  return ZONES[z]?.color || "#94a3b8";
}

function fmt(n) {
  if (!n) return "—";
  return n >= 1000000 ? `${(n/1000000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n/1000)}K` : String(n);
}
function fmtUSD(n) { return n ? `USD ${n.toLocaleString("es-AR")}` : "—"; }

// AI Analysis Engine
function generateInsights(neighborhoods, properties, opportunities) {
  const insights = [];
  if (!neighborhoods.length) return insights;

  const sorted = [...neighborhoods].sort((a,b) => (a.median_ppsm||999999) - (b.median_ppsm||999999));
  const cheapest = sorted.slice(0, 3);
  const priciest = sorted.slice(-3).reverse();

  insights.push({
    type: "market",
    icon: "📊",
    title: "Panorama General",
    text: `El mercado de casas en CABA tiene ${properties.length.toLocaleString()} propiedades activas en ${neighborhoods.length} barrios. La mediana general de precio por m² es USD ${Math.round(neighborhoods.reduce((s,n) => s + (n.median_ppsm||0), 0) / neighborhoods.length).toLocaleString()}/m².`
  });

  insights.push({
    type: "cheap",
    icon: "💰",
    title: "Barrios Más Económicos (por m²)",
    text: `Los barrios con menor costo por m² son ${cheapest.map(n => `${n.neighborhood} (USD ${Math.round(n.median_ppsm)}/m²)`).join(", ")}. Estos barrios en zona Sur ofrecen la mejor relación superficie-precio.`
  });

  insights.push({
    type: "premium",
    icon: "🏆",
    title: "Barrios Premium",
    text: `Los barrios más caros son ${priciest.map(n => `${n.neighborhood} (USD ${Math.round(n.median_ppsm)}/m²)`).join(", ")}. La brecha con los barrios económicos es de ${((priciest[0]?.median_ppsm / cheapest[0]?.median_ppsm) || 0).toFixed(1)}x.`
  });

  const refacCount = properties.filter(p => (p.title||"").toLowerCase().includes("refaccionar")).length;
  if (refacCount > 0) {
    insights.push({
      type: "opportunity",
      icon: "🔧",
      title: "Casas a Refaccionar",
      text: `Hay ${refacCount} casas a refaccionar en el mercado. Estas representan oportunidades de inversión con alto potencial de revalorización, especialmente en barrios con USD/m² bajo.`
    });
  }

  if (opportunities.length > 0) {
    insights.push({
      type: "alert",
      icon: "🚨",
      title: `${opportunities.length} Oportunidades Detectadas`,
      text: `El sistema detectó ${opportunities.length} oportunidades con precio/m² significativamente bajo. Las mejores están en ${[...new Set(opportunities.slice(0,5).map(o => o.details?.neighborhood))].filter(Boolean).join(", ")}.`
    });
  }

  const bigAreaDeals = properties.filter(p => p.total_area > 200 && p.price_per_sqm && p.price_per_sqm < 1200 && p.currency === "USD");
  if (bigAreaDeals.length > 0) {
    insights.push({
      type: "insight",
      icon: "📐",
      title: "Grandes Superficies Económicas",
      text: `Hay ${bigAreaDeals.length} propiedades con más de 200m² y menos de USD 1.200/m². Ideal para inversores que buscan metros cuadrados baratos para subdividir o desarrollar.`
    });
  }

  return insights;
}

// KPI Card Component
function KPI({ icon: Icon, label, value, sub, color = "#00d4ff" }) {
  return (
    <div className="bg-gray-900 rounded-xl p-5 border border-gray-800 flex flex-col gap-1">
      <div className="flex items-center gap-2 mb-1">
        <Icon size={18} style={{ color }} />
        <span className="text-gray-400 text-sm">{label}</span>
      </div>
      <div className="text-2xl font-bold" style={{ color }}>{value}</div>
      {sub && <div className="text-xs text-gray-500">{sub}</div>}
    </div>
  );
}

// Search Pill Component
function Pill({ label, onRemove }) {
  return (
    <span className="inline-flex items-center gap-1 bg-cyan-900 text-cyan-300 text-xs px-2 py-1 rounded-full">
      {label}
      <X size={12} className="cursor-pointer hover:text-white" onClick={onRemove} />
    </span>
  );
}

// Main Dashboard
export default function CABADashboard() {
  const [properties, setProperties] = useState([]);
  const [neighborhoods, setNeighborhoods] = useState([]);
  const [opportunities, setOpportunities] = useState([]);
  const [loading, setLoading] = useState(true);
  const [lastUpdate, setLastUpdate] = useState(null);

  // Search state
  const [searchText, setSearchText] = useState("");
  const [searchKeywords, setSearchKeywords] = useState([]);
  const [priceRange, setPriceRange] = useState([0, 2000000]);
  const [areaRange, setAreaRange] = useState([0, 1000]);
  const [selectedZone, setSelectedZone] = useState("all");
  const [selectedBarrio, setSelectedBarrio] = useState("all");
  const [sortBy, setSortBy] = useState("price_per_sqm");
  const [showFilters, setShowFilters] = useState(false);
  const [activeTab, setActiveTab] = useState("overview");

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [props, opps] = await Promise.all([
        supaFetch("properties", "is_active=eq.true&select=id,title,price,currency,total_area,covered_area,ambientes,bedrooms,bathrooms,neighborhood,price_per_sqm,segment,slug,keywords,scraped_at&order=price_per_sqm.asc.nullslast&limit=5000"),
        supaFetch("opportunity_events", "select=*&order=created_at.desc&limit=100")
      ]);
      setProperties(props || []);
      setOpportunities(opps || []);

      // Compute neighborhood stats
      const byBarrio = {};
      for (const p of (props || [])) {
        if (!p.neighborhood) continue;
        if (!byBarrio[p.neighborhood]) byBarrio[p.neighborhood] = { prices: [], ppsms: [], areas: [], count: 0 };
        byBarrio[p.neighborhood].count++;
        if (p.price && p.currency === "USD" && p.price > 10000 && p.price < 5000000) byBarrio[p.neighborhood].prices.push(p.price);
        if (p.price_per_sqm && p.price_per_sqm > 100 && p.price_per_sqm < 10000) byBarrio[p.neighborhood].ppsms.push(p.price_per_sqm);
        if (p.total_area && p.total_area > 0) byBarrio[p.neighborhood].areas.push(p.total_area);
      }
      const nData = Object.entries(byBarrio)
        .filter(([,v]) => v.count >= 5 && v.ppsms.length >= 3)
        .map(([n, v]) => {
          v.prices.sort((a,b) => a-b);
          v.ppsms.sort((a,b) => a-b);
          return {
            neighborhood: n,
            count: v.count,
            avg_price: Math.round(v.prices.reduce((s,x)=>s+x,0) / v.prices.length),
            median_price: v.prices[Math.floor(v.prices.length/2)] || 0,
            avg_ppsm: Math.round(v.ppsms.reduce((s,x)=>s+x,0) / v.ppsms.length),
            median_ppsm: v.ppsms[Math.floor(v.ppsms.length/2)] || 0,
            avg_area: Math.round(v.areas.reduce((s,x)=>s+x,0) / v.areas.length),
            zone: getZone(n)
          };
        })
        .sort((a,b) => b.count - a.count);
      setNeighborhoods(nData);
      setLastUpdate(new Date());
    } catch (e) { console.error(e); }
    setLoading(false);
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  // Insights
  const insights = useMemo(() => generateInsights(neighborhoods, properties, opportunities), [neighborhoods, properties, opportunities]);

  // Filtered properties for Super Searcher
  const filtered = useMemo(() => {
    let result = properties.filter(p => p.currency === "USD" && p.price > 0);
    if (priceRange[0] > 0) result = result.filter(p => p.price >= priceRange[0]);
    if (priceRange[1] < 2000000) result = result.filter(p => p.price <= priceRange[1]);
    if (areaRange[0] > 0) result = result.filter(p => p.total_area >= areaRange[0]);
    if (areaRange[1] < 1000) result = result.filter(p => p.total_area <= areaRange[1]);
    if (selectedZone !== "all") result = result.filter(p => getZone(p.neighborhood) === selectedZone);
    if (selectedBarrio !== "all") result = result.filter(p => p.neighborhood === selectedBarrio);
    if (searchKeywords.length > 0) {
      result = result.filter(p => {
        const text = `${p.title} ${(p.keywords||[]).join(" ")}`.toLowerCase();
        return searchKeywords.every(kw => text.includes(kw.toLowerCase()));
      });
    }
    if (searchText.trim()) {
      const q = searchText.toLowerCase();
      result = result.filter(p => `${p.title} ${(p.keywords||[]).join(" ")} ${p.neighborhood}`.toLowerCase().includes(q));
    }
    result.sort((a,b) => {
      if (sortBy === "price_per_sqm") return (a.price_per_sqm||99999) - (b.price_per_sqm||99999);
      if (sortBy === "price_asc") return (a.price||0) - (b.price||0);
      if (sortBy === "price_desc") return (b.price||0) - (a.price||0);
      if (sortBy === "area_desc") return (b.total_area||0) - (a.total_area||0);
      return 0;
    });
    return result;
  }, [properties, priceRange, areaRange, selectedZone, selectedBarrio, searchKeywords, searchText, sortBy]);

  // Chart data
  const chartData = useMemo(() =>
    [...neighborhoods]
      .sort((a,b) => a.median_ppsm - b.median_ppsm)
      .slice(0, 25)
      .map(n => ({ ...n, fill: getZoneColor(n.neighborhood) }))
  , [neighborhoods]);

  // Zone distribution
  const zoneData = useMemo(() => {
    const zones = {};
    properties.forEach(p => {
      const z = getZone(p.neighborhood);
      zones[z] = (zones[z] || 0) + 1;
    });
    return Object.entries(zones).map(([name, value]) => ({
      name, value, fill: ZONES[name]?.color || "#94a3b8"
    }));
  }, [properties]);

  const addKeyword = (kw) => {
    const k = kw.trim().toLowerCase();
    if (k && !searchKeywords.includes(k)) setSearchKeywords([...searchKeywords, k]);
    setSearchText("");
  };

  const QUICK_KEYWORDS = ["refaccionar","pileta","cochera","terraza","jardín","parrilla","escritura","reciclada","ph","lote propio","quincho","luminosa"];

  const totalProps = properties.length;
  const usdProps = properties.filter(p => p.currency === "USD" && p.price > 10000 && p.price < 5000000);
  const medianPrice = usdProps.length > 0 ? usdProps.sort((a,b) => a.price - b.price)[Math.floor(usdProps.length/2)]?.price : 0;

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center">
        <div className="text-center">
          <RefreshCw size={40} className="text-cyan-400 animate-spin mx-auto mb-4" />
          <p className="text-gray-400">Cargando datos del mercado...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      {/* Header */}
      <div className="border-b border-gray-800 bg-gray-950">
        <div className="max-w-7xl mx-auto px-4 py-6">
          <div className="flex items-center justify-between flex-wrap gap-4">
            <div>
              <h1 className="text-2xl font-bold text-cyan-400">CABA Market Study</h1>
              <p className="text-gray-500 text-sm">
                {totalProps.toLocaleString()} propiedades activas &middot; {neighborhoods.length} barrios &middot; Actualizado {lastUpdate?.toLocaleTimeString("es-AR")}
              </p>
            </div>
            <div className="flex gap-2">
              {["overview","search","deals"].map(tab => (
                <button key={tab} onClick={() => setActiveTab(tab)}
                  className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${activeTab === tab ? "bg-cyan-900 text-cyan-300" : "bg-gray-800 text-gray-400 hover:text-gray-200"}`}>
                  {tab === "overview" ? "📊 Overview" : tab === "search" ? "🔍 Super Search" : "⭐ Oportunidades"}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 py-6">
        {/* ============ OVERVIEW TAB ============ */}
        {activeTab === "overview" && (
          <div className="space-y-6">
            {/* KPIs */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <KPI icon={Home} label="Propiedades" value={totalProps.toLocaleString()} sub="Casas en venta CABA" />
              <KPI icon={DollarSign} label="Mediana Precio" value={fmtUSD(medianPrice)} sub="Casas en USD" color="#4ade80" />
              <KPI icon={MapPin} label="Barrios" value={neighborhoods.length} sub="Con 5+ propiedades" color="#fb923c" />
              <KPI icon={AlertTriangle} label="Oportunidades" value={opportunities.length} sub="Detectadas por AI" color="#f472b6" />
            </div>

            {/* AI Insights */}
            <div className="bg-gray-900 rounded-xl border border-gray-800 p-6">
              <div className="flex items-center gap-2 mb-4">
                <Sparkles size={20} className="text-yellow-400" />
                <h2 className="text-lg font-semibold text-yellow-400">Análisis AI del Mercado</h2>
              </div>
              <div className="grid md:grid-cols-2 gap-4">
                {insights.map((ins, i) => (
                  <div key={i} className="bg-gray-800 rounded-lg p-4 border border-gray-700">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-lg">{ins.icon}</span>
                      <span className="font-semibold text-sm text-gray-200">{ins.title}</span>
                    </div>
                    <p className="text-sm text-gray-400 leading-relaxed">{ins.text}</p>
                  </div>
                ))}
              </div>
            </div>

            {/* Neighborhood Chart */}
            <div className="bg-gray-900 rounded-xl border border-gray-800 p-6">
              <h2 className="text-lg font-semibold text-cyan-400 mb-1">Precio por m² por Barrio</h2>
              <p className="text-sm text-gray-500 mb-4">Mediana USD/m² — Top 25 barrios con más listados</p>
              <div className="flex gap-4 mb-4 flex-wrap">
                {Object.entries(ZONES).map(([z, d]) => (
                  <div key={z} className="flex items-center gap-2 text-sm">
                    <div className="w-3 h-3 rounded-full" style={{ background: d.color }} />
                    <span className="text-gray-400">{z}</span>
                  </div>
                ))}
              </div>
              <ResponsiveContainer width="100%" height={600}>
                <BarChart data={chartData} layout="vertical" margin={{ left: 120, right: 30 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                  <XAxis type="number" stroke="#64748b" tickFormatter={v => `$${v}`} />
                  <YAxis type="category" dataKey="neighborhood" stroke="#94a3b8" width={110} tick={{ fontSize: 12 }} />
                  <Tooltip
                    contentStyle={{ background: "#1a1f3a", border: "1px solid #334155", borderRadius: 8 }}
                    formatter={(v, name) => [fmtUSD(v), "Mediana USD/m²"]}
                    labelFormatter={l => `${l} (${chartData.find(c => c.neighborhood === l)?.count || 0} props)`}
                  />
                  <Bar dataKey="median_ppsm" radius={[0, 4, 4, 0]}>
                    {chartData.map((d, i) => <Cell key={i} fill={d.fill} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>

            {/* Zone Distribution */}
            <div className="grid md:grid-cols-2 gap-6">
              <div className="bg-gray-900 rounded-xl border border-gray-800 p-6">
                <h2 className="text-lg font-semibold text-cyan-400 mb-4">Distribución por Zona</h2>
                <ResponsiveContainer width="100%" height={250}>
                  <PieChart>
                    <Pie data={zoneData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={90} label={({ name, percent }) => `${name} ${(percent*100).toFixed(0)}%`}>
                      {zoneData.map((d, i) => <Cell key={i} fill={d.fill} />)}
                    </Pie>
                    <Tooltip contentStyle={{ background: "#1a1f3a", border: "1px solid #334155", borderRadius: 8 }} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div className="bg-gray-900 rounded-xl border border-gray-800 p-6">
                <h2 className="text-lg font-semibold text-cyan-400 mb-4">Top 10 Barrios por Cantidad</h2>
                <div className="space-y-2">
                  {neighborhoods.slice(0, 10).map((n, i) => (
                    <div key={i} className="flex items-center gap-3">
                      <span className="text-xs text-gray-500 w-5">{i+1}</span>
                      <div className="w-3 h-3 rounded-full" style={{ background: getZoneColor(n.neighborhood) }} />
                      <span className="text-sm flex-1">{n.neighborhood}</span>
                      <span className="text-sm text-gray-400">{n.count}</span>
                      <span className="text-xs text-cyan-400">${Math.round(n.median_ppsm)}/m²</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ============ SUPER SEARCH TAB ============ */}
        {activeTab === "search" && (
          <div className="space-y-4">
            {/* Search Bar */}
            <div className="bg-gray-900 rounded-xl border border-gray-800 p-5">
              <div className="flex items-center gap-2 mb-3">
                <Search size={20} className="text-cyan-400" />
                <h2 className="text-lg font-semibold text-cyan-400">Super Searcher</h2>
                <span className="text-sm text-gray-500 ml-2">{filtered.length} resultados</span>
              </div>

              {/* Main search input */}
              <div className="flex gap-2 mb-3">
                <div className="flex-1 relative">
                  <input
                    type="text" value={searchText}
                    onChange={e => setSearchText(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter" && searchText.trim()) { addKeyword(searchText); } }}
                    placeholder="Buscar por palabras clave... (Enter para agregar filtro)"
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-3 text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-cyan-500"
                  />
                </div>
                <button onClick={() => setShowFilters(!showFilters)}
                  className="px-4 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-gray-400 hover:text-cyan-400 flex items-center gap-1">
                  <Filter size={16} />
                  {showFilters ? <ChevronUp size={16}/> : <ChevronDown size={16}/>}
                </button>
              </div>

              {/* Active keyword pills */}
              {searchKeywords.length > 0 && (
                <div className="flex flex-wrap gap-2 mb-3">
                  {searchKeywords.map((kw, i) => <Pill key={i} label={kw} onRemove={() => setSearchKeywords(searchKeywords.filter((_,j) => j !== i))} />)}
                  <button onClick={() => setSearchKeywords([])} className="text-xs text-gray-500 hover:text-red-400">Limpiar todo</button>
                </div>
              )}

              {/* Quick keyword buttons */}
              <div className="flex flex-wrap gap-1.5 mb-3">
                {QUICK_KEYWORDS.map(kw => (
                  <button key={kw} onClick={() => addKeyword(kw)}
                    className={`px-2.5 py-1 rounded-full text-xs border transition-all ${searchKeywords.includes(kw) ? "bg-cyan-900 border-cyan-600 text-cyan-300" : "bg-gray-800 border-gray-700 text-gray-400 hover:border-cyan-700 hover:text-cyan-400"}`}>
                    {kw}
                  </button>
                ))}
              </div>

              {/* Advanced filters */}
              {showFilters && (
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 pt-3 border-t border-gray-800">
                  <div>
                    <label className="text-xs text-gray-500 mb-1 block">Precio mín (USD)</label>
                    <input type="number" value={priceRange[0]} onChange={e => setPriceRange([+e.target.value, priceRange[1]])}
                      className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-300" />
                  </div>
                  <div>
                    <label className="text-xs text-gray-500 mb-1 block">Precio máx (USD)</label>
                    <input type="number" value={priceRange[1]} onChange={e => setPriceRange([priceRange[0], +e.target.value])}
                      className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-300" />
                  </div>
                  <div>
                    <label className="text-xs text-gray-500 mb-1 block">m² mín</label>
                    <input type="number" value={areaRange[0]} onChange={e => setAreaRange([+e.target.value, areaRange[1]])}
                      className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-300" />
                  </div>
                  <div>
                    <label className="text-xs text-gray-500 mb-1 block">m² máx</label>
                    <input type="number" value={areaRange[1]} onChange={e => setAreaRange([areaRange[0], +e.target.value])}
                      className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-300" />
                  </div>
                  <div>
                    <label className="text-xs text-gray-500 mb-1 block">Zona</label>
                    <select value={selectedZone} onChange={e => { setSelectedZone(e.target.value); setSelectedBarrio("all"); }}
                      className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-300">
                      <option value="all">Todas</option>
                      {Object.keys(ZONES).map(z => <option key={z} value={z}>{z}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="text-xs text-gray-500 mb-1 block">Barrio</label>
                    <select value={selectedBarrio} onChange={e => setSelectedBarrio(e.target.value)}
                      className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-300">
                      <option value="all">Todos</option>
                      {(selectedZone !== "all" ? ZONES[selectedZone]?.barrios || [] : neighborhoods.map(n => n.neighborhood))
                        .sort().map(b => <option key={b} value={b}>{b}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="text-xs text-gray-500 mb-1 block">Ordenar por</label>
                    <select value={sortBy} onChange={e => setSortBy(e.target.value)}
                      className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-300">
                      <option value="price_per_sqm">Mejor USD/m²</option>
                      <option value="price_asc">Precio: menor a mayor</option>
                      <option value="price_desc">Precio: mayor a menor</option>
                      <option value="area_desc">Más superficie</option>
                    </select>
                  </div>
                </div>
              )}
            </div>

            {/* Results */}
            <div className="space-y-2">
              {filtered.slice(0, 50).map((p, i) => (
                <div key={p.id} className="bg-gray-900 rounded-lg border border-gray-800 p-4 hover:border-gray-600 transition-colors">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        {p.price_per_sqm && p.price_per_sqm < 900 && <Star size={14} className="text-yellow-400 flex-shrink-0" />}
                        <h3 className="text-sm font-medium text-gray-200 truncate">{p.title}</h3>
                      </div>
                      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-400">
                        <span className="flex items-center gap-1"><MapPin size={12} />{p.neighborhood}</span>
                        {p.total_area && <span className="flex items-center gap-1"><Ruler size={12} />{p.total_area}m²</span>}
                        {p.ambientes && <span>{p.ambientes} amb</span>}
                        {p.bedrooms && <span>{p.bedrooms} dorm</span>}
                        {p.bathrooms && <span>{p.bathrooms} baños</span>}
                      </div>
                      {p.keywords && p.keywords.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-2">
                          {p.keywords.map((kw, j) => (
                            <span key={j} className="text-[10px] bg-gray-800 text-gray-500 px-1.5 py-0.5 rounded">{kw}</span>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="text-right flex-shrink-0">
                      <div className="text-lg font-bold text-green-400">{fmtUSD(p.price)}</div>
                      {p.price_per_sqm && (
                        <div className={`text-xs font-medium ${p.price_per_sqm < 900 ? "text-yellow-400" : p.price_per_sqm < 1500 ? "text-green-400" : "text-gray-400"}`}>
                          USD {Math.round(p.price_per_sqm)}/m²
                        </div>
                      )}
                      <div className="w-2 h-2 rounded-full ml-auto mt-1" style={{ background: getZoneColor(p.neighborhood) }} />
                    </div>
                  </div>
                </div>
              ))}
              {filtered.length > 50 && (
                <p className="text-center text-gray-500 text-sm py-4">Mostrando 50 de {filtered.length} resultados. Usá los filtros para acotar.</p>
              )}
              {filtered.length === 0 && (
                <div className="text-center py-12 text-gray-500">
                  <Search size={40} className="mx-auto mb-3 opacity-30" />
                  <p>No se encontraron propiedades con esos filtros.</p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ============ DEALS TAB ============ */}
        {activeTab === "deals" && (
          <div className="space-y-6">
            <div className="bg-gray-900 rounded-xl border border-gray-800 p-6">
              <div className="flex items-center gap-2 mb-4">
                <Star size={20} className="text-yellow-400" />
                <h2 className="text-lg font-semibold text-yellow-400">Top Oportunidades</h2>
              </div>
              <p className="text-sm text-gray-500 mb-4">Propiedades con USD/m² significativamente bajo — detectadas automáticamente</p>

              <div className="space-y-3">
                {opportunities.slice(0, 30).map((opp, i) => (
                  <div key={i} className="bg-gray-800 rounded-lg p-4 border border-gray-700">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="flex items-center gap-2 mb-1">
                          <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${opp.severity === "high" ? "bg-red-900 text-red-300" : opp.severity === "medium" ? "bg-yellow-900 text-yellow-300" : "bg-blue-900 text-blue-300"}`}>
                            {opp.severity}
                          </span>
                          <span className="text-xs text-gray-500">{opp.event_type}</span>
                        </div>
                        <h3 className="text-sm font-medium text-gray-200">{opp.title}</h3>
                        <div className="flex gap-4 mt-1 text-xs text-gray-400">
                          {opp.details?.neighborhood && <span>📍 {opp.details.neighborhood}</span>}
                          {opp.details?.price && <span>💰 USD {parseInt(opp.details.price).toLocaleString()}</span>}
                          {opp.details?.price_per_sqm && <span>📐 USD {Math.round(opp.details.price_per_sqm)}/m²</span>}
                          {opp.details?.total_area && <span>🏠 {opp.details.total_area}m²</span>}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Scatter: Price vs Area */}
            <div className="bg-gray-900 rounded-xl border border-gray-800 p-6">
              <h2 className="text-lg font-semibold text-cyan-400 mb-4">Precio vs Superficie (USD, casas activas)</h2>
              <ResponsiveContainer width="100%" height={400}>
                <ScatterChart>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                  <XAxis type="number" dataKey="total_area" name="m²" stroke="#64748b" label={{ value: "m²", position: "bottom", fill: "#64748b" }} domain={[0, 800]} />
                  <YAxis type="number" dataKey="price" name="Precio" stroke="#64748b" tickFormatter={v => `$${fmt(v)}`} domain={[0, 1500000]} />
                  <ZAxis range={[20, 20]} />
                  <Tooltip contentStyle={{ background: "#1a1f3a", border: "1px solid #334155", borderRadius: 8 }}
                    formatter={(v, name) => [name === "Precio" ? fmtUSD(v) : `${v}m²`, name]} />
                  <Scatter name="Propiedades"
                    data={properties.filter(p => p.currency === "USD" && p.price > 30000 && p.price < 1500000 && p.total_area > 20 && p.total_area < 800).slice(0, 500)}
                    fill="#00d4ff" fillOpacity={0.4} />
                </ScatterChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}