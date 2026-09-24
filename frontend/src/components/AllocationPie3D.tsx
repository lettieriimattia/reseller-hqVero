// AllocationPie3D — torta 3D del MAGAZZINO ATTUALE (solo pezzi IN STOCK oggi), divisa per reparto.
// Due torte, a scelta: CAPITALE (quanto ho pagato IO, cioè costo d'acquisto × mia quota) e QUANTITÀ
// (numero di pezzi). Al centro il totale del magazzino; toccando una fetta (o la riga del reparto)
// la fetta si solleva e a lato compaiono valore, pezzi e % sul totale.
// Il colore segue il REPARTO, non la posizione: resta lo stesso quando cambi torta.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

interface PieProduct { category?: string; purchasePrice: number; status: string }

type Criterion = 'capital' | 'qty';

interface Props {
  products: PieProduct[];
  myCostFactor: (p: any) => number;
  t: (key: string) => string;
  dateLocale: string;
  getCategoryIcon: (cat: any) => ReactNode;
}

const MAX_NAMED = 6; // colori categoriali disponibili; il resto confluisce in "Altro"
const OTHER = '__other__';

// Geometria (unità del viewBox)
const W = 360, H = 236, CX = 180, CY = 98, RX = 158, RY = 86, DEPTH = 26, LIFT = 12;
const pt = (a: number, dy = 0) => [CX + RX * Math.cos(a), CY + RY * Math.sin(a) + dy] as const;

const reducedMotion = () => {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
};

export default function AllocationPie3D({ products, myCostFactor, t, dateLocale, getCategoryIcon }: Props) {
  const [criterion, setCriterion] = useState<Criterion>('capital');
  const [hover, setHover] = useState<string | null>(null);
  const boxRef = useRef<HTMLElement>(null);
  // Tocco fuori dalla torta → chiude il dettaglio del reparto (utile col dito, dove non c'è "mouse che esce").
  useEffect(() => {
    if (!hover) return;
    const out = (e: PointerEvent) => { if (boxRef.current && !boxRef.current.contains(e.target as Node)) setHover(null); };
    document.addEventListener('pointerdown', out);
    return () => document.removeEventListener('pointerdown', out);
  }, [hover]);

  const eur = (n: number) => new Intl.NumberFormat(dateLocale, { style: 'currency', currency: 'EUR', maximumFractionDigits: 0, useGrouping: 'always' as any }).format(Math.round(n) || 0);
  const int = (n: number) => new Intl.NumberFormat(dateLocale, { maximumFractionDigits: 0, useGrouping: 'always' as any }).format(Math.round(n) || 0);
  const pcs = (v: number) => `${int(v)} ${Math.round(v) === 1 ? t('pie.pc') : t('pie.pcs')}`;
  const fmt = (v: number) => (criterion === 'capital' ? eur(v) : pcs(v));

  const stock = useMemo(() => products.filter(p => p.status === 'IN STOCK'), [products]);
  // Ordine STABILE dei reparti (per capitale in magazzino): decide colore e chi finisce in "Altro".
  const ranking = useMemo(() => {
    const tot: Record<string, number> = {};
    stock.forEach(p => { const c = p.category || '—'; tot[c] = (tot[c] || 0) + (p.purchasePrice || 0); });
    return Object.keys(tot).sort((a, b) => tot[b] - tot[a] || a.localeCompare(b));
  }, [stock]);
  const named = ranking.slice(0, MAX_NAMED);
  const colorOf = (key: string) => (key === OTHER ? 'var(--series-other)' : `var(--series-${named.indexOf(key) + 1})`);
  const labelOf = (key: string) => (key === OTHER ? t('pie.other') : key);

  // Per ogni reparto: capitale (quanto ho pagato io) e numero di pezzi in magazzino.
  const { cap, qty } = useMemo(() => {
    const c: Record<string, number> = {}, q: Record<string, number> = {};
    stock.forEach(p => {
      const cat = p.category || '—';
      const key = named.includes(cat) ? cat : OTHER;
      c[key] = (c[key] || 0) + (p.purchasePrice || 0) * myCostFactor(p);
      q[key] = (q[key] || 0) + 1;
    });
    return { cap: c, qty: q };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stock, named.join('|')]);
  const target = criterion === 'capital' ? cap : qty;

  // Animazione: i valori mostrati inseguono il bersaglio (fette che si trasformano).
  const [shown, setShown] = useState<Record<string, number>>(() => {
    // Primo ingresso: parte da zero e "cresce" (nessuna animazione se ridotta).
    return reducedMotion() ? target : {};
  });
  const shownRef = useRef(shown);
  shownRef.current = shown;
  useEffect(() => {
    if (reducedMotion()) { setShown(target); return; }
    const from = shownRef.current;
    const keys = Array.from(new Set([...Object.keys(from), ...Object.keys(target)]));
    // Normalizzo in frazioni, così passare da € a pezzi non "esplode" la scala.
    const sum = (o: Record<string, number>) => keys.reduce((a, k) => a + (o[k] || 0), 0);
    const fs = sum(from), ts = sum(target);
    const f0: Record<string, number> = {}, f1: Record<string, number> = {};
    keys.forEach(k => { f0[k] = fs > 0 ? (from[k] || 0) / fs : 0; f1[k] = ts > 0 ? (target[k] || 0) / ts : 0; });
    let raf = 0; const t0 = performance.now(), dur = 650;
    const tick = (now: number) => {
      const x = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - x, 3);
      const next: Record<string, number> = {};
      keys.forEach(k => { next[k] = (f0[k] + (f1[k] - f0[k]) * e) * (ts || 1); });
      setShown(x < 1 ? next : target);
      if (x < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    // Rete di sicurezza: se requestAnimationFrame non gira (scheda in background, webview), arrivo comunque al valore finale.
    const done = setTimeout(() => setShown(target), dur + 150);
    return () => { cancelAnimationFrame(raf); clearTimeout(done); };
  }, [target]);

  // Apertura "a ventaglio" al primo ingresso.
  const [sweep, setSweep] = useState(() => (reducedMotion() ? 1 : 0));
  useEffect(() => {
    if (sweep >= 1) return;
    let raf = 0; const t0 = performance.now();
    const tick = (now: number) => {
      const x = Math.min(1, (now - t0) / 900);
      setSweep(1 - Math.pow(1 - x, 3));
      if (x < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    const done = setTimeout(() => setSweep(1), 1050);
    return () => { cancelAnimationFrame(raf); clearTimeout(done); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const total = Object.values(target).reduce((a, b) => a + b, 0);
  // Righe della tabella (ordinate per valore, "Altro" sempre in fondo).
  const rows = Object.entries(target)
    .filter(([, v]) => v > 0)
    .sort((a, b) => (a[0] === OTHER ? 1 : b[0] === OTHER ? -1 : b[1] - a[1]));

  // Fette dagli angoli ANIMATI, disegnate nell'ordine stabile dei reparti (partendo da ore 12).
  const order = [...named, OTHER];
  const shownTot = order.reduce((a, k) => a + (shown[k] || 0), 0);
  let acc = -Math.PI / 2;
  const slices = order
    .filter(k => (shown[k] || 0) > 0 && shownTot > 0)
    .map(k => {
      const span = ((shown[k] || 0) / shownTot) * Math.PI * 2 * sweep;
      const s = { key: k, a1: acc, a2: acc + span, mid: acc + span / 2 };
      acc += span;
      return s;
    });

  const topPath = (a1: number, a2: number) => {
    if (a2 - a1 >= Math.PI * 2 - 1e-6) return `M ${CX - RX} ${CY} A ${RX} ${RY} 0 1 1 ${CX + RX} ${CY} A ${RX} ${RY} 0 1 1 ${CX - RX} ${CY} Z`;
    const [x1, y1] = pt(a1), [x2, y2] = pt(a2);
    return `M ${CX} ${CY} L ${x1} ${y1} A ${RX} ${RY} 0 ${a2 - a1 > Math.PI ? 1 : 0} 1 ${x2} ${y2} Z`;
  };
  // Parete esterna: solo la parte rivolta verso chi guarda (angoli tra 0 e π, metà inferiore).
  const wallPath = (a1: number, a2: number) => {
    const s = Math.max(a1, 0), e = Math.min(a2, Math.PI);
    if (e <= s) return null;
    const [x1, y1] = pt(s), [x2, y2] = pt(e);
    return `M ${x1} ${y1} A ${RX} ${RY} 0 0 1 ${x2} ${y2} L ${x2} ${y2 + DEPTH} A ${RX} ${RY} 0 0 0 ${x1} ${y1 + DEPTH} Z`;
  };
  // Facce radiali (visibili solo sulla fetta sollevata).
  const sidePath = (a: number) => {
    const [x, y] = pt(a);
    return `M ${CX} ${CY} L ${x} ${y} L ${x} ${y + DEPTH} L ${CX} ${CY + DEPTH} Z`;
  };
  const liftOf = (s: { key: string; mid: number }) =>
    hover === s.key && slices.length > 1 ? `translate(${Math.cos(s.mid) * LIFT} ${Math.sin(s.mid) * LIFT * (RY / RX)})` : undefined;

  const drawSlice = (s: typeof slices[number], part: 'wall' | 'top') => {
    const fill = colorOf(s.key);
    const lifted = !!liftOf(s);
    const dim = hover && hover !== s.key ? 0.55 : 1;
    if (part === 'wall') {
      const w = wallPath(s.a1, s.a2);
      return (
        <g key={`w-${s.key}`} transform={liftOf(s)} opacity={dim}>
          {lifted && [s.a1, s.a2].map(a => (
            <g key={a}><path d={sidePath(a)} fill={fill} /><path d={sidePath(a)} fill="#000" opacity={0.42} /></g>
          ))}
          {w && <><path d={w} fill={fill} /><path d={w} fill="url(#pie-wall-shade)" /></>}
        </g>
      );
    }
    return (
      <path key={`t-${s.key}`} d={topPath(s.a1, s.a2)} fill={fill} transform={liftOf(s)} opacity={dim}
        stroke="var(--surface)" strokeWidth={slices.length > 1 ? 1.5 : 0} strokeLinejoin="round"
        style={{ cursor: 'pointer', transition: 'opacity .2s' }}
        onMouseEnter={() => setHover(s.key)} onClick={() => setHover(s.key)} />
    );
  };
  // Prima tutte le pareti, poi tutti i piani; la fetta sollevata per ultima (sta "sopra").
  const base = slices.filter(s => s.key !== hover), lifted = slices.filter(s => s.key === hover);

  const focus = hover && target[hover] != null ? hover : null;
  const Seg = ({ value, cur, set, opts }: { value: string; cur: string; set: (v: any) => void; opts: [string, string][] }) => (
    <div role="tablist" aria-label={value} className="flex p-0.5 rounded-lg bg-[var(--surface-2)] border border-[var(--border)]">
      {opts.map(([k, l]) => (
        <button key={k} role="tab" aria-selected={cur === k} onClick={() => { set(k); setHover(null); }}
          className={`px-3 py-1.5 rounded-md text-[12.5px] font-semibold transition-colors ${cur === k ? 'bg-[var(--text)] text-[var(--bg)]' : 'text-[var(--text-soft)] hover:text-[var(--text)]'}`}>{l}</button>
      ))}
    </div>
  );

  return (
    <section ref={boxRef} className="bg-[var(--surface)] border border-[var(--border)] rounded-3xl p-5">
      <div className="flex items-start justify-between gap-3 flex-wrap mb-4">
        <div>
          <h3 className="font-bold text-lg">{t('pie.title')}</h3>
          <p className="text-[12.5px] text-[var(--text-soft)] mt-0.5">{criterion === 'capital' ? t('pie.subCapital') : t('pie.subQty')}</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Seg value={t('pie.criterion')} cur={criterion} set={setCriterion} opts={[['capital', t('pie.capital')], ['qty', t('pie.qty')]]} />
        </div>
      </div>

      {total <= 0 ? (
        <p className="text-sm text-[var(--text-faint)] py-10 text-center">{t('pie.empty')}</p>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-5 lg:gap-8 items-center">
          <div className="lg:col-span-3" onMouseLeave={() => setHover(null)}>
            <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto max-w-[520px] mx-auto block" role="img"
              aria-label={`${t('pie.title')}: ${rows.map(([k, v]) => `${labelOf(k)} ${Math.round((v / total) * 100)}%`).join(', ')}`}>
              <defs>
                <linearGradient id="pie-wall-shade" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" stopColor="#000" stopOpacity="0.28" />
                  <stop offset="1" stopColor="#000" stopOpacity="0.5" />
                </linearGradient>
                <radialGradient id="pie-gloss" cx="0.38" cy="0.18" r="0.9">
                  <stop offset="0" stopColor="#fff" stopOpacity="0.20" />
                  <stop offset="0.55" stopColor="#fff" stopOpacity="0.04" />
                  <stop offset="1" stopColor="#fff" stopOpacity="0" />
                </radialGradient>
                <filter id="pie-shadow" x="-20%" y="-50%" width="140%" height="200%"><feGaussianBlur stdDeviation="7" /></filter>
              </defs>
              {/* Ombra a terra */}
              <ellipse cx={CX} cy={CY + DEPTH + 10} rx={RX * 0.94} ry={RY * 0.72} fill="#000" opacity={0.26} filter="url(#pie-shadow)" />
              {base.map(s => drawSlice(s, 'wall'))}
              {base.map(s => drawSlice(s, 'top'))}
              {/* Riflesso sul piano (non intercetta il mouse) */}
              <path d={topPath(-Math.PI / 2, Math.PI * 1.5)} fill="url(#pie-gloss)" pointerEvents="none" />
              {lifted.map(s => drawSlice(s, 'wall'))}
              {lifted.map(s => drawSlice(s, 'top'))}
              {/* Al centro: il totale del magazzino */}
              <g pointerEvents="none">
                <rect x={CX - 62} y={CY - 25} width={124} height={46} rx={12} fill="var(--surface)" opacity={0.9} />
                <text x={CX} y={CY - 7} textAnchor="middle" fontSize={8.5} fontWeight={700} letterSpacing={0.8} fill="var(--text-faint)">{t('pie.centerLabel').toUpperCase()}</text>
                <text x={CX} y={CY + 13} textAnchor="middle" fontSize={19} fontWeight={900} fill="var(--text)" style={{ fontVariantNumeric: 'tabular-nums' }}>{fmt(total)}</text>
              </g>
            </svg>
          </div>

          <div className="lg:col-span-2 min-w-0">
            {/* Lettura: totale, oppure la fetta evidenziata */}
            <div className="mb-3 pb-3 border-b border-[var(--border)]">
              <p className="sys-label">{focus ? labelOf(focus) : t('pie.total')}</p>
              <p className="num font-black text-[28px] leading-tight font-display" style={{ fontStretch: '118%' }}>
                {fmt(focus ? target[focus] : total)}
              </p>
              <p className="text-[12.5px] text-[var(--text-soft)] mt-0.5 num">
                {focus
                  ? `${criterion === 'capital' ? pcs(qty[focus] || 0) : eur(cap[focus] || 0)} · ${Math.round((target[focus] / total) * 100)}% ${t('pie.ofTotal')}`
                  : t('pie.hint')}
              </p>
            </div>
            {/* Tabella: identità mai affidata al solo colore */}
            <ul className="space-y-0.5">
              {rows.map(([k, v]) => (
                <li key={k}>
                  <button onMouseEnter={() => setHover(k)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(k)} onBlur={() => setHover(null)}
                    onClick={() => setHover(k)} aria-pressed={hover === k}
                    className={`w-full flex items-center gap-2.5 px-2 py-2 rounded-lg text-left transition-colors ${hover === k ? 'bg-[var(--fill-2)]' : 'hover:bg-[var(--fill)]'}`}>
                    <span className="w-3 h-3 rounded-[3px] shrink-0" style={{ background: colorOf(k) }} />
                    {k !== OTHER && <span className="text-[var(--text-soft)] text-[13px] shrink-0">{getCategoryIcon(k)}</span>}
                    <span className="flex-1 min-w-0 text-[13.5px] font-semibold truncate">{labelOf(k)}</span>
                    <span className="num text-[13px] text-[var(--text-soft)] shrink-0">{fmt(v)}</span>
                    <span className="num text-[13px] font-bold w-11 text-right shrink-0">{Math.round((v / total) * 100)}%</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </section>
  );
}
