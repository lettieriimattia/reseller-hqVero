// frontend/src/admin/AdminApp.tsx
// Pannello admin "parallelo" servito su /admin — separato dall'app utenti.
// Sessione via cookie httpOnly (stesso dominio). Accesso riservato agli account admin.
import { useEffect, useState } from 'react';

const API_URL = import.meta.env.VITE_API_URL || '';

let refreshInFlight: Promise<boolean> | null = null;
function refreshSession(): Promise<boolean> {
  if (!refreshInFlight) {
    refreshInFlight = fetch(`${API_URL}/auth/refresh`, { method: 'POST', credentials: 'include' })
      .then(r => r.ok).catch(() => false).finally(() => { refreshInFlight = null; });
  }
  return refreshInFlight;
}
async function api<T = any>(path: string, opts: RequestInit = {}): Promise<{ ok: boolean; data: T; status: number }> {
  const doFetch = () => fetch(`${API_URL}${path}`, { credentials: 'include', headers: { 'Content-Type': 'application/json', ...opts.headers }, ...opts });
  let res = await doFetch();
  if (res.status === 401 && path !== '/auth/refresh') {
    if (await refreshSession()) res = await doFetch();
  }
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data: data as T, status: res.status };
}

const PLANS = ['free', 'starter', 'pro', 'business'];
const PLAN_LABEL: Record<string, string> = { free: 'Free', starter: 'Starter', pro: 'Pro', business: 'Business' };

type Tab = 'users' | 'feedback' | 'deliveries' | 'disputes' | 'stats';

export default function AdminApp() {
  const [authState, setAuthState] = useState<'checking' | 'login' | 'in'>('checking');
  const [tab, setTab] = useState<Tab>('users');
  const [toast, setToast] = useState<string>('');

  // login
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [twoFA, setTwoFA] = useState('');
  const [require2FA, setRequire2FA] = useState(false);
  const [loginErr, setLoginErr] = useState('');
  const [loggingIn, setLoggingIn] = useState(false);

  // data
  const [users, setUsers] = useState<any[]>([]);
  const [feedback, setFeedback] = useState<any[]>([]);
  const [deliveries, setDeliveries] = useState<any[]>([]);
  const [disputes, setDisputes] = useState<any[]>([]);
  const [stats, setStats] = useState<any>(null);          // analytics pre-lancio (visite + waitlist)
  const [fbFilter, setFbFilter] = useState<'nuove' | 'risolte'>('nuove'); // assistenza: da rispondere vs risolte
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState('');
  const [replyId, setReplyId] = useState<string | null>(null);
  const [replyText, setReplyText] = useState('');

  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(''), 2500); };

  // verifica sessione: solo admin entra
  const checkSession = async () => {
    const me = await api<any>('/api/plans/me');
    if (me.ok && me.data?.isAdmin) { setAuthState('in'); return true; }
    setAuthState('login'); return false;
  };
  useEffect(() => { checkSession(); }, []);

  const doLogin = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setLoginErr(''); setLoggingIn(true);
    const { ok, data } = await api<any>('/auth/login', { method: 'POST', body: JSON.stringify({ email: email.trim().toLowerCase(), password, ...(twoFA ? { twoFactorCode: twoFA } : {}) }) });
    setLoggingIn(false);
    if (data?.require2FA) { setRequire2FA(true); setLoginErr('Inserisci il codice 2FA.'); return; }
    if (data?.needsVerification) { setLoginErr('Email non verificata: verificala prima dall\'app principale.'); return; }
    if (!ok || !data?.user) { setLoginErr(data?.error || 'Credenziali non valide.'); return; }
    const isAdmin = await checkSession();
    if (!isAdmin) setLoginErr('Questo account non è un amministratore.');
  };

  const logout = async () => { await api('/auth/logout', { method: 'POST' }); setAuthState('login'); };

  // loaders
  const loadUsers = async () => { setLoading(true); const r = await api<any>('/admin/users'); if (r.ok) setUsers(r.data.users || []); setLoading(false); };
  const loadFeedback = async () => { setLoading(true); const r = await api<any>('/admin/feedback'); if (r.ok) setFeedback(r.data.feedback || []); setLoading(false); };
  const loadDeliveries = async () => { setLoading(true); const r = await api<any>('/admin/deliveries'); if (r.ok) setDeliveries(r.data.deliveries || []); setLoading(false); };
  const loadDisputes = async () => { setLoading(true); const r = await api<any>('/admin/disputes'); if (r.ok) setDisputes(r.data.disputes || []); setLoading(false); };
  const loadStats = async () => { setLoading(true); const r = await api<any>('/admin/analytics'); if (r.ok) setStats(r.data); setLoading(false); };

  useEffect(() => {
    if (authState !== 'in') return;
    if (tab === 'users') loadUsers();
    else if (tab === 'feedback') loadFeedback();
    else if (tab === 'deliveries') loadDeliveries();
    else if (tab === 'disputes') loadDisputes();
    else if (tab === 'stats') loadStats();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authState, tab]);

  // actions
  const changePlan = async (id: string, plan: string) => {
    const r = await api(`/admin/users/${id}/plan`, { method: 'POST', body: JSON.stringify({ plan }) });
    if (r.ok) { flash(`Piano aggiornato a ${PLAN_LABEL[plan]}`); loadUsers(); } else flash('Errore');
  };
  const delUser = async (id: string, name: string) => {
    if (!confirm(`Eliminare ${name}? Tutti i suoi dati verranno rimossi.`)) return;
    const r = await api(`/admin/users/${id}`, { method: 'DELETE' });
    if (r.ok) { flash('Utente eliminato'); loadUsers(); } else flash('Errore');
  };
  const sendReply = async (id: string) => {
    if (replyText.trim().length < 2) return;
    const r = await api(`/admin/feedback/${id}/reply`, { method: 'POST', body: JSON.stringify({ reply: replyText.trim() }) });
    if (r.ok) { flash('Risposta inviata via email'); setReplyId(null); setReplyText(''); loadFeedback(); } else flash((r.data as any)?.error || 'Errore');
  };
  const delFeedback = async (id: string) => { if (!confirm('Eliminare la richiesta?')) return; const r = await api(`/admin/feedback/${id}`, { method: 'DELETE' }); if (r.ok) { flash('Eliminata'); loadFeedback(); } };
  const resolveDispute = async (productId: string, decision: 'refund_buyer' | 'release_seller') => {
    if (!confirm(decision === 'refund_buyer' ? 'Rimborsare TUTTO al compratore?' : 'Pagare il venditore (contestazione respinta)?')) return;
    const r = await api(`/admin/disputes/${productId}/resolve`, { method: 'POST', body: JSON.stringify({ decision }) });
    if (r.ok) { flash('Contestazione risolta'); loadDisputes(); } else flash((r.data as any)?.error || 'Errore');
  };

  // ---- RENDER ----
  if (authState === 'checking') {
    return <div className="min-h-screen bg-neutral-950 text-white flex items-center justify-center">Caricamento…</div>;
  }

  if (authState === 'login') {
    return (
      <div className="min-h-screen bg-neutral-950 text-white flex items-center justify-center p-4">
        <form onSubmit={doLogin} className="w-full max-w-sm bg-neutral-900 border border-neutral-800 rounded-2xl p-6 space-y-4">
          <div className="text-center">
            <div className="text-3xl font-black tracking-tight">HQ</div>
            <p className="text-xs text-neutral-400 mt-1">Pannello amministrazione</p>
          </div>
          <input type="email" placeholder="Email admin" value={email} onChange={e => setEmail(e.target.value)} required
            className="w-full bg-neutral-800 border border-neutral-700 rounded-xl p-3 text-sm outline-none focus:border-brand" />
          <input type="password" placeholder="Password" value={password} onChange={e => setPassword(e.target.value)} required
            className="w-full bg-neutral-800 border border-neutral-700 rounded-xl p-3 text-sm outline-none focus:border-brand" />
          {require2FA && (
            <input inputMode="numeric" placeholder="Codice 2FA" value={twoFA} onChange={e => setTwoFA(e.target.value)}
              className="w-full bg-neutral-800 border border-neutral-700 rounded-xl p-3 text-sm outline-none focus:border-brand" />
          )}
          {loginErr && <p className="text-xs text-red-400">{loginErr}</p>}
          <button disabled={loggingIn} className="w-full py-3 rounded-xl bg-brand-lo hover:bg-brand font-bold text-sm disabled:opacity-50">
            {loggingIn ? 'Accesso…' : 'Entra'}
          </button>
          <p className="text-[10px] text-neutral-500 text-center">Accesso riservato agli amministratori HQ.</p>
        </form>
      </div>
    );
  }

  const filteredUsers = users.filter(u => !q || (u.name + ' ' + u.email).toLowerCase().includes(q.toLowerCase()));
  const escalated = disputes.filter(d => d.status === 'ESCALATED').length;

  return (
    <div className="min-h-screen bg-neutral-950 text-white">
      {/* Header */}
      <header className="sticky top-0 z-10 bg-neutral-950/90 backdrop-blur border-b border-neutral-800 px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xl font-black tracking-tight">HQ</span>
          <span className="text-xs px-2 py-0.5 rounded-full bg-brand-lo/20 text-brand-hi font-bold">ADMIN</span>
        </div>
        <button onClick={logout} className="text-xs font-bold text-neutral-400 hover:text-white">Esci</button>
      </header>

      {/* Tabs */}
      <nav className="flex gap-1 px-4 py-3 border-b border-neutral-800 overflow-x-auto">
        {([['users', 'Utenti'], ['feedback', 'Assistenza'], ['deliveries', 'Consegne'], ['disputes', 'Rimborsi'], ['stats', 'Statistiche']] as [Tab, string][]).map(([t, l]) => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-3 py-1.5 rounded-lg text-xs font-bold whitespace-nowrap flex items-center gap-1.5 ${tab === t ? 'bg-brand-lo text-white' : 'bg-neutral-900 text-neutral-400 hover:text-white'}`}>
            {l}
            {t === 'disputes' && escalated > 0 && <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-red-500 text-white">{escalated}</span>}
          </button>
        ))}
      </nav>

      <main className="max-w-4xl mx-auto p-4">
        {loading && <p className="text-center text-neutral-500 text-sm py-8">Caricamento…</p>}

        {/* UTENTI */}
        {tab === 'users' && !loading && (
          <div className="space-y-3">
            <input placeholder="Cerca per nome o email…" value={q} onChange={e => setQ(e.target.value)}
              className="w-full bg-neutral-900 border border-neutral-800 rounded-xl p-3 text-sm outline-none focus:border-brand" />
            <p className="text-xs text-neutral-500">{filteredUsers.length} utenti</p>
            {filteredUsers.map(u => (
              <div key={u.id} className="bg-neutral-900 border border-neutral-800 rounded-xl p-3.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-bold text-sm truncate">{u.name}</p>
                    <p className="text-xs text-neutral-400 truncate">{u.email}</p>
                    <p className="text-[11px] text-neutral-500 mt-1">
                      {u.stats?.totalProducts ?? 0} prodotti · {u.stats?.sold ?? 0} venduti
                      {u.warehouses?.length ? ` · ${u.warehouses.map((w: any) => w.name).join(', ')}` : ''}
                    </p>
                  </div>
                  <button onClick={() => delUser(u.id, u.name)} className="text-red-500/60 hover:text-red-400 text-xs font-bold shrink-0">Elimina</button>
                </div>
                <div className="flex items-center gap-1.5 mt-3 flex-wrap">
                  <span className="text-[10px] text-neutral-500 uppercase font-bold mr-1">Piano:</span>
                  {PLANS.map(p => (
                    <button key={p} onClick={() => changePlan(u.id, p)}
                      className={`px-2.5 py-1 rounded-lg text-[11px] font-bold ${u.plan === p ? 'bg-brand-lo text-white' : 'bg-neutral-800 text-neutral-400 hover:text-white'}`}>
                      {PLAN_LABEL[p]}{p === 'business' && u.plan !== p ? ' 🎁' : ''}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ASSISTENZA — divisa in "Da rispondere" e "Risolte" */}
        {tab === 'feedback' && !loading && (() => {
          const nuove = feedback.filter(f => f.status === 'nuova');
          const risolte = feedback.filter(f => f.status !== 'nuova');
          const list = fbFilter === 'nuove' ? nuove : risolte;
          return (
          <div className="space-y-3">
            <div className="flex gap-2">
              <button onClick={() => setFbFilter('nuove')}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1.5 ${fbFilter === 'nuove' ? 'bg-brand-lo text-white' : 'bg-neutral-900 text-neutral-400 hover:text-white'}`}>
                Da rispondere {nuove.length > 0 && <span className={`text-[9px] px-1.5 py-0.5 rounded-full ${fbFilter === 'nuove' ? 'bg-white/25' : 'bg-brand-lo text-white'}`}>{nuove.length}</span>}
              </button>
              <button onClick={() => setFbFilter('risolte')}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1.5 ${fbFilter === 'risolte' ? 'bg-brand-lo text-white' : 'bg-neutral-900 text-neutral-400 hover:text-white'}`}>
                Risolte {risolte.length > 0 && <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-green-600/25 text-green-300">{risolte.length}</span>}
              </button>
            </div>
            {list.length === 0 && <p className="text-center text-neutral-500 text-sm py-8">{fbFilter === 'nuove' ? 'Nessuna richiesta da rispondere. 🎉' : 'Nessuna richiesta risolta.'}</p>}
            {list.map(f => (
              <div key={f.id} className="bg-neutral-900 border border-neutral-800 rounded-xl p-3.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-[9px] uppercase font-bold px-1.5 py-0.5 rounded-full bg-neutral-800 text-neutral-400">{f.type}</span>
                      {f.status === 'nuova'
                        ? <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-brand-lo text-white font-bold">nuova</span>
                        : <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-green-600/20 text-green-400 font-bold">risposta</span>}
                      <span className="text-xs font-semibold truncate">{f.userName || f.userEmail}</span>
                    </div>
                    <p className="text-[10px] text-neutral-500 mt-0.5">{f.userEmail}</p>
                  </div>
                  <button onClick={() => delFeedback(f.id)} className="text-red-500/60 hover:text-red-400 text-xs shrink-0">✕</button>
                </div>
                <p className="text-sm mt-2 whitespace-pre-wrap break-words">{f.message}</p>
                {f.reply && <div className="mt-2 bg-neutral-800/60 border-l-2 border-green-500/40 rounded-r-lg px-3 py-2"><p className="text-[9px] uppercase font-bold text-green-400 mb-1">Tua risposta</p><p className="text-xs text-neutral-300 whitespace-pre-wrap">{f.reply}</p></div>}
                {replyId === f.id ? (
                  <div className="mt-2">
                    <textarea value={replyText} onChange={e => setReplyText(e.target.value)} rows={3} autoFocus placeholder={`Rispondi a ${f.userEmail}…`}
                      className="w-full bg-neutral-800 border border-neutral-700 rounded-xl p-2.5 text-sm outline-none focus:border-brand resize-none" />
                    <div className="flex justify-end gap-2 mt-2">
                      <button onClick={() => { setReplyId(null); setReplyText(''); }} className="px-3 py-1.5 text-xs font-bold text-neutral-400">Annulla</button>
                      <button onClick={() => sendReply(f.id)} disabled={replyText.trim().length < 2} className="px-4 py-1.5 bg-brand-lo rounded-lg text-xs font-bold disabled:opacity-40">Invia via email</button>
                    </div>
                  </div>
                ) : (
                  <button onClick={() => { setReplyId(f.id); setReplyText(f.reply || ''); }} className="mt-2 text-xs font-bold text-brand-hi">{f.reply ? 'Modifica risposta' : '↩ Rispondi'}</button>
                )}
              </div>
            ))}
          </div>
          );
        })()}

        {/* CONSEGNE */}
        {tab === 'deliveries' && !loading && (
          <div className="space-y-3">
            {deliveries.length === 0 && <p className="text-center text-neutral-500 text-sm py-8">Nessuna consegna in corso.</p>}
            {deliveries.map(d => (
              <div key={d.productId} className="bg-neutral-900 border border-neutral-800 rounded-xl p-3.5">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="font-semibold text-sm truncate">{d.product}</span>
                  <span className="text-xs text-neutral-400">{(d.amount || 0).toFixed(2)}€</span>
                  {d.disputeStatus && <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-red-500/20 text-red-400 font-bold">contestato</span>}
                  {d.trackingStatus && <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-blue-500/20 text-blue-300 font-bold">{d.trackingStatus}</span>}
                </div>
                <p className="text-[11px] text-neutral-500 mt-1">Venditore: {d.seller} · Compratore: {d.buyer}</p>
                {d.trackingCode && <p className="text-[11px] text-neutral-400 mt-0.5">📦 {d.trackingCode} ({d.trackingCarrier || '—'})</p>}
                {d.autoReleaseAt && <p className="text-[10px] text-neutral-500 mt-0.5">Sblocco automatico: {new Date(d.autoReleaseAt).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' })}</p>}
              </div>
            ))}
          </div>
        )}

        {/* RIMBORSI / CONTESTAZIONI */}
        {tab === 'disputes' && !loading && (
          <div className="space-y-3">
            {disputes.length === 0 && <p className="text-center text-neutral-500 text-sm py-8">Nessuna contestazione aperta.</p>}
            {disputes.map(d => (
              <div key={d.productId} className="bg-neutral-900 border border-neutral-800 rounded-xl p-3.5">
                <div className="flex items-center gap-1.5 flex-wrap">
                  {d.status === 'ESCALATED'
                    ? <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-red-500 text-white font-bold">DA DECIDERE</span>
                    : <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-400 font-bold">attesa venditore</span>}
                  <span className="text-[9px] uppercase font-bold px-1.5 py-0.5 rounded-full bg-neutral-800 text-neutral-400">{d.reasonLabel}</span>
                  <span className="font-semibold text-sm truncate">{d.product}</span>
                  <span className="text-xs text-neutral-400">{(d.amount || 0).toFixed(2)}€</span>
                </div>
                <p className="text-[11px] text-neutral-500 mt-1">Venditore: {d.seller?.name || '—'} · Compratore: {d.buyer?.name || '—'}</p>
                {d.note && <p className="text-sm mt-2 whitespace-pre-wrap break-words">{d.note}</p>}
                {d.photos?.length > 0 && (
                  <div className="flex gap-1.5 mt-2 flex-wrap">
                    {d.photos.map((p: string, i: number) => <img key={i} src={p} alt="" className="w-16 h-16 rounded-lg object-cover border border-neutral-700" />)}
                  </div>
                )}
                {d.status === 'ESCALATED' ? (
                  <div className="flex gap-2 mt-3">
                    <button onClick={() => resolveDispute(d.productId, 'refund_buyer')} className="px-3 py-1.5 rounded-lg text-xs font-bold bg-red-600">Rimborsa compratore</button>
                    <button onClick={() => resolveDispute(d.productId, 'release_seller')} className="px-3 py-1.5 rounded-lg text-xs font-bold bg-green-600">Paga venditore</button>
                  </div>
                ) : (
                  <p className="text-[10px] text-neutral-500 mt-2">In attesa che il venditore risponda. Intervieni solo se viene escalata.</p>
                )}
              </div>
            ))}
          </div>
        )}

        {/* STATISTICHE (pre-lancio): visite landing + waitlist */}
        {tab === 'stats' && !loading && (() => {
          if (!stats) return <p className="text-center text-neutral-500 text-sm py-8">Nessun dato ancora.</p>;
          const pageLabels: Record<string, string> = { home: 'Home', magazzino: 'Magazzino', spedizione: 'Spedizione', waitlist: 'Waitlist', privacy: 'Privacy' };
          const pages = Object.entries(stats.byPage || {}).sort((a: any, b: any) => b[1] - a[1]) as [string, number][];
          const maxPage = Math.max(1, ...pages.map(p => p[1]));
          const sources = Object.entries(stats.bySource || {}).sort((a: any, b: any) => b[1] - a[1]) as [string, number][];
          const maxSrc = Math.max(1, ...sources.map(s => s[1]));
          const recent = stats.waitlist?.recent || [];
          return (
          <div className="space-y-6">
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-4">
                <p className="text-[10px] uppercase tracking-widest text-neutral-500 font-bold">Iscritti waitlist</p>
                <p className="text-3xl font-black mt-1 text-brand-hi">{stats.waitlist?.total ?? 0}</p>
              </div>
              <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-4">
                <p className="text-[10px] uppercase tracking-widest text-neutral-500 font-bold">Visite (30 gg)</p>
                <p className="text-3xl font-black mt-1">{stats.totalHits ?? 0}</p>
              </div>
            </div>

            <div>
              <p className="text-[11px] uppercase tracking-widest text-neutral-400 font-bold mb-2.5">Visite per pagina</p>
              {pages.length === 0 ? <p className="text-xs text-neutral-500">Ancora nessuna visita.</p> : (
                <div className="space-y-2">
                  {pages.map(([k, v]) => (
                    <div key={k} className="flex items-center gap-3">
                      <span className="text-xs font-bold w-24 shrink-0 truncate">{pageLabels[k] || k}</span>
                      <div className="flex-1 h-2.5 rounded-full bg-neutral-800 overflow-hidden"><div className="h-full rounded-full bg-brand" style={{ width: `${(v / maxPage) * 100}%` }} /></div>
                      <span className="text-xs font-black w-10 text-right">{v}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div>
              <p className="text-[11px] uppercase tracking-widest text-neutral-400 font-bold mb-2.5">Da dove arrivano</p>
              {sources.length === 0 ? <p className="text-xs text-neutral-500">—</p> : (
                <div className="space-y-2">
                  {sources.map(([k, v]) => (
                    <div key={k} className="flex items-center gap-3">
                      <span className="text-xs font-semibold w-24 shrink-0 truncate text-neutral-400">{k}</span>
                      <div className="flex-1 h-2.5 rounded-full bg-neutral-800 overflow-hidden"><div className="h-full rounded-full bg-teal-500/70" style={{ width: `${(v / maxSrc) * 100}%` }} /></div>
                      <span className="text-xs font-black w-10 text-right">{v}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div>
              <p className="text-[11px] uppercase tracking-widest text-neutral-400 font-bold mb-2.5">Email raccolte (ultime {recent.length})</p>
              {recent.length === 0 ? <p className="text-xs text-neutral-500">Ancora nessuna iscrizione.</p> : (
                <div className="border border-neutral-800 rounded-xl divide-y divide-neutral-800 max-h-64 overflow-y-auto">
                  {recent.map((w: any, i: number) => (
                    <div key={i} className="flex items-center justify-between gap-2 px-3 py-2">
                      <span className="text-xs font-semibold truncate">{w.email}</span>
                      <span className="text-[10px] text-neutral-500 shrink-0">{w.source || '—'} · {new Date(w.createdAt).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' })}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* TROVA VALORE: uso del checker pubblico (anonimo) */}
            {stats.priceChecks && (
              <div>
                <p className="text-[11px] uppercase tracking-widest text-neutral-400 font-bold mb-2.5">Trova valore prodotto (30 gg)</p>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
                  <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-3"><p className="text-[9px] uppercase tracking-widest text-neutral-500 font-bold">Ricerche</p><p className="text-xl font-black mt-1">{stats.priceChecks.total}</p></div>
                  <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-3"><p className="text-[9px] uppercase tracking-widest text-neutral-500 font-bold">Visitatori (IP)</p><p className="text-xl font-black mt-1">{stats.priceChecks.uniqueIps}</p></div>
                  <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-3"><p className="text-[9px] uppercase tracking-widest text-neutral-500 font-bold">Hanno riusato</p><p className="text-xl font-black mt-1 text-brand-hi">{stats.priceChecks.reusedIps}</p></div>
                  <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-3"><p className="text-[9px] uppercase tracking-widest text-neutral-500 font-bold">Con esito</p><p className="text-xl font-black mt-1">{stats.priceChecks.found}</p></div>
                </div>
                {stats.priceChecks.topReusers?.length > 0 && (
                  <div className="mb-3">
                    <p className="text-[10px] text-neutral-500 mb-1.5">Chi ha riusato di più (IP anonimo · n° ricerche)</p>
                    <div className="flex flex-wrap gap-1.5">
                      {stats.priceChecks.topReusers.map((u: any) => (
                        <span key={u.id} className="text-[11px] bg-neutral-900 border border-neutral-800 rounded-lg px-2 py-1"><span className="text-neutral-500">#{u.id}</span> · <b>{u.count}×</b></span>
                      ))}
                    </div>
                  </div>
                )}
                {stats.priceChecks.topQueries?.length > 0 && (
                  <div>
                    <p className="text-[10px] text-neutral-500 mb-1.5">Modelli più cercati</p>
                    <div className="flex flex-wrap gap-1.5">
                      {stats.priceChecks.topQueries.map((x: any, i: number) => (
                        <span key={i} className="text-[11px] bg-neutral-900 border border-neutral-800 rounded-lg px-2 py-1">{x.q} <b className="text-neutral-400">{x.count}×</b></span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
          );
        })()}
      </main>

      {toast && <div className="fixed bottom-4 left-1/2 -translate-x-1/2 bg-brand-lo text-white text-sm font-bold px-4 py-2 rounded-xl shadow-lg z-50">{toast}</div>}
    </div>
  );
}
