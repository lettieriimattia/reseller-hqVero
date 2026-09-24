// HomeLedger — la home "a etichetta".
// Il riepilogo del periodo (mese / trimestre / anno) è stampato come l'etichetta di una scatola:
// profitto netto in grande, celle con le metriche chiave (confrontate col periodo precedente)
// e un "codice a barre" in cui ogni barra è un giorno (o una settimana, nella vista anno).
// Accanto: obiettivo + proiezione, coda "Da fare", e sotto le classifiche per piattaforma,
// reparto e singolo pezzo. Importi sulla quota dell'utente (come la vecchia card Personale).
import { useMemo, useState, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight, ArrowUpRight, ArrowDownRight, Truck, AlertTriangle, StickyNote, Package, Target, Lock } from 'lucide-react';

interface LedgerProduct {
  id: string; category?: string; brand: string; name: string; status: string;
  purchasePrice: number; salePrice?: number; fees?: number; platform?: string;
  createdAt?: string; soldAt?: string;
}

type Kind = 'month' | 'quarter' | 'year';

interface Props {
  products: LedgerProduct[];
  myProfitFactor: (p: any) => number;
  myCostFactor: (p: any) => number;
  t: (key: string) => string;
  dateLocale: string;
  hasAdvanced: boolean;
  toShipCount: number;
  staleCount: number;
  openTasksCount: number;
  stockValue: number;
  inStockCount: number;
  onOpenShip: () => void;
  onOpenStale: () => void;
  onOpenTasks: () => void;
  onOpenStock: () => void;
  onUpgrade: () => void;
  getCategoryIcon: (cat: any) => ReactNode;
  fullName: (brand?: string, name?: string) => string;
}

const DAY = 86400000;
const GOAL_KEY = 'hq-goal-month';

// Giorni "di calendario" tra due date, immuni al cambio d'ora legale.
const dayDiff = (a: Date, b: Date) =>
  Math.floor((Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) - Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / DAY);

function periodRange(kind: Kind, offset: number, now: Date) {
  const y = now.getFullYear(), m = now.getMonth();
  if (kind === 'month') return { start: new Date(y, m + offset, 1), end: new Date(y, m + offset + 1, 1) };
  if (kind === 'quarter') {
    const q = Math.floor(m / 3) + offset;
    return { start: new Date(y, q * 3, 1), end: new Date(y, q * 3 + 3, 1) };
  }
  return { start: new Date(y + offset, 0, 1), end: new Date(y + offset + 1, 0, 1) };
}

function readGoal(): number {
  try { return Math.max(0, Number(localStorage.getItem(GOAL_KEY)) || 0); } catch { return 0; }
}

export default function HomeLedger(props: Props) {
  const { products, myProfitFactor, myCostFactor, t, dateLocale, hasAdvanced } = props;
  const [kind, setKind] = useState<Kind>('month');
  const [offset, setOffset] = useState(0);
  const [goal, setGoal] = useState<number>(readGoal);
  const [goalDraft, setGoalDraft] = useState<string | null>(null);
  const [hover, setHover] = useState<number | null>(null);

  const eur = (n: number) => new Intl.NumberFormat(dateLocale, { style: 'currency', currency: 'EUR', maximumFractionDigits: 0, useGrouping: 'always' as any }).format(Math.round(n));
  const int = (n: number) => new Intl.NumberFormat(dateLocale, { maximumFractionDigits: 0, useGrouping: 'always' as any }).format(Math.round(n));

  const now = new Date();
  const { start, end } = periodRange(kind, offset, now);
  const prev = periodRange(kind, offset - 1, now);
  const isCurrent = offset === 0;
  const totalDays = dayDiff(start, end);
  const elapsedDays = isCurrent ? dayDiff(start, now) + 1 : totalDays;
  // Confronto equo: nel periodo in corso confronto con lo STESSO numero di giorni del precedente.
  const prevCut = isCurrent ? new Date(Math.min(prev.start.getTime() + elapsedDays * DAY, prev.end.getTime())) : prev.end;

  const periodTitle = kind === 'month'
    ? start.toLocaleDateString(dateLocale, { month: 'long', year: 'numeric' })
    : kind === 'quarter'
      ? `Q${Math.floor(start.getMonth() / 3) + 1} ${start.getFullYear()}`
      : String(start.getFullYear());
  const prevTitle = kind === 'month'
    ? prev.start.toLocaleDateString(dateLocale, { month: 'long' })
    : kind === 'quarter' ? `Q${Math.floor(prev.start.getMonth() / 3) + 1}` : String(prev.start.getFullYear());

  const data = useMemo(() => {
    const soldAt = (p: LedgerProduct) => (p.soldAt ? new Date(p.soldAt) : null);
    const sold = products.filter(p => p.status === 'VENDUTO' && p.soldAt);
    const inWin = (d: Date | null, a: Date, b: Date) => !!d && d >= a && d < b;

    const stats = (items: LedgerProduct[]) => {
      let profit = 0, revenue = 0, cost = 0, gross = 0, daysSum = 0, daysN = 0;
      items.forEach(p => {
        const f = myProfitFactor(p);
        const sale = p.salePrice || 0;
        profit += (sale - p.purchasePrice - (p.fees || 0)) * f;
        revenue += sale * f;
        cost += p.purchasePrice * f;
        gross += sale;
        if (p.createdAt && p.soldAt) {
          daysSum += Math.max(0, dayDiff(new Date(p.createdAt), new Date(p.soldAt)));
          daysN++;
        }
      });
      const count = items.length;
      return {
        profit, revenue, count,
        roi: cost > 0 ? (profit / cost) * 100 : null,
        asp: count > 0 ? gross / count : null,
        days: daysN > 0 ? daysSum / daysN : null,
      };
    };

    const cur = sold.filter(p => inWin(soldAt(p), start, end));
    const cmp = sold.filter(p => inWin(soldAt(p), prev.start, prevCut));
    const bought = products
      .filter(p => p.createdAt && inWin(new Date(p.createdAt), start, end))
      .reduce((a, p) => a + p.purchasePrice * myCostFactor(p), 0);
    const boughtPrev = products
      .filter(p => p.createdAt && inWin(new Date(p.createdAt), prev.start, prevCut))
      .reduce((a, p) => a + p.purchasePrice * myCostFactor(p), 0);

    // Barre: un giorno ciascuna (mese/trimestre), una settimana (anno).
    const step = kind === 'year' ? 7 : 1;
    const nBars = Math.ceil(totalDays / step);
    const bars = Array.from({ length: nBars }, (_, i) => ({ i, profit: 0, count: 0, prevProfit: 0 }));
    cur.forEach(p => {
      const idx = Math.floor(dayDiff(start, new Date(p.soldAt!)) / step);
      if (bars[idx]) { bars[idx].profit += ((p.salePrice || 0) - p.purchasePrice - (p.fees || 0)) * myProfitFactor(p); bars[idx].count++; }
    });
    sold.filter(p => inWin(soldAt(p), prev.start, prev.end)).forEach(p => {
      const idx = Math.floor(dayDiff(prev.start, new Date(p.soldAt!)) / step);
      if (bars[idx]) bars[idx].prevProfit += ((p.salePrice || 0) - p.purchasePrice - (p.fees || 0)) * myProfitFactor(p);
    });

    const group = (key: (p: LedgerProduct) => string) => {
      const acc: Record<string, { name: string; profit: number; revenue: number; count: number }> = {};
      cur.forEach(p => {
        const k = key(p);
        const f = myProfitFactor(p);
        if (!acc[k]) acc[k] = { name: k, profit: 0, revenue: 0, count: 0 };
        acc[k].profit += ((p.salePrice || 0) - p.purchasePrice - (p.fees || 0)) * f;
        acc[k].revenue += (p.salePrice || 0) * f;
        acc[k].count++;
      });
      return Object.values(acc).sort((a, b) => b.profit - a.profit);
    };

    const top = cur
      .map(p => {
        const profit = (p.salePrice || 0) - p.purchasePrice - (p.fees || 0);
        return { p, profit, roi: p.purchasePrice > 0 ? (profit / p.purchasePrice) * 100 : null };
      })
      .sort((a, b) => b.profit - a.profit)
      .slice(0, 5);

    return {
      cur: stats(cur), cmp: stats(cmp), bought, boughtPrev, bars, step,
      platforms: group(p => p.platform || t('home.private')),
      depts: group(p => p.category || '—'),
      top,
      shared: cur.some(p => myProfitFactor(p) < 0.999),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [products, kind, offset, start.getTime(), prevCut.getTime()]);

  const { cur, cmp } = data;

  // Delta percentuale (null se il precedente è zero: niente "+∞%").
  const pct = (a: number | null, b: number | null) => (a == null || b == null || b === 0 ? null : ((a - b) / Math.abs(b)) * 100);
  const profitDelta = pct(cur.profit, cmp.profit);

  const periodGoal = goal * (kind === 'month' ? 1 : kind === 'quarter' ? 3 : 12);
  const goalProgress = periodGoal > 0 ? Math.min(1, Math.max(0, cur.profit / periodGoal)) : 0;
  const projection = isCurrent && elapsedDays >= 3 ? (cur.profit / elapsedDays) * totalDays : null;

  const saveGoal = () => {
    const v = Math.max(0, Math.round(Number((goalDraft || '').replace(/[^\d]/g, '')) || 0));
    setGoal(v);
    try { localStorage.setItem(GOAL_KEY, String(v)); } catch { /* storage non disponibile */ }
    setGoalDraft(null);
  };

  // ---- Codice a barre ----
  const maxPos = Math.max(1, ...data.bars.map(b => Math.max(b.profit, b.prevProfit)));
  const maxNeg = Math.max(0, ...data.bars.map(b => -Math.min(0, b.profit)));
  const negH = maxNeg > 0 ? 18 : 0;
  const futureFrom = isCurrent ? Math.floor((elapsedDays - 1) / data.step) + 1 : Infinity;
  const barDate = (i: number) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i * data.step);
  const fmtDay = (d: Date) => d.toLocaleDateString(dateLocale, { day: 'numeric', month: 'short' });
  const hoverBar = hover != null ? data.bars[hover] : null;
  const best = data.bars.reduce((b, x) => (x.profit > (b?.profit ?? 0) ? x : b), null as null | { i: number; profit: number });
  const code = `HQ-${start.getFullYear()}-${kind === 'month' ? String(start.getMonth() + 1).padStart(2, '0') : kind === 'quarter' ? 'Q' + (Math.floor(start.getMonth() / 3) + 1) : 'FY'}`;

  const Delta = ({ v, unit = '%', invert = false, onPaper = true }: { v: number | null; unit?: string; invert?: boolean; onPaper?: boolean }) => {
    if (v == null || !isFinite(v)) return <span className={onPaper ? 'lbl-soft' : 'text-[var(--text-faint)]'}>—</span>;
    const good = invert ? v < 0 : v > 0;
    const flat = Math.abs(v) < 0.5;
    const cls = flat ? (onPaper ? 'lbl-soft' : 'text-[var(--text-faint)]') : good ? (onPaper ? 'lbl-up' : 'text-[var(--up)]') : (onPaper ? 'lbl-down' : 'text-[var(--down)]');
    const Arrow = v >= 0 ? ArrowUpRight : ArrowDownRight;
    return (
      <span className={`inline-flex items-center gap-0.5 font-semibold ${cls}`}>
        {!flat && <Arrow size={12} strokeWidth={2.5} />}
        {v > 0 ? '+' : ''}{Math.round(v)}{unit === '%' ? '%' : ' ' + unit}
      </span>
    );
  };

  const cells: { label: string; value: string; delta: ReactNode }[] = [
    { label: t('home.revenue'), value: eur(cur.revenue), delta: <Delta v={pct(cur.revenue, cmp.revenue)} /> },
    { label: t('home.pieces'), value: int(cur.count), delta: <Delta v={cmp.count || cur.count ? cur.count - cmp.count : null} unit={t('home.pcs')} /> },
    { label: 'ROI', value: cur.roi == null ? '—' : `${Math.round(cur.roi)}%`, delta: <Delta v={cur.roi != null && cmp.roi != null ? cur.roi - cmp.roi : null} unit="pt" /> },
    { label: t('home.asp'), value: cur.asp == null ? '—' : eur(cur.asp), delta: <Delta v={pct(cur.asp, cmp.asp)} /> },
    { label: t('home.days'), value: cur.days == null ? '—' : `${Math.round(cur.days)} ${t('home.daysShort')}`, delta: <Delta v={cur.days != null && cmp.days != null ? cur.days - cmp.days : null} unit={t('home.daysShort')} invert /> },
    { label: t('home.bought'), value: eur(data.bought), delta: <span className="lbl-soft">{data.boughtPrev ? `${prevTitle} ${eur(data.boughtPrev)}` : '—'}</span> },
  ];

  const todo: { icon: typeof Truck; label: string; value: string; sub?: string; on: () => void; alert: boolean }[] = [
    // Rimosso: riga "Da spedire" (portava alla pagina Tracking) → components/_archived/tracking-rimosso.tsx.txt
    { icon: AlertTriangle, label: t('home.stale'), value: int(props.staleCount), on: props.onOpenStale, alert: props.staleCount > 0 },
    { icon: StickyNote, label: t('home.notes'), value: int(props.openTasksCount), on: props.onOpenTasks, alert: false },
    // Rimosso: riga "Capitale in magazzino" → components/_archived/home-da-fare-capitale-magazzino.tsx.txt (vedi REMOVED_SECTIONS.md)
  ];

  const compareText = isCurrent
    ? `vs ${prevTitle} · ${fmtDay(prev.start)}–${fmtDay(new Date(prevCut.getTime() - DAY))}`
    : `vs ${prevTitle}`;

  return (
    <div className="space-y-3 lg:space-y-5">
      {/* Rimosso: selettore Mese / Trimestre / Anno → components/_archived/dashboard-home-resti.tsx.txt. L'obiettivo resta sul mese corrente. */}
      <div className="grid grid-cols-1 gap-3 lg:gap-5">
        {/* Rimosso: etichetta bianca (profitto, caselle, codice a barre) → components/_archived/home-etichetta-bianca.tsx.txt (vedi REMOVED_SECTIONS.md) */}

        {/* ===== Colonna destra: obiettivo + da fare ===== */}
        <div className="grid grid-cols-1 gap-3 lg:gap-5 content-start">
          <section className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-4 lg:p-5">
            <div className="flex items-center justify-between">
              <p className="sys-label flex items-center gap-1.5"><Target size={12} /> {t('home.goal')}</p>
              {goal > 0 && goalDraft == null && (
                <button onClick={() => setGoalDraft(String(goal))} className="text-[11.5px] font-semibold text-[var(--text-soft)] hover:text-[var(--text)]">{t('home.goalEdit')}</button>
              )}
            </div>
            {goalDraft != null ? (
              <form className="mt-3 flex gap-2" onSubmit={e => { e.preventDefault(); saveGoal(); }}>
                <label className="sr-only" htmlFor="hq-goal">{t('home.goalSet')}</label>
                <input id="hq-goal" autoFocus inputMode="numeric" value={goalDraft} onChange={e => setGoalDraft(e.target.value)} placeholder="1500"
                  className="flex-1 min-w-0 bg-[var(--surface-2)] border border-[var(--border-2)] rounded-lg px-3 py-2 text-sm num outline-none focus:border-brand" />
                <button type="submit" className="px-3.5 py-2 rounded-lg bg-[var(--text)] text-[var(--bg)] text-[13px] font-bold">{t('home.goalSave')}</button>
              </form>
            ) : goal > 0 ? (
              <>
                <div className="flex items-baseline justify-between gap-2 mt-2.5">
                  <p className="num font-black text-[26px] leading-none font-display" style={{ fontStretch: '118%' }}>{Math.round(goalProgress * 100)}%</p>
                  <p className="text-[12px] text-[var(--text-soft)] num">{eur(cur.profit)} / {eur(periodGoal)}</p>
                </div>
                <div className="mt-3 h-2 rounded-sm bg-[var(--fill-2)] overflow-hidden" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(goalProgress * 100)}>
                  <div className="h-full bg-brand rounded-sm transition-[width] duration-500" style={{ width: `${goalProgress * 100}%` }} />
                </div>
                <p className="text-[12px] text-[var(--text-soft)] mt-2.5">
                  {goalProgress >= 1 ? t('home.goalDone') : `${t('home.goalLeft')} ${eur(periodGoal - cur.profit)}`}
                </p>
              </>
            ) : (
              <button onClick={() => setGoalDraft('')} className="mt-3 w-full text-left text-[13px] font-semibold text-brand-hi hover:underline">{t('home.goalSet')} →</button>
            )}
            <div className="mt-4 pt-3 border-t border-[var(--border)]">
              <p className="sys-label">{t('home.projection')}</p>
              {projection != null ? (
                <p className="mt-1.5 text-[13px] text-[var(--text-soft)]">
                  <span className="num font-bold text-[18px] text-[var(--text)]">≈ {eur(projection)}</span>
                  {periodGoal > 0 && <span className={`ml-2 font-semibold ${projection >= periodGoal ? 'text-[var(--up)]' : 'text-[var(--down)]'}`}>{projection >= periodGoal ? t('home.onTrack') : t('home.offTrack')}</span>}
                </p>
              ) : (
                <p className="mt-1.5 text-[12.5px] text-[var(--text-faint)]">{isCurrent ? t('home.projectionWait') : t('home.projectionPast')}</p>
              )}
            </div>
          </section>

          {/* Rimosso: "Da fare" → components/_archived/dashboard-home-resti.tsx.txt (pezzi fermi in Analytics, note nel menu in alto) */}
        </div>
      </div>

      {/* Rimosso: "Pezzi più redditizi" → components/_archived/dashboard-home-resti.tsx.txt (in Analytics c'è "Il tuo prodotto migliore") */}
    </div>
  );
}

function RankCard({ title, rows, empty, className = '' }: {
  title: string; empty: string; className?: string;
  rows: { key: string; label: string; sub: string; value: string; weight: number | null; icon?: ReactNode }[];
}) {
  const max = Math.max(1, ...rows.map(r => r.weight || 0));
  return (
    <section className={`bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-4 lg:p-5 ${className}`}>
      <p className="sys-label mb-3">{title}</p>
      {rows.length === 0 ? (
        <p className="text-[13px] text-[var(--text-faint)] py-3">{empty}</p>
      ) : (
        <ol className="space-y-3">
          {rows.slice(0, 5).map((r, i) => (
            <li key={r.key} className="min-w-0">
              <div className="flex items-baseline gap-2.5">
                <span className="hq-mono text-[10px] text-[var(--text-faint)] w-4 shrink-0">{i + 1}</span>
                {r.icon && <span className="text-[var(--text-soft)] text-[13px] shrink-0">{r.icon}</span>}
                <span className="flex-1 min-w-0 text-[13.5px] font-semibold truncate">{r.label}</span>
                <span className="num font-bold text-[13.5px] shrink-0">{r.value}</span>
              </div>
              <p className="text-[11.5px] text-[var(--text-faint)] mt-0.5 pl-[26px] truncate">{r.sub}</p>
              {r.weight != null && (
                <div className="ml-[26px] mt-1.5 h-[3px] rounded-sm bg-[var(--fill-2)] overflow-hidden">
                  <div className={`h-full rounded-sm ${i === 0 ? 'bg-brand' : 'bg-[var(--text-faint)]'}`} style={{ width: `${((r.weight || 0) / max) * 100}%` }} />
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
