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

  const todo = [
    { icon: Truck, label: t('home.toShip'), value: int(props.toShipCount), on: props.onOpenShip, alert: props.toShipCount > 0 },
    { icon: AlertTriangle, label: t('home.stale'), value: int(props.staleCount), on: props.onOpenStale, alert: props.staleCount > 0 },
    { icon: StickyNote, label: t('home.notes'), value: int(props.openTasksCount), on: props.onOpenTasks, alert: false },
    { icon: Package, label: t('home.stock'), value: eur(props.stockValue), sub: `${int(props.inStockCount)} ${t('home.pcs')}`, on: props.onOpenStock, alert: false },
  ];

  const compareText = isCurrent
    ? `vs ${prevTitle} · ${fmtDay(prev.start)}–${fmtDay(new Date(prevCut.getTime() - DAY))}`
    : `vs ${prevTitle}`;

  return (
    <div className="space-y-3 lg:space-y-5">
      {/* Selettore periodo: tipo + frecce. */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div role="tablist" aria-label={t('home.period')} className="flex p-0.5 rounded-lg bg-[var(--surface)] border border-[var(--border)]">
          {(['month', 'quarter', 'year'] as Kind[]).map(k => (
            <button key={k} role="tab" aria-selected={kind === k} onClick={() => { setKind(k); setOffset(0); setHover(null); }}
              className={`px-3 lg:px-3.5 py-1.5 rounded-md text-[12.5px] font-semibold transition-colors ${kind === k ? 'bg-[var(--text)] text-[var(--bg)]' : 'text-[var(--text-soft)] hover:text-[var(--text)]'}`}>
              {t(`home.${k}`)}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <button onClick={() => { setOffset(o => o - 1); setHover(null); }} aria-label={t('home.prevPeriod')}
            className="p-2 rounded-lg text-[var(--text-soft)] hover:text-[var(--text)] hover:bg-[var(--fill)]"><ChevronLeft size={16} /></button>
          <span className="hq-mono text-[11.5px] uppercase tracking-[0.04em] text-[var(--text)] min-w-[9.5rem] text-center">{periodTitle}</span>
          <button onClick={() => { setOffset(o => Math.min(0, o + 1)); setHover(null); }} disabled={isCurrent} aria-label={t('home.nextPeriod')}
            className="p-2 rounded-lg text-[var(--text-soft)] hover:text-[var(--text)] hover:bg-[var(--fill)] disabled:opacity-25 disabled:hover:bg-transparent"><ChevronRight size={16} /></button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-3 lg:gap-5">
        {/* ===== ETICHETTA ===== */}
        <section className="hq-label lg:col-span-8 p-4 sm:p-5 lg:p-6 flex flex-col" aria-label={t('home.netProfit')}>
          <div className="flex items-start justify-between gap-3 hq-mono text-[10px] sm:text-[10.5px] uppercase tracking-[0.06em] lbl-soft">
            <span>{t('home.netProfit')}{data.shared ? ` · ${t('home.yourShare')}` : ''}</span>
            <span className="text-right">{periodTitle}</span>
          </div>

          <div className="flex items-end justify-between gap-3 mt-2 sm:mt-3">
            <p className="font-display hq-wide font-black leading-[0.9] tracking-[-0.035em] text-[44px] sm:text-[60px] lg:text-[72px] num" style={{ fontStretch: '125%' }}>
              {eur(cur.profit)}
            </p>
            <div className="text-right pb-1 shrink-0">
              <div className="text-[15px] sm:text-[17px]"><Delta v={profitDelta} /></div>
              <p className="hq-mono text-[9.5px] sm:text-[10px] lbl-soft mt-1 normal-case">{compareText}</p>
            </div>
          </div>

          {/* Celle metriche: come le colonne taglia US/UK/EU di un'etichetta. */}
          <div className="grid grid-cols-3 sm:grid-cols-6 mt-4 sm:mt-5 border-t border-l lbl-rule">
            {cells.map(c => (
              <div key={c.label} className="border-r border-b lbl-rule px-2.5 py-2 sm:py-2.5 min-w-0">
                <p className="hq-mono text-[8.5px] sm:text-[9px] uppercase tracking-[0.05em] lbl-soft truncate">{c.label}</p>
                <p className="num font-bold text-[15px] sm:text-[16px] mt-1 truncate">{c.value}</p>
                <p className="text-[11px] mt-0.5 truncate">{c.delta}</p>
              </div>
            ))}
          </div>

          {/* Codice a barre = profitto per giorno (settimana nella vista anno). */}
          {hasAdvanced ? (
            <div className="mt-4 sm:mt-5 flex-1 flex flex-col">
              <div className="relative flex-1 flex flex-col" onMouseLeave={() => setHover(null)}>
                {hoverBar && (
                  <div className="absolute -top-1 z-10 pointer-events-none px-2 py-1 rounded-md text-[11px] font-semibold whitespace-nowrap"
                    style={{ background: 'var(--paper-ink)', color: 'var(--paper)', left: `${Math.min(85, Math.max(15, ((hoverBar.i + 0.5) / data.bars.length) * 100))}%`, transform: 'translate(-50%, -100%)' }}>
                    {data.step === 7 ? `${fmtDay(barDate(hoverBar.i))} →` : fmtDay(barDate(hoverBar.i))} · {hoverBar.count} {t('home.salesWord')} · {eur(hoverBar.profit)}
                  </div>
                )}
                <div className="flex-1 min-h-[88px] flex items-end gap-[2px] sm:gap-[3px]"
                  role="img" aria-label={`${t('home.barcodeAria')}. ${best && best.profit > 0 ? `${t('home.bestDay')}: ${fmtDay(barDate(best.i))} ${eur(best.profit)}` : t('home.noSales')}`}>
                  {data.bars.map(b => {
                    const future = b.i >= futureFrom;
                    const h = b.profit > 0 ? `max(4px, ${(b.profit / maxPos) * 100}%)` : '3px';
                    const gh = b.prevProfit > 0 ? `${(b.prevProfit / maxPos) * 100}%` : '';
                    return (
                      <div key={b.i} className="relative flex-1 h-full flex items-end justify-center cursor-default"
                        onMouseEnter={() => !future && setHover(b.i)}>
                        {gh && <span className="absolute bottom-0 inset-x-0 rounded-[1px]" style={{ height: gh, background: 'var(--paper-ghost)' }} />}
                        {future
                          ? <span className="relative w-full rounded-[1px]" style={{ height: 3, background: 'var(--paper-line)' }} />
                          : <span className="hq-bar relative w-[58%] min-w-[2px] rounded-[1px]"
                              style={{ height: h, background: b.profit > 0 ? 'var(--paper-ink)' : 'var(--paper-soft)', opacity: hover != null && hover !== b.i ? 0.45 : 1, animationDelay: `${Math.min(b.i, 60) * 8}ms` }} />}
                      </div>
                    );
                  })}
                </div>
                {negH > 0 && (
                  <div className="flex items-start gap-[2px] sm:gap-[3px] border-t lbl-rule" style={{ height: negH }} aria-hidden="true">
                    {data.bars.map(b => (
                      <div key={b.i} className="flex-1 flex justify-center">
                        {b.profit < 0 && <span className="hq-bar hq-bar-neg w-[58%] min-w-[2px] rounded-[1px] lbl-down" style={{ height: Math.max(3, (-b.profit / maxNeg) * negH), background: 'currentColor' }} />}
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div className="flex items-center justify-between gap-2 mt-2 hq-mono text-[9px] sm:text-[9.5px] uppercase tracking-[0.05em] lbl-soft">
                <span>{fmtDay(start)}</span>
                <span className="truncate">{code} · {isCurrent ? `${elapsedDays}/${totalDays}` : totalDays} {t('home.daysShort')}{cur.count === 0 ? ` · ${t('home.noSales')}` : ''}</span>
                <span>{fmtDay(new Date(end.getTime() - DAY))}</span>
              </div>
            </div>
          ) : (
            <button onClick={props.onUpgrade} className="mt-4 sm:mt-5 flex items-center justify-between gap-3 border lbl-rule rounded-lg px-3 py-3 text-left">
              <span className="flex items-center gap-2 text-[12.5px] font-semibold"><Lock size={14} /> {t('home.unlock')}</span>
              <span className="hq-mono text-[10px] uppercase tracking-[0.05em]">{t('home.unlockCta')} →</span>
            </button>
          )}
        </section>

        {/* ===== Colonna destra: obiettivo + da fare ===== */}
        <div className="lg:col-span-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-1 gap-3 lg:gap-5 content-start">
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

          <section className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-2 lg:p-2.5">
            <p className="sys-label px-2 pt-2 pb-1.5">{t('home.todo')}</p>
            {todo.map(row => {
              const Icon = row.icon;
              return (
                <button key={row.label} onClick={row.on}
                  className="w-full flex items-center gap-3 px-2 py-2.5 rounded-lg hover:bg-[var(--fill)] text-left group">
                  <span className={`w-8 h-8 rounded-md flex items-center justify-center shrink-0 ${row.alert ? 'bg-brand/15 text-brand-hi' : 'bg-[var(--fill)] text-[var(--text-soft)]'}`}><Icon size={15} /></span>
                  <span className="flex-1 min-w-0">
                    <span className="block text-[13px] font-semibold text-[var(--text)] truncate">{row.label}</span>
                    {row.sub && <span className="block text-[11px] text-[var(--text-faint)]">{row.sub}</span>}
                  </span>
                  <span className={`num font-bold text-[15px] ${row.alert ? 'text-[var(--text)]' : 'text-[var(--text-soft)]'}`}>{row.value}</span>
                  <ChevronRight size={14} className="text-[var(--text-faint)] group-hover:text-[var(--text-soft)]" />
                </button>
              );
            })}
          </section>
        </div>
      </div>

      {/* ===== Classifiche del periodo ===== */}
      {hasAdvanced && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 lg:gap-5">
          <RankCard title={t('home.byPlatform')} empty={t('home.noSales')}
            rows={data.platforms.map(r => ({ key: r.name, label: r.name, sub: `${r.count} ${t('home.salesWord')} · ${eur(r.revenue)}`, value: eur(r.profit), weight: r.revenue }))} />
          <RankCard title={t('home.byDept')} empty={t('home.noSales')}
            rows={data.depts.map(r => ({ key: r.name, label: r.name, icon: props.getCategoryIcon(r.name), sub: `${r.count} ${t('home.salesWord')}`, value: eur(r.profit), weight: Math.max(0, r.profit) }))} />
          <RankCard title={t('home.topItems')} empty={t('home.noSales')} className="md:col-span-2 lg:col-span-1"
            rows={data.top.map(({ p, profit, roi }) => ({ key: p.id, label: props.fullName(p.brand, p.name), sub: `${p.platform || t('home.private')}${roi != null ? ` · ROI ${Math.round(roi)}%` : ''}`, value: eur(profit), weight: null }))} />
        </div>
      )}
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
