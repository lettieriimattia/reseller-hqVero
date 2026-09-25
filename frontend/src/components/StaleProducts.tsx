// StaleProducts — "prodotti fermi" in Analytics, richiudibile.
// Fermo = in magazzino da PIÙ di `threshold` giorni (Impostazioni › Prodotti fermi, predefinito 60).
// Età calcolata come nell'"Età del magazzino" (stockAgeDays). Capitale = costo d'acquisto sulla QUOTA dell'utente.
// Aperto: suddivisione per reparto (quanti fermi, % sullo stock del reparto, capitale bloccato) e
// l'elenco dal più vecchio, con "Riprezza" che apre la modifica del prezzo del pezzo nel Magazzino.
import { useMemo, useState, type ReactNode } from 'react';
import { ChevronDown, Clock, CheckCircle2, Tag } from 'lucide-react';
import { stockAgeDays, type XProduct } from './AnalyticsExplorer';

interface Props {
  products: XProduct[];
  myCostFactor: (p: any) => number;
  threshold: number;
  t: (key: string) => string;
  dateLocale: string;
  fullName: (brand?: string, name?: string) => string;
  getCategoryIcon: (cat: any) => ReactNode;
  onReprice: (id: string) => void;
}
const LIST_STEP = 25;

export default function StaleProducts({ products, myCostFactor, threshold, t, dateLocale, fullName, getCategoryIcon, onReprice }: Props) {
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState(LIST_STEP);
  const eur = (n: number) => new Intl.NumberFormat(dateLocale, { style: 'currency', currency: 'EUR', maximumFractionDigits: 0, useGrouping: 'always' as any }).format(Math.round(n) || 0);
  const int = (n: number) => new Intl.NumberFormat(dateLocale, { maximumFractionDigits: 0, useGrouping: 'always' as any }).format(n);
  const deptOf = (p: XProduct) => (p.category || '').trim() || t('ds.other');

  const { stale, depts, capital } = useMemo(() => {
    const now = new Date();
    const stock = products.filter(p => p.status === 'IN STOCK');
    const stale = stock
      .map(p => ({ p, days: stockAgeDays(p, now), cost: p.purchasePrice * myCostFactor(p) }))
      .filter(x => x.days > threshold)
      .sort((a, b) => b.days - a.days);
    const byDept = new Map<string, { key: string; n: number; stock: number; capital: number }>();
    stock.forEach(p => { const k = deptOf(p); const d = byDept.get(k) || { key: k, n: 0, stock: 0, capital: 0 }; d.stock++; byDept.set(k, d); });
    stale.forEach(x => { const d = byDept.get(deptOf(x.p))!; d.n++; d.capital += x.cost; });
    const depts = [...byDept.values()].filter(d => d.n > 0).sort((a, b) => b.capital - a.capital);
    return { stale, depts, capital: stale.reduce((a, x) => a + x.cost, 0) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [products, threshold]);

  const n = stale.length;
  if (n === 0) {
    return (
      <section className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-4 sm:p-5 flex items-center gap-3" aria-label={t('st.title')}>
        <span className="w-9 h-9 rounded-lg bg-[var(--up)]/15 text-[var(--up)] flex items-center justify-center shrink-0"><CheckCircle2 size={18} /></span>
        <span>
          <span className="block text-sm font-bold">{t('st.noneTitle')}</span>
          <span className="block text-[12px] text-[var(--text-soft)]">{t('st.noneSub').replace('{days}', String(threshold))}</span>
        </span>
      </section>
    );
  }

  return (
    <section className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl" aria-label={t('st.title')}>
      <button onClick={() => setOpen(o => !o)} aria-expanded={open} className="w-full flex items-center gap-3 p-4 sm:p-5 text-left">
        <span className="w-9 h-9 rounded-lg bg-amber-500/15 text-amber-400 flex items-center justify-center shrink-0"><Clock size={18} /></span>
        <span className="flex-1 min-w-0">
          <span className="block text-sm sm:text-base font-bold">
            {t('st.head').replace('{n}', int(n)).replace('{items}', n === 1 ? t('st.item') : t('st.items')).replace('{capital}', eur(capital))}
          </span>
          <span className="block text-[12px] text-[var(--text-soft)]">{t('st.sub').replace('{days}', String(threshold))}</span>
        </span>
        <ChevronDown size={17} className={`text-[var(--text-faint)] shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="px-4 sm:px-5 pb-4 sm:pb-5 space-y-4">
          {/* Per reparto */}
          <div className="overflow-hidden rounded-xl border border-[var(--border)]">
            <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-3 sm:gap-x-6 px-3 py-2 bg-[var(--surface-2)] text-[10px] uppercase tracking-widest font-bold text-[var(--text-faint)]">
              <span>{t('ds.dept')}</span><span className="text-right">{t('st.stale')}</span><span className="text-right">{t('st.ofStock')}</span><span className="text-right">{t('st.blocked')}</span>
            </div>
            <ul className="divide-y divide-[var(--border)]">
              {depts.map(d => (
                <li key={d.key} className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-x-3 sm:gap-x-6 px-3 py-2.5">
                  <span className="flex items-center gap-2 min-w-0"><span className="shrink-0 opacity-80">{getCategoryIcon(d.key)}</span><span className="text-sm font-bold truncate">{d.key}</span></span>
                  <span className="text-sm num text-right">{int(d.n)}</span>
                  <span className="text-sm num text-right text-[var(--text-soft)]">{Math.round((d.n / d.stock) * 100)}%</span>
                  <span className="text-sm font-bold num text-right">{eur(d.capital)}</span>
                </li>
              ))}
            </ul>
          </div>

          {/* Elenco dal più vecchio */}
          <div>
            <p className="text-[10px] uppercase tracking-widest font-bold text-[var(--text-faint)] mb-2">{t('st.listTitle')}</p>
            <ul className="divide-y divide-[var(--border)] rounded-xl border border-[var(--border)] overflow-hidden">
              {stale.slice(0, shown).map(({ p, days, cost }) => {
                const price = p.quickSalePrice ?? null, market = p.marketPriceAvg ?? null;
                return (
                  <li key={p.id} className="flex items-center gap-3 px-3 py-2.5">
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-bold truncate">{fullName(p.brand, p.name)}</span>
                      <span className="block text-[11px] text-[var(--text-faint)] num truncate">
                        {[p.size ? `${t('st.size')} ${p.size}` : null, `${t('st.cost')} ${eur(cost)}`,
                          price != null ? `${t('st.price')} ${eur(price)}` : market != null ? `${t('st.market')} ${eur(market)}` : `${t('st.price')} —`].filter(Boolean).join(' · ')}
                      </span>
                    </span>
                    <span className="text-right shrink-0">
                      <span className="block text-sm font-extrabold num text-amber-400">{int(days)} {t('st.days')}</span>
                    </span>
                    <button onClick={() => onReprice(p.id)}
                      className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-[var(--border-2)] hover:border-[var(--border-3)] hover:bg-[var(--fill)] text-xs font-bold transition-colors">
                      <Tag size={12} /> {t('st.reprice')}
                    </button>
                  </li>
                );
              })}
            </ul>
            {n > shown && (
              <button onClick={() => setShown(s => s + LIST_STEP)} className="w-full mt-2 py-2 text-xs font-bold text-[var(--text-soft)] hover:text-[var(--text)]">
                {t('ex.showMore')} ({n - shown})
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
