// Liquidity — "Liquidità" (Magazzino, al posto di "Venduti"): bilancio personale dei soldi.
// TOTALE = conti + crediti − debiti. Tutti i saldi arrivano dal server, calcolati dai MOVIMENTI:
// qui non si scrive mai un saldo, si registrano solo operazioni.
// Persona: saldo positivo = mi deve (verde), negativo = le devo (rosso).
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Banknote, Landmark, Bitcoin, Store, Wallet, ArrowLeftRight, Plus, Minus, HandCoins, Users, Scale, Archive, Trash2, X, Loader2, ChevronDown } from 'lucide-react';

type ApiCall = <T = any>(path: string, opts?: RequestInit) => Promise<{ ok: boolean; data: T; status: number }>;
interface Account { id: string; name: string; type: string; archived: boolean; balanceCents: number }
interface Person { id: string; name: string; note: string | null; archived: boolean; balanceCents: number }
interface Movement { id: string; date: string; amountCents: number; kind: string; note: string | null;
  fromAccountId: string | null; toAccountId: string | null; fromPersonId: string | null; toPersonId: string | null; from: string | null; to: string | null }
type Op = 'DEPOSIT' | 'WITHDRAW' | 'TRANSFER' | 'CREDIT' | 'DEBT' | 'SETTLE' | 'PERSON_TRANSFER' | 'NEW_ACCOUNT';

interface Props { apiCall: ApiCall; lang: string; dateLocale: string; showToast: (msg: string, type?: 'ok' | 'err' | 'warn') => void }

const TYPES: { k: string; it: string; en: string; Icon: typeof Wallet }[] = [
  { k: 'CASH', it: 'Contanti', en: 'Cash', Icon: Banknote },
  { k: 'BANK', it: 'Conto corrente', en: 'Bank account', Icon: Landmark },
  { k: 'CRYPTO', it: 'Crypto', en: 'Crypto', Icon: Bitcoin },
  { k: 'PLATFORM', it: 'Saldo piattaforma', en: 'Platform balance', Icon: Store },
  { k: 'OTHER', it: 'Altro', en: 'Other', Icon: Wallet },
];
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
// "1.234,50" / "1234.5" / "12" → centesimi interi
export function parseCents(s: string): number | null {
  let v = (s || '').replace(/[€\s]/g, '');
  if (!v) return null;
  if (v.includes(',')) v = v.replace(/\./g, '').replace(',', '.');
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

export default function Liquidity({ apiCall, lang, dateLocale, showToast }: Props) {
  const en = lang === 'en';
  const tx = (it: string, eng: string) => (en ? eng : it);
  const [data, setData] = useState<{ accounts: Account[]; people: Person[]; totalCents: number } | null>(null);
  const [loadErr, setLoadErr] = useState('');
  const [op, setOp] = useState<Op | null>(null);
  const [detail, setDetail] = useState<{ kind: 'account' | 'person'; id: string } | null>(null);
  const [showEven, setShowEven] = useState(false);

  const eur = (c: number, sign = false) => new Intl.NumberFormat(dateLocale, {
    style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: 'always' as any, signDisplay: sign ? 'exceptZero' : 'auto',
  }).format(c / 100);

  const load = async () => {
    const { ok, data: d, status } = await apiCall<any>('/liquidity');
    if (ok && d?.accounts) { setData(d); setLoadErr(''); }
    else setLoadErr(status === 404 ? tx('La Liquidità sarà disponibile dopo il prossimo aggiornamento del server.', 'Liquidity will be available after the next server update.') : tx('Non riesco a caricare la liquidità. Riprova tra poco.', 'Could not load liquidity. Try again shortly.'));
  };
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const accounts = (data?.accounts || []).filter(a => !a.archived);
  const credits = (data?.people || []).filter(p => p.balanceCents > 0).sort((a, b) => b.balanceCents - a.balanceCents);
  const debts = (data?.people || []).filter(p => p.balanceCents < 0).sort((a, b) => a.balanceCents - b.balanceCents);
  const even = (data?.people || []).filter(p => p.balanceCents === 0 && !p.archived);
  const sumA = accounts.reduce((s, a) => s + a.balanceCents, 0), sumC = credits.reduce((s, p) => s + p.balanceCents, 0), sumD = debts.reduce((s, p) => s + p.balanceCents, 0);
  const typeOf = (k: string) => TYPES.find(x => x.k === k) || TYPES[4];

  const actions: { op: Op; label: string; Icon: typeof Wallet }[] = [
    { op: 'DEPOSIT', label: tx('Aggiungi', 'Add'), Icon: Plus },
    { op: 'WITHDRAW', label: tx('Togli', 'Remove'), Icon: Minus },
    { op: 'TRANSFER', label: tx('Trasferisci', 'Transfer'), Icon: ArrowLeftRight },
    { op: 'CREDIT', label: tx('Mi deve', 'Owes me'), Icon: HandCoins },
    { op: 'DEBT', label: tx('Gli devo', 'I owe'), Icon: HandCoins },
    { op: 'SETTLE', label: tx('Salda', 'Settle'), Icon: Scale },
    { op: 'PERSON_TRANSFER', label: tx('Tra persone', 'Between people'), Icon: Users },
    { op: 'NEW_ACCOUNT', label: tx('Nuovo conto', 'New account'), Icon: Wallet },
  ];

  if (loadErr) return <div className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-6 text-sm text-[var(--text-soft)]">{loadErr}</div>;
  if (!data) return <div className="flex justify-center py-16"><Loader2 className="animate-spin text-[var(--text-faint)]" /></div>;

  const personLine = (p: Person) => p.balanceCents > 0
    ? <span className="text-[var(--up)]">{tx('ti deve', 'owes you')} {eur(p.balanceCents)}</span>
    : p.balanceCents < 0 ? <span className="text-[var(--down)]">{tx('gli devi', 'you owe')} {eur(-p.balanceCents)}</span>
    : <span className="text-[var(--text-faint)]">{tx('in pari', 'settled')}</span>;

  const Group = ({ title, total, tone, children, empty }: { title: string; total: number; tone: string; children: ReactNode; empty: string }) => (
    <section className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
        <p className="text-[11px] uppercase tracking-widest font-bold text-[var(--text-faint)]">{title}</p>
        <p className={`text-sm font-extrabold num ${tone}`}>{eur(total)}</p>
      </div>
      {Array.isArray(children) && children.length === 0 ? <p className="px-4 py-4 text-sm text-[var(--text-faint)]">{empty}</p> : <ul className="divide-y divide-[var(--border)]">{children}</ul>}
    </section>
  );

  return (
    <div className="space-y-4">
      {/* TOTALE */}
      <section className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-4 sm:p-5" aria-label={tx('Totale liquidità', 'Total liquidity')}>
        <p className="text-[11px] uppercase tracking-widest font-bold text-[var(--text-faint)]">{tx('Totale', 'Total')}</p>
        <p className={`text-4xl sm:text-5xl font-extrabold num mt-1.5 leading-none ${data.totalCents < 0 ? 'text-[var(--down)]' : ''}`}>{eur(data.totalCents)}</p>
        <p className="text-[12px] text-[var(--text-soft)] mt-2 num">
          {tx('Conti', 'Accounts')} {eur(sumA)} <span className="text-[var(--up)]">+ {tx('crediti', 'credits')} {eur(sumC)}</span> <span className="text-[var(--down)]">− {tx('debiti', 'debts')} {eur(-sumD)}</span>
        </p>
        <div className="grid grid-cols-4 gap-1.5 mt-4">
          {actions.map(a => (
            <button key={a.op} onClick={() => setOp(a.op)}
              className="flex flex-col items-center gap-1 py-2.5 rounded-xl bg-[var(--surface-2)] border border-[var(--border)] hover:border-[var(--border-2)] text-[11px] font-bold transition-colors">
              <a.Icon size={16} className={a.op === 'CREDIT' ? 'text-[var(--up)]' : a.op === 'DEBT' ? 'text-[var(--down)]' : 'text-brand-hi'} />
              <span className="text-center leading-tight">{a.label}</span>
            </button>
          ))}
        </div>
      </section>

      <Group title={tx('Conti', 'Accounts')} total={sumA} tone="" empty={tx('Nessun conto. Tocca "Nuovo conto" per crearne uno.', 'No accounts yet. Tap "New account".')}>
        {accounts.map(a => { const T = typeOf(a.type); return (
          <li key={a.id}><button onClick={() => setDetail({ kind: 'account', id: a.id })} className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-[var(--fill)]">
            <span className="w-9 h-9 rounded-lg bg-[var(--fill)] flex items-center justify-center shrink-0"><T.Icon size={16} className="text-[var(--text-soft)]" /></span>
            <span className="flex-1 min-w-0"><span className="block text-sm font-bold truncate">{a.name}</span><span className="block text-[11px] text-[var(--text-faint)]">{tx(T.it, T.en)}</span></span>
            <span className={`text-sm font-extrabold num ${a.balanceCents < 0 ? 'text-[var(--down)]' : ''}`}>{eur(a.balanceCents)}</span>
          </button></li>); })}
      </Group>

      <Group title={tx('Crediti · ti devono', 'Credits · owed to you')} total={sumC} tone="text-[var(--up)]" empty={tx('Nessuno ti deve soldi.', 'Nobody owes you money.')}>
        {credits.map(p => (
          <li key={p.id}><button onClick={() => setDetail({ kind: 'person', id: p.id })} className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-[var(--fill)]">
            <span className="flex-1 min-w-0 text-sm font-bold truncate">{p.name}</span>
            <span className="text-sm font-extrabold num text-[var(--up)]">+{eur(p.balanceCents)}</span>
          </button></li>))}
      </Group>

      <Group title={tx('Debiti · devi tu', 'Debts · you owe')} total={sumD} tone="text-[var(--down)]" empty={tx('Non devi soldi a nessuno.', 'You owe nobody.')}>
        {debts.map(p => (
          <li key={p.id}><button onClick={() => setDetail({ kind: 'person', id: p.id })} className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-[var(--fill)]">
            <span className="flex-1 min-w-0 text-sm font-bold truncate">{p.name}</span>
            <span className="text-sm font-extrabold num text-[var(--down)]">{eur(p.balanceCents)}</span>
          </button></li>))}
      </Group>

      {even.length > 0 && (
        <div>
          <button onClick={() => setShowEven(s => !s)} className="flex items-center gap-1.5 text-xs font-bold text-[var(--text-soft)] px-1">
            <ChevronDown size={14} className={`transition-transform ${showEven ? 'rotate-180' : ''}`} /> {tx('Persone in pari', 'Settled people')} ({even.length})
          </button>
          {showEven && (
            <ul className="mt-2 bg-[var(--surface)] border border-[var(--border)] rounded-2xl divide-y divide-[var(--border)] overflow-hidden">
              {even.map(p => (
                <li key={p.id}><button onClick={() => setDetail({ kind: 'person', id: p.id })} className="w-full flex items-center justify-between px-4 py-2.5 text-left hover:bg-[var(--fill)] text-sm">
                  <span className="font-semibold">{p.name}</span><span className="text-[var(--text-faint)] text-xs">{tx('in pari', 'settled')}</span></button></li>))}
            </ul>
          )}
        </div>
      )}

      {op && <OpSheet op={op} accounts={accounts} people={data.people} onClose={() => setOp(null)} onDone={() => { setOp(null); load(); }}
        apiCall={apiCall} tx={tx} eur={eur} showToast={showToast} personLine={personLine} />}
      {detail && <DetailSheet detail={detail} data={data} onClose={() => setDetail(null)} onChanged={load} apiCall={apiCall} tx={tx} eur={eur}
        dateLocale={dateLocale} typeOf={typeOf} personLine={personLine} showToast={showToast}
        onSettle={() => { setDetail(null); setOp('SETTLE'); }} />}
    </div>
  );
}

// ---------- Foglio "operazione" ----------
function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-[70] flex items-end sm:items-center justify-center" role="dialog" aria-modal="true" aria-label={title}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full sm:max-w-md max-h-[90vh] overflow-y-auto bg-[var(--surface)] border border-[var(--border-2)] rounded-t-3xl sm:rounded-2xl p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))]">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-bold">{title}</h3>
          <button onClick={onClose} aria-label="Chiudi" className="p-1.5 rounded-full hover:bg-[var(--fill)] text-[var(--text-soft)]"><X size={18} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}
const field = 'w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl px-3 py-2.5 text-base sm:text-sm outline-none focus:border-brand';
const Label = ({ children }: { children: ReactNode }) => <span className="block text-[10px] uppercase tracking-widest font-bold text-[var(--text-faint)] mb-1.5">{children}</span>;

function OpSheet({ op, accounts, people, onClose, onDone, apiCall, tx, eur, showToast, personLine }: {
  op: Op; accounts: Account[]; people: Person[]; onClose: () => void; onDone: () => void; apiCall: ApiCall;
  tx: (a: string, b: string) => string; eur: (c: number, s?: boolean) => string; showToast: Props['showToast']; personLine: (p: Person) => ReactNode;
}) {
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(today());
  const [note, setNote] = useState('');
  const [accA, setAccA] = useState(accounts[0]?.id || '');
  const [accB, setAccB] = useState(accounts[1]?.id || '');
  const [optAcc, setOptAcc] = useState('');         // conto facoltativo per crediti/debiti
  const [perA, setPerA] = useState('');             // nome persona (esistente o nuova)
  const [perB, setPerB] = useState('');
  const [newName, setNewName] = useState(''); const [newType, setNewType] = useState('CASH');
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const active = people.filter(p => !p.archived);
  const findP = (name: string) => people.find(p => p.name.trim().toLowerCase() === name.trim().toLowerCase()) || null;
  const pA = findP(perA), pB = findP(perB);
  const cents = parseCents(amount);
  // Salda: verso deciso dal saldo (ti deve → incasso; gli devi → pago)
  const [dir, setDir] = useState<'in' | 'out'>('in');
  useEffect(() => { if (op === 'SETTLE' && pA) { setDir(pA.balanceCents < 0 ? 'out' : 'in'); if (!amount && pA.balanceCents !== 0) setAmount(String(Math.abs(pA.balanceCents) / 100).replace('.', ',')); } /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [op, pA?.id]);

  const titles: Record<Op, string> = {
    DEPOSIT: tx('Aggiungi soldi a un conto', 'Add money'), WITHDRAW: tx('Togli soldi da un conto', 'Remove money'), TRANSFER: tx('Trasferisci tra conti', 'Transfer'),
    CREDIT: tx('Nuovo credito: qualcuno ti deve', 'New credit: someone owes you'), DEBT: tx('Nuovo debito: devi a qualcuno', 'New debt: you owe someone'),
    SETTLE: tx('Salda un credito o un debito', 'Settle'), PERSON_TRANSFER: tx('Tra persone (una paga l\'altra per te)', 'Between people'), NEW_ACCOUNT: tx('Nuovo conto', 'New account'),
  };
  const needsAccount = ['DEPOSIT', 'WITHDRAW', 'TRANSFER', 'SETTLE'].includes(op);

  // Anteprima del saldo dopo l'operazione (persone)
  const after = (p: Person | null, delta: number) => (p && cents ? personLine({ ...p, balanceCents: p.balanceCents + delta }) : null);

  const submit = async (e: FormEvent) => {
    e.preventDefault(); setErr('');
    if (op === 'NEW_ACCOUNT') {
      if (!newName.trim()) return setErr(tx('Dai un nome al conto', 'Name the account'));
      const init = amount.trim() ? parseCents(amount) : 0;
      if (init === null) return setErr(tx('Saldo iniziale non valido', 'Invalid starting balance'));
      setBusy(true);
      const r = await apiCall<any>('/liquidity/accounts', { method: 'POST', body: JSON.stringify({ name: newName, type: newType, initialCents: init }) });
      setBusy(false);
      if (!r.ok) return setErr(r.data?.error || tx('Errore', 'Error'));
      showToast(tx('Conto creato', 'Account created')); return onDone();
    }
    if (!cents || cents <= 0) return setErr(tx('Scrivi un importo maggiore di zero', 'Enter an amount above zero'));
    const person = (name: string, key: 'from' | 'to') => { const p = findP(name); return p ? { [`${key}PersonId`]: p.id } : { [`${key}PersonName`]: name.trim() }; };
    // Oggi = ora esatta (così l'ordine dello storico segue l'ordine reale); giorni passati = mezzogiorno locale.
    const when = date === today() ? new Date().toISOString() : new Date(`${date}T12:00:00`).toISOString();
    let body: any = { amountCents: cents, date: when, note };
    if (op === 'DEPOSIT') body = { ...body, kind: 'DEPOSIT', toAccountId: accA };
    if (op === 'WITHDRAW') body = { ...body, kind: 'WITHDRAW', fromAccountId: accA };
    if (op === 'TRANSFER') body = { ...body, kind: 'TRANSFER', fromAccountId: accA, toAccountId: accB };
    if (op === 'CREDIT') body = { ...body, kind: 'CREDIT', ...person(perA, 'to'), fromAccountId: optAcc || null };
    if (op === 'DEBT') body = { ...body, kind: 'DEBT', ...person(perA, 'from'), toAccountId: optAcc || null };
    if (op === 'SETTLE') {
      if (!pA) return setErr(tx('Scegli una persona dall\'elenco', 'Pick a person from the list'));
      body = dir === 'in' ? { ...body, kind: 'SETTLE_IN', fromPersonId: pA.id, toAccountId: accA } : { ...body, kind: 'SETTLE_OUT', fromAccountId: accA, toPersonId: pA.id };
    }
    if (op === 'PERSON_TRANSFER') body = { ...body, kind: 'PERSON_TRANSFER', ...person(perA, 'from'), ...person(perB, 'to') };
    if ((op === 'CREDIT' || op === 'DEBT' || op === 'PERSON_TRANSFER') && !perA.trim()) return setErr(tx('Scrivi il nome della persona', 'Enter the person\'s name'));
    if (op === 'PERSON_TRANSFER' && !perB.trim()) return setErr(tx('Scrivi chi riceve i soldi', 'Enter who receives'));
    setBusy(true);
    const r = await apiCall<any>('/liquidity/movements', { method: 'POST', body: JSON.stringify(body) });
    setBusy(false);
    if (!r.ok) return setErr(r.data?.error || tx('Errore', 'Error'));
    showToast(tx('Operazione registrata', 'Saved')); onDone();
  };

  const accSelect = (value: string, onChange: (v: string) => void, label: string, optional?: string) => (
    <label className="block"><Label>{label}</Label>
      <select value={value} onChange={e => onChange(e.target.value)} className={field}>
        {optional && <option value="">{optional}</option>}
        {accounts.map(a => <option key={a.id} value={a.id}>{a.name} · {eur(a.balanceCents)}</option>)}
      </select></label>
  );
  const personInput = (value: string, onChange: (v: string) => void, label: string, listId: string) => (
    <label className="block"><Label>{label}</Label>
      <input value={value} onChange={e => onChange(e.target.value)} list={listId} placeholder={tx('Nome (nuovo o esistente)', 'Name (new or existing)')} className={field} />
      <datalist id={listId}>{active.map(p => <option key={p.id} value={p.name} />)}</datalist></label>
  );

  if (needsAccount && accounts.length === 0) {
    return <Sheet title={titles[op]} onClose={onClose}><p className="text-sm text-[var(--text-soft)]">{tx('Prima crea un conto con "Nuovo conto".', 'Create an account first.')}</p></Sheet>;
  }
  return (
    <Sheet title={titles[op]} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        {op === 'NEW_ACCOUNT' && (<>
          <label className="block"><Label>{tx('Nome', 'Name')}</Label><input value={newName} onChange={e => setNewName(e.target.value)} placeholder={tx('Es. Revolut, Contanti, Vinted', 'E.g. Revolut, Cash, Vinted')} className={field} autoFocus /></label>
          <label className="block"><Label>{tx('Tipo', 'Type')}</Label>
            <select value={newType} onChange={e => setNewType(e.target.value)} className={field}>{TYPES.map(x => <option key={x.k} value={x.k}>{tx(x.it, x.en)}</option>)}</select></label>
          <label className="block"><Label>{tx('Saldo iniziale in € (anche negativo)', 'Starting balance in € (can be negative)')}</Label>
            <input value={amount} onChange={e => setAmount(e.target.value)} inputMode="decimal" placeholder="0,00" className={field} /></label>
          {newType === 'CRYPTO' && <p className="text-[11px] text-[var(--text-faint)]">{tx('Il valore delle crypto si inserisce a mano in €, senza prezzi in tempo reale.', 'Crypto value is entered manually in €.')}</p>}
        </>)}

        {op === 'SETTLE' && (<>
          {personInput(perA, setPerA, tx('Persona', 'Person'), "liq-p1")}
          {pA && <p className="text-xs">{tx('Adesso', 'Now')}: {personLine(pA)}</p>}
          <div className="grid grid-cols-2 gap-1 p-1 rounded-xl bg-[var(--surface-2)] border border-[var(--border)]">
            {(['in', 'out'] as const).map(d => <button type="button" key={d} onClick={() => setDir(d)} className={`py-2 rounded-lg text-xs font-bold ${dir === d ? 'bg-[var(--text)] text-[var(--bg)]' : 'text-[var(--text-soft)]'}`}>
              {d === 'in' ? tx('Mi paga lui', 'They pay me') : tx('Lo pago io', 'I pay them')}</button>)}
          </div>
        </>)}
        {op === 'PERSON_TRANSFER' && (<>
          <p className="text-[12px] text-[var(--text-soft)]">{tx('Una persona paga un\'altra al posto tuo: quello che doveva a te passa all\'altra (in qualsiasi direzione).', 'One person pays another on your behalf.')}</p>
          {personInput(perA, setPerA, tx('Chi paga', 'Who pays'), "liq-p1")}
          {personInput(perB, setPerB, tx('Chi riceve', 'Who receives'), "liq-p2")}
        </>)}
        {(op === 'CREDIT' || op === 'DEBT') && personInput(perA, setPerA, tx('Persona', 'Person'), "liq-p1")}
        {(op === 'CREDIT' || op === 'DEBT') && pA && <p className="text-xs">{tx('Adesso', 'Now')}: {personLine(pA)}</p>}

        {op !== 'NEW_ACCOUNT' && (
          <label className="block"><Label>{tx('Importo in €', 'Amount in €')}</Label>
            <input value={amount} onChange={e => setAmount(e.target.value)} inputMode="decimal" placeholder="0,00" className={`${field} text-lg font-bold num`} autoFocus={op !== 'SETTLE' && op !== 'CREDIT' && op !== 'DEBT' && op !== 'PERSON_TRANSFER'} /></label>
        )}

        {op === 'DEPOSIT' && accSelect(accA, setAccA, tx('Su quale conto', 'Into account'))}
        {op === 'WITHDRAW' && accSelect(accA, setAccA, tx('Da quale conto', 'From account'))}
        {op === 'TRANSFER' && (<>{accSelect(accA, setAccA, tx('Da', 'From'))}{accSelect(accB, setAccB, tx('A', 'To'))}</>)}
        {op === 'CREDIT' && accSelect(optAcc, setOptAcc, tx('Gli hai dato soldi da un conto?', 'Did you give money from an account?'), tx('No, mi deve per altro', 'No, owes me for something else'))}
        {op === 'DEBT' && accSelect(optAcc, setOptAcc, tx('Ti ha dato soldi su un conto?', 'Did they give you money into an account?'), tx('No, gli devo per altro', 'No, I owe for something else'))}
        {op === 'SETTLE' && accSelect(accA, setAccA, dir === 'in' ? tx('Su quale conto entrano', 'Into account') : tx('Da quale conto escono', 'From account'))}

        {/* Anteprima: come cambia il saldo della persona */}
        {op === 'SETTLE' && pA && cents ? <p className="text-xs">{tx('Dopo', 'After')}: {after(pA, dir === 'in' ? -cents : cents)}</p> : null}
        {op === 'CREDIT' && pA && cents ? <p className="text-xs">{tx('Dopo', 'After')}: {after(pA, cents)}</p> : null}
        {op === 'DEBT' && pA && cents ? <p className="text-xs">{tx('Dopo', 'After')}: {after(pA, -cents)}</p> : null}
        {op === 'PERSON_TRANSFER' && cents ? (
          <div className="text-xs space-y-0.5">
            {pA && <p>{tx('Dopo', 'After')} · <b>{pA.name}</b>: {after(pA, -cents)}</p>}
            {pB && <p>{tx('Dopo', 'After')} · <b>{pB.name}</b>: {after(pB, cents)}</p>}
          </div>
        ) : null}

        {op !== 'NEW_ACCOUNT' && (
          <div className="grid grid-cols-[auto_1fr] gap-2">
            <label className="block"><Label>{tx('Data', 'Date')}</Label><input type="date" value={date} onChange={e => setDate(e.target.value)} className={`${field} [color-scheme:dark] [.light_&]:[color-scheme:light]`} /></label>
            <label className="block"><Label>{tx('Nota', 'Note')}</Label><input value={note} onChange={e => setNote(e.target.value)} placeholder={tx('Facoltativa', 'Optional')} className={field} /></label>
          </div>
        )}
        {err && <p className="text-sm text-[var(--down)]">{err}</p>}
        <button type="submit" disabled={busy} className="w-full py-3 rounded-xl bg-brand text-white font-bold disabled:opacity-50 flex items-center justify-center gap-2">
          {busy && <Loader2 size={16} className="animate-spin" />} {tx('Conferma', 'Confirm')}
        </button>
      </form>
    </Sheet>
  );
}

// ---------- Storico di un conto o di una persona ----------
function DetailSheet({ detail, data, onClose, onChanged, apiCall, tx, eur, dateLocale, typeOf, personLine, showToast, onSettle }: {
  detail: { kind: 'account' | 'person'; id: string }; data: { accounts: Account[]; people: Person[] }; onClose: () => void; onChanged: () => void;
  apiCall: ApiCall; tx: (a: string, b: string) => string; eur: (c: number, s?: boolean) => string; dateLocale: string;
  typeOf: (k: string) => { it: string; en: string; Icon: typeof Wallet }; personLine: (p: Person) => ReactNode; showToast: Props['showToast']; onSettle: () => void;
}) {
  const [moves, setMoves] = useState<Movement[] | null>(null);
  const acc = detail.kind === 'account' ? data.accounts.find(a => a.id === detail.id) : undefined;
  const per = detail.kind === 'person' ? data.people.find(p => p.id === detail.id) : undefined;
  const load = async () => {
    const q = detail.kind === 'account' ? `accountId=${detail.id}` : `personId=${detail.id}`;
    const { ok, data: d } = await apiCall<Movement[]>(`/liquidity/movements?${q}`);
    setMoves(ok && Array.isArray(d) ? d : []);
  };
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [detail.id]);
  // Segno del movimento dal punto di vista di questo conto/persona: entra = +, esce = −
  const signOf = (m: Movement) => (detail.kind === 'account' ? (m.toAccountId === detail.id ? 1 : -1) : (m.toPersonId === detail.id ? 1 : -1));
  const describe = (m: Movement) => {
    const f = m.from || '', t = m.to || '';
    switch (m.kind) {
      case 'OPENING': case 'OPENING_NEG': return tx('Saldo iniziale', 'Starting balance');
      case 'DEPOSIT': return tx(`Aggiunti su ${t}`, `Added to ${t}`);
      case 'WITHDRAW': return tx(`Tolti da ${f}`, `Removed from ${f}`);
      case 'TRANSFER': return tx(`Da ${f} a ${t}`, `From ${f} to ${t}`);
      case 'CREDIT': return m.fromAccountId ? tx(`Prestito a ${t} da ${f}`, `Lent to ${t} from ${f}`) : tx(`${t} ti deve`, `${t} owes you`);
      case 'DEBT': return m.toAccountId ? tx(`Prestito da ${f} su ${t}`, `Loan from ${f} into ${t}`) : tx(`Devi a ${f}`, `You owe ${f}`);
      case 'SETTLE_IN': return tx(`${f} ha pagato su ${t}`, `${f} paid into ${t}`);
      case 'SETTLE_OUT': return tx(`Pagato ${t} da ${f}`, `Paid ${t} from ${f}`);
      case 'PERSON_TRANSFER': return tx(`${f} ha pagato ${t} per te`, `${f} paid ${t} for you`);
      case 'PURCHASE': return m.note || tx('Acquisto', 'Purchase');
      case 'SALE': return m.note || tx('Vendita', 'Sale');
      default: return m.kind;
    }
  };
  const remove = async (m: Movement) => {
    if (!window.confirm(tx(`Eliminare questo movimento di ${eur(m.amountCents)}? I saldi si ricalcolano.`, `Delete this movement of ${eur(m.amountCents)}?`))) return;
    const r = await apiCall<any>(`/liquidity/movements/${m.id}`, { method: 'DELETE' });
    if (!r.ok) return showToast(r.data?.error || tx('Errore', 'Error'), 'err');
    showToast(tx('Movimento eliminato', 'Movement deleted')); load(); onChanged();
  };
  const archive = async () => {
    const r = await apiCall<any>(`/liquidity/accounts/${detail.id}`, { method: 'PATCH', body: JSON.stringify({ archived: true }) });
    if (r.ok) { showToast(tx('Conto archiviato', 'Account archived')); onChanged(); onClose(); }
  };
  const title = acc ? acc.name : per ? per.name : '';
  const T = acc ? typeOf(acc.type) : null;
  return (
    <Sheet title={title} onClose={onClose}>
      <div className="flex items-baseline justify-between gap-3 mb-3">
        {acc ? <span className="text-xs text-[var(--text-faint)]">{T && tx(T.it, T.en)}</span> : <span className="text-sm font-bold">{per && personLine(per)}</span>}
        {acc && <span className={`text-2xl font-extrabold num ${acc.balanceCents < 0 ? 'text-[var(--down)]' : ''}`}>{eur(acc.balanceCents)}</span>}
      </div>
      {per && per.balanceCents !== 0 && (
        <button onClick={onSettle} className="w-full mb-3 py-2.5 rounded-xl border border-[var(--border-2)] text-sm font-bold flex items-center justify-center gap-2"><Scale size={15} /> {tx('Salda', 'Settle')}</button>
      )}
      <p className="text-[10px] uppercase tracking-widest font-bold text-[var(--text-faint)] mb-1.5">{tx('Movimenti', 'Movements')}</p>
      {!moves ? <div className="flex justify-center py-6"><Loader2 className="animate-spin text-[var(--text-faint)]" /></div>
        : moves.length === 0 ? <p className="text-sm text-[var(--text-faint)] py-3">{tx('Nessun movimento.', 'No movements.')}</p>
        : (
          <ul className="divide-y divide-[var(--border)] rounded-xl border border-[var(--border)] overflow-hidden">
            {moves.map(m => { const s = signOf(m); return (
              <li key={m.id} className="flex items-center gap-2 px-3 py-2.5">
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-semibold truncate">{describe(m)}</span>
                  <span className="block text-[11px] text-[var(--text-faint)] truncate">{new Date(m.date).toLocaleDateString(dateLocale, { day: 'numeric', month: 'short', year: 'numeric' })}{m.note && m.note !== describe(m) ? ` · ${m.note}` : ''}</span>
                </span>
                <span className={`text-sm font-extrabold num shrink-0 ${s > 0 ? 'text-[var(--up)]' : 'text-[var(--down)]'}`}>{eur(s * m.amountCents, true)}</span>
                {m.kind !== 'PURCHASE' && m.kind !== 'SALE' && <button onClick={() => remove(m)} aria-label={tx('Elimina movimento', 'Delete movement')} className="p-1.5 rounded-md text-[var(--text-faint)] hover:text-[var(--down)] hover:bg-[var(--fill)] shrink-0"><Trash2 size={14} /></button>}
              </li>); })}
          </ul>
        )}
      {acc && acc.balanceCents === 0 && (
        <button onClick={archive} className="w-full mt-3 py-2 text-xs font-bold text-[var(--text-soft)] hover:text-[var(--text)] flex items-center justify-center gap-1.5"><Archive size={13} /> {tx('Archivia conto (saldo a zero)', 'Archive account')}</button>
      )}
    </Sheet>
  );
}
