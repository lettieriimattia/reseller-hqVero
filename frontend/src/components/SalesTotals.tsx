// SalesTotals — "Dati totali" in Analytics: ricavi totali e profitto netto su TUTTO lo storico vendite
// (dalla prima vendita a oggi, sempre sulla QUOTA dell'utente) + "Vendite totali": ogni mese con pezzi,
// ricavi e profitto; toccando un mese si vedono i pezzi venduti (prodotti identici raggruppati).
// Si apre anche dal collegamento "Osserva i prodotti venduti" in Magazzino (focusSignal).
import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { aggregate, SelectionList, type XProduct } from './AnalyticsExplorer';

interface Props {
  products: XProduct[];
  myProfitFactor: (p: any) => number;
  myCostFactor: (p: any) => number;
  t: (key: string) => string;
  dateLocale: string;
  fullName: (brand?: string, name?: string) => string;
  onOpenProduct: (id: string) => void;
  focusSignal: number; // cambia quando si arriva dal collegamento del Magazzino
}

const ALL = { start: new Date(1970, 0, 1), end: new Date(2999, 0, 1) };
const cap1 = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export default function SalesTotals({ products, myProfitFactor, myCostFactor, t, dateLocale, fullName, onOpenProduct, focusSignal }: Props) {
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<'value' | 'date'>('date');
  const [shown, setShown] = useState(20);
  const ref = useRef<HTMLElement>(null);

  // Arrivo dal Magazzino: apro l'elenco e porto la sezione in vista.
  useEffect(() => {
    if (!focusSignal) return;
    setOpen(true);
    const id = setTimeout(() => ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80);
    return () => clearTimeout(id);
  }, [focusSignal]);

  const eur = (n: number) => new Intl.NumberFormat(dateLocale, { style: 'currency', currency: 'EUR', maximumFractionDigits: 0, useGrouping: 'always' as any }).format(Math.round(n) || 0);
  const int = (n: number) => new Intl.NumberFormat(dateLocale, { maximumFractionDigits: 0, useGrouping: 'always' as any }).format(n);
  const dShort = (d: Date) => d.toLocaleDateString(dateLocale, { day: 'numeric', month: 'short' });

  const tot = aggregate(products, ALL, ALL, myProfitFactor, myCostFactor);
  const sold = useMemo(() => products.filter(p => p.status === 'VENDUTO' && p.soldAt), [products]);
  const first = sold.reduce<Date | null>((a, p) => { const d = new Date(p.soldAt as string); return !a || d < a ? d : a; }, null);

  // Mesi con almeno una vendita, dal più recente.
  const months = useMemo(() => {
    const m = new Map<string, { key: string; start: Date; end: Date }>();
    sold.forEach(p => {
      const d = new Date(p.soldAt as string);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      if (!m.has(key)) m.set(key, { key, start: new Date(d.getFullYear(), d.getMonth(), 1), end: new Date(d.getFullYear(), d.getMonth() + 1, 1) });
    });
    return [...m.values()].sort((a, b) => b.start.getTime() - a.start.getTime()).map(x => ({ ...x, agg: aggregate(products, x, x, myProfitFactor, myCostFactor) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sold, products]);

  const itemsOf = (r: { start: Date; end: Date }) => sold
    .filter(p => { const d = new Date(p.soldAt as string); return d >= r.start && d < r.end; })
    .map(p => ({ p, d: new Date(p.soldAt as string), v: ((p.salePrice || 0) - p.purchasePrice - (p.fees || 0)) * myProfitFactor(p) }));

  return (
    <section ref={ref} className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-4 sm:p-5 scroll-mt-24" aria-label={t('tot.title')}>
      <h3 className="font-bold text-lg">{t('tot.title')}</h3>
      <p className="text-[12.5px] text-[var(--text-soft)] mt-0.5">
        {t('tot.sub')}{first ? ` · ${t('tot.since')} ${first.toLocaleDateString(dateLocale, { day: 'numeric', month: 'long', year: 'numeric' })}` : ''}
      </p>

      <div className="grid grid-cols-2 gap-3 mt-4">
        <div className="bg-[var(--surface-2)] border border-[var(--border)] rounded-xl p-3 sm:p-4">
          <p className="text-[10px] uppercase tracking-widest font-bold text-[var(--text-faint)]">{t('tot.revenue')}</p>
          <p className="text-2xl sm:text-3xl font-extrabold num mt-1.5 leading-none">{eur(tot.revenue)}</p>
        </div>
        <div className="bg-[var(--surface-2)] border border-[var(--border)] rounded-xl p-3 sm:p-4">
          <p className="text-[10px] uppercase tracking-widest font-bold text-[var(--text-faint)]">{t('tot.profit')}</p>
          <p className={`text-2xl sm:text-3xl font-extrabold num mt-1.5 leading-none ${tot.profit < 0 ? 'text-[var(--down)]' : ''}`}>{eur(tot.profit)}</p>
        </div>
      </div>

      {/* Vendite totali: mese per mese */}
      <button onClick={() => setOpen(o => !o)} aria-expanded={open}
        className="w-full mt-3 flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl border border-[var(--border)] hover:border-[var(--border-2)] hover:bg-[var(--fill)] transition-colors text-left">
        <span className="text-sm font-bold">{t('tot.salesAll')} <span className="font-medium text-[var(--text-faint)] num">· {int(tot.count)} {tot.count === 1 ? t('ex.pc') : t('ex.pcs')}</span></span>
        <ChevronDown size={16} className={`text-[var(--text-faint)] transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        months.length === 0 ? (
          <p className="text-xs text-[var(--text-soft)] px-1 pt-3">{t('tot.none')}</p>
        ) : (
          <ul className="mt-2 space-y-1.5">
            {months.map(m => {
              const isOpen = month === m.key;
              const label = cap1(m.start.toLocaleDateString(dateLocale, { month: 'long', year: 'numeric' }));
              return (
                <li key={m.key}>
                  <button onClick={() => { setMonth(isOpen ? null : m.key); setShown(20); }} aria-expanded={isOpen}
                    className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-colors ${isOpen ? 'bg-[var(--fill-2)]' : 'hover:bg-[var(--fill)]'}`}>
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm font-bold">{label}</span>
                      <span className="block text-[11px] text-[var(--text-faint)] num">{int(m.agg.count)} {m.agg.count === 1 ? t('ex.pc') : t('ex.pcs')} · {t('tot.revenueShort')} {eur(m.agg.revenue)}</span>
                    </span>
                    <span className="text-right shrink-0">
                      <span className={`block text-sm font-extrabold num ${m.agg.profit < 0 ? 'text-[var(--down)]' : ''}`}>{eur(m.agg.profit)}</span>
                      <span className="block text-[10px] text-[var(--text-faint)]">{t('tot.profitShort')}</span>
                    </span>
                    <ChevronDown size={14} className={`text-[var(--text-faint)] transition-transform shrink-0 ${isOpen ? 'rotate-180' : ''}`} />
                  </button>
                  {isOpen && (
                    <div className="mt-1.5">
                      <SelectionList title={label} items={itemsOf(m)} metric="profit" fmt={(_m, v) => (v === null ? '—' : eur(v))} t={t}
                        sortBy={sortBy} setSortBy={setSortBy} shown={shown} setShown={setShown} onClose={() => setMonth(null)}
                        onOpen={onOpenProduct} fullName={fullName} dShort={dShort} dateLocale={dateLocale} />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )
      )}
    </section>
  );
}
