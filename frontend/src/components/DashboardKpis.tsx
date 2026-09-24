// DashboardKpis — tre riquadri "a colpo d'occhio" sotto al grafico della Dashboard:
// ricavo ultimi 3 mesi (vs i 3 mesi prima), ricavo del mese e profitto del mese (vs mese prima).
// I calcoli sono quelli di "Esplora i numeri" (aggregate/valueOf), sulla quota dell'utente.
import { ArrowUp, ArrowDown } from 'lucide-react';
import { aggregate, valueOf, useCountUp, type Agg, type Metric, type Range, type XProduct } from './AnalyticsExplorer';

interface Props {
  products: XProduct[];
  myProfitFactor: (p: any) => number;
  myCostFactor: (p: any) => number;
  t: (key: string) => string;
  dateLocale: string;
}

interface Kpi { key: string; label: string; metric: Metric; cur: Agg; prev: Agg; vs: string }

export default function DashboardKpis({ products, myProfitFactor, myCostFactor, t, dateLocale }: Props) {
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth();
  const month = (off: number) => new Date(y, m + off, 1);
  const sum = (r: Range) => aggregate(products, r, r, myProfitFactor, myCostFactor);
  const monthName = (d: Date) => d.toLocaleDateString(dateLocale, { month: 'long' });
  const shortName = (d: Date) => d.toLocaleDateString(dateLocale, { month: 'short' }).replace('.', '');

  const thisMonth: Range = { start: month(0), end: month(1) };
  const lastMonth: Range = { start: month(-1), end: month(0) };
  const last3: Range = { start: month(-2), end: month(1) };
  const prev3: Range = { start: month(-5), end: month(-2) };
  const cm = sum(thisMonth), pm = sum(lastMonth);

  const kpis: Kpi[] = [
    { key: 'rev3', label: t('kpi.rev3m'), metric: 'revenue', cur: sum(last3), prev: sum(prev3), vs: `${t('kpi.vs')} ${shortName(prev3.start)} – ${shortName(month(-3))}` },
    { key: 'revM', label: t('kpi.revMonth'), metric: 'revenue', cur: cm, prev: pm, vs: `${t('kpi.vs')} ${monthName(lastMonth.start)}` },
    { key: 'profM', label: t('kpi.profitMonth'), metric: 'profit', cur: cm, prev: pm, vs: `${t('kpi.vs')} ${monthName(lastMonth.start)}` },
  ];

  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
      {kpis.map(k => <KpiCard key={k.key} kpi={k} dateLocale={dateLocale} />)}
    </div>
  );
}

function KpiCard({ kpi, dateLocale }: { kpi: Kpi; dateLocale: string }) {
  const eur = (n: number, sign = false) => new Intl.NumberFormat(dateLocale, {
    style: 'currency', currency: 'EUR', maximumFractionDigits: 0, useGrouping: 'always' as any, signDisplay: sign ? 'exceptZero' : 'auto',
  }).format(Math.round(n) || 0);
  // Periodo senza vendite = nessun dato: "—", non 0 € né 0 %.
  const cur = kpi.cur.count > 0 ? valueOf(kpi.cur, kpi.metric) : null;
  const prev = kpi.prev.count > 0 ? valueOf(kpi.prev, kpi.metric) : null;
  const shown = useCountUp(cur ?? 0);
  const diff = cur !== null && prev !== null ? cur - prev : null;
  const pct = diff !== null && prev !== 0 ? (diff / Math.abs(prev as number)) * 100 : null;
  const up = (diff ?? 0) > 0, down = (diff ?? 0) < 0;
  const tone = up ? 'text-[var(--up)]' : down ? 'text-[var(--down)]' : 'text-[var(--text-soft)]';

  return (
    <section className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-4 lg:p-5" aria-label={kpi.label}>
      <p className="text-[10px] lg:text-[11px] uppercase tracking-[0.12em] font-bold text-[var(--text-faint)]">{kpi.label}</p>
      <p className={`text-3xl lg:text-4xl font-extrabold num mt-2 leading-none ${kpi.metric === 'profit' && (cur ?? 0) < 0 ? 'text-[var(--down)]' : ''}`}>
        {cur === null ? '—' : eur(shown)}
      </p>
      <div className={`flex items-center gap-1.5 mt-3 text-sm font-bold num ${tone}`}>
        {diff === null ? (
          <span className="text-[var(--text-faint)]">—</span>
        ) : (
          <>
            {up && <ArrowUp size={16} aria-hidden />}
            {down && <ArrowDown size={16} aria-hidden />}
            <span>{pct === null ? '—' : `${pct > 0 ? '+' : ''}${new Intl.NumberFormat(dateLocale, { maximumFractionDigits: 0 }).format(pct)}%`}</span>
            <span className="font-semibold opacity-80">({eur(diff, true)})</span>
          </>
        )}
      </div>
      <p className="text-[11px] text-[var(--text-faint)] mt-1">{kpi.vs}</p>
    </section>
  );
}
