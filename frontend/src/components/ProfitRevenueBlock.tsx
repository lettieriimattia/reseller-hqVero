// ProfitRevenueBlock — il blocco unico della Dashboard: SOLO profitto e ricavo.
// - Numero grande: all'apertura il totale del MESE CORRENTE (profitto o ricavo, a scelta, scelta ricordata),
//   sotto il confronto col mese precedente (€ e %).
// - Vista "Mese": una barra per ogni giorno del mese corrente. Vista "3 mesi": una barra per ciascuno
//   degli ultimi 3 mesi di calendario.
// - Tocca una barra → valore di quel giorno/mese (e accanto l'altra metrica). Trascina → somma del range,
//   con le date sotto. Tocca fuori dal blocco → si torna al totale del mese. Funziona col dito e col mouse.
// Calcoli: `aggregate` (vendite per data di vendita, quota dell'utente), identico al resto dell'app.
import { useEffect, useRef, useState, type PointerEvent as RPointerEvent, type KeyboardEvent as RKeyboardEvent } from 'react';
import { ArrowUp, ArrowDown } from 'lucide-react';
import { aggregate, useCountUp, SelectionList, type Agg, type Metric, type Range, type XProduct } from './AnalyticsExplorer';

type Mode = 'profit' | 'revenue';
type View = 'month' | '3m';
type Bucket = Range & { label: string; tick: string; future: boolean };

interface Props {
  products: XProduct[];
  myProfitFactor: (p: any) => number;
  myCostFactor: (p: any) => number;
  t: (key: string) => string;
  dateLocale: string;
  fullName: (brand?: string, name?: string) => string;
  onOpenProduct: (id: string) => void;
  now?: Date; // solo per verifiche: "oggi"
}

const MODE_KEY = 'hq-dash-mode';
const CHART_H = 200;
const readMode = (): Mode => { try { return localStorage.getItem(MODE_KEY) === 'revenue' ? 'revenue' : 'profit'; } catch { return 'profit'; } };
const cap1 = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export default function ProfitRevenueBlock({ products, myProfitFactor, myCostFactor, t, dateLocale, fullName, onOpenProduct, now: nowProp }: Props) {
  const [mode, setMode] = useState<Mode>(readMode);
  const [view, setView] = useState<View>('month');
  const [sel, setSel] = useState<{ a: number; b: number } | null>(null);
  const [drag, setDrag] = useState<{ a: number; b: number } | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [sortBy, setSortBy] = useState<'value' | 'date'>('value');
  const [shown, setShown] = useState(20);
  const blockRef = useRef<HTMLElement>(null);
  const chartRef = useRef<HTMLDivElement>(null);

  const pickMode = (m: Mode) => { setMode(m); try { localStorage.setItem(MODE_KEY, m); } catch { /* ok */ } };
  useEffect(() => { setSel(null); setShown(20); }, [view]);
  // Tocco/clic FUORI dal blocco → torna al totale del mese.
  useEffect(() => {
    if (!sel) return;
    const out = (e: PointerEvent) => { if (blockRef.current && !blockRef.current.contains(e.target as Node)) setSel(null); };
    document.addEventListener('pointerdown', out);
    return () => document.removeEventListener('pointerdown', out);
  }, [sel]);

  const eur = (n: number, sign = false) => new Intl.NumberFormat(dateLocale, {
    style: 'currency', currency: 'EUR', maximumFractionDigits: 0, useGrouping: 'always' as any, signDisplay: sign ? 'exceptZero' : 'auto',
  }).format(Math.round(n) || 0);
  const fmt = (_m: Metric, v: number | null) => (v === null ? '—' : eur(v));
  const dShort = (d: Date) => d.toLocaleDateString(dateLocale, { day: 'numeric', month: 'short' });
  const monthName = (d: Date) => d.toLocaleDateString(dateLocale, { month: 'long' });

  // ---------- Periodi (tutto in giorni/mesi di calendario locali: nessun accorpamento) ----------
  const now = nowProp || new Date();
  const y = now.getFullYear(), mo = now.getMonth();
  const today = new Date(y, mo, now.getDate());
  const thisMonth: Range = { start: new Date(y, mo, 1), end: new Date(y, mo + 1, 1) };
  const lastMonth: Range = { start: new Date(y, mo - 1, 1), end: new Date(y, mo, 1) };
  const sum = (r: Range): Agg => aggregate(products, r, r, myProfitFactor, myCostFactor);

  const buckets: Bucket[] = view === 'month'
    ? Array.from({ length: new Date(y, mo + 1, 0).getDate() }, (_, i) => {
        const s = new Date(y, mo, i + 1);
        return { start: s, end: new Date(y, mo, i + 2), label: cap1(s.toLocaleDateString(dateLocale, { weekday: 'short', day: 'numeric', month: 'short' })), tick: String(i + 1), future: s > today };
      })
    : [-2, -1, 0].map(k => {
        const s = new Date(y, mo + k, 1);
        return { start: s, end: new Date(y, mo + k + 1, 1), label: cap1(s.toLocaleDateString(dateLocale, { month: 'long', year: 'numeric' })), tick: cap1(s.toLocaleDateString(dateLocale, { month: 'short' }).replace('.', '')), future: false };
      });
  const aggs = buckets.map(b => sum(b));
  const vals = aggs.map(a => a[mode]);

  const cur = sum(thisMonth), prev = sum(lastMonth);
  const other: Mode = mode === 'profit' ? 'revenue' : 'profit';
  const label = (m: Mode) => t(m === 'profit' ? 'pr.profit' : 'pr.revenue');

  // ---------- Cosa mostra il numero grande ----------
  const single = sel && sel.a === sel.b ? sel.a : null;
  const selRange: Range | null = sel ? { start: buckets[sel.a].start, end: buckets[sel.b].end } : null;
  const selAgg = selRange ? sum(selRange) : null;
  const bigValue = selAgg ? selAgg[mode] : cur[mode];
  const shownBig = useCountUp(bigValue);
  const headLabel = single !== null
    ? `${label(mode)} · ${buckets[single].label}`
    : sel
      ? `${label(mode)} · ${t('pr.selection')}`
      : `${label(mode)} · ${cap1(thisMonth.start.toLocaleDateString(dateLocale, { month: 'long', year: 'numeric' }))}`;

  let compare: { up: boolean; down: boolean; txt: string } | null = null;
  if (!sel && prev.count > 0) {
    const d = cur[mode] - prev[mode];
    const p = prev[mode] !== 0 ? (d / Math.abs(prev[mode])) * 100 : null;
    compare = { up: d > 0, down: d < 0, txt: `${p === null ? '' : `${p > 0 ? '+' : ''}${new Intl.NumberFormat(dateLocale, { maximumFractionDigits: 0 }).format(p)}% `}(${eur(d, true)})` };
  }

  // ---------- Grafico: tocco, trascinamento, tastiera ----------
  const idxAt = (clientX: number) => {
    const r = chartRef.current?.getBoundingClientRect();
    if (!r || !buckets.length) return 0;
    return Math.max(0, Math.min(buckets.length - 1, Math.floor(((clientX - r.left) / r.width) * buckets.length)));
  };
  const onDown = (e: RPointerEvent<HTMLDivElement>) => {
    const i = idxAt(e.clientX);
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ok */ }
    setDrag({ a: i, b: i });
  };
  const onMove = (e: RPointerEvent<HTMLDivElement>) => {
    const i = idxAt(e.clientX);
    if (e.pointerType === 'mouse') setHover(i);
    if (drag && i !== drag.b) setDrag({ a: drag.a, b: i });
  };
  const onUp = () => {
    if (!drag) return;
    const a = Math.min(drag.a, drag.b), b = Math.max(drag.a, drag.b);
    setDrag(null);
    setShown(20);
    if (a === b) setSel(s => (s && s.a === a && s.b === a ? null : { a, b }));
    else setSel({ a, b });
  };
  const onKey = (e: RKeyboardEvent) => {
    const n = buckets.length;
    const base = single ?? (view === 'month' ? Math.min(n - 1, now.getDate() - 1) : n - 1);
    if (e.key === 'ArrowLeft') { e.preventDefault(); setSel({ a: Math.max(0, base - 1), b: Math.max(0, base - 1) }); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); setSel({ a: Math.min(n - 1, base + 1), b: Math.min(n - 1, base + 1) }); }
    else if (e.key === 'Escape') setSel(null);
  };

  const live = drag ? { a: Math.min(drag.a, drag.b), b: Math.max(drag.a, drag.b) } : sel;
  const inLive = (i: number) => !!live && i >= live.a && i <= live.b;
  const maxV = Math.max(0, ...vals), minV = Math.min(0, ...vals);
  const span = maxV - minV || 1;
  const zeroFrac = maxV === 0 && minV === 0 ? 1 : maxV / span; // tutto a zero: linea in basso

  // Pezzi venduti nella selezione (raggruppati per prodotto identico).
  const selItems = selRange
    ? products.filter(p => p.status === 'VENDUTO' && p.soldAt && new Date(p.soldAt) >= selRange.start && new Date(p.soldAt) < selRange.end)
      .map(p => {
        const f = myProfitFactor(p);
        const v = mode === 'profit' ? ((p.salePrice || 0) - p.purchasePrice - (p.fees || 0)) * f : (p.salePrice || 0) * f;
        return { p, v, d: new Date(p.soldAt as string) };
      })
    : [];
  const selTitle = !sel ? '' : single !== null ? buckets[single].label
    : view === 'month' ? `${dShort(buckets[sel.a].start)} – ${dShort(buckets[sel.b].start)}` : `${buckets[sel.a].label} – ${buckets[sel.b].label}`;

  const seg = (on: boolean) => `px-3 py-1.5 rounded-md text-xs font-bold whitespace-nowrap transition-colors ${on ? 'bg-[var(--text)] text-[var(--bg)]' : 'text-[var(--text-soft)] hover:text-[var(--text)]'}`;

  return (
    <section ref={blockRef} aria-label={t('pr.title')} className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-4 sm:p-5 space-y-4">
      <div className="flex flex-col-reverse sm:flex-row sm:items-start sm:justify-between gap-3">
        {/* Numero grande: numero e metrica accanto sempre sulla stessa riga, così il grafico non si sposta */}
        <div className="min-w-0" aria-live="polite">
          <p className="text-[11px] uppercase tracking-[0.1em] font-bold text-[var(--text-faint)] truncate">{headLabel}</p>
          <div className="flex items-baseline gap-4 flex-nowrap mt-1.5 min-w-0 h-9 sm:h-12 overflow-hidden">
            <p className={`text-4xl sm:text-5xl font-extrabold num leading-none ${bigValue < 0 ? 'text-[var(--down)]' : ''}`}>{eur(shownBig)}</p>
            {single !== null && selAgg && (
              <p className="text-sm leading-none text-[var(--text-soft)] whitespace-nowrap">{label(other)} <span className="font-extrabold num text-[var(--text)]">{eur(selAgg[other])}</span></p>
            )}
          </div>
          <div className="mt-2 text-sm h-6 flex items-center min-w-0">
            {sel ? (
              single === null && selRange && (
                <span className="text-[var(--text-soft)]">
                  {view === 'month'
                    ? `${t('pr.from')} ${dShort(selRange.start)} ${t('pr.to')} ${dShort(new Date(selRange.end.getTime() - 86400000))}`
                    : `${buckets[sel.a].label} – ${buckets[sel.b].label}`}
                </span>
              )
            ) : compare ? (
              <span className={`inline-flex items-center gap-1 font-bold num ${compare.up ? 'text-[var(--up)]' : compare.down ? 'text-[var(--down)]' : 'text-[var(--text-soft)]'}`}>
                {compare.up && <ArrowUp size={15} aria-hidden />}{compare.down && <ArrowDown size={15} aria-hidden />}
                {compare.txt}
                <span className="font-medium text-[var(--text-faint)] ml-1">{t('pr.vs')} {monthName(lastMonth.start)}</span>
              </span>
            ) : (
              <span className="text-[var(--text-faint)]">{t('pr.noPrev')} {monthName(lastMonth.start)}</span>
            )}
          </div>
        </div>

        {/* Interruttori */}
        <div className="flex sm:flex-col items-center sm:items-end justify-between gap-2 shrink-0">
          <div role="radiogroup" aria-label={t('pr.show')} className="flex p-0.5 rounded-lg bg-[var(--surface-2)] border border-[var(--border)]">
            {(['profit', 'revenue'] as Mode[]).map(m => (
              <button key={m} role="radio" aria-checked={mode === m} onClick={() => pickMode(m)} className={seg(mode === m)}>{label(m)}</button>
            ))}
          </div>
          <div role="radiogroup" aria-label={t('pr.period')} className="flex p-0.5 rounded-lg bg-[var(--surface-2)] border border-[var(--border)]">
            {(['month', '3m'] as View[]).map(v => (
              <button key={v} role="radio" aria-checked={view === v} onClick={() => setView(v)} className={seg(view === v)}>{t(v === 'month' ? 'pr.month' : 'pr.3m')}</button>
            ))}
          </div>
        </div>
      </div>

      {/* Grafico */}
      <div>
        <div ref={chartRef} tabIndex={0} role="group"
          aria-label={`${label(mode)} · ${t(view === 'month' ? 'pr.hint' : 'pr.hint3m')}`}
          className={`relative flex items-stretch select-none outline-none rounded-lg focus-visible:ring-2 focus-visible:ring-brand/60 cursor-pointer ${view === 'month' ? 'gap-[2px]' : 'gap-4 sm:gap-8'}`}
          style={{ height: CHART_H, touchAction: 'pan-y' }}
          onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}
          onPointerCancel={() => setDrag(null)} onPointerLeave={() => setHover(null)} onKeyDown={onKey}>
          <div className="absolute left-0 right-0 border-t border-[var(--border-2)] pointer-events-none" style={{ top: `${zeroFrac * 100}%` }} />
          {buckets.map((b, i) => {
            const v = vals[i];
            const h = (Math.abs(v) / span) * 100;
            const neg = v < 0;
            const on = inLive(i);
            const dim = !!live && !on;
            return (
              <div key={b.start.getTime()} data-bar={i} aria-label={`${b.label}: ${eur(v)}`}
                className={`relative flex-1 min-w-0 rounded-sm transition-colors ${on ? 'bg-brand/[0.07]' : hover === i ? 'bg-[var(--fill)]' : ''}`}>
                {view === '3m' && (
                  <span className="absolute left-0 right-0 text-center text-xs font-bold num text-[var(--text-soft)] pointer-events-none"
                    style={{ top: `calc(${(neg ? zeroFrac + h / 100 : zeroFrac - h / 100) * 100}% ${neg ? '+ 4px' : '- 20px'})` }}>{eur(v)}</span>
                )}
                {v !== 0 ? (
                  <div className={`absolute ${view === 'month' ? 'left-[12%] right-[12%]' : 'left-[18%] right-[18%]'} rounded-[3px] transition-all duration-300 motion-reduce:transition-none`}
                    style={{ height: `${h}%`, top: neg ? `${zeroFrac * 100}%` : `${(zeroFrac - h / 100) * 100}%`, background: neg ? 'var(--down)' : 'var(--accent)', opacity: dim ? 0.3 : 1 }} />
                ) : !b.future && (
                  <div className="absolute left-[25%] right-[25%] h-[2px] rounded-full bg-[var(--border-2)]" style={{ top: `calc(${zeroFrac * 100}% - 1px)` }} />
                )}
              </div>
            );
          })}
        </div>
        <div className={`flex mt-1.5 ${view === 'month' ? 'gap-[2px]' : 'gap-4 sm:gap-8'}`}>
          {buckets.map((b, i) => (
            <span key={b.start.getTime()} className={`flex-1 min-w-0 text-center text-[10px] num ${inLive(i) ? 'text-[var(--text)] font-bold' : 'text-[var(--text-faint)]'}`}>
              {view === '3m' || i === 0 || (i + 1) % 5 === 0 || i === buckets.length - 1 ? b.tick : ''}
            </span>
          ))}
        </div>
        <p className="text-[11px] text-[var(--text-faint)] mt-2">{t(view === 'month' ? 'pr.hint' : 'pr.hint3m')}</p>
      </div>

      {sel && (
        <SelectionList title={selTitle} items={selItems} metric={mode} fmt={fmt} t={t} sortBy={sortBy} setSortBy={setSortBy}
          shown={shown} setShown={setShown} onClose={() => setSel(null)} onOpen={onOpenProduct} fullName={fullName} dShort={dShort} dateLocale={dateLocale} />
      )}
    </section>
  );
}
