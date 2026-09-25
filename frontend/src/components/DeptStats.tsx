// DeptStats — "Osserva le statistiche dei tuoi prodotti venduti" (Analytics, sotto la torta).
// Panoramica: una riga per reparto con vendite (ordinate per ricavi) con ricavi, profitto e RICARICO medio
// ponderato (profitto del reparto / costo d'acquisto del reparto × 100). Tutto sulla QUOTA dell'utente.
// Dettaglio (solo su richiesta): reparto scelto → classifica "Per modello / Per brand" (barre orizzontali,
// ordinate per pezzi venduti) → toccando un modello, le sue singole vendite.
// Modelli: regole fisse (lib/modelGroup) + IA solo per i nomi incerti, con risultato salvato.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, X, Package, Sparkles, Loader2, Check } from 'lucide-react';
import type { XProduct } from './AnalyticsExplorer';
import { groupFor, aiKey, readAiCache, resolveUncertain } from '../lib/modelGroup';
import { readMerges, applyMerges, loadServerMerges, saveMerges, parseMergeInstruction, askAiMerge, addMerges, removeTarget, type Merges, type MergeGroup } from '../lib/modelMerges';

type ApiCall = <T = any>(path: string, opts?: RequestInit) => Promise<{ ok: boolean; data: T; status: number }>;
interface Props {
  products: XProduct[];
  myProfitFactor: (p: any) => number;
  myCostFactor: (p: any) => number;
  t: (key: string) => string;
  dateLocale: string;
  fullName: (brand?: string, name?: string) => string;
  onOpenProduct: (id: string) => void;
  getCategoryIcon: (cat: any) => ReactNode;
  apiCall: ApiCall;
}
type Row = { key: string; n: number; revenue: number; profit: number; cost: number; items: { p: XProduct; d: Date; profit: number; revenue: number }[] };
const TOP = 10;

export default function DeptStats({ products, myProfitFactor, myCostFactor, t, dateLocale, fullName, onOpenProduct, getCategoryIcon, apiCall }: Props) {
  const [dept, setDept] = useState<string | null>(null);
  const [by, setBy] = useState<'model' | 'brand'>('model');
  const [openRow, setOpenRow] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [ai, setAi] = useState<Record<string, string>>(readAiCache);
  // Unioni decise dall'utente ("Chiedi all'AI") — salvate sull'account.
  const [merges, setMerges] = useState<Merges>(readMerges);
  const [askOpen, setAskOpen] = useState(false);
  const [askText, setAskText] = useState('');
  const [askBusy, setAskBusy] = useState(false);
  const [preview, setPreview] = useState<MergeGroup[] | null>(null);
  const [askMsg, setAskMsg] = useState('');
  useEffect(() => { loadServerMerges(apiCall).then(m => { if (m) setMerges(m); }); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const eur = (n: number) => new Intl.NumberFormat(dateLocale, { style: 'currency', currency: 'EUR', maximumFractionDigits: 0, useGrouping: 'always' as any }).format(Math.round(n) || 0);
  const int = (n: number) => new Intl.NumberFormat(dateLocale, { maximumFractionDigits: 0, useGrouping: 'always' as any }).format(n);
  const pct = (profit: number, cost: number) => (cost > 0 ? `${new Intl.NumberFormat(dateLocale, { maximumFractionDigits: 0, signDisplay: 'exceptZero' }).format((profit / cost) * 100)}%` : '—');
  const pcs = (n: number) => `${int(n)} ${n === 1 ? t('ex.pc') : t('ex.pcs')}`;

  const sold = useMemo(() => products.filter(p => p.status === 'VENDUTO' && p.soldAt), [products]);
  const deptOf = (p: XProduct) => (p.category || '').trim() || t('ds.other');

  // Nomi incerti per le regole → IA una volta sola (il server salva il risultato).
  useEffect(() => {
    const uncertain = sold.filter(p => !groupFor(p.brand, p.name).confident).map(p => ({ brand: p.brand || '', name: p.name || '' }));
    if (uncertain.length === 0) return;
    let alive = true;
    resolveUncertain(uncertain, apiCall).then(c => { if (alive) setAi({ ...c }); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sold]);
  const baseModelOf = (p: XProduct) => { const g = groupFor(p.brand, p.name); return g.confident ? g.model : (ai[aiKey(p.brand, p.name)] || g.model); };
  const modelOf = (p: XProduct) => applyMerges(baseModelOf(p), merges);

  const add = (m: Map<string, Row>, key: string, p: XProduct) => {
    const f = myProfitFactor(p), cf = myCostFactor(p);
    const revenue = (p.salePrice || 0) * f, profit = ((p.salePrice || 0) - p.purchasePrice - (p.fees || 0)) * f;
    const r = m.get(key) || { key, n: 0, revenue: 0, profit: 0, cost: 0, items: [] };
    r.n++; r.revenue += revenue; r.profit += profit; r.cost += p.purchasePrice * cf;
    r.items.push({ p, d: new Date(p.soldAt as string), profit, revenue });
    m.set(key, r);
  };

  const depts = useMemo(() => {
    const m = new Map<string, Row>();
    sold.forEach(p => add(m, deptOf(p), p));
    return [...m.values()].sort((a, b) => b.revenue - a.revenue);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sold]);

  const ranking = useMemo(() => {
    if (!dept) return [];
    const m = new Map<string, Row>();
    sold.filter(p => deptOf(p) === dept).forEach(p => add(m, by === 'model' ? modelOf(p) : groupFor(p.brand, p.name).brand, p));
    return [...m.values()].sort((a, b) => b.n - a.n || b.revenue - a.revenue);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sold, dept, by, ai, merges]);
  const maxN = Math.max(1, ...ranking.map(r => r.n));
  const pick = (d: string | null) => { setDept(d); setOpenRow(null); setShowAll(false); setPreview(null); setAskMsg(''); };

  // ---------- "Chiedi all'AI": unisci modelli ----------
  const deptBases = useMemo(() => (dept ? [...new Set(sold.filter(p => deptOf(p) === dept).map(baseModelOf))] : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sold, dept, ai]);
  const mergeNames = [...new Set([...deptBases, ...deptBases.map(b => applyMerges(b, merges))])];
  // Unioni attive in questo reparto: nome finale → modelli che ci sono confluiti.
  const activeMerges = (() => {
    const m = new Map<string, string[]>();
    deptBases.forEach(b => { const to = applyMerges(b, merges); if (to !== b) m.set(to, [...(m.get(to) || []), b]); });
    return [...m.entries()];
  })();
  const ask = async () => {
    const text = askText.trim();
    if (!text) return;
    setAskMsg(''); setPreview(null);
    const local = parseMergeInstruction(text, mergeNames);           // frasi semplici: niente IA
    if (local) { setPreview([local]); return; }
    setAskBusy(true);
    const groups = await askAiMerge(text, mergeNames, apiCall);       // frasi libere: IA
    setAskBusy(false);
    if (groups === null) setAskMsg(t('ds.aiOffline'));
    else if (groups.length === 0) setAskMsg(t('ds.aiNotUnderstood'));
    else setPreview(groups);
  };
  const confirmMerge = () => {
    if (!preview) return;
    const next = addMerges(merges, preview);
    setMerges(next); saveMerges(next, apiCall);
    setPreview(null); setAskText(''); setAskMsg(t('ds.aiDone'));
  };
  const undoMerge = (to: string) => { const next = removeTarget(merges, to); setMerges(next); saveMerges(next, apiCall); };

  const seg = (on: boolean) => `px-3 py-1.5 rounded-md text-xs font-bold whitespace-nowrap transition-colors ${on ? 'bg-[var(--text)] text-[var(--bg)]' : 'text-[var(--text-soft)] hover:text-[var(--text)]'}`;

  return (
    <section className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-4 sm:p-5" aria-label={t('ds.title')}>
      <h3 className="font-bold text-lg">{t('ds.title')}</h3>
      <p className="text-[12.5px] text-[var(--text-soft)] mt-0.5">{t('ds.sub')}</p>

      {depts.length === 0 ? (
        <p className="text-sm text-[var(--text-faint)] py-6">{t('ds.none')}</p>
      ) : (
        <>
          {/* Panoramica per reparto */}
          <div className="mt-4 overflow-hidden rounded-xl border border-[var(--border)]">
            <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-3 sm:gap-x-6 px-3 py-2 bg-[var(--surface-2)] text-[10px] uppercase tracking-widest font-bold text-[var(--text-faint)]">
              <span>{t('ds.dept')}</span><span className="text-right">{t('ds.revenue')}</span><span className="text-right">{t('ds.profit')}</span><span className="text-right w-12 sm:w-14">{t('ds.markup')}</span>
            </div>
            <ul className="divide-y divide-[var(--border)]">
              {depts.map(d => (
                <li key={d.key}>
                  <button onClick={() => pick(dept === d.key ? null : d.key)} aria-pressed={dept === d.key}
                    className={`w-full grid grid-cols-[1fr_auto_auto_auto] items-center gap-x-3 sm:gap-x-6 px-3 py-3 text-left transition-colors ${dept === d.key ? 'bg-brand/[0.08]' : 'hover:bg-[var(--fill)]'}`}>
                    <span className="flex items-center gap-2 min-w-0">
                      <span className="shrink-0 opacity-80">{getCategoryIcon(d.key)}</span>
                      <span className="min-w-0">
                        <span className="block text-sm font-bold truncate">{d.key}</span>
                        <span className="block text-[10px] text-[var(--text-faint)] num">{pcs(d.n)}</span>
                      </span>
                    </span>
                    <span className="text-sm num text-right">{eur(d.revenue)}</span>
                    <span className={`text-sm font-bold num text-right ${d.profit < 0 ? 'text-[var(--down)]' : ''}`}>{eur(d.profit)}</span>
                    <span className="text-sm font-bold num text-right w-12 sm:w-14 flex items-center justify-end gap-1">
                      {pct(d.profit, d.cost)}<ChevronRight size={13} className={`text-[var(--text-faint)] transition-transform ${dept === d.key ? 'rotate-90' : ''}`} />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>

          {!dept && (
            <button onClick={() => pick(depts[0].key)}
              className="w-full mt-3 py-2.5 rounded-xl bg-[var(--surface-2)] border border-[var(--border-2)] hover:border-[var(--border-3)] text-sm font-bold transition-colors">
              {t('ds.detail')} →
            </button>
          )}

          {/* Dettaglio: solo quando lo chiedi */}
          {dept && (
            <div className="mt-4 rounded-xl border border-[var(--border-2)] bg-[var(--surface-2)] p-3 sm:p-4">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-bold">{t('ds.bestSellers')}</p>
                <button onClick={() => pick(null)} aria-label={t('ex.close')} className="w-8 h-8 flex items-center justify-center rounded-md hover:bg-[var(--fill)] text-[var(--text-soft)]"><X size={15} /></button>
              </div>
              {/* Selettore reparto */}
              <div className="flex gap-1.5 mt-2 overflow-x-auto pb-1 -mx-1 px-1">
                {depts.map(d => (
                  <button key={d.key} onClick={() => pick(d.key)} aria-pressed={dept === d.key}
                    className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-bold border transition-colors ${dept === d.key ? 'bg-[var(--text)] text-[var(--bg)] border-transparent' : 'border-[var(--border-2)] text-[var(--text-soft)] hover:text-[var(--text)]'}`}>
                    {d.key}
                  </button>
                ))}
              </div>
              {/* Per modello / Per brand */}
              <div role="radiogroup" aria-label={t('ds.groupBy')} className="inline-flex p-0.5 rounded-lg bg-[var(--surface)] border border-[var(--border)] mt-3">
                {(['model', 'brand'] as const).map(k => (
                  <button key={k} role="radio" aria-checked={by === k} onClick={() => { setBy(k); setOpenRow(null); setShowAll(false); }} className={seg(by === k)}>{t(k === 'model' ? 'ds.byModel' : 'ds.byBrand')}</button>
                ))}
              </div>
              {by === 'model' && (
                <button onClick={() => { setAskOpen(o => !o); setAskMsg(''); setPreview(null); }} aria-expanded={askOpen}
                  className={`ml-2 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold border transition-colors align-top mt-3 ${askOpen ? 'bg-brand/15 border-brand/40 text-brand-hi' : 'border-[var(--border-2)] text-[var(--text-soft)] hover:text-[var(--text)]'}`}>
                  <Sparkles size={13} /> {t('ds.askAi')}
                </button>
              )}

              {/* Chiedi all'AI: unisci modelli con una frase */}
              {by === 'model' && askOpen && (
                <div className="mt-3 rounded-xl border border-brand/30 bg-brand/[0.05] p-3">
                  <form onSubmit={e => { e.preventDefault(); ask(); }} className="flex gap-2">
                    <input value={askText} onChange={e => setAskText(e.target.value)} placeholder={t('ds.askPlaceholder')} aria-label={t('ds.askAi')}
                      className="flex-1 min-w-0 bg-[var(--surface)] border border-[var(--border-2)] rounded-lg px-3 py-2 text-base sm:text-sm outline-none focus:border-brand" />
                    <button type="submit" disabled={askBusy || !askText.trim()}
                      className="px-3.5 py-2 rounded-lg bg-brand text-white text-sm font-bold disabled:opacity-40 flex items-center gap-1.5 shrink-0">
                      {askBusy ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />} {t('ds.askSend')}
                    </button>
                  </form>
                  <p className="text-[11px] text-[var(--text-faint)] mt-1.5">{t('ds.askHint')}</p>
                  {preview && (
                    <div className="mt-3 rounded-lg bg-[var(--surface)] border border-[var(--border-2)] p-3">
                      <p className="text-xs font-bold text-[var(--text-soft)]">{t('ds.previewTitle')}</p>
                      {preview.map(g => (
                        <p key={g.to} className="text-sm mt-1.5"><span className="text-[var(--text-soft)]">{g.from.join(', ')}</span> <span className="text-[var(--text-faint)]">→</span> <b>{g.to}</b></p>
                      ))}
                      <div className="flex gap-2 mt-3">
                        <button onClick={confirmMerge} className="flex-1 py-2 rounded-lg bg-[var(--text)] text-[var(--bg)] text-sm font-bold flex items-center justify-center gap-1.5"><Check size={15} /> {t('ds.confirm')}</button>
                        <button onClick={() => setPreview(null)} className="px-4 py-2 rounded-lg border border-[var(--border-2)] text-sm font-bold text-[var(--text-soft)]">{t('ds.cancel')}</button>
                      </div>
                    </div>
                  )}
                  {askMsg && <p className="text-xs text-[var(--text-soft)] mt-2">{askMsg}</p>}
                  {activeMerges.length > 0 && (
                    <div className="mt-3 pt-3 border-t border-[var(--border)]">
                      <p className="text-[10px] uppercase tracking-widest font-bold text-[var(--text-faint)] mb-1.5">{t('ds.activeMerges')}</p>
                      <ul className="space-y-1">
                        {activeMerges.map(([to, from]) => (
                          <li key={to} className="flex items-center gap-2 text-xs">
                            <span className="flex-1 min-w-0 truncate"><b>{to}</b> <span className="text-[var(--text-faint)]">← {from.join(', ')}</span></span>
                            <button onClick={() => undoMerge(to)} aria-label={`${t('ds.undo')} ${to}`} className="px-2 py-1 rounded-md text-[11px] font-bold text-[var(--text-soft)] hover:text-[var(--text)] hover:bg-[var(--fill)] shrink-0">{t('ds.undo')}</button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}

              <ul className="mt-3 space-y-1">
                {ranking.slice(0, showAll ? undefined : TOP).map((r, i) => {
                  const isOpen = openRow === r.key;
                  return (
                    <li key={r.key}>
                      <button onClick={() => setOpenRow(isOpen ? null : r.key)} aria-expanded={isOpen}
                        className={`w-full text-left px-2.5 py-2 rounded-lg transition-colors ${isOpen ? 'bg-[var(--fill-2)]' : 'hover:bg-[var(--fill)]'}`}>
                        <div className="flex items-center gap-2">
                          <span className="text-[11px] num text-[var(--text-faint)] w-5 shrink-0">{i + 1}</span>
                          <span className="text-sm font-bold truncate flex-1">{r.key}</span>
                          <span className="text-xs font-bold num shrink-0">{pcs(r.n)}</span>
                          <ChevronDown size={13} className={`text-[var(--text-faint)] shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                        </div>
                        <div className="ml-7 mt-1.5 h-2 rounded-full bg-[var(--fill)] overflow-hidden">
                          <div className="h-full rounded-full transition-all duration-500 motion-reduce:transition-none" style={{ width: `${(r.n / maxN) * 100}%`, background: 'var(--accent)' }} />
                        </div>
                        <div className="ml-7 mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] num text-[var(--text-soft)]">
                          <span>{t('ds.revenue')} <b className="text-[var(--text)]">{eur(r.revenue)}</b></span>
                          <span>{t('ds.profit')} <b className={r.profit < 0 ? 'text-[var(--down)]' : 'text-[var(--text)]'}>{eur(r.profit)}</b></span>
                          <span>{t('ds.markup')} <b className="text-[var(--text)]">{pct(r.profit, r.cost)}</b></span>
                        </div>
                      </button>
                      {isOpen && (
                        <ul className="ml-7 mt-1 mb-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] divide-y divide-[var(--border)] max-h-[320px] overflow-y-auto">
                          {[...r.items].sort((a, b) => b.d.getTime() - a.d.getTime()).map(({ p, d, profit, revenue }) => (
                            <li key={p.id}>
                              <button onClick={() => onOpenProduct(p.id)} className="w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-[var(--fill)] transition-colors">
                                <Package size={13} className="text-[var(--text-faint)] shrink-0" />
                                <span className="min-w-0 flex-1">
                                  <span className="block text-[12px] font-semibold truncate">{fullName(p.brand, p.name)}</span>
                                  <span className="block text-[10px] text-[var(--text-faint)] truncate">{[d.toLocaleDateString(dateLocale, { day: 'numeric', month: 'short', year: 'numeric' }), p.size, p.platform].filter(Boolean).join(' · ')}</span>
                                </span>
                                <span className="text-right shrink-0">
                                  <span className="block text-[12px] num">{eur(revenue)}</span>
                                  <span className={`block text-[10px] font-bold num ${profit < 0 ? 'text-[var(--down)]' : 'text-[var(--text-soft)]'}`}>{eur(profit)}</span>
                                </span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>
              {ranking.length > TOP && (
                <button onClick={() => setShowAll(s => !s)} className="w-full mt-2 py-2 text-xs font-bold text-[var(--text-soft)] hover:text-[var(--text)]">
                  {showAll ? t('ds.showLess') : `${t('ex.showMore')} (${ranking.length - TOP})`}
                </button>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
