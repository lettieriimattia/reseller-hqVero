// PaymentPicker — "Pagato con" (acquisti) / "Incassato su" (vendite), collegato alla Liquidità.
// Scelte: un conto · una persona (acquisto: "a debito verso…" / "con credito verso…";
// vendita: "credito verso…" / "ripaga debito verso…") · "Dividi" su più fonti (la somma deve fare il totale).
// Propone l'ultima scelta usata. Le persone nuove si scrivono direttamente (il server le crea).
import { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';

export type Role = 'PURCHASE' | 'SALE';
export interface LiqAccount { id: string; name: string; type: string; archived: boolean; balanceCents: number }
export interface LiqPerson { id: string; name: string; balanceCents: number; archived: boolean }
export interface Part { accountId?: string; personName?: string; amountCents: number }
type Choice = { mode: 'account'; accountId: string } | { mode: 'person'; label: 'debt' | 'credit'; personName: string } | { mode: 'split' };
type Row = { src: string; amount: string }; // src: "acc:<id>" | "per:<nome>"

const LAST_KEY = (r: Role) => `hq-liq-last-${r}`;
export function parseCents(s: string): number | null {
  let v = (s || '').replace(/[€\s]/g, '');
  if (!v) return null;
  if (v.includes(',')) v = v.replace(/\./g, '').replace(',', '.');
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}
const centsStr = (c: number) => (c / 100).toFixed(2).replace('.', ',');

interface Props {
  role: Role;
  totalCents: number;
  accounts: LiqAccount[];
  people: LiqPerson[];
  lang: string;
  dateLocale: string;
  onChange: (parts: Part[] | null) => void; // null = scelta incompleta / non valida
}

export default function PaymentPicker({ role, totalCents, accounts, people, lang, dateLocale, onChange }: Props) {
  const tx = (it: string, en: string) => (lang === 'en' ? en : it);
  const eur = (c: number) => new Intl.NumberFormat(dateLocale, { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(c / 100);
  const active = accounts.filter(a => !a.archived);
  const peopleActive = people.filter(p => !p.archived);

  // Ultima scelta usata (se ancora valida), altrimenti il primo conto.
  const initial = (): Choice => {
    try {
      const last = JSON.parse(localStorage.getItem(LAST_KEY(role)) || 'null');
      if (last?.mode === 'account' && active.some(a => a.id === last.accountId)) return last;
      if (last?.mode === 'person' && last.personName) return last;
    } catch { /* ok */ }
    return active[0] ? { mode: 'account', accountId: active[0].id } : { mode: 'person', label: role === 'PURCHASE' ? 'debt' : 'credit', personName: '' };
  };
  const [choice, setChoice] = useState<Choice>(initial);
  const [rows, setRows] = useState<Row[]>(() => [
    { src: active[0] ? `acc:${active[0].id}` : '', amount: '' },
    { src: active[1] ? `acc:${active[1].id}` : '', amount: '' },
  ]);

  const selectValue = choice.mode === 'account' ? `acc:${choice.accountId}` : choice.mode === 'person' ? `per:${choice.label}` : 'split';
  const onSelect = (v: string) => {
    if (v === 'split') setChoice({ mode: 'split' });
    else if (v.startsWith('acc:')) setChoice({ mode: 'account', accountId: v.slice(4) });
    else setChoice({ mode: 'person', label: v.slice(4) as 'debt' | 'credit', personName: choice.mode === 'person' ? choice.personName : '' });
  };

  const splitSum = rows.reduce((s, r) => s + (parseCents(r.amount) || 0), 0);
  const parts: Part[] | null = useMemo(() => {
    if (choice.mode === 'account') return choice.accountId ? [{ accountId: choice.accountId, amountCents: totalCents }] : null;
    if (choice.mode === 'person') return choice.personName.trim() ? [{ personName: choice.personName.trim(), amountCents: totalCents }] : null;
    const ps: Part[] = [];
    for (const r of rows) {
      const c = parseCents(r.amount);
      if (!r.src && !c) continue;
      if (!r.src || !c || c <= 0) return null;
      if (r.src.startsWith('acc:')) ps.push({ accountId: r.src.slice(4), amountCents: c });
      else { const n = r.src.slice(4).trim(); if (!n) return null; ps.push({ personName: n, amountCents: c }); }
    }
    return ps.length > 0 && splitSum === totalCents ? ps : null;
  }, [choice, rows, totalCents, splitSum]);

  useEffect(() => {
    onChange(parts);
    if (parts && choice.mode !== 'split') { try { localStorage.setItem(LAST_KEY(role), JSON.stringify(choice)); } catch { /* ok */ } }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(parts)]);

  const field = 'w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl px-3 py-2.5 text-base sm:text-sm outline-none focus:border-brand';
  const personLabel = role === 'PURCHASE'
    ? { debt: tx('A debito verso una persona', 'On debt to a person'), credit: tx('Con credito verso una persona', 'Using credit with a person') }
    : { credit: tx('Credito verso una persona (pagherà dopo)', 'Credit to a person (pays later)'), debt: tx('Ripaga un debito verso una persona', 'Repays a debt to a person') };
  const personHint = (name: string) => {
    const p = peopleActive.find(x => x.name.trim().toLowerCase() === name.trim().toLowerCase());
    if (!p || totalCents <= 0) return null;
    const after = p.balanceCents + (role === 'PURCHASE' ? -totalCents : totalCents);
    const txt = (c: number) => (c > 0 ? `${tx('ti deve', 'owes you')} ${eur(c)}` : c < 0 ? `${tx('gli devi', 'you owe')} ${eur(-c)}` : tx('in pari', 'settled'));
    return <p className="text-[11px] text-[var(--text-soft)] mt-1">{tx('Adesso', 'Now')}: {txt(p.balanceCents)} → {tx('dopo', 'after')}: <b className={after > 0 ? 'text-[var(--up)]' : after < 0 ? 'text-[var(--down)]' : ''}>{txt(after)}</b></p>;
  };

  return (
    <div className="rounded-xl border border-[var(--border-2)] bg-[var(--surface)] p-3 space-y-2" data-payment-picker={role}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest">{role === 'PURCHASE' ? tx('Pagato con', 'Paid with') : tx('Incassato su', 'Received into')} *</span>
        <span className="text-xs text-[var(--text-soft)] num">{role === 'SALE' ? tx('netto', 'net') + ' ' : ''}<b className="text-[var(--text)]">{eur(totalCents)}</b></span>
      </div>
      <select value={selectValue} onChange={e => onSelect(e.target.value)} className={field} aria-label={role === 'PURCHASE' ? tx('Pagato con', 'Paid with') : tx('Incassato su', 'Received into')}>
        {active.length > 0 && <optgroup label={tx('Conti', 'Accounts')}>{active.map(a => <option key={a.id} value={`acc:${a.id}`}>{a.name} · {eur(a.balanceCents)}</option>)}</optgroup>}
        <optgroup label={tx('Persone', 'People')}>
          <option value={`per:${role === 'PURCHASE' ? 'debt' : 'credit'}`}>{personLabel[role === 'PURCHASE' ? 'debt' : 'credit']}</option>
          <option value={`per:${role === 'PURCHASE' ? 'credit' : 'debt'}`}>{personLabel[role === 'PURCHASE' ? 'credit' : 'debt']}</option>
        </optgroup>
        <option value="split">{tx('Dividi su più fonti…', 'Split across sources…')}</option>
      </select>

      {choice.mode === 'person' && (
        <div>
          <input value={choice.personName} onChange={e => setChoice({ ...choice, personName: e.target.value })} list={`pp-${role}`}
            placeholder={tx('Nome della persona (nuova o esistente)', 'Person name (new or existing)')} className={field} aria-label={tx('Persona', 'Person')} />
          <datalist id={`pp-${role}`}>{peopleActive.map(p => <option key={p.id} value={p.name} />)}</datalist>
          {personHint(choice.personName)}
        </div>
      )}

      {choice.mode === 'split' && (
        <div className="space-y-2">
          {rows.map((r, i) => (
            <div key={i} className="flex gap-2">
              <select value={r.src.startsWith('per:') ? 'per:' : r.src} onChange={e => setRows(rs => rs.map((x, k) => (k === i ? { ...x, src: e.target.value === 'per:' ? 'per: ' : e.target.value } : x)))}
                className={`${field} flex-1 min-w-0`} aria-label={tx('Fonte', 'Source')}>
                <option value="">{tx('Scegli…', 'Choose…')}</option>
                {active.map(a => <option key={a.id} value={`acc:${a.id}`}>{a.name}</option>)}
                <option value="per:">{tx('Una persona…', 'A person…')}</option>
              </select>
              {r.src.startsWith('per:') && (
                <input value={r.src.slice(4).trimStart()} onChange={e => setRows(rs => rs.map((x, k) => (k === i ? { ...x, src: `per:${e.target.value || ' '}` } : x)))}
                  list={`pp-${role}-s`} placeholder={tx('Nome', 'Name')} className={`${field} w-28`} aria-label={tx('Persona', 'Person')} />
              )}
              <input value={r.amount} onChange={e => setRows(rs => rs.map((x, k) => (k === i ? { ...x, amount: e.target.value } : x)))}
                inputMode="decimal" placeholder="0,00" className={`${field} w-24 text-right num`} aria-label={tx('Importo', 'Amount')} />
              {rows.length > 2 && <button type="button" onClick={() => setRows(rs => rs.filter((_, k) => k !== i))} aria-label={tx('Togli riga', 'Remove row')} className="px-2 text-[var(--text-faint)] hover:text-[var(--down)]"><Trash2 size={15} /></button>}
            </div>
          ))}
          <datalist id={`pp-${role}-s`}>{peopleActive.map(p => <option key={p.id} value={p.name} />)}</datalist>
          <div className="flex items-center justify-between">
            <button type="button" onClick={() => setRows(rs => [...rs, { src: '', amount: '' }])} className="text-xs font-bold text-brand-hi flex items-center gap-1"><Plus size={13} /> {tx('Aggiungi fonte', 'Add source')}</button>
            <button type="button" onClick={() => {
              // Completa l'ultima riga con quanto manca al totale
              const others = rows.slice(0, -1).reduce((s, r) => s + (parseCents(r.amount) || 0), 0);
              setRows(rs => rs.map((x, k) => (k === rs.length - 1 ? { ...x, amount: centsStr(Math.max(0, totalCents - others)) } : x)));
            }} className="text-xs font-bold text-[var(--text-soft)] hover:text-[var(--text)]">{tx('Completa il totale', 'Fill the rest')}</button>
          </div>
          <p className={`text-xs font-bold num ${splitSum === totalCents ? 'text-[var(--up)]' : 'text-[var(--down)]'}`}>
            {tx('Somma', 'Sum')} {eur(splitSum)} / {eur(totalCents)}
            {splitSum !== totalCents && ` · ${splitSum < totalCents ? tx('mancano', 'missing') : tx('troppo', 'too much')} ${eur(Math.abs(totalCents - splitSum))}`}
          </p>
        </div>
      )}
    </div>
  );
}
