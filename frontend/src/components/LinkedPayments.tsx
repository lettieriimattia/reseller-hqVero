// LinkedPayments — nella scheda di un pezzo: da dove sono usciti i soldi (acquisto) e dove sono entrati (vendita).
// "Cambia" sostituisce la fonte mantenendo il totale; se non c'è ancora un collegamento, "Collega" lo crea.
// Gli importi si aggiornano da soli quando cambi prezzi/fee, elimini o ripristini il pezzo.
import { useEffect, useState } from 'react';
import { Loader2, Pencil, Link2 } from 'lucide-react';
import PaymentPicker, { type LiqAccount, type LiqPerson, type Part, type Role } from './PaymentPicker';

type ApiCall = <T = any>(path: string, opts?: RequestInit) => Promise<{ ok: boolean; data: T; status: number }>;
interface Link { groupId: string; role: Role; pieces: number; totalCents: number; parts: { amountCents: number; name: string; isPerson: boolean }[] }
interface Props {
  product: { id: string; status: string; purchasePrice: number; salePrice?: number | null; fees?: number | null };
  profitFactor: number; costFactor: number;
  liq: { accounts: LiqAccount[]; people: LiqPerson[] };
  apiCall: ApiCall; lang: string; dateLocale: string;
  onSaved: () => void; showToast: (m: string, t?: 'ok' | 'err' | 'warn') => void;
}

export default function LinkedPayments({ product, profitFactor, costFactor, liq, apiCall, lang, dateLocale, onSaved, showToast }: Props) {
  const tx = (it: string, en: string) => (lang === 'en' ? en : it);
  const eur = (c: number) => new Intl.NumberFormat(dateLocale, { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(c / 100);
  const [links, setLinks] = useState<Link[] | null>(null);
  const [editing, setEditing] = useState<{ role: Role; groupId?: string; totalCents: number } | null>(null);
  const [parts, setParts] = useState<Part[] | null>(null);
  const [busy, setBusy] = useState(false);
  const load = async () => { const r = await apiCall<Link[]>(`/liquidity/links?productId=${product.id}`); setLinks(r.ok && Array.isArray(r.data) ? r.data : []); };
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [product.id]);

  // Totale se il collegamento non c'è ancora (stessa formula del server)
  const ownTotal = (role: Role) => role === 'PURCHASE'
    ? Math.max(0, Math.round((product.purchasePrice || 0) * costFactor * 100))
    : Math.max(0, Math.round(((product.salePrice || 0) - (product.fees || 0)) * profitFactor * 100));
  const roles: Role[] = product.status === 'VENDUTO' ? ['PURCHASE', 'SALE'] : ['PURCHASE'];

  const save = async () => {
    if (!editing || !parts) return;
    setBusy(true);
    const r = editing.groupId
      ? await apiCall<any>(`/liquidity/links/${editing.groupId}`, { method: 'PUT', body: JSON.stringify({ parts }) })
      : await apiCall<any>('/liquidity/links', { method: 'POST', body: JSON.stringify({ role: editing.role, productIds: [product.id], factors: { [product.id]: editing.role === 'PURCHASE' ? costFactor : profitFactor }, parts }) });
    setBusy(false);
    if (!r.ok) return showToast(r.data?.error || tx('Errore', 'Error'), 'err');
    showToast(tx('Pagamento aggiornato', 'Payment updated'));
    setEditing(null); setParts(null); load(); onSaved();
  };

  if (!links) return <div className="flex justify-center py-3"><Loader2 size={16} className="animate-spin text-[var(--text-faint)]" /></div>;
  return (
    <div className="space-y-2" data-linked-payments>
      {roles.map(role => {
        const l = links.find(x => x.role === role);
        const label = role === 'PURCHASE' ? tx('Pagato con', 'Paid with') : tx('Incassato su', 'Received into');
        const isEditing = editing?.role === role;
        return (
          <div key={role} className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest">{label}</span>
              {!isEditing && (
                <button type="button" onClick={() => { setParts(null); setEditing({ role, groupId: l?.groupId, totalCents: l ? l.totalCents : ownTotal(role) }); }}
                  className="text-xs font-bold text-brand-hi flex items-center gap-1">
                  {l ? <><Pencil size={12} /> {tx('Cambia', 'Change')}</> : <><Link2 size={12} /> {tx('Collega', 'Link')}</>}
                </button>
              )}
            </div>
            {!isEditing && (l ? (
              <p className="text-sm mt-1">
                {l.parts.filter(p => p.amountCents > 0).map((p, i) => <span key={i}>{i > 0 && ' + '}<b>{p.name}</b>{p.isPerson ? ` (${role === 'PURCHASE' ? tx('persona', 'person') : tx('persona', 'person')})` : ''} {eur(p.amountCents)}</span>)}
                {l.totalCents === 0 && <span className="text-[var(--text-faint)]">{tx('annullato (pezzo eliminato o reso)', 'cancelled (item deleted or returned)')}</span>}
                {l.pieces > 1 && <span className="text-[11px] text-[var(--text-faint)]"> · {tx(`pagamento unico per ${l.pieces} pezzi`, `one payment for ${l.pieces} items`)}</span>}
              </p>
            ) : <p className="text-xs text-[var(--text-faint)] mt-1">{tx('Nessun pagamento collegato (operazione precedente alla Liquidità).', 'No linked payment.')}</p>)}
            {isEditing && (
              <div className="mt-2 space-y-2">
                <PaymentPicker role={role} totalCents={editing!.totalCents} accounts={liq.accounts} people={liq.people} lang={lang} dateLocale={dateLocale} onChange={setParts} />
                <div className="flex gap-2">
                  <button type="button" onClick={save} disabled={!parts || busy} className="flex-1 py-2 rounded-lg bg-[var(--text)] text-[var(--bg)] text-sm font-bold disabled:opacity-40">{busy ? '…' : tx('Salva pagamento', 'Save payment')}</button>
                  <button type="button" onClick={() => { setEditing(null); setParts(null); }} className="px-4 py-2 rounded-lg border border-[var(--border-2)] text-sm font-bold text-[var(--text-soft)]">{tx('Annulla', 'Cancel')}</button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
