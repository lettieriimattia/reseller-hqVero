// BestProduct — "Il tuo prodotto migliore" (Analytics, sotto le statistiche per reparto), richiudibile.
// Il MODELLO (nomi raggruppati come nelle statistiche) con il profitto totale più alto su tutto lo storico,
// sulla quota dell'utente: pezzi venduti, profitto, ricarico % e una frase di spiegazione.
// Calcolo deterministico, nessuna IA (usa solo i raggruppamenti già salvati, se ci sono).
import { useMemo, useState } from 'react';
import { ChevronDown, Trophy } from 'lucide-react';
import type { XProduct } from './AnalyticsExplorer';
import { groupFor, aiKey, readAiCache } from '../lib/modelGroup';
import { readMerges, applyMerges } from '../lib/modelMerges';

interface Props {
  products: XProduct[];
  myProfitFactor: (p: any) => number;
  myCostFactor: (p: any) => number;
  t: (key: string) => string;
  dateLocale: string;
}
const OPEN_KEY = 'hq-best-open';

export default function BestProduct({ products, myProfitFactor, myCostFactor, t, dateLocale }: Props) {
  const [open, setOpen] = useState(() => { try { return localStorage.getItem(OPEN_KEY) !== '0'; } catch { return true; } });
  const toggle = () => setOpen(o => { try { localStorage.setItem(OPEN_KEY, o ? '0' : '1'); } catch { /* ok */ } return !o; });
  const eur = (n: number) => new Intl.NumberFormat(dateLocale, { style: 'currency', currency: 'EUR', maximumFractionDigits: 0, useGrouping: 'always' as any }).format(Math.round(n) || 0);
  const int = (n: number) => new Intl.NumberFormat(dateLocale, { maximumFractionDigits: 0 }).format(n);

  const best = useMemo(() => {
    const ai = readAiCache(), merges = readMerges();
    const m = new Map<string, { model: string; n: number; profit: number; cost: number; revenue: number; depts: Set<string> }>();
    products.filter(p => p.status === 'VENDUTO' && p.soldAt).forEach(p => {
      const g = groupFor(p.brand, p.name);
      const model = applyMerges(g.confident ? g.model : (ai[aiKey(p.brand, p.name)] || g.model), merges); // rispetta le unioni dell'utente
      const f = myProfitFactor(p);
      const r = m.get(model) || { model, n: 0, profit: 0, cost: 0, revenue: 0, depts: new Set<string>() };
      r.n++; r.profit += ((p.salePrice || 0) - p.purchasePrice - (p.fees || 0)) * f; r.revenue += (p.salePrice || 0) * f;
      r.cost += p.purchasePrice * myCostFactor(p); if (p.category) r.depts.add(p.category);
      m.set(model, r);
    });
    // Profitto totale più alto; a parità, più pezzi venduti.
    return [...m.values()].sort((a, b) => b.profit - a.profit || b.n - a.n)[0] || null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [products]);

  if (!best || best.profit <= 0) return null;
  const markup = best.cost > 0 ? Math.round((best.profit / best.cost) * 100) : null;
  const pcs = `${int(best.n)} ${best.n === 1 ? t('ex.pc') : t('ex.pcs')}`;
  const why = best.n === 1
    ? t('best.whyOne').replace('{model}', best.model).replace('{profit}', eur(best.profit)).replace('{markup}', markup === null ? '—' : `${markup}%`)
    : t('best.why').replace('{n}', pcs).replace('{model}', best.model).replace('{profit}', eur(best.profit))
        .replace('{each}', eur(best.profit / best.n)).replace('{markup}', markup === null ? '—' : `${markup}%`);

  return (
    <section className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl" aria-label={t('best.title')}>
      <button onClick={toggle} aria-expanded={open} className="w-full flex items-center justify-between gap-3 p-4 sm:p-5 text-left">
        <span className="flex items-center gap-2 font-bold text-lg"><Trophy size={17} className="text-brand-hi" /> {t('best.title')}</span>
        <ChevronDown size={17} className={`text-[var(--text-faint)] transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="px-4 sm:px-5 pb-4 sm:pb-5 -mt-1">
          <p className="text-2xl sm:text-3xl font-extrabold leading-tight">{best.model}</p>
          {best.depts.size > 0 && <p className="text-[12px] text-[var(--text-faint)] mt-0.5">{[...best.depts].join(' · ')}</p>}
          <div className="grid grid-cols-3 gap-2 mt-3">
            {[
              [t('best.sold'), pcs],
              [t('ds.profit'), eur(best.profit)],
              [t('ds.markup'), markup === null ? '—' : `${markup > 0 ? '+' : ''}${markup}%`],
            ].map(([k, v]) => (
              <div key={k} className="bg-[var(--surface-2)] border border-[var(--border)] rounded-xl px-3 py-2.5">
                <p className="text-[10px] uppercase tracking-widest font-bold text-[var(--text-faint)] truncate">{k}</p>
                <p className="text-lg sm:text-xl font-extrabold num mt-0.5 truncate">{v}</p>
              </div>
            ))}
          </div>
          <p className="text-sm text-[var(--text-soft)] mt-3">{why}</p>
        </div>
      )}
    </section>
  );
}
