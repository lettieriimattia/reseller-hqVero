// AnalyticsExplorer — "Esplora i numeri": un unico cruscotto in cui tutto è collegato.
// Periodo → metrica (tocca un riquadro) → grafico (passa sopra, trascina per ingrandire,
// tocca una barra per i pezzi) → classifiche per reparto/piattaforma/brand (tocca per filtrare
// tutto il resto) → età del magazzino (tocca una fascia per i pezzi fermi).
// Importi sulla quota dell'utente, come la home.
import { useEffect, useRef, useState, type ReactNode, type PointerEvent as RPointerEvent, type KeyboardEvent as RKeyboardEvent } from 'react';
import { X, ArrowUpRight, ArrowDownRight, RotateCcw, ZoomOut, Package } from 'lucide-react';

interface XProduct {
  id: string; category?: string; brand: string; name: string; size?: string; status: string;
  purchasePrice: number; salePrice?: number; fees?: number; platform?: string;
  createdAt?: string; soldAt?: string; photos?: string;
}

type RangeKey = '7d' | '30d' | '90d' | '12m' | 'ytd' | 'all';
type Metric = 'profit' | 'revenue' | 'count' | 'margin' | 'spent';
type Dim = 'category' | 'platform' | 'brand';
type Range = { start: Date; end: Date };
type Bucket = Range & { label: string; tick: string };
type Sel = { kind: 'bucket' | 'aging'; i: number } | null;

interface Props {
  products: XProduct[];
  myProfitFactor: (p: any) => number;
  myCostFactor: (p: any) => number;
  t: (key: string) => string;
  dateLocale: string;
  getCategoryIcon: (cat: any) => ReactNode;
  fullName: (brand?: string, name?: string) => string;
  onOpenProduct: (id: string) => void;
}

const DAY = 86400000;
const RANGES: RangeKey[] = ['7d', '30d', '90d', '12m', 'ytd', 'all'];
const METRICS: Metric[] = ['profit', 'revenue', 'count', 'margin', 'spent'];
const AGING = [
  { from: 0, to: 30, label: '0–30' },
  { from: 31, to: 60, label: '31–60' },
  { from: 61, to: 90, label: '61–90' },
  { from: 91, to: Infinity, label: '90+' },
];
const CHART_H = 210;

const sod = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const dayDiff = (a: Date, b: Date) =>
  Math.round((Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) - Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / DAY);
const reducedMotion = () => { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };
const inR = (d: Date | null, r: Range) => !!d && d >= r.start && d < r.end;
const dateOf = (s?: string) => (s ? new Date(s) : null);
const cap1 = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function firstPhoto(p: XProduct): string | null {
  try {
    const arr = p.photos ? JSON.parse(p.photos) : [];
    const x = Array.isArray(arr) ? arr[0] : null;
    return typeof x === 'string' ? x : x?.url || null;
  } catch { return null; }
}

// Numero che "scorre" verso il nuovo valore quando cambi periodo/filtro.
function useCountUp(value: number) {
  const [v, setV] = useState(value);
  const cur = useRef(value);
  useEffect(() => {
    const from = cur.current;
    if (reducedMotion() || from === value) { cur.current = value; setV(value); return; }
    let raf = 0; const t0 = performance.now(), dur = 550;
    const tick = (now: number) => {
      const x = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - x, 3);
      cur.current = from + (value - from) * e; setV(cur.current);
      if (x < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    const done = setTimeout(() => { cur.current = value; setV(value); }, dur + 120);
    return () => { cancelAnimationFrame(raf); clearTimeout(done); };
  }, [value]);
  return v;
}

export default function AnalyticsExplorer({ products, myProfitFactor, myCostFactor, t, dateLocale, getCategoryIcon, fullName, onOpenProduct }: Props) {
  const [rangeKey, setRangeKey] = useState<RangeKey>('30d');
  const [zoom, setZoom] = useState<Range | null>(null);
  const [metric, setMetric] = useState<Metric>('profit');
  const [filters, setFilters] = useState<Record<Dim, string | null>>({ category: null, platform: null, brand: null });
  const [sel, setSel] = useState<Sel>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [drag, setDrag] = useState<{ a: number; b: number } | null>(null);
  const [sortBy, setSortBy] = useState<'value' | 'date'>('value');
  const [shown, setShown] = useState(20);
  const chartRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setSel(null); setShown(20); }, [rangeKey, zoom, metric, filters]);

  const eur = (n: number) => new Intl.NumberFormat(dateLocale, { style: 'currency', currency: 'EUR', maximumFractionDigits: 0, useGrouping: 'always' as any }).format(Math.round(n) || 0);
  const int = (n: number) => new Intl.NumberFormat(dateLocale, { maximumFractionDigits: 0, useGrouping: 'always' as any }).format(Math.round(n) || 0);
  const pct = (n: number) => `${new Intl.NumberFormat(dateLocale, { maximumFractionDigits: 1, minimumFractionDigits: 1 }).format(n)}%`;
  const fmt = (m: Metric, v: number | null) => (v === null ? '—' : m === 'count' ? int(v) : m === 'margin' ? pct(v) : eur(v));
  const dShort = (d: Date) => d.toLocaleDateString(dateLocale, { day: 'numeric', month: 'short' });
  const pcs = (n: number) => `${int(n)} ${n === 1 ? t('ex.pc') : t('ex.pcs')}`;

  // ---------- Periodo ----------
  const now = new Date();
  const today1 = addDays(sod(now), 1);
  const baseRange = ((): Range => {
    switch (rangeKey) {
      case '7d': return { start: addDays(today1, -7), end: today1 };
      case '30d': return { start: addDays(today1, -30), end: today1 };
      case '90d': return { start: addDays(today1, -90), end: today1 };
      case '12m': return { start: new Date(now.getFullYear(), now.getMonth() - 11, 1), end: today1 };
      case 'ytd': return { start: new Date(now.getFullYear(), 0, 1), end: today1 };
      case 'all': {
        let min = Infinity;
        products.forEach(p => [p.createdAt, p.soldAt].forEach(s => { if (s) { const x = new Date(s).getTime(); if (x < min) min = x; } }));
        const e = isFinite(min) ? new Date(min) : new Date(now.getFullYear(), now.getMonth() - 11, 1);
        return { start: new Date(e.getFullYear(), e.getMonth(), 1), end: today1 };
      }
    }
  })();
  const range = zoom || baseRange;
  const lenDays = Math.max(1, dayDiff(range.start, range.end));
  const prevRange: Range = { start: addDays(range.start, -lenDays), end: range.start };

  // Barre: giorni (≤45 gg), settimane (≤190 gg), altrimenti mesi.
  const buckets: Bucket[] = (() => {
    const out: Bucket[] = [];
    if (lenDays <= 45) {
      for (let d = range.start; d < range.end; d = addDays(d, 1)) out.push({ start: d, end: addDays(d, 1), label: cap1(d.toLocaleDateString(dateLocale, { weekday: 'short', day: 'numeric', month: 'short' })), tick: dShort(d) });
    } else if (lenDays <= 190) {
      for (let d = range.start; d < range.end; d = addDays(d, 7)) {
        const e = addDays(d, 7) < range.end ? addDays(d, 7) : range.end;
        out.push({ start: d, end: e, label: `${dShort(d)} – ${dShort(addDays(e, -1))}`, tick: dShort(d) });
      }
    } else {
      const multiYear = range.start.getFullYear() !== addDays(range.end, -1).getFullYear();
      for (let c = new Date(range.start.getFullYear(), range.start.getMonth(), 1); c < range.end; c = new Date(c.getFullYear(), c.getMonth() + 1, 1)) {
        const s = c < range.start ? range.start : c;
        const nx = new Date(c.getFullYear(), c.getMonth() + 1, 1);
        out.push({
          start: s, end: nx < range.end ? nx : range.end,
          label: cap1(c.toLocaleDateString(dateLocale, { month: 'long', year: 'numeric' })),
          tick: c.toLocaleDateString(dateLocale, multiYear ? { month: 'short', year: '2-digit' } : { month: 'short' }),
        });
      }
    }
    return out;
  })();

  // ---------- Filtri incrociati ----------
  const keyOf = (p: XProduct, d: Dim) => (d === 'category' ? p.category || '—' : d === 'platform' ? p.platform || '—' : (p.brand || '—').trim());
  const labelOf = (d: Dim, k: string) => (k === '—' ? (d === 'platform' ? t('ex.noPlatform') : '—') : k);
  const matches = (p: XProduct, except?: Dim) => (Object.keys(filters) as Dim[]).every(d => d === except || !filters[d] || keyOf(p, d) === filters[d]);
  const toggleFilter = (d: Dim, k: string) => setFilters(f => ({ ...f, [d]: f[d] === k ? null : k }));
  const activeFilters = (Object.keys(filters) as Dim[]).filter(d => filters[d]);

  // ---------- Valori ----------
  const isSold = (p: XProduct) => p.status === 'VENDUTO' && !!p.soldAt;
  const profitOf = (p: XProduct) => ((p.salePrice || 0) - p.purchasePrice - (p.fees || 0)) * myProfitFactor(p);
  const revenueOf = (p: XProduct) => (p.salePrice || 0) * myProfitFactor(p);
  const spentOf = (p: XProduct) => p.purchasePrice * myCostFactor(p);
  // Per ogni metrica: quali pezzi contano (venduti o acquistati) e in quale data.
  const usesPurchases = metric === 'spent';
  const relevant = (p: XProduct) => (usesPurchases ? !!p.createdAt : isSold(p));
  const when = (p: XProduct) => (usesPurchases ? dateOf(p.createdAt) : dateOf(p.soldAt));

  type Agg = { profit: number; revenue: number; count: number; spent: number };
  const agg = (items: XProduct[], soldRange: Range, boughtRange: Range): Agg => {
    const a: Agg = { profit: 0, revenue: 0, count: 0, spent: 0 };
    items.forEach(p => {
      if (isSold(p) && inR(dateOf(p.soldAt), soldRange)) { a.profit += profitOf(p); a.revenue += revenueOf(p); a.count++; }
      if (p.createdAt && inR(dateOf(p.createdAt), boughtRange)) a.spent += spentOf(p);
    });
    return a;
  };
  const valueOf = (a: Agg, m: Metric): number | null => (m === 'margin' ? (a.revenue > 0 ? (a.profit / a.revenue) * 100 : null) : a[m]);

  const pool = products.filter(p => matches(p));
  const cur = agg(pool, range, range);
  const prev = agg(pool, prevRange, prevRange);
  const series = buckets.map(b => {
    const a = agg(pool, b, b);
    const pb: Range = { start: addDays(b.start, -lenDays), end: addDays(b.end, -lenDays) };
    const pa = agg(pool, pb, pb);
    return { agg: a, prevAgg: pa };
  });
  const vals = series.map(s => valueOf(s.agg, metric));
  const prevVals = series.map(s => valueOf(s.prevAgg, metric));
  const hasAny = vals.some(v => v !== null && v !== 0);

  // Scala con lo zero (il profitto può essere negativo).
  const all = [...vals, ...prevVals].filter((v): v is number => v !== null);
  const maxV = Math.max(0, ...all), minV = Math.min(0, ...all);
  const span = maxV - minV || 1;
  const zeroFrac = maxV / span; // quota di altezza sopra lo zero

  // ---------- Grafico: passaggio, trascinamento, tastiera ----------
  const idxAt = (clientX: number) => {
    const r = chartRef.current?.getBoundingClientRect();
    if (!r || buckets.length === 0) return null;
    return Math.max(0, Math.min(buckets.length - 1, Math.floor(((clientX - r.left) / r.width) * buckets.length)));
  };
  const onDown = (e: RPointerEvent) => { const i = idxAt(e.clientX); if (i === null) return; setDrag({ a: i, b: i }); setHover(i); };
  const onMove = (e: RPointerEvent) => { const i = idxAt(e.clientX); if (i === null) return; setHover(i); if (drag) setDrag({ a: drag.a, b: i }); };
  const onUp = () => {
    if (!drag) return;
    const lo = Math.min(drag.a, drag.b), hi = Math.max(drag.a, drag.b);
    setDrag(null);
    if (hi > lo) setZoom({ start: buckets[lo].start, end: buckets[hi].end });
    else setSel(s => (s?.kind === 'bucket' && s.i === lo ? null : { kind: 'bucket', i: lo }));
  };
  const onKey = (e: RKeyboardEvent) => {
    const n = buckets.length; if (!n) return;
    const base = hover ?? (sel?.kind === 'bucket' ? sel.i : n - 1);
    if (e.key === 'ArrowLeft') { e.preventDefault(); setHover(Math.max(0, base - 1)); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); setHover(Math.min(n - 1, base + 1)); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSel({ kind: 'bucket', i: base }); }
    else if (e.key === 'Escape') { setSel(null); setHover(null); }
  };
  const dragLo = drag ? Math.min(drag.a, drag.b) : -1, dragHi = drag ? Math.max(drag.a, drag.b) : -1;
  const tickEvery = Math.max(1, Math.ceil(buckets.length / 7));

  // ---------- Classifiche per dimensione (ignorano il proprio filtro: vedi le alternative) ----------
  const breakdown = (d: Dim) => {
    const m: Record<string, Agg> = {};
    products.filter(p => matches(p, d)).forEach(p => {
      const k = keyOf(p, d);
      if (!m[k]) m[k] = { profit: 0, revenue: 0, count: 0, spent: 0 };
      if (isSold(p) && inR(dateOf(p.soldAt), range)) { m[k].profit += profitOf(p); m[k].revenue += revenueOf(p); m[k].count++; }
      if (p.createdAt && inR(dateOf(p.createdAt), range)) m[k].spent += spentOf(p);
    });
    return Object.entries(m)
      .map(([k, a]) => ({ k, v: valueOf(a, metric), n: usesPurchases ? null : a.count }))
      .filter(r => r.v !== null && (metric === 'margin' ? (r.n || 0) > 0 : r.v !== 0))
      .sort((a, b) => (b.v as number) - (a.v as number));
  };
  const dims: Dim[] = usesPurchases ? ['category', 'brand'] : ['category', 'platform', 'brand'];

  // ---------- Età del magazzino ----------
  const stock = products.filter(p => p.status === 'IN STOCK' && matches(p, 'platform'));
  const ageOf = (p: XProduct) => (p.createdAt ? Math.max(0, dayDiff(new Date(p.createdAt), now)) : 0);
  const aging = AGING.map(b => {
    const items = stock.filter(p => { const a = ageOf(p); return a >= b.from && a <= b.to; });
    return { ...b, items, capital: items.reduce((s, p) => s + spentOf(p), 0) };
  });
  const stockCap = aging.reduce((s, b) => s + b.capital, 0);

  // ---------- Pezzi della selezione ----------
  const selItems: { p: XProduct; v: number; d: Date | null }[] = (() => {
    if (!sel) return [];
    if (sel.kind === 'aging') return aging[sel.i].items.map(p => ({ p, v: spentOf(p), d: dateOf(p.createdAt) }));
    const b = buckets[sel.i]; if (!b) return [];
    return pool.filter(p => relevant(p) && inR(when(p), b)).map(p => ({
      p, d: when(p),
      v: metric === 'revenue' ? revenueOf(p) : metric === 'spent' ? spentOf(p) : metric === 'margin' ? ((p.salePrice || 0) > 0 ? (profitOf(p) / revenueOf(p)) * 100 : 0) : profitOf(p),
    }));
  })().sort((a, b) => (sortBy === 'value' ? b.v - a.v : (b.d?.getTime() || 0) - (a.d?.getTime() || 0)));
  const itemMetric: Metric = sel?.kind === 'aging' ? 'spent' : metric === 'count' ? 'profit' : metric;
  const selTitle = !sel ? '' : sel.kind === 'aging'
    ? `${t('ex.aging')} · ${aging[sel.i].label} ${t('ex.days')}`
    : buckets[sel.i]?.label || '';

  const rangeLabel = `${dShort(range.start)} – ${dShort(addDays(range.end, -1))}${range.start.getFullYear() !== now.getFullYear() ? ` ${range.start.getFullYear()}` : ''}`;
  const hv = hover !== null && !drag ? hover : null;

  return (
    <section className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-4 sm:p-5 space-y-5" aria-label={t('ex.title')}>
      {/* Intestazione + periodo */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <h3 className="font-bold text-lg">{t('ex.title')}</h3>
          <p className="text-xs text-[var(--text-soft)] mt-0.5">{rangeLabel} · <span className="text-[var(--text-faint)]">{t('ex.vsPrev')}</span></p>
        </div>
        <div role="tablist" aria-label={t('ex.period')} className="flex items-center gap-0.5 p-0.5 rounded-lg bg-[var(--surface-2)] border border-[var(--border)] overflow-x-auto max-w-full">
          {RANGES.map(k => (
            <button key={k} role="tab" aria-selected={!zoom && rangeKey === k} onClick={() => { setZoom(null); setRangeKey(k); }}
              className={`px-2.5 py-1.5 rounded-md text-xs font-bold whitespace-nowrap transition-colors ${!zoom && rangeKey === k ? 'bg-[var(--text)] text-[var(--bg)]' : 'text-[var(--text-soft)] hover:text-[var(--text)]'}`}>
              {t(`ex.r.${k}`)}
            </button>
          ))}
        </div>
      </div>

      {/* Filtri attivi */}
      {(activeFilters.length > 0 || zoom) && (
        <div className="flex items-center gap-2 flex-wrap">
          {zoom && (
            <button onClick={() => setZoom(null)} className="flex items-center gap-1.5 pl-2.5 pr-2 py-1 rounded-full text-xs font-bold bg-brand/15 text-brand-hi border border-brand/30 hover:bg-brand/25 transition-colors">
              <ZoomOut size={12} /> {t('ex.zoomOut')}
            </button>
          )}
          {activeFilters.map(d => (
            <button key={d} onClick={() => toggleFilter(d, filters[d]!)} className="flex items-center gap-1.5 pl-2.5 pr-1.5 py-1 rounded-full text-xs font-bold bg-[var(--surface-2)] border border-[var(--border-2)] hover:border-[var(--border-3)] transition-colors">
              <span className="text-[var(--text-faint)] font-medium">{t(`ex.dim.${d}`)}:</span> {labelOf(d, filters[d]!)} <X size={12} className="text-[var(--text-faint)]" />
            </button>
          ))}
          {activeFilters.length > 1 && (
            <button onClick={() => setFilters({ category: null, platform: null, brand: null })} className="flex items-center gap-1 text-xs text-[var(--text-soft)] hover:text-[var(--text)] px-1.5">
              <RotateCcw size={12} /> {t('ex.reset')}
            </button>
          )}
        </div>
      )}

      {/* Metriche: tocca per mostrarla nel grafico */}
      <div role="tablist" aria-label={t('ex.metric')} className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
        {METRICS.map(m => (
          <MetricTile key={m} m={m} active={metric === m} onClick={() => setMetric(m)}
            value={valueOf(cur, m)} prev={valueOf(prev, m)} spark={series.map(s => valueOf(s.agg, m))}
            label={t(`ex.m.${m}`)} fmt={fmt} t={t} sub={m === 'count' ? null : m === 'spent' ? null : `${int(cur.count)} ${cur.count === 1 ? t('ex.sale') : t('ex.sales')}`} />
        ))}
      </div>

      {/* Grafico */}
      <div>
        <div className="relative">
          <div ref={chartRef} tabIndex={0} role="application"
            aria-label={`${t(`ex.m.${metric}`)} · ${t('ex.dragHint')}`}
            className="relative flex items-stretch gap-[2px] select-none outline-none rounded-lg focus-visible:ring-2 focus-visible:ring-brand/60 cursor-crosshair"
            style={{ height: CHART_H, touchAction: 'pan-y' }}
            onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}
            onPointerLeave={() => { if (!drag) setHover(null); }} onPointerCancel={() => setDrag(null)} onKeyDown={onKey}>
            {/* linea dello zero */}
            <div className="absolute left-0 right-0 border-t border-[var(--border-2)] pointer-events-none" style={{ top: `${zeroFrac * 100}%` }} />
            {buckets.map((b, i) => {
              const v = vals[i], pv = prevVals[i];
              const h = v === null ? 0 : (Math.abs(v) / span) * 100;
              const neg = (v ?? 0) < 0;
              const isSel = sel?.kind === 'bucket' && sel.i === i;
              const inDrag = i >= dragLo && i <= dragHi;
              const dim = sel?.kind === 'bucket' && !isSel;
              return (
                <div key={b.start.getTime()} className={`relative flex-1 min-w-0 rounded-sm transition-colors ${inDrag ? 'bg-brand/15' : hv === i ? 'bg-[var(--fill)]' : ''}`}>
                  {v !== null && v !== 0 && (
                    <div className="absolute left-[12%] right-[12%] rounded-[3px] transition-all duration-500 ease-out motion-reduce:transition-none"
                      style={{
                        height: `${h}%`,
                        top: neg ? `${zeroFrac * 100}%` : `${(zeroFrac - Math.abs(v) / span) * 100}%`,
                        background: neg ? 'var(--down)' : 'var(--accent)',
                        opacity: dim ? 0.35 : 1,
                        outline: isSel ? '2px solid var(--text)' : undefined, outlineOffset: 1,
                      }} />
                  )}
                  {pv !== null && pv !== 0 && (
                    <div className="absolute left-[4%] right-[4%] h-[2px] rounded-full pointer-events-none transition-all duration-500 motion-reduce:transition-none"
                      style={{ top: `${(zeroFrac - pv / span) * 100}%`, background: 'var(--text-faint)', opacity: 0.8 }} />
                  )}
                </div>
              );
            })}
            {!hasAny && (
              <div className="absolute inset-0 flex items-center justify-center text-sm text-[var(--text-soft)] pointer-events-none">{t('ex.empty')}</div>
            )}
          </div>

          {/* Tooltip */}
          {hv !== null && buckets[hv] && (
            <div className="absolute z-10 pointer-events-none top-1"
              style={{ left: `${((hv + 0.5) / buckets.length) * 100}%`, transform: `translateX(${hv / buckets.length > 0.5 ? 'calc(-100% - 14px)' : '14px'})` }}>
              <div className="bg-[var(--surface-2)] border border-[var(--border-2)] rounded-lg shadow-xl px-3 py-2 min-w-[170px]">
                <p className="text-[11px] text-[var(--text-soft)] whitespace-nowrap">{buckets[hv].label}</p>
                <p className="text-lg font-extrabold num leading-tight">{fmt(metric, vals[hv])}</p>
                <div className="flex items-center justify-between gap-3 text-[11px] mt-1">
                  <span className="text-[var(--text-faint)]">{t('ex.prev')}</span>
                  <span className="num text-[var(--text-soft)]">{fmt(metric, prevVals[hv])}</span>
                </div>
                {!usesPurchases && (
                  <div className="flex items-center justify-between gap-3 text-[11px]">
                    <span className="text-[var(--text-faint)]">{t('ex.sales')}</span>
                    <span className="num text-[var(--text-soft)]">{int(series[hv].agg.count)}</span>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
        {/* Asse del tempo */}
        <div className="flex gap-[2px] mt-1.5">
          {buckets.map((b, i) => (
            <span key={b.start.getTime()} className="flex-1 min-w-0 text-[10px] text-[var(--text-faint)] text-center whitespace-nowrap overflow-visible">
              {i % tickEvery === 0 ? b.tick : ''}
            </span>
          ))}
        </div>
        <div className="flex items-center justify-between gap-3 mt-2 flex-wrap">
          <div className="flex items-center gap-3 text-[11px] text-[var(--text-soft)]">
            <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-[2px]" style={{ background: 'var(--accent)' }} />{t(`ex.m.${metric}`)}</span>
            <span className="flex items-center gap-1.5"><span className="w-3 h-[2px] rounded-full" style={{ background: 'var(--text-faint)' }} />{t('ex.prev')}</span>
          </div>
          <p className="text-[11px] text-[var(--text-faint)]">{t('ex.dragHint')}</p>
        </div>
      </div>

      {/* Pezzi della selezione */}
      {sel && (
        <SelectionList title={selTitle} items={selItems} metric={itemMetric} fmt={fmt} t={t} sortBy={sortBy} setSortBy={setSortBy}
          shown={shown} setShown={setShown} onClose={() => setSel(null)} onOpen={onOpenProduct} fullName={fullName} dShort={dShort} />
      )}

      {/* Classifiche: tocca per filtrare tutto */}
      <div className={`grid grid-cols-1 gap-3 ${dims.length === 3 ? 'md:grid-cols-3' : 'md:grid-cols-2'}`}>
        {dims.map(d => {
          const rows = breakdown(d);
          const top = rows.slice(0, 6);
          const maxAbs = Math.max(...top.map(r => Math.abs(r.v as number)), 1);
          const total = rows.reduce((s, r) => s + Math.max(0, r.v as number), 0);
          return (
            <div key={d} className="bg-[var(--surface-2)] border border-[var(--border)] rounded-xl p-3">
              <p className="text-[10px] uppercase tracking-widest text-[var(--text-faint)] font-bold mb-2">{t(`ex.by.${d}`)}</p>
              {top.length === 0 ? (
                <p className="text-xs text-[var(--text-soft)] py-3">{t('ex.empty')}</p>
              ) : (
                <ul className="space-y-0.5">
                  {top.map(r => {
                    const on = filters[d] === r.k;
                    const off = !!filters[d] && !on;
                    const v = r.v as number;
                    return (
                      <li key={r.k}>
                        <button onClick={() => toggleFilter(d, r.k)} aria-pressed={on}
                          className={`w-full text-left px-2 py-1.5 rounded-lg transition-colors ${on ? 'bg-brand/15 ring-1 ring-brand/40' : 'hover:bg-[var(--fill)]'} ${off ? 'opacity-45 hover:opacity-100' : ''}`}>
                          <div className="flex items-center gap-2 text-xs">
                            {d === 'category' && <span className="shrink-0 opacity-80">{getCategoryIcon(r.k)}</span>}
                            <span className="font-bold truncate flex-1">{labelOf(d, r.k)}</span>
                            <span className="num font-bold">{fmt(metric, v)}</span>
                            {metric !== 'margin' && total > 0 && v > 0 && <span className="num text-[10px] text-[var(--text-faint)] w-8 text-right">{Math.round((v / total) * 100)}%</span>}
                          </div>
                          <div className="h-1.5 mt-1 rounded-full bg-[var(--fill)] overflow-hidden">
                            <div className="h-full rounded-full transition-all duration-500 motion-reduce:transition-none"
                              style={{ width: `${(Math.abs(v) / maxAbs) * 100}%`, background: v < 0 ? 'var(--down)' : on ? 'var(--accent)' : 'var(--text-faint)' }} />
                          </div>
                        </button>
                      </li>
                    );
                  })}
                  {rows.length > top.length && <li className="text-[10px] text-[var(--text-faint)] px-2 pt-1">+{rows.length - top.length} {t('ex.others')}</li>}
                </ul>
              )}
            </div>
          );
        })}
      </div>

      {/* Età del magazzino */}
      <div className="bg-[var(--surface-2)] border border-[var(--border)] rounded-xl p-3 sm:p-4">
        <div className="flex items-baseline justify-between gap-3 flex-wrap mb-3">
          <div>
            <p className="text-[10px] uppercase tracking-widest text-[var(--text-faint)] font-bold">{t('ex.aging')}</p>
            <p className="text-[11px] text-[var(--text-soft)] mt-0.5">{t('ex.agingSub')}</p>
          </div>
          <p className="text-sm"><span className="text-[var(--text-faint)] text-xs">{t('ex.stockCap')} </span><span className="font-extrabold num">{eur(stockCap)}</span></p>
        </div>
        {stockCap <= 0 ? (
          <p className="text-xs text-[var(--text-soft)]">{t('ex.noStock')}</p>
        ) : (
          <>
            <div className="flex h-9 rounded-lg overflow-hidden gap-[2px]">
              {aging.map((b, i) => b.capital > 0 && (
                <button key={b.label} onClick={() => setSel(s => (s?.kind === 'aging' && s.i === i ? null : { kind: 'aging', i }))}
                  aria-pressed={sel?.kind === 'aging' && sel.i === i}
                  title={`${b.label} ${t('ex.days')} · ${eur(b.capital)} · ${pcs(b.items.length)}`}
                  className="h-full transition-all duration-300 hover:brightness-110 motion-reduce:transition-none"
                  style={{
                    width: `${(b.capital / stockCap) * 100}%`, minWidth: 6,
                    background: `color-mix(in srgb, var(--accent) ${[30, 55, 78, 100][i]}%, var(--surface))`,
                    outline: sel?.kind === 'aging' && sel.i === i ? '2px solid var(--text)' : undefined, outlineOffset: -2,
                    opacity: sel?.kind === 'aging' && sel.i !== i ? 0.45 : 1,
                  }} />
              ))}
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-3">
              {aging.map((b, i) => (
                <button key={b.label} onClick={() => b.items.length && setSel(s => (s?.kind === 'aging' && s.i === i ? null : { kind: 'aging', i }))}
                  disabled={!b.items.length}
                  className={`text-left rounded-lg px-2.5 py-2 border transition-colors disabled:opacity-40 ${sel?.kind === 'aging' && sel.i === i ? 'border-brand/50 bg-brand/10' : 'border-[var(--border)] hover:border-[var(--border-2)]'}`}>
                  <span className="flex items-center gap-1.5 text-[11px] text-[var(--text-soft)]">
                    <span className="w-2.5 h-2.5 rounded-[2px]" style={{ background: `color-mix(in srgb, var(--accent) ${[30, 55, 78, 100][i]}%, var(--surface))` }} />
                    {b.label} {t('ex.days')}
                  </span>
                  <span className="block font-extrabold num text-sm mt-0.5">{eur(b.capital)}</span>
                  <span className="block text-[10px] text-[var(--text-faint)]">{pcs(b.items.length)}</span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </section>
  );
}

function MetricTile({ m, active, onClick, value, prev, spark, label, fmt, t, sub }: {
  m: Metric; active: boolean; onClick: () => void; value: number | null; prev: number | null; spark: (number | null)[];
  label: string; fmt: (m: Metric, v: number | null) => string; t: (k: string) => string; sub: string | null;
}) {
  const shownVal = useCountUp(value ?? 0);
  // Delta: per il margine in punti, per il resto in % sul periodo precedente.
  let delta: { txt: string; up: boolean } | null = null;
  if (value !== null && prev !== null) {
    if (m === 'margin') { const d = value - prev; if (Math.abs(d) >= 0.05) delta = { txt: `${d > 0 ? '+' : ''}${d.toFixed(1)} ${t('ex.pts')}`, up: d > 0 }; }
    else if (prev !== 0) { const d = ((value - prev) / Math.abs(prev)) * 100; if (Math.abs(d) >= 0.5) delta = { txt: `${d > 0 ? '+' : ''}${Math.round(d)}%`, up: d > 0 }; }
  }
  // Spendere di più non è "bene" né "male": per Acquistato il delta resta neutro.
  const tone = !delta ? '' : m === 'spent' ? 'text-[var(--text-soft)]' : delta.up ? 'text-[var(--up)]' : 'text-[var(--down)]';
  const pts = spark.map(v => v ?? 0);
  const mx = Math.max(...pts, 0), mn = Math.min(...pts, 0), sp = mx - mn || 1;
  const path = pts.length > 1 ? pts.map((v, i) => `${(i / (pts.length - 1)) * 100},${28 - ((v - mn) / sp) * 26 - 1}`).join(' ') : '';
  return (
    <button role="tab" aria-selected={active} onClick={onClick}
      className={`relative text-left rounded-xl p-3 border transition-all duration-200 overflow-hidden ${active ? 'border-brand/60 bg-brand/[0.08] shadow-[0_0_0_1px_rgba(var(--brand-rgb),0.25)]' : 'border-[var(--border)] bg-[var(--surface-2)] hover:border-[var(--border-2)] hover:-translate-y-[1px]'}`}>
      <p className="text-[10px] uppercase tracking-widest font-bold text-[var(--text-faint)] truncate">{label}</p>
      <p className={`text-xl sm:text-2xl font-extrabold num mt-1 leading-none ${m === 'profit' && (value ?? 0) < 0 ? 'text-[var(--down)]' : ''}`}>{value === null ? '—' : fmt(m, shownVal)}</p>
      <div className="flex items-center gap-1.5 mt-1.5 min-h-[16px] text-[11px]">
        {delta ? (
          <span className={`flex items-center gap-0.5 font-bold num ${tone}`}>{delta.up ? <ArrowUpRight size={12} /> : <ArrowDownRight size={12} />}{delta.txt}</span>
        ) : <span className="text-[var(--text-faint)]">—</span>}
        {sub && <span className="text-[var(--text-faint)] truncate">· {sub}</span>}
      </div>
      {path && (
        <svg viewBox="0 0 100 28" preserveAspectRatio="none" className="w-full h-6 mt-1.5" aria-hidden>
          <polyline points={path} fill="none" stroke={active ? 'var(--accent)' : 'var(--text-faint)'} strokeWidth={1.6} vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
        </svg>
      )}
    </button>
  );
}

function SelectionList({ title, items, metric, fmt, t, sortBy, setSortBy, shown, setShown, onClose, onOpen, fullName, dShort }: {
  title: string; items: { p: XProduct; v: number; d: Date | null }[]; metric: Metric;
  fmt: (m: Metric, v: number | null) => string; t: (k: string) => string;
  sortBy: 'value' | 'date'; setSortBy: (s: 'value' | 'date') => void; shown: number; setShown: (n: number) => void;
  onClose: () => void; onOpen: (id: string) => void; fullName: (b?: string, n?: string) => string; dShort: (d: Date) => string;
}) {
  return (
    <div className="bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl overflow-hidden">
      <div className="flex items-center justify-between gap-2 px-3 py-2.5 border-b border-[var(--border)]">
        <div className="min-w-0">
          <p className="text-sm font-bold truncate">{title}</p>
          <p className="text-[11px] text-[var(--text-faint)]">{items.length} {items.length === 1 ? t('ex.pc') : t('ex.pcs')}</p>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {(['value', 'date'] as const).map(s => (
            <button key={s} onClick={() => setSortBy(s)} className={`px-2 py-1 rounded-md text-[11px] font-bold ${sortBy === s ? 'bg-[var(--fill)] text-[var(--text)]' : 'text-[var(--text-faint)] hover:text-[var(--text)]'}`}>{t(`ex.sort.${s}`)}</button>
          ))}
          <button onClick={onClose} aria-label={t('ex.close')} className="w-8 h-8 flex items-center justify-center rounded-md hover:bg-[var(--fill)] text-[var(--text-soft)]"><X size={15} /></button>
        </div>
      </div>
      {items.length === 0 ? (
        <p className="text-xs text-[var(--text-soft)] px-3 py-4">{t('ex.noItems')}</p>
      ) : (
        <ul className="divide-y divide-[var(--border)] max-h-[360px] overflow-y-auto">
          {items.slice(0, shown).map(({ p, v, d }) => {
            const ph = firstPhoto(p);
            return (
              <li key={p.id}>
                <button onClick={() => onOpen(p.id)} className="w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-[var(--fill)] transition-colors">
                  <span className="w-9 h-9 rounded-md bg-[var(--fill)] overflow-hidden shrink-0 flex items-center justify-center">
                    {ph ? <img src={ph} alt="" className="w-full h-full object-cover" loading="lazy" /> : <Package size={15} className="text-[var(--text-faint)]" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-xs font-bold truncate">{fullName(p.brand, p.name)}</span>
                    <span className="block text-[10px] text-[var(--text-faint)] truncate">{[d ? dShort(d) : null, p.size, p.platform, p.category].filter(Boolean).join(' · ')}</span>
                  </span>
                  <span className={`text-xs font-extrabold num shrink-0 ${metric === 'profit' && v < 0 ? 'text-[var(--down)]' : ''}`}>{fmt(metric, v)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {items.length > shown && (
        <button onClick={() => setShown(shown + 20)} className="w-full py-2 text-xs font-bold text-[var(--text-soft)] hover:text-[var(--text)] border-t border-[var(--border)]">{t('ex.showMore')} ({items.length - shown})</button>
      )}
    </div>
  );
}
