import React, { useState, useEffect, useCallback, useMemo, useRef, Suspense, lazy } from 'react';
import { createPortal } from 'react-dom';
import { DynamicForm } from './components/DynamicForm';
import CatalogBrowser from './components/CatalogBrowser';
import AssistantChat from './components/AssistantChat';
import SmartLotModal from './components/SmartLotModal';
import { startRegistration, startAuthentication } from '@simplewebauthn/browser';

// Face ID (passkey di login) temporaneamente NASCOSTO: il codice resta, si riattiva mettendo true.
const FACE_ID_ENABLED = false;
import { getLang, setLangStorage, translate, LANGUAGES, MARKETPLACE_ENABLED, type Lang } from './i18n';
// xlsx caricato on-demand (import dinamico) dentro gli handler: resta fuori dal bundle iniziale
// Grafico caricato in lazy: recharts finisce in un chunk separato, fuori dal bundle iniziale
const TrendChart = lazy(() => import('./components/TrendChart'));
import {
  Package, BarChart3, Plus, TrendingUp, Wallet, CheckCircle, Search, LayoutDashboard,
  PieChart as PieChartIcon, Loader2, Layers, DollarSign, Store, X, Edit, Settings,
  Users, Camera, UserPlus, Bell, Shield, Sparkles, AlertTriangle, TrendingDown,
  KeyRound, Copy, LogOut, Eye, EyeOff, Trophy, Trash2, Download, ArrowUpDown, Lock, Truck, StickyNote, ChevronDown, Mail, Sun, Moon, ScanFace,
  Image as ImageIcon, Lightbulb, Bug, HelpCircle, MoreHorizontal, Send,
  Footprints, Shirt, Watch, ShoppingBag, Gem, Glasses, SprayCan, Smartphone,
  Disc3, ToyBrick, Coins, BookOpen, Palette, Guitar, Stamp, ScanLine, Check, Share2
} from 'lucide-react';

// ==========================================
// CONFIGURAZIONE API
// ==========================================
// Stringa vuota = path relativo → il proxy Vite (o nginx in prod) smista le chiamate al backend
const API_URL = import.meta.env.VITE_API_URL || '';

// Le immagini dei CDN cataloghi (StockX/pokemontcg) bloccano le richieste cross-site dal
// browser: le serviamo dal nostro dominio via proxy. Cloudinary/data:/altri passano diretti.
function proxyImg(url?: string | null): string | undefined {
  if (!url) return undefined;
  if (/^https?:\/\/(images\.stockx\.com|images\.pokemontcg\.io|images?\.goat\.com)/i.test(url)) {
    return `/api/catalog/img?u=${encodeURIComponent(url)}`;
  }
  return url;
}
// Riconosce le foto SEGNAPOSTO ("immagine non disponibile": X grigia StockX / template GOAT):
// vanno trattate come "nessuna foto" così mostriamo il logo HQ invece di una foto finta.
function isPlaceholderPhoto(url?: string | null): boolean {
  if (!url) return true;
  return /placeholder|product[-_]?template|not[-_]?available|no[-_]?image|noimage|coming[-_]?soon|missing|default[-_]?product|stockx[-_]?logo|\/static\/|blank\.(png|jpe?g|webp)/i.test(url);
}
// Restituisce l'URL della foto solo se è una foto VERA (non un segnaposto), altrimenti null.
function realPhoto(url?: string | null): string | null {
  return url && !isPlaceholderPhoto(url) ? url : null;
}

// Raggruppa le singole vendite di un gruppo per COMPRATORE (nome). Ogni buyer: quantità totale
// + l'elenco delle singole vendite (con id e data) per mostrarle nella tendina e fare il reso del
// pezzo esatto. La stessa persona può aver comprato lo stesso paio in date diverse → più righe.
function buyersFromSales(sales: any[]): { name: string; qty: number; sales: any[] }[] {
  const map: Record<string, { name: string; qty: number; sales: any[] }> = {};
  for (const s of (sales || [])) {
    const name = (s.customer || '').trim() || '—';
    if (!map[name]) map[name] = { name, qty: 0, sales: [] };
    map[name].qty += 1;
    map[name].sales.push(s);
  }
  for (const b of Object.values(map)) b.sales.sort((a: any, c: any) => new Date(c.soldAt || 0).getTime() - new Date(a.soldAt || 0).getTime());
  return Object.values(map).sort((a, b) => b.qty - a.qty);
}

// Tutte le chiamate API usano credentials: 'include' per inviare i cookies httpOnly
// Single-flight del refresh: se più chiamate scadono insieme all'avvio, parte UN SOLO
// /auth/refresh e tutte aspettano lo stesso esito (niente race che sloggava l'utente).
let refreshInFlight: Promise<boolean> | null = null;
function refreshSession(): Promise<boolean> {
  if (!refreshInFlight) {
    refreshInFlight = fetch(`${API_URL}/auth/refresh`, { method: 'POST', credentials: 'include' })
      .then(r => r.ok)
      .catch(() => false)
      .finally(() => { refreshInFlight = null; });
  }
  return refreshInFlight;
}

async function apiCall<T = any>(
  path: string,
  opts: RequestInit = {}
): Promise<{ ok: boolean; data: T; status: number }> {
  const res = await fetch(`${API_URL}${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...opts.headers },
    ...opts,
  });

  // Auto-refresh token se scaduto (un solo refresh condiviso tra chiamate concorrenti)
  if (res.status === 401 && path !== '/auth/refresh') {
    const ok = await refreshSession();
    if (ok) {
      // Ritenta la richiesta originale col token aggiornato
      const retry = await fetch(`${API_URL}${path}`, {
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...opts.headers },
        ...opts,
      });
      const data = await retry.json().catch(() => ({}));
      return { ok: retry.ok, data, status: retry.status };
    }
  }

  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data, status: res.status };
}

// ==========================================
// TIPI
// ==========================================
interface Product {
  id: string; category?: string; brand: string; name: string; size: string; condition: string;
  purchasePrice: number; salePrice?: number; platform?: string; fees?: number; status: string; customer?: string; supplier?: string; quickSalePrice?: number;
  customShares?: string; photos?: string; createdAt?: string; soldAt?: string;
  marketPriceMin?: number; marketPriceMax?: number; marketPriceAvg?: number; authenticityScore?: number;
  trackingCode?: string; trackingCarrier?: string; trackingStatus?: string;
  trackingHistory?: string; trackingUpdatedAt?: string;
  notes?: string; warehouseId?: string; trackingDirection?: string;
}

interface AppUser {
  id: string; name: string; email: string; twoFactorEnabled?: boolean; plan?: string;
  warehouses: Array<{ id: string; name: string; role: string; inviteCode: string | null; percentage: number; aiConfig: string | null; parentId?: string | null; category?: string | null }>;
}

interface AINotification {
  id: string; type: string; title: string; message: string; read: boolean; createdAt: string; link?: string;
}

// ==========================================
// HQ LOADER — lettere H e Q che si alternano
// ==========================================
function HQLoader() {
  return (
    <div className="flex items-center justify-center gap-1" aria-label="Caricamento">
      <style>{`
        @keyframes hq-h {
          0%, 100% { opacity: 1; transform: scale(1);   color: #ffffff; }
          50%       { opacity: 0.15; transform: scale(0.7); color: #ffffff; }
        }
        @keyframes hq-q {
          0%, 100% { opacity: 0.15; transform: scale(0.7); color: #ffffff; }
          50%       { opacity: 1; transform: scale(1);   color: #ffffff; }
        }
      `}</style>
      <span style={{
        fontSize: 52,
        fontWeight: 900,
        letterSpacing: '-2px',
        fontFamily: 'inherit',
        animation: 'hq-h 1.2s ease-in-out infinite',
        display: 'inline-block',
        lineHeight: 1,
      }}>H</span>
      <span style={{
        fontSize: 52,
        fontWeight: 900,
        letterSpacing: '-2px',
        fontFamily: 'inherit',
        animation: 'hq-q 1.2s ease-in-out infinite',
        display: 'inline-block',
        lineHeight: 1,
      }}>Q</span>
    </div>
  );
}

// VAULT LOADER — animazione vera: la porta della cassaforte SBATTE chiusa, il volantino
// GIRA per bloccare e la luce diventa TEAL (chiuso). In loop finché l'app carica.
function VaultLoader() {
  const C = 200; // centro
  const ring = (n: number, r: number) =>
    Array.from({ length: n }, (_, i) => { const a = (i / n) * 2 * Math.PI; return [C + r * Math.cos(a), C + r * Math.sin(a)] as const; });
  const bars = [0, 90, 180, 270]; // chiavistelli a croce (come la reference)
  const spokes = [22.5, 67.5, 112.5, 157.5, 202.5, 247.5, 292.5, 337.5]; // 8 razze del volantino
  return (
    <div className="relative flex items-center justify-center" style={{ width: 'min(360px, 90vw)', height: 'min(360px, 90vw)' }} aria-label="Caricamento">
      <style>{`
        @keyframes vlSlam  { 0%{transform:scale(.88) rotate(-6deg);opacity:0} 24%{opacity:1} 62%{transform:scale(1.02) rotate(1.5deg)} 80%{transform:scale(.994) rotate(-.6deg)} 100%{transform:scale(1) rotate(0)} }
        @keyframes vlWheel { 0%,26%{transform:rotate(0)} 82%,100%{transform:rotate(135deg)} }
        @keyframes vlMech  { 0%,26%{transform:rotate(0)} 82%,100%{transform:rotate(-22deg)} }
        @keyframes vlGlow  { 0%,60%{opacity:.06} 82%{opacity:.42} 100%{opacity:.26} }
        @keyframes vlSheen { to { transform: rotate(360deg); } }
        .vl-door{transform-origin:200px 200px;animation:vlSlam 3.4s cubic-bezier(.3,.72,.2,1) infinite}
        .vl-wheel{transform-origin:200px 200px;animation:vlWheel 3.4s cubic-bezier(.4,0,.2,1) infinite}
        .vl-mech{transform-origin:200px 200px;animation:vlMech 3.4s cubic-bezier(.4,0,.2,1) infinite}
        .vl-glow{animation:vlGlow 3.4s ease infinite}
        .vl-sheen{transform-origin:200px 200px;animation:vlSheen 7s linear infinite}
      `}</style>
      <div className="vl-glow absolute inset-[6%]" style={{ borderRadius: '50%', background: 'radial-gradient(circle, rgba(44,156,142,0.8), transparent 60%)', filter: 'blur(26px)' }} />
      <svg viewBox="0 0 400 400" width="100%" height="100%" className="relative" style={{ filter: 'drop-shadow(0 20px 56px rgba(0,0,0,0.8))' }}>
        <defs>
          <radialGradient id="vSteel" cx="40%" cy="26%" r="82%"><stop offset="0%" stopColor="#56565f" /><stop offset="46%" stopColor="#26262d" /><stop offset="100%" stopColor="#090a0d" /></radialGradient>
          <radialGradient id="vDoor" cx="42%" cy="28%" r="84%"><stop offset="0%" stopColor="#50505b" /><stop offset="50%" stopColor="#212129" /><stop offset="100%" stopColor="#0d0d12" /></radialGradient>
          <linearGradient id="vRim" x1="0" y1="0" x2="0.9" y2="1"><stop offset="0%" stopColor="#8e8e9a" /><stop offset="48%" stopColor="#2c2c34" /><stop offset="100%" stopColor="#5e5e68" /></linearGradient>
          <linearGradient id="vBar" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#a0a0ac" /><stop offset="44%" stopColor="#3a3a44" /><stop offset="56%" stopColor="#56565f" /><stop offset="100%" stopColor="#15151b" /></linearGradient>
          <radialGradient id="vHub" cx="40%" cy="34%" r="72%"><stop offset="0%" stopColor="#a0a0ac" /><stop offset="58%" stopColor="#3a3a44" /><stop offset="100%" stopColor="#131319" /></radialGradient>
          <radialGradient id="vSpec" cx="50%" cy="50%" r="50%"><stop offset="0%" stopColor="rgba(255,255,255,0.55)" /><stop offset="70%" stopColor="rgba(255,255,255,0.06)" /><stop offset="100%" stopColor="rgba(255,255,255,0)" /></radialGradient>
        </defs>
        {/* parete + cornice con bulloneria */}
        <rect x="8" y="8" width="384" height="384" rx="16" fill="url(#vSteel)" stroke="#101015" strokeWidth="3" />
        <rect x="26" y="26" width="348" height="348" rx="9" fill="none" stroke="#0b0b10" strokeWidth="2" />
        <rect x="38" y="38" width="324" height="324" rx="6" fill="none" stroke="#6a6a74" strokeWidth="7" strokeDasharray="2.5 40" strokeLinecap="round" />
        {/* cardini (sinistra) */}
        <g fill="url(#vBar)" stroke="#101015" strokeWidth="2">
          <rect x="34" y="120" width="34" height="64" rx="11" /><rect x="34" y="216" width="34" height="64" rx="11" />
          <rect x="44" y="150" width="14" height="100" rx="6" fill="#23232a" />
        </g>
        {/* scatola combinazione (destra) */}
        <g><rect x="320" y="172" width="44" height="56" rx="6" fill="url(#vBar)" stroke="#101015" strokeWidth="2" /><circle cx="342" cy="200" r="13" fill="url(#vHub)" stroke="#101015" strokeWidth="2" /><circle cx="342" cy="200" r="4" fill="#0c0c11" /></g>
        {/* anelli esterni del portello */}
        <circle cx={C} cy={C} r="172" fill="none" stroke="#0c0c11" strokeWidth="3" />
        <circle cx={C} cy={C} r="160" fill="none" stroke="url(#vRim)" strokeWidth="22" />
        <circle cx={C} cy={C} r="147" fill="none" stroke="#0c0c11" strokeWidth="3" />
        <g fill="#6c6c76" stroke="#16161b" strokeWidth="1">{ring(28, 160).map(([x, y], i) => <circle key={i} cx={x} cy={y} r="4.6" />)}</g>
        <circle cx={C} cy={C} r="138" fill="#000" opacity="0.45" />
        {/* PORTELLO che si chiude */}
        <g className="vl-door">
          <circle cx={C} cy={C} r="134" fill="url(#vDoor)" stroke="#3c3c46" strokeWidth="4" />
          {/* anelli del meccanismo (segmentati) che ruotano piano */}
          <g className="vl-mech">
            <circle cx={C} cy={C} r="120" fill="none" stroke="#6a6a76" strokeWidth="9" strokeDasharray="3 13" />
            <circle cx={C} cy={C} r="104" fill="none" stroke="#3a3a44" strokeWidth="2" />
            <circle cx={C} cy={C} r="92" fill="none" stroke="#6a6a76" strokeWidth="7" strokeDasharray="2 11" />
          </g>
          <circle cx={C} cy={C} r="78" fill="none" stroke="#0e0e14" strokeWidth="2" />
          <ellipse cx="150" cy="142" rx="78" ry="50" fill="url(#vSpec)" opacity="0.5" />
          <circle className="vl-sheen" cx={C} cy={C} r="134" fill="url(#vSpec)" opacity="0.18" />
          {/* VOLANTINO + CHIAVISTELLI che girano per bloccare */}
          <g className="vl-wheel">
            <g stroke="url(#vBar)" strokeWidth="22" strokeLinecap="round">
              {bars.map(a => { const [x, y] = ring(1, 150)[0] && [C + 150 * Math.cos(a * Math.PI / 180), C + 150 * Math.sin(a * Math.PI / 180)]; return <line key={a} x1={C} y1={C} x2={x} y2={y} />; })}
            </g>
            <g fill="url(#vHub)" stroke="#101015" strokeWidth="2">{bars.map(a => { const x = C + 150 * Math.cos(a * Math.PI / 180), y = C + 150 * Math.sin(a * Math.PI / 180); return <circle key={a} cx={x} cy={y} r="14" />; })}</g>
            <g stroke="url(#vBar)" strokeWidth="9" strokeLinecap="round">{spokes.map(a => <line key={a} x1={C} y1={C} x2={C + 64 * Math.cos(a * Math.PI / 180)} y2={C + 64 * Math.sin(a * Math.PI / 180)} />)}</g>
            <circle cx={C} cy={C} r="64" fill="none" stroke="url(#vRim)" strokeWidth="6" />
            <circle cx={C} cy={C} r="34" fill="url(#vHub)" stroke="#101015" strokeWidth="3" />
            <circle cx={C} cy={C} r="26" fill="none" stroke="#7a7a86" strokeWidth="1.5" />
            <circle cx={C} cy={C} r="11" fill="#0b0b10" />
            <circle cx="192" cy="190" r="4" fill="rgba(255,255,255,0.45)" />
          </g>
        </g>
      </svg>
    </div>
  );
}

// ==========================================
// COMPONENTI RIUTILIZZABILI
// ==========================================
function StatCard({ title, value, sub, icon, color = 'text-[var(--text)]', onClick }: any) {
  return (
    <div
      onClick={onClick}
      className={`bg-[var(--surface)] border border-[var(--border)] p-5 lg:p-6 rounded-2xl transition-colors ${
        onClick ? 'cursor-pointer hover:border-[var(--border-2)]' : ''
      }`}
    >
      <div className="flex justify-between items-start mb-4 lg:mb-5">
        <span className="text-[10px] lg:text-xs font-semibold text-[var(--text-muted)] tracking-[0.12em] uppercase">{title}</span>
        {icon}
      </div>
      <p className={`text-2xl lg:text-4xl font-semibold num ${color}`}>{value}</p>
      <p className="text-[11px] lg:text-sm text-[var(--text-soft)] mt-1.5 lg:mt-2">{sub}</p>
    </div>
  );
}

// ==========================================
// IMAGE COMPRESSION HELPER (riutilizzato in più form)
// ==========================================
async function compressImage(file: File, maxSize = 1024, quality = 0.5): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const img = new Image();
      img.src = reader.result as string;
      img.onload = () => {
        const canvas = document.createElement('canvas');
        let { width, height } = img;
        if (width > height) {
          if (width > maxSize) { height *= maxSize / width; width = maxSize; }
        } else {
          if (height > maxSize) { width *= maxSize / height; height = maxSize; }
        }
        canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx?.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = reject;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Sentinella "modalità automatica": l'IA rileva la categoria dalla foto
const AUTO_CATEGORY = '__AUTO__';

// Dal catalogo il NOME arriva spesso col brand già dentro ("Jordan 5 Trophy Room" con brand
// "Jordan") → mostrando "brand + nome" diventava "Jordan Jordan 5…". Togliamo il brand ripetuto
// in testa al nome. Robusto: gestisce anche brand a più parole (es. "Air Jordan").
function stripDupBrand(brand?: string | null, name?: string | null): string {
  const b = (brand || '').trim(); const n = (name || '').trim();
  if (!b || !n) return n;
  const esc = b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const cleaned = n.replace(new RegExp(`^${esc}\\s+`, 'i'), '').trim();
  return cleaned || n;
}
// Titolo pulito "Brand Nome" senza duplicazioni del brand.
function fullName(brand?: string | null, name?: string | null): string {
  return `${(brand || '').trim()} ${stripDupBrand(brand, name)}`.trim();
}
// Valutazione di mercato: DISATTIVATA. La ricerca eBay generica dava prezzi falsi
// (es. Rolex a 110€ perché pescava cinturini/parti/repliche). Riattivare SOLO con
// fonti affidabili per categoria (StockX sneaker, Chrono24 orologi, ecc.).
const VALUATION_ENABLED = false;

// Converte la chiave VAPID (base64url) in Uint8Array per pushManager.subscribe
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

// ==========================================
// COMPONENTE PRINCIPALE
// ==========================================
export default function App() {
  // ----- AUTH STATE -----
  // Idratazione ottimistica: se c'è un utente in cache, mostriamo SUBITO l'app
  // (niente schermata "primo accesso"/spinner), poi validiamo in background con /auth/me.
  const cachedUser = (() => { try { const c = localStorage.getItem('hq_user'); return c ? JSON.parse(c) as AppUser : null; } catch { return null; } })();
  const [isAuthenticated, setIsAuthenticated] = useState(!!cachedUser);
  const [user, setUser] = useState<AppUser | null>(cachedUser);
  const [bootLoading, setBootLoading] = useState(!cachedUser);
  // Lingua app (it/en/es/de). t(key) traduce; cambio lingua → re-render immediato.
  const [lang, setLang] = useState<Lang>(getLang());
  const t = (key: string) => translate(lang, key);
  // Locale per date/numeri in base alla lingua scelta.
  const dateLocale = lang === 'it' ? 'it-IT' : lang === 'es' ? 'es-ES' : lang === 'de' ? 'de-DE' : 'en-GB';
  const changeLang = (l: Lang) => { setLang(l); setLangStorage(l); };
  // Modalità manutenzione (durante la migrazione foto): il server espone /api/status.
  const [maintenance, setMaintenance] = useState(false);
  useEffect(() => {
    const check = () => apiCall<any>('/api/status').then(({ ok, data }) => { if (ok) setMaintenance(!!data?.maintenance); }).catch(() => {});
    check();
    const iv = setInterval(check, 20000);
    return () => clearInterval(iv);
  }, []);
  // Banner cookie DISABILITATO: l'app usa solo cookie tecnici strettamente necessari (niente
  // profilazione) → il consenso non è richiesto dal Garante, quindi niente popup ad ogni accesso.
  const [cookieConsent, setCookieConsent] = useState<boolean>(true);
  const [privacyOpen, setPrivacyOpen] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  // Supporto clienti IA (primo livello) con escalation a operatore umano.
  const [supportOpen, setSupportOpen] = useState(false);
  const [supportMsgs, setSupportMsgs] = useState<{ role: 'user' | 'assistant'; content: string }[]>([]);
  const [supportInput, setSupportInput] = useState('');
  const [supportLoading, setSupportLoading] = useState(false);
  const [supportEscalated, setSupportEscalated] = useState(false);
  const [repartiOpen, setRepartiOpen] = useState(false); // lista reparti a tendina nelle impostazioni
  const [marketingConsent, setMarketingConsent] = useState(false);
  const [privacyAccepted, setPrivacyAccepted] = useState(false); // consenso privacy (obbligatorio in registrazione)
  const [faceIdOn, setFaceIdOn] = useState(false); // Face ID / passkey configurato per questo account
  
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  // Recupero password ("Password dimenticata?"): step email → codice+nuova password.
  const [forgotOpen, setForgotOpen] = useState(false);
  const [forgotStep, setForgotStep] = useState<'email' | 'code'>('email');
  const [forgotEmail, setForgotEmail] = useState('');
  const [forgotCode, setForgotCode] = useState('');
  const [forgotNewPw, setForgotNewPw] = useState('');
  const [forgotBusy, setForgotBusy] = useState(false);
  const [forgotMsg, setForgotMsg] = useState<string | null>(null);
  const [regType, setRegType] = useState<'new_team' | 'join_team'>('new_team');
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [authName, setAuthName] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authPasswordErrors, setAuthPasswordErrors] = useState<string[]>([]);
  const [regCategories, setRegCategories] = useState<string[]>([]);
  const [showLanding, setShowLanding] = useState(true);
  // Assistente vocale "Ehy HQ" (wake-word Vosk): attivato dalle Impostazioni (qui si dà il
  // permesso microfono). La preferenza è condivisa con AssistantChat via localStorage+evento.
  const [voiceWake, setVoiceWake] = useState(() => { try { return localStorage.getItem('hq_wake') === '1'; } catch { return false; } });
  const toggleVoiceWake = async () => {
    const next = !voiceWake;
    if (next) {
      try { const s = await navigator.mediaDevices.getUserMedia({ audio: true }); s.getTracks().forEach(t => t.stop()); }
      catch { showToast('Permesso microfono negato', 'err'); return; }
    }
    setVoiceWake(next);
    try { localStorage.setItem('hq_wake', next ? '1' : '0'); } catch { /* noop */ }
    window.dispatchEvent(new CustomEvent('hq-wake', { detail: next }));
  };
  
  // 2FA login
  const [require2FA, setRequire2FA] = useState(false);
  const [twoFactorCode, setTwoFactorCode] = useState('');
  // Verifica email (codice OTP) — per evitare account con email inesistenti
  const [needVerifyEmail, setNeedVerifyEmail] = useState<string | null>(null);
  const [verifyCode, setVerifyCode] = useState('');
  
  const availableCategories = [
    { id: 'Scarpe', label: 'Scarpe', icon: '👟' },
    { id: 'Vestiti', label: 'Vestiti', icon: '👕' },
    { id: 'Pokemon', label: 'Pokémon', icon: '🃏' },
    { id: 'Orologi', label: 'Orologi', icon: '⌚' },
  ];
  
  // ----- DATA STATE -----
  const [products, setProducts] = useState<Product[]>([]);
  // true dopo il primo caricamento prodotti: evita il flash "Benvenuto, primo articolo"
  // ad ogni apertura mentre i dati stanno ancora caricando.
  const [productsLoaded, setProductsLoaded] = useState(false);
  const [teamData, setTeamData] = useState<any[]>([]);
  const [notifications, setNotifications] = useState<AINotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [notifPanelOpen, setNotifPanelOpen] = useState(false);
  const [topMenuOpen, setTopMenuOpen] = useState(false); // menu "Altro" del top nav (desktop)
  
  // ----- TEMA (scuro / chiaro / glass) -----
  // 'chrome' = tema premium cromato, ora DEFAULT per tutti gli account.
  const [theme, setTheme] = useState<'dark' | 'light' | 'glass' | 'lux' | 'chrome' | 'carbon'>(() => {
    try {
      // Rollout CARBON (Pagani × JP Morgan): porta TUTTI al tema scuro/carbon UNA volta (poi
      // resta modificabile dall'utente). 'dark' come valore → applica la colorazione carbon.
      if (localStorage.getItem('hq-theme-rollout') !== 'carbon') {
        localStorage.setItem('hq-theme', 'dark');
        localStorage.setItem('hq-theme-rollout', 'carbon');
        return 'dark';
      }
      return (localStorage.getItem('hq-theme') as 'dark' | 'light' | 'glass' | 'lux' | 'chrome' | 'carbon') || 'dark';
    } catch { return 'dark'; }
  });
  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove('light', 'glass', 'lux', 'chrome', 'carbon');
    // Il tema "Black" (dark) ora USA la colorazione CARBON FIBER (etichetta invariata):
    // 'dark' come valore di stato → applica la classe .carbon. Ogni tema ha sempre una classe.
    const cls = theme === 'dark' ? 'carbon' : theme;
    root.classList.add(cls);
    try { localStorage.setItem('hq-theme', theme); } catch { /* storage non disponibile */ }
  }, [theme]);

  // ----- UI STATE -----
  const [currentView, setCurrentView] = useState<'dashboard' | 'magazzino' | 'analytics' | 'tracking' | 'settings' | 'admin' | 'market' | 'chat' | 'wallet' | 'catalog'>('dashboard');
  const [magazzinoView, setMagazzinoView] = useState<'instock' | 'sold' | 'toship'>('instock');
  const [searchTerm, setSearchTerm] = useState('');
  const [filterCat, setFilterCat] = useState('all');
  // PERIODO "Personal": pilota profitto personale + grafico dashboard + buyer/seller del periodo.
  const [personalPeriod, setPersonalPeriod] = useState<{ kind: '7d' | '30d' | 'year' | 'all' | 'custom'; from?: string; to?: string }>({ kind: 'all' });
  const [periodPickerOpen, setPeriodPickerOpen] = useState(false);
  const [ppFrom, setPpFrom] = useState('');
  const [ppTo, setPpTo] = useState('');
  // Report mensile (conto economico) — mese selezionato
  const [reportMonth, setReportMonth] = useState(() => { const d = new Date(); return { y: d.getFullYear(), m: d.getMonth() }; });
  // ----- COMMAND PALETTE (Ctrl/Cmd+K) -----
  const [cmdOpen, setCmdOpen] = useState(false);
  const [cmdQuery, setCmdQuery] = useState('');
  const [cmdIndex, setCmdIndex] = useState(0);
  
  // ----- FORM PRODOTTO -----
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  
  const [category, setCategory] = useState('');
  // Categoria rilevata dall'IA in modalità Automatica ma senza un reparto corrispondente
  const [detectedReparto, setDetectedReparto] = useState('');
  // In modalità Automatica foto-first: mostra la griglia reparti solo su richiesta
  const [showRepartoGrid, setShowRepartoGrid] = useState(false);
  const [price, setPrice] = useState('');
  const [productSupplier, setProductSupplier] = useState(''); // da chi ho acquistato (fornitore, facoltativo)
  const [quantity, setQuantity] = useState('1');
  const [brand, setBrand] = useState('');
  const [name, setName] = useState('');
  const [sku, setSku] = useState(''); // style code/SKU letto dalla scatola
  const [size, setSize] = useState('42');
  const [condition, setCondition] = useState('DS');
  // Conto vendita (consignment): prodotto di un terzo. Nome obbligatorio, % facoltativa.
  const [isConsignment, setIsConsignment] = useState(false);
  const [consignmentName, setConsignmentName] = useState('');
  const [consignmentPercent, setConsignmentPercent] = useState('');
  const [pokeName, setPokeName] = useState('');
  // Numero collezione carta (es. 4/102) — rilevato dall'IA, modificabile a mano.
  const [cardNumber, setCardNumber] = useState('');
  const [cardGame, setCardGame] = useState('pokemon'); // pokemon | magic | yugioh (rilevato dall'IA)
  const [revaluingCard, setRevaluingCard] = useState(false);
  const [pokeGraded, setPokeGraded] = useState('No');
  const [pokeGrade, setPokeGrade] = useState('10');
  const [watchBrand, setWatchBrand] = useState('');
  const [watchModel, setWatchModel] = useState('');
  const [watchCase, setWatchCase] = useState('');
  const [watchStrap, setWatchStrap] = useState('');
  const [watchMaterial, setWatchMaterial] = useState('');
  
  // IA scan state
  const [isScanning, setIsScanning] = useState(false);
  const [scanResult, setScanResult] = useState<any>(null);
  const [scanMarket, setScanMarket] = useState<any>(null); // verifica eBay del riconoscimento (valore di mercato)
  const [scanStockxMatch, setScanStockxMatch] = useState<any>(null); // conferma visiva StockX (foto+nome del modello riconosciuto)
  // Annullamento scan: se rimuovi la foto in analisi (o le togli tutte), abortiamo la
  // richiesta in corso così l'IA smette di "pensare" e non ripopola i campi.
  const scanAbortRef = useRef<AbortController | null>(null);
  const scanningImageRef = useRef<string | null>(null); // quale immagine è attualmente in scansione
  const [priceEstimate, setPriceEstimate] = useState<any>(null); // rimasto per compatibilità reset, non più usato in UI
  
  // Input categoria scritta a mano nel form (crea o seleziona la categoria)
  const [formCatInput, setFormCatInput] = useState('');
  // "Dettagli categoria" a comparsa nel form (chiuso di default)
  const [showCatDetails, setShowCatDetails] = useState(false);
  // ----- BARCODE (scansiona + cerca prodotto) -----
  const [barcodeModalOpen, setBarcodeModalOpen] = useState(false);
  const [barcodeSupported, setBarcodeSupported] = useState(true);
  const [barcodeManual, setBarcodeManual] = useState('');
  const [barcodeBusy, setBarcodeBusy] = useState(false);

  // ----- FOTO PRODOTTO -----
  const [productPhotos, setProductPhotos] = useState<string[]>([]);
  const [editPhotos, setEditPhotos] = useState<string[]>([]);

  // Quote condivise
  const [isSharedPurchase, setIsSharedPurchase] = useState(false);
  const [productShares, setProductShares] = useState<{userId: string, name: string, percentage: string | number}[]>([]);
  // Quote costi d'acquisto: chi ha pagato quanto
  const [isSharedCost, setIsSharedCost] = useState(false);
  const [purchaseCostShares, setPurchaseCostShares] = useState<{userId: string, name: string, percentage: string | number, amount?: number}[]>([]);
  // Sotto-magazzini: scelta nel form (vuoto = reparto stesso) + creazione nelle impostazioni
  const [selectedSubWh, setSelectedSubWh] = useState('');
  const [newSubName, setNewSubName] = useState('');
  const [addingSubTo, setAddingSubTo] = useState(''); // id reparto a cui sto aggiungendo un sotto-magazzino
  const [creatingSub, setCreatingSub] = useState(false);
  
  // ----- VENDITA & MODIFICA -----
  const [sellModalOpen, setSellModalOpen] = useState(false);
  const [productToSell, setProductToSell] = useState<{ids: string[], name: string, maxQty: number, suggestedPrice?: number, purchasePrice?: number} | null>(null);
  const [sellQuantity, setSellQuantity] = useState('1');
  const [sellPrice, setSellPrice] = useState('');
  const [sellPlatform, setSellPlatform] = useState('Vinted');
  const [sellPaymentMethod, setSellPaymentMethod] = useState('Nessuna Fee (Contanti/Bonifico)');
  const [sellCustomer, setSellCustomer] = useState(''); // identificativo cliente (facoltativo)
  const [sellFees, setSellFees] = useState('0');
  // Costi extra per la vendita (scatola, etichetta spedizione, dogana…): voci modificabili,
  // la loro somma viene SOTTRATTA dal ricavo (aggiunta alle fees del prodotto).
  const [sellExtraCosts, setSellExtraCosts] = useState<{ desc: string; amount: string }[]>([]);
  const [sellExtraOpen, setSellExtraOpen] = useState(false);
  const [smartLotOpen, setSmartLotOpen] = useState(false); // flusso "Lotto smart (IA)"
  const [dashPopular, setDashPopular] = useState<any[]>([]); // catalogo che scorre in dashboard
  const [enrichingPhotos, setEnrichingPhotos] = useState(false);
  const autoEnrichedRef = useRef(false); // aggancio foto automatico una volta per sessione
  const enrichMissingPhotos = async (silent = false) => {
    setEnrichingPhotos(true);
    if (!silent) showToast('🖼️ Cerco le foto mancanti…', 'ok');
    const { ok, data } = await apiCall<any>('/products/enrich-photos', { method: 'POST', body: JSON.stringify({}) });
    setEnrichingPhotos(false);
    if (!ok) { if (!silent) showToast('Errore ricerca foto', 'err'); return; }
    await fetchProducts();
    if (!silent) showToast(data?.updated ? `✅ ${data.updated} foto agganciate` : 'Nessuna nuova foto trovata', data?.updated ? 'ok' : 'warn');
    else if (data?.updated) showToast(`✅ ${data.updated} foto agganciate in automatico`, 'ok');
  };
  // AUTO: all'apertura del Magazzino, se ci sono prodotti IN STOCK senza foto, le aggancia da
  // solo (una volta per sessione, silenzioso). Solo admin per ora.
  useEffect(() => {
    if (autoEnrichedRef.current || currentView !== 'magazzino') return;
    if (!productsLoaded || !products.length || !isAdminEmail(user?.email)) return;
    if (!products.some((p: any) => p.status === 'IN STOCK' && !p.photos)) return;
    autoEnrichedRef.current = true;
    enrichMissingPhotos(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentView, productsLoaded, products, user]);

  // Tracking opzionale della spedizione di vendita (OUTBOUND) direttamente nel flusso Vendi
  const [sellTrackingCode, setSellTrackingCode] = useState('');
  const [sellTrackingCarrier, setSellTrackingCarrier] = useState('Auto');
  
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [productToEdit, setProductToEdit] = useState<any>(null);
  const [lotDetail, setLotDetail] = useState<any>(null); // dettaglio lotto: lista dei pezzi
  const [modelDetail, setModelDetail] = useState<any>(null); // dettaglio MODELLO: suddivisione per taglia
  const [zoomPhoto, setZoomPhoto] = useState<string | null>(null); // foto ingrandita (lightbox magazzino)
  const [expandedSoldKey, setExpandedSoldKey] = useState<string | null>(null); // card venduto aperta (tendina compratori)
  // Pubblicazione nel marketplace dalla modale di modifica
  const [editIsPublic, setEditIsPublic] = useState(false);
  const [editPublicPrice, setEditPublicPrice] = useState('');
  const [editShippingCost, setEditShippingCost] = useState('');
  const [isPublishing, setIsPublishing] = useState(false);
  // Modifica quantità pezzi dall'edit (lotti e gruppi multi-pezzo)
  const [editQuantity, setEditQuantity] = useState('1');
  const [editLotIds, setEditLotIds] = useState<string[]>([]); // tutti i pezzi in stock del lotto (se è un lotto)
  // Valutazione di mercato (eBay autenticati / StockX in futuro)
  const [valuation, setValuation] = useState<any>(null);
  const [valLoading, setValLoading] = useState(false);
  // ----- SOURCING "Quanto lo pago?" -----
  const [sourcingOpen, setSourcingOpen] = useState(false);
  const [sourcingBrand, setSourcingBrand] = useState('');
  const [sourcingModel, setSourcingModel] = useState('');
  const [sourcingSize, setSourcingSize] = useState('');
  const [sourcingMargin, setSourcingMargin] = useState(50); // % di margine desiderato sul costo
  const [sourcingVal, setSourcingVal] = useState<any>(null);
  const [sourcingScanning, setSourcingScanning] = useState(false);
  const [sourcingCalcLoading, setSourcingCalcLoading] = useState(false);
  const sourcingCamInputRef = useRef<HTMLInputElement | null>(null);
  const [editBrand, setEditBrand] = useState('');
  const [editName, setEditName] = useState('');
  const [editSize, setEditSize] = useState('');
  const [editCondition, setEditCondition] = useState('');
  const [editPrice, setEditPrice] = useState('');
  // Modifica VENDITA (per prodotti già venduti): prezzo, piattaforma, fee, cliente.
  const [editSalePrice, setEditSalePrice] = useState('');
  const [editSalePlatform, setEditSalePlatform] = useState('');
  const [editSaleFees, setEditSaleFees] = useState('');
  const [editSaleCustomer, setEditSaleCustomer] = useState('');
  const [editQuickSale, setEditQuickSale] = useState(''); // sell panic: prezzo svendita rapida
  const [editSupplier, setEditSupplier] = useState('');   // da chi ho acquistato (fornitore, facoltativo)
  const [editPurchaseDate, setEditPurchaseDate] = useState(''); // data acquisto (facoltativa)
  const [editSoldDate, setEditSoldDate] = useState('');         // data vendita (facoltativa)
  const [editWarehouseId, setEditWarehouseId] = useState(''); // magazzino del prodotto (per spostarlo)
  const [isEditShared, setIsEditShared] = useState(false);
  const [editShares, setEditShares] = useState<{userId: string, name: string, percentage: string | number}[]>([]);
  
  // ----- TEAM -----
  const [isSavingTeam, setIsSavingTeam] = useState(false);
  const [newCatName, setNewCatName] = useState('');
  const [isAddingCat, setIsAddingCat] = useState(false);
  // Magazzino (partnership) selezionato nel form di aggiunta. Vuoto = magazzino base.
  const [selectedWarehouseId, setSelectedWarehouseId] = useState('');
  // Creazione nuovo magazzino (partnership) dalle impostazioni
  const [newWarehouseName, setNewWarehouseName] = useState('');
  const [isAddingWarehouse, setIsAddingWarehouse] = useState(false);
  // ----- CATEGORIE (trasversali, da CategoryTemplate) -----
  // Catalogo categorie indipendente dai magazzini: {name, icon, fields}.
  const [categories, setCategories] = useState<{ name: string; icon: string | null }[]>([]);
  // ----- COSTI EXTRA (Expense) -----
  const [expenses, setExpenses] = useState<any[]>([]);
  const [expAmount, setExpAmount] = useState('');
  const [expDesc, setExpDesc] = useState('');
  const [expCat, setExpCat] = useState('Sacchetti');
  const [expWarehouse, setExpWarehouse] = useState('');
  const [isAddingExp, setIsAddingExp] = useState(false);
  const [expensesOpen, setExpensesOpen] = useState(false); // accordion costi extra (chiuso = non invade le analytics)
  const [expandedContact, setExpandedContact] = useState<string | null>(null); // riga contatto aperta (mostra i suoi pezzi)
  const [contactsPage, setContactsPage] = useState<null | 'buyers' | 'sellers'>(null); // popup tutti i compratori/fornitori
  const [contactPageExpanded, setContactPageExpanded] = useState<string | null>(null);
  const [contactSearch, setContactSearch] = useState(''); // ricerca nel popup compratori/fornitori
  // TASK / NOTE (widget promemoria, sincronizzate sul server, riassunte dall'IA)
  const [tasks, setTasks] = useState<any[]>([]);
  const [taskInput, setTaskInput] = useState('');
  const [taskPanelOpen, setTaskPanelOpen] = useState(false);
  const [taskSaving, setTaskSaving] = useState(false);
  const [expandedTask, setExpandedTask] = useState<string | null>(null);
  const [taskRemind, setTaskRemind] = useState('');       // promemoria (datetime-local) per la nuova nota
  const [editingTask, setEditingTask] = useState<string | null>(null); // nota in modifica
  const [editText, setEditText] = useState('');
  const [editRemind, setEditRemind] = useState('');
  const [notifyPrompt, setNotifyPrompt] = useState(false); // popup "attiva notifiche" quando metti un promemoria
  // Mesi STORICI (prima dell'apertura del conto)
  const [manualMonths, setManualMonths] = useState<any[]>([]);
  const [manualOpen, setManualOpen] = useState(false);
  const [isAddingMM, setIsAddingMM] = useState(false);
  const [mmYear, setMmYear] = useState(String(new Date().getFullYear()));
  const [mmMonth, setMmMonth] = useState('0');
  const [mmRevenue, setMmRevenue] = useState('');
  const [mmCost, setMmCost] = useState('');
  // ----- MARKETPLACE + CHAT -----
  // Pagina pubblica (senza login): attiva se si arriva su /market
  const [publicMarket, setPublicMarket] = useState(() => {
    try { return window.location.pathname.replace(/\/$/, '') === '/market'; } catch { return false; }
  });
  const [marketItems, setMarketItems] = useState<any[]>([]);
  const [marketQuery, setMarketQuery] = useState('');
  const [marketCat, setMarketCat] = useState('');
  const [marketCats, setMarketCats] = useState<string[]>([]);
  const [marketLoading, setMarketLoading] = useState(false);
  const [marketDetail, setMarketDetail] = useState<any>(null);
  const [marketPhotoIdx, setMarketPhotoIdx] = useState(0);
  useEffect(() => { setMarketPhotoIdx(0); }, [marketDetail?.id]);
  const [conversations, setConversations] = useState<any[]>([]);
  const [activeConvo, setActiveConvo] = useState<any>(null);
  const [chatMessages, setChatMessages] = useState<any[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [chatSending, setChatSending] = useState(false);
  // Completa vendita + spedizione dalla chat (lato venditore)
  const [shipForm, setShipForm] = useState<{ open: boolean; price: string; code: string; carrier: string }>({ open: false, price: '', code: '', carrier: 'Auto' });
  const [shipping, setShipping] = useState(false);
  // Etichetta dimostrativa mostrata in-app (no nuova finestra che intrappola su mobile)
  const [labelData, setLabelData] = useState<{ productName: string; sender: string; recipient: string; code: string; carrier: string } | null>(null);
  // Stripe Connect (incassi venditore)
  const [connectStatus, setConnectStatus] = useState<{ configured: boolean; connected: boolean; chargesEnabled: boolean } | null>(null);
  const [connecting, setConnecting] = useState(false);
  // Portafoglio venditore (saldo da riscuotere)
  const [wallet, setWallet] = useState<{ available: number; pending: number; readyItems: any[]; pendingItems: any[] } | null>(null);
  const [withdrawing, setWithdrawing] = useState(false);
  // Stato integrazione StockX (configurato + connesso via OAuth)
  const [stockxStatus, setStockxStatus] = useState<{ configured: boolean; connected: boolean; tokenOk?: boolean } | null>(null);
  const [stockxConnecting, setStockxConnecting] = useState(false);
  
  // ----- PROFIT SHARING -----
  const [showProfitSharesModal, setShowProfitSharesModal] = useState(false);
  const [profitSharesMode, setProfitSharesMode] = useState<'warehouse' | 'subwarehouse'>('warehouse');
  const [profitSharesParentId, setProfitSharesParentId] = useState('');
  const [profitSharesName, setProfitSharesName] = useState('');
  const [profitShares, setProfitShares] = useState<{userId: string, name: string, percentage: string}[]>([]);
  
  // ----- TOAST -----
  const [toast, setToast] = useState<{ msg: string; type: 'ok' | 'err' | 'warn'; action?: { label: string; onClick: () => void } } | null>(null);
  const toastRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Input fotocamera sempre montato: premendo "+" lo clicchiamo nel gesto utente
  // così su mobile la fotocamera si apre SUBITO (zero tap sprecati).
  const addCameraInputRef = useRef<HTMLInputElement | null>(null);
  // Barcode scanner (BarcodeDetector + stream fotocamera)
  const barcodeVideoRef = useRef<HTMLVideoElement | null>(null);
  const barcodeStreamRef = useRef<MediaStream | null>(null);
  const barcodeLoopRef = useRef<number | null>(null);
  const notifRef = useRef<HTMLDivElement | null>(null);
  const bottomNavRef = useRef<HTMLElement | null>(null);
  const topBarRef = useRef<HTMLElement | null>(null);
  // Misura l'ALTEZZA REALE della bottom-nav (varia per modello: notch, densità, safe-area)
  // e la espone come variabile CSS --bottom-nav-h. Barra-chat e contenuti la usano per non
  // sovrapporsi MAI, su qualsiasi telefono. (Su desktop la nav non c'è → fallback 0.)
  useEffect(() => {
    const el = bottomNavRef.current;
    const root = document.documentElement;
    const apply = () => {
      const visible = el && getComputedStyle(el).display !== 'none';
      const h = visible ? el!.offsetHeight : 0;
      // Se la misura fallisce (0/troppo bassa) su mobile, usa un default sicuro così la
      // barra-chat NON finisce mai sopra la nav. Su desktop (nav hidden) resta 0.
      const val = visible ? (h > 24 ? h : 84) : 0;
      root.style.setProperty('--bottom-nav-h', `${val}px`);
    };
    apply();
    requestAnimationFrame(apply);            // dopo il primo paint
    const t = setTimeout(apply, 350);        // dopo che il layout/safe-area si è assestato
    let ro: ResizeObserver | null = null;
    if (el && 'ResizeObserver' in window) { ro = new ResizeObserver(apply); ro.observe(el); }
    window.addEventListener('resize', apply);
    window.addEventListener('orientationchange', apply);
    return () => { clearTimeout(t); ro?.disconnect(); window.removeEventListener('resize', apply); window.removeEventListener('orientationchange', apply); };
  }, [currentView]);
  // Misura l'ALTEZZA REALE dell'header mobile FISSO (safe-area + contenuto) → variabile CSS
  // --top-bar-h. Il contenuto si stacca esattamente di quel tanto, così la barra resta bloccata
  // in alto SENZA buchi né sovrapposizioni. Su desktop l'header è display:none → 0.
  useEffect(() => {
    const el = topBarRef.current;
    const root = document.documentElement;
    const apply = () => {
      const visible = el && getComputedStyle(el).display !== 'none';
      const h = visible ? el!.offsetHeight : 0;
      root.style.setProperty('--top-bar-h', `${visible ? h : 0}px`);
    };
    apply();
    requestAnimationFrame(apply);
    const t = setTimeout(apply, 350);
    let ro: ResizeObserver | null = null;
    if (el && 'ResizeObserver' in window) { ro = new ResizeObserver(apply); ro.observe(el); }
    window.addEventListener('resize', apply);
    window.addEventListener('orientationchange', apply);
    return () => { clearTimeout(t); ro?.disconnect(); window.removeEventListener('resize', apply); window.removeEventListener('orientationchange', apply); };
  }, [currentView]);
  const showToast = useCallback((msg: string, type: 'ok' | 'err' | 'warn' = 'ok', action?: { label: string; onClick: () => void }) => {
    if (toastRef.current) clearTimeout(toastRef.current);
    setToast({ msg, type, action });
    // Più tempo per agire quando c'è un "Annulla"
    toastRef.current = setTimeout(() => setToast(null), action ? 6000 : 3200);
  }, []);

  // ----- 2FA SETUP -----
  const [twoFaSetupOpen, setTwoFaSetupOpen] = useState(false);
  const [twoFaQR, setTwoFaQR] = useState<string | null>(null);
  const [twoFaCode, setTwoFaCode] = useState('');
  const [twoFaBackupCodes, setTwoFaBackupCodes] = useState<string[] | null>(null);
  const [twoFaLoading, setTwoFaLoading] = useState(false);
  
  // ----- 2FA DISABLE MODAL -----
  const [twoFaDisableOpen, setTwoFaDisableOpen] = useState(false);
  const [twoFaDisablePwd, setTwoFaDisablePwd] = useState('');
  const [twoFaDisableOtp, setTwoFaDisableOtp] = useState('');

  // ----- PRODOTTI FERMI -----
  const [staleThreshold, setStaleThreshold] = useState(() => {
    const saved = localStorage.getItem('staleThreshold');
    return saved ? parseInt(saved) : 60;
  });
  const [staleProducts, setStaleProducts] = useState<any[]>([]);

  // ----- SORT & FILTER MAGAZZINO -----
  const [sortField, setSortField] = useState<'date' | 'price' | 'name'>('date');
  const [sortDir, setSortDir] = useState<'desc' | 'asc'>('desc');
  const [filterCondition, setFilterCondition] = useState('all');
  const [filterPriceMin, setFilterPriceMin] = useState('');
  const [filterPriceMax, setFilterPriceMax] = useState('');
  const [staleOnly, setStaleOnly] = useState(false); // filtro rapido "Fermi" (in stock da +30gg)

  // ----- DELETE PRODOTTO -----
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [productToDelete, setProductToDelete] = useState<any>(null);

  // ----- CAMBIO PASSWORD -----
  const [changePwdOpen, setChangePwdOpen] = useState(false);
  const [changePwdCurrent, setChangePwdCurrent] = useState('');
  const [changePwdNew, setChangePwdNew] = useState('');
  const [changePwdConfirm, setChangePwdConfirm] = useState('');
  const [changePwdLoading, setChangePwdLoading] = useState(false);

  // ----- BULK ACTIONS -----
  const [bulkMode, setBulkMode] = useState(false);
  const [selectedGroupKeys, setSelectedGroupKeys] = useState<Set<string>>(new Set());
  // Pezzi SINGOLI selezionati (es. alcuni pezzi di un lotto) da raggruppare con altri prodotti
  const [selectedPieceIds, setSelectedPieceIds] = useState<Set<string>>(new Set());
  // Selezione PARZIALE di un gruppo di pezzi identici (es. 14 di 29) in modalità selezione:
  // toccando il gruppo si apre un selettore "quanti".
  const [bulkQtyGroup, setBulkQtyGroup] = useState<any | null>(null);
  const [bulkQtyValue, setBulkQtyValue] = useState('1');
  const openBulkQty = (g: any) => {
    setBulkMode(true);
    const already = (g.ids as string[]).filter(id => selectedPieceIds.has(id)).length;
    setBulkQtyValue(String(already > 0 ? already : g.ids.length));
    setBulkQtyGroup(g);
  };
  const applyBulkQty = () => {
    const g = bulkQtyGroup; if (!g) return;
    const n = Math.min(g.ids.length, Math.max(0, parseInt(bulkQtyValue) || 0));
    setSelectedPieceIds(prev => {
      const next = new Set(prev);
      (g.ids as string[]).forEach(id => next.delete(id));        // azzera questo gruppo
      (g.ids as string[]).slice(0, n).forEach(id => next.add(id)); // seleziona i primi n
      return next;
    });
    // il gruppo va gestito a livello di PEZZI, non come blocco intero
    setSelectedGroupKeys(prev => { const next = new Set(prev); next.delete((g.ids as string[]).join(',')); return next; });
    setBulkQtyGroup(null);
  };

  // Long-press per entrare in selezione (sostituisce il tasto "Seleziona").
  // Robusto su tablet/telefono: si ANNULLA se il dito si muove (= stai scorrendo), così
  //  - un tocco normale resta un "tap" → apre la Modifica (prima su tablet falliva);
  //  - lo scroll del magazzino non attiva più per sbaglio la selezione multipla.
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFired = useRef(false);
  const pressStart = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const pressMoved = useRef(false);
  const startLongPress = (groupKey: string, e?: any) => {
    longPressFired.current = false;
    pressMoved.current = false;
    const pt = e?.touches?.[0] || e;
    if (pt && typeof pt.clientX === 'number') pressStart.current = { x: pt.clientX, y: pt.clientY };
    if (longPressTimer.current) clearTimeout(longPressTimer.current);
    longPressTimer.current = setTimeout(() => {
      if (pressMoved.current) return; // il dito si è spostato → era uno scroll, non un long-press
      longPressFired.current = true;
      setBulkMode(true);
      setSelectedGroupKeys(prev => { const n = new Set(prev); n.add(groupKey); return n; });
      if ('vibrate' in navigator) { try { navigator.vibrate(30); } catch {} }
    }, 500);
  };
  const moveLongPress = (e?: any) => {
    if (!longPressTimer.current) return;
    const pt = e?.touches?.[0] || e;
    if (!pt || typeof pt.clientX !== 'number') return;
    if (Math.abs(pt.clientX - pressStart.current.x) > 10 || Math.abs(pt.clientY - pressStart.current.y) > 10) {
      pressMoved.current = true;
      cancelLongPress();
    }
  };
  const cancelLongPress = () => {
    if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null; }
  };
  // Props riutilizzabili per ogni card: avvia/annulla long-press + click che gestisce toggle/edit
  const cardPressProps = (groupKey: string) => (!bulkMode ? {
    onMouseDown: (e: any) => startLongPress(groupKey, e),
    onMouseUp: cancelLongPress,
    onMouseLeave: cancelLongPress,
    onTouchStart: (e: any) => startLongPress(groupKey, e),
    onTouchMove: moveLongPress,
    onTouchEnd: cancelLongPress,
  } : {});
  const cardClick = (groupKey: string, group?: any) => {
    if (swipeActed.current) { swipeActed.current = false; return; } // dopo una swipe niente click
    if (longPressFired.current) { longPressFired.current = false; return; }
    if (!bulkMode) return;
    // In selezione, se l'oggetto CONTIENE più pezzi (modello con più taglie/venditori, o lotto),
    // aprire il dettaglio così si scelgono i SINGOLI pezzi (es. vendere solo 2 su 3, e decidere
    // quali in base al venditore) invece di selezionare per forza tutto il gruppo.
    if (group?.isModel) { setModelDetail(group); return; }
    if (group?.isLot) { setLotDetail(group); return; }
    // Gruppo di pezzi IDENTICI (es. ×29): apri il selettore "quanti" così ne selezioni una parte
    // (es. 14 di 29) invece di tutto il gruppo. Un pezzo solo → toggle diretto.
    if (group && (group.ids?.length || 0) > 1) { openBulkQty(group); return; }
    toggleGroupSelection(groupKey);
  };

  // ===== SWIPE sulle card magazzino (mobile): destra = Vendi, sinistra = Elimina (con conferma) =====
  const [swipe, setSwipe] = useState<{ key: string; dx: number } | null>(null);
  const [swipeDelete, setSwipeDelete] = useState<any>(null); // prodotto da eliminare (popup conferma)
  const swipeRef = useRef<{ x: number; y: number; axis: '' | 'h' | 'v'; key: string }>({ x: 0, y: 0, axis: '', key: '' });
  const swipeActed = useRef(false);
  const SWIPE_SELL = 82, SWIPE_DEL = 100; // soglie px (elimina un po' più "marcata")
  const swipeStart = (key: string, e: any) => {
    const t = e.touches?.[0]; if (!t) return;
    swipeRef.current = { x: t.clientX, y: t.clientY, axis: '', key };
  };
  const swipeMove = (key: string, e: any) => {
    if (swipeRef.current.key !== key || bulkMode) return;
    const t = e.touches?.[0]; if (!t) return;
    const dx = t.clientX - swipeRef.current.x, dy = t.clientY - swipeRef.current.y;
    if (!swipeRef.current.axis && (Math.abs(dx) > 12 || Math.abs(dy) > 12)) swipeRef.current.axis = Math.abs(dx) > Math.abs(dy) ? 'h' : 'v';
    if (swipeRef.current.axis === 'h') setSwipe({ key, dx: Math.max(-150, Math.min(150, dx)) });
  };
  const swipeEnd = (key: string, g: any) => {
    if (swipeRef.current.key === key && swipeRef.current.axis === 'h' && swipe && swipe.key === key) {
      const dx = swipe.dx;
      // MODELLO/LOTTO = contenitori (più taglie/pezzi): lo swipe non vende/elimina tutto; apre il
      // dettaglio così scegli la taglia/pezzo giusto.
      if (g.isModel || g.isLot) {
        if (Math.abs(dx) >= SWIPE_SELL) { swipeActed.current = true; openEditModal(g); }
      } else if (dx >= SWIPE_SELL) { swipeActed.current = true; openSellModal(g.ids, `${fullName(g.brand, g.name)}`, g); }
      else if (dx <= -SWIPE_DEL) { swipeActed.current = true; setSwipeDelete(g); }
    }
    setSwipe(null); swipeRef.current = { x: 0, y: 0, axis: '', key: '' };
  };
  // Props card: long-press (bulk) + swipe insieme.
  const cardTouchProps = (groupKey: string, g: any) => (!bulkMode ? {
    onMouseDown: (e: any) => startLongPress(groupKey, e),
    onMouseUp: cancelLongPress,
    onMouseLeave: cancelLongPress,
    onTouchStart: (e: any) => { startLongPress(groupKey, e); swipeStart(groupKey, e); },
    onTouchMove: (e: any) => { moveLongPress(e); swipeMove(groupKey, e); },
    onTouchEnd: () => { cancelLongPress(); swipeEnd(groupKey, g); },
  } : {});
  // Elimina il prodotto/gruppo (soft-delete): toast con Annulla + reintegrabile via Importazioni.
  const deleteProductGroup = async (g: any) => {
    const ids: string[] = g.ids || [];
    setSwipeDelete(null);
    const results = await Promise.allSettled(ids.map(id => apiCall(`/products/${id}`, { method: 'DELETE' })));
    const ok = results.filter(r => r.status === 'fulfilled' && (r.value as any).ok).length;
    await fetchProducts();
    if (ok > 0) showToast(`🗑️ ${fullName(g.brand, g.name)} rimosso — puoi reintegrarlo dalle Importazioni`, 'ok', { label: t('common.cancel'), onClick: () => undoDeleteIds(ids) });
    else showToast(t('ts.error'), 'err');
  };
  const [bulkSellOpen, setBulkSellOpen] = useState(false);
  const [bulkSellPrice, setBulkSellPrice] = useState('');
  const [bulkSellPlatform, setBulkSellPlatform] = useState('Vinted');
  const [bulkSellFees, setBulkSellFees] = useState('0');
  const [bulkDeleteConfirmOpen, setBulkDeleteConfirmOpen] = useState(false);
  const [isBulkProcessing, setIsBulkProcessing] = useState(false);

  // ----- IMPORT EXCEL -----
  const [importOpen, setImportOpen] = useState(false);
  const [importRows, setImportRows] = useState<any[]>([]);
  const [importCategory, setImportCategory] = useState('');
  const [importWarehouseId, setImportWarehouseId] = useState(''); // magazzino per l'import (default: base)
  const [isImporting, setIsImporting] = useState(false);
  const [importErrors, setImportErrors] = useState<string[]>([]);
  // Import "qualsiasi Excel": teniamo righe grezze + intestazioni + abbinamento colonna→campo,
  // così l'utente può mappare il SUO file (colonne con nomi diversi).
  const [importRaw, setImportRaw] = useState<any[]>([]);
  const [importHeaders, setImportHeaders] = useState<string[]>([]);
  const [importMap, setImportMap] = useState<Record<string, string>>({});

  // ----- TEAM PANEL -----
  const [teamPanelOpen, setTeamPanelOpen] = useState(false);
  // Stato del pannello Team — DEVE stare a livello di componente (non dentro la IIFE
  // del render, altrimenti gli hook sono condizionali → crash "pagina bianca").
  const [editQuoteWarehouse, setEditQuoteWarehouse] = useState<string | null>(null);
  const [editQuoteValues, setEditQuoteValues] = useState<Record<string, string>>({});
  const [kickConfirm, setKickConfirm] = useState<string | null>(null);
  const [isRegenerating, setIsRegenerating] = useState<string | null>(null);

  // ----- ENTRA IN MAGAZZINO -----
  const [joinCodeInput, setJoinCodeInput] = useState('');
  const [isJoining, setIsJoining] = useState(false);

  // ----- ELIMINA ACCOUNT -----
  const [deleteAccountStep, setDeleteAccountStep] = useState(0); // 0=chiuso, 1=warning, 2=email, 3=password, 4=finale
  const [deleteEmailConfirm, setDeleteEmailConfirm] = useState('');
  const [deletePasswordConfirm, setDeletePasswordConfirm] = useState('');
  const [deleteCheckbox, setDeleteCheckbox] = useState(false);
  const [isDeletingAccount, setIsDeletingAccount] = useState(false);

  // ----- AIUTO & ASSISTENZA (feedback all'admin) -----
  const [feedbackType, setFeedbackType] = useState<'bug' | 'idea' | 'domanda' | 'altro'>('idea');
  const [feedbackMsg, setFeedbackMsg] = useState('');
  const [feedbackSending, setFeedbackSending] = useState(false);

  // ----- NOTIFICHE PUSH -----
  const [pushEnabled, setPushEnabled] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  // Preferenze notifiche (schermata dedicata con toggle per categoria)
  const [notifPrefsOpen, setNotifPrefsOpen] = useState(false);
  const [notifPrefs, setNotifPrefs] = useState<Record<string, boolean>>({});
  const NOTIF_LABELS: { key: string; label: string; desc: string }[] = [
    { key: 'offers', label: t('notif.offers'), desc: t('notif.offersDesc') },
    { key: 'messages', label: t('notif.messages'), desc: t('notif.messagesDesc') },
    { key: 'sales', label: t('notif.sales'), desc: t('notif.salesDesc') },
    { key: 'shipping', label: t('notif.shipping'), desc: t('notif.shippingDesc') },
    { key: 'disputes', label: t('notif.disputes'), desc: t('notif.disputesDesc') },
    { key: 'team', label: t('notif.team'), desc: t('notif.teamDesc') },
    { key: 'insights', label: t('notif.insights'), desc: t('notif.insightsDesc') },
  ];
  // Magazzino pubblico (auto-pubblicazione dei nuovi prodotti in vetrina)
  const [autoPublishOn, setAutoPublishOn] = useState(false);
  const toggleAutoPublish = async () => {
    const next = !autoPublishOn;
    setAutoPublishOn(next);
    const { ok } = await apiCall('/products/auto-publish', { method: 'PUT', body: JSON.stringify({ enabled: next }) });
    if (!ok) { setAutoPublishOn(!next); showToast(t('ts.saveError'), 'err'); }
    else showToast(next ? 'Magazzino pubblico attivo: i nuovi prodotti andranno in vetrina' : 'Magazzino pubblico disattivato', 'ok');
  };
  const openNotifPrefs = async () => {
    setNotifPrefsOpen(true);
    const { ok, data } = await apiCall<any>('/notifications/prefs');
    if (ok && data?.prefs) setNotifPrefs(data.prefs);
  };
  const toggleNotifPref = async (key: string) => {
    const next = { ...notifPrefs, [key]: !(notifPrefs[key] !== false) };
    setNotifPrefs(next);
    await apiCall('/notifications/prefs', { method: 'PUT', body: JSON.stringify({ prefs: next }) });
  };

  // ----- ADMIN -----
  const [adminUsers, setAdminUsers] = useState<any[]>([]);
  const [adminLoading, setAdminLoading] = useState(false);
  const [adminLoaded, setAdminLoaded] = useState(false);
  const [adminPanelOpen, setAdminPanelOpen] = useState(false);
  const adminRefreshRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const ADMIN_EMAILS = ['noreply.hq.app@gmail.com', 'ciaociao@gmail.com'];
  const isAdminEmail = (e?: string | null) => !!e && ADMIN_EMAILS.includes(e.toLowerCase());

  // ── PIANI & STRUMENTI PRO ──
  const [planModalOpen, setPlanModalOpen] = useState(false);
  const [planCatalog, setPlanCatalog] = useState<any[]>([]);
  const [myPlan, setMyPlan] = useState<string>('free');
  const [myFeatures, setMyFeatures] = useState<string[]>([]);
  const [proTab, setProTab] = useState<'plans' | 'repricing' | 'offer' | 'channels'>('plans');
  const [repricingList, setRepricingList] = useState<any[] | null>(null);
  const [repricingLoading, setRepricingLoading] = useState(false);
  const [offerProductId, setOfferProductId] = useState('');
  const [offerAmount, setOfferAmount] = useState('');
  const [offerMargin, setOfferMargin] = useState('20');
  const [offerResult, setOfferResult] = useState<any>(null);
  const [offerLoading, setOfferLoading] = useState(false);
  const [chProductId, setChProductId] = useState('');
  const [chSelected, setChSelected] = useState<string[]>([]);
  const [chSaving, setChSaving] = useState(false);
  const hasFeature = (f: string) => myFeatures.includes(f);
  // Gating UX: se non hai la feature, apre i Piani (invece di dare errore). true = puoi procedere.
  const requireFeatureOrUpgrade = (f: string) => {
    if (hasFeature(f)) return true;
    openPlanModal();
    return false;
  };
  // Lucchetto cliccabile → apre i Piani. Mostralo accanto alle feature premium bloccate.
  const PlanLock = ({ plan = 'Pro' }: { plan?: string }) => (
    <button type="button" onClick={(e) => { e.stopPropagation(); openPlanModal(); }}
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-[#8397aa]/15 text-[#8397aa] shrink-0">
      <Lock size={10} /> {plan}
    </button>
  );
  // Admin: vista corrente (Utenti / Richieste) + stato richieste
  const [adminView, setAdminView] = useState<'users' | 'feedback' | 'disputes' | 'stats'>('users');
  const [adminStats, setAdminStats] = useState<any>(null); // analytics pre-lancio (visite + waitlist)
  const [adminDisputes, setAdminDisputes] = useState<any[]>([]);
  const [adminFeedback, setAdminFeedback] = useState<any[]>([]);
  const [adminFbNuove, setAdminFbNuove] = useState(0);
  const [fbFilter, setFbFilter] = useState<'nuove' | 'risolte'>('nuove'); // distinzione assistenza: da rispondere vs risolte
  const [replyingId, setReplyingId] = useState<string | null>(null);
  const [replyText, setReplyText] = useState('');
  const [replySending, setReplySending] = useState(false);

  const fetchAdminUsers = async () => {
    setAdminLoading(true);
    const { ok, data } = await apiCall('/admin/users');
    if (ok) { setAdminUsers(data.users || []); setAdminLoaded(true); }
    else showToast(data?.error || 'Errore caricamento utenti admin', 'err');
    setAdminLoading(false);
  };

  const fetchAdminFeedback = async () => {
    const { ok, data } = await apiCall('/admin/feedback');
    if (ok) { setAdminFeedback(data.feedback || []); setAdminFbNuove(data.nuove || 0); }
    else showToast(data?.error || 'Errore caricamento richieste', 'err');
  };

  const fetchAdminDisputes = async () => {
    const { ok, data } = await apiCall('/admin/disputes');
    if (ok) setAdminDisputes(data.disputes || []);
    else showToast(data?.error || 'Errore caricamento contestazioni', 'err');
  };
  const fetchAdminStats = async () => {
    const { ok, data } = await apiCall('/admin/analytics');
    if (ok) setAdminStats(data);
    else showToast(data?.error || 'Errore caricamento statistiche', 'err');
  };
  const resolveAdminDispute = async (productId: string, decision: 'refund_buyer' | 'release_seller') => {
    const msg = decision === 'refund_buyer' ? 'Rimborsare TUTTO al compratore?' : 'Respingere la contestazione e pagare il venditore?';
    if (!window.confirm(msg)) return;
    const { ok, data } = await apiCall(`/admin/disputes/${productId}/resolve`, { method: 'POST', body: JSON.stringify({ decision }) });
    if (ok && data?.success) { await fetchAdminDisputes(); showToast('Contestazione risolta ✓'); }
    else showToast(data?.error || 'Errore', 'err');
  };

  const sendAdminReply = async (id: string) => {
    const reply = replyText.trim();
    if (reply.length < 2) { showToast('Scrivi una risposta', 'warn'); return; }
    setReplySending(true);
    const { ok, data } = await apiCall(`/admin/feedback/${id}/reply`, {
      method: 'POST', body: JSON.stringify({ reply }),
    });
    setReplySending(false);
    if (ok) {
      setAdminFeedback(prev => prev.map(f => f.id === id ? data.feedback : f));
      setAdminFbNuove(prev => Math.max(0, prev - 1));
      setReplyingId(null); setReplyText('');
      showToast('Risposta inviata via email ✓');
    } else showToast(data?.error || 'Errore invio risposta', 'err');
  };

  const deleteAdminFeedback = async (id: string) => {
    if (!confirm('Eliminare questa richiesta?')) return;
    const { ok } = await apiCall(`/admin/feedback/${id}`, { method: 'DELETE' });
    if (ok) setAdminFeedback(prev => prev.filter(f => f.id !== id));
  };

  const sendTestEmail = async () => {
    showToast('Invio email di test...');
    try {
      const { data } = await apiCall('/api/test-email', {
        method: 'POST',
        body: JSON.stringify({
          to: ['lettieriimattia@gmail.com', 'francescofera45@gmail.com', 'beaglelarry0@gmail.com'],
          subject: 'Email Test',
          text: 'Email Test',
        }),
      });
      if (data?.ok) showToast('Email inviata a 3 destinatari');
      else showToast(data?.error || 'Errore configurazione email', 'err');
    } catch (e: any) {
      showToast('Errore di rete: ' + (e?.message || 'sconosciuto'), 'err');
    }
  };

  const handleJoinWarehouse = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!joinCodeInput.trim()) return;
    setIsJoining(true);
    const { ok, data } = await apiCall('/warehouses/join', {
      method: 'POST',
      body: JSON.stringify({ inviteCode: joinCodeInput.trim() }),
    });
    if (ok) {
      setUser(data.user);
      setJoinCodeInput('');
      showToast(`Sei entrato nel team!`);
      await fetchTeam();
    } else {
      showToast(data.error || 'Codice non valido', 'err');
    }
    setIsJoining(false);
  };

  const handleDeleteAccount = async () => {
    setIsDeletingAccount(true);
    const { ok, data } = await apiCall('/auth/delete-account', {
      method: 'DELETE',
      body: JSON.stringify({ password: deletePasswordConfirm }),
    });
    if (ok) {
      setIsAuthenticated(false);
      setUser(null);
    } else {
      showToast(data.error || 'Errore eliminazione account', 'err');
    }
    setIsDeletingAccount(false);
  };

  // Invia un messaggio di aiuto/feedback: arriva all'admin via email
  const sendFeedback = async () => {
    const msg = feedbackMsg.trim();
    if (msg.length < 3) { showToast(t('ts.msgLonger'), 'warn'); return; }
    setFeedbackSending(true);
    const { ok, data } = await apiCall('/api/feedback', {
      method: 'POST',
      body: JSON.stringify({ message: msg, type: feedbackType }),
    });
    setFeedbackSending(false);
    if (ok) {
      setFeedbackMsg('');
      showToast(t('ts.feedbackSent'));
    } else {
      showToast(data.error || 'Invio non riuscito', 'err');
    }
  };

  // Supporto IA: invia il messaggio, l'IA risponde; se non può, crea il ticket per l'operatore.
  const sendSupport = async () => {
    const text = supportInput.trim();
    if (!text || supportLoading) return;
    const next = [...supportMsgs, { role: 'user' as const, content: text }];
    setSupportMsgs(next); setSupportInput(''); setSupportLoading(true);
    try {
      const { ok, data } = await apiCall<any>('/api/support/chat', { method: 'POST', body: JSON.stringify({ messages: next }) });
      if (ok && data?.reply) {
        setSupportMsgs(m => [...m, { role: 'assistant', content: data.reply }]);
        if (data.escalated) setSupportEscalated(true);
      } else {
        setSupportMsgs(m => [...m, { role: 'assistant', content: 'Ops, si è verificato un errore. Riprova tra poco.' }]);
      }
    } catch {
      setSupportMsgs(m => [...m, { role: 'assistant', content: 'Ops, errore di rete. Riprova.' }]);
    } finally { setSupportLoading(false); }
  };

  // ===== NOTIFICHE PUSH =====
  const pushSupported = typeof navigator !== 'undefined' && 'serviceWorker' in navigator && typeof window !== 'undefined' && 'PushManager' in window;

  const enablePush = async () => {
    if (!pushSupported) { showToast(t('ts.pushUnsupported'), 'warn'); return; }
    // Evita attese infinite: ogni passo ha un timeout
    const withTimeout = <T,>(p: Promise<T>, ms: number, label: string): Promise<T> =>
      Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('timeout:' + label)), ms))]);
    setPushBusy(true);
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') { showToast(t('ts.pushDenied'), 'warn'); return; }
      const { ok, data } = await apiCall<any>('/api/push/vapid-public');
      if (!ok || !data?.key) { showToast(t('ts.pushNotReady'), 'err'); return; }
      const reg = await withTimeout(navigator.serviceWorker.ready, 8000, 'sw');
      const existing = await reg.pushManager.getSubscription();
      const sub = existing || await withTimeout(reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(data.key) as BufferSource,
      }), 8000, 'subscribe');
      const res = await apiCall('/api/push/subscribe', { method: 'POST', body: JSON.stringify({ subscription: sub.toJSON() }) });
      if (res.ok) { setPushEnabled(true); localStorage.setItem('pushEnabled', '1'); showToast(t('hdr.pushOn')); }
      else showToast(t('ts.notifSaveError'), 'err');
    } catch (err: any) {
      const msg = String(err?.message || '');
      showToast(msg.startsWith('timeout') ? 'Tempo scaduto: ricarica la pagina (per aggiornare l\'app) e riprova' : 'Errore attivazione notifiche', 'err');
    } finally { setPushBusy(false); }
  };

  const sendTestPush = async () => {
    setPushBusy(true);
    const { ok, data } = await apiCall('/api/push/test', { method: 'POST' });
    setPushBusy(false);
    if (ok) showToast(t('ts.testNotifSent')); else showToast(data?.error || 'Errore invio', 'err');
  };

  const disablePush = async () => {
    setPushBusy(true);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await apiCall('/api/push/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint: sub.endpoint }) });
        await sub.unsubscribe().catch(() => {});
      }
      setPushEnabled(false); localStorage.removeItem('pushEnabled');
      showToast(t('hdr.pushOff'));
    } catch { showToast(t('ts.error'), 'err'); }
    finally { setPushBusy(false); }
  };

  const toggleAdminPanel = async () => {
    if (!adminPanelOpen) {
      setAdminPanelOpen(true);
      if (!adminLoaded) await fetchAdminUsers();
      fetchAdminFeedback();
      // Auto-refresh ogni 5 minuti quando il pannello è aperto
      adminRefreshRef.current = setInterval(() => { fetchAdminUsers(); fetchAdminFeedback(); }, 5 * 60 * 1000);
    } else {
      setAdminPanelOpen(false);
      if (adminRefreshRef.current) { clearInterval(adminRefreshRef.current); adminRefreshRef.current = null; }
    }
  };


  const deleteAdminUser = async (userId: string, userName: string) => {
    if (!confirm(`Eliminare definitivamente l'utente "${userName}" e tutti i suoi dati?`)) return;
    const { ok } = await apiCall(`/admin/users/${userId}`, { method: 'DELETE' });
    if (ok) { setAdminUsers(prev => prev.filter(u => u.id !== userId)); showToast(`Utente ${userName} eliminato`); }
    else showToast(t('ts.deleteError'), 'err');
  };

  // ----- CAMPI DINAMICI CATEGORIA AI -----
  const [customFieldValues, setCustomFieldValues] = useState<Record<string, string>>({});

  const getCategoryConfig = (cat: string) => {
    const w = user?.warehouses?.find(wh => wh.name.replace('Magazzino ', '') === cat);
    if (!w?.aiConfig) return null;
    try { return JSON.parse(w.aiConfig); } catch { return null; }
  };

  const isBuiltinCategory = (cat: string) => ['Scarpe', 'Vestiti', 'Pokemon', 'Orologi'].includes(cat);

  // ----- ADD TYPE PICKER -----
  const [addPickerOpen, setAddPickerOpen] = useState(false);

  // ----- LOTTO -----
  const [lotOpen, setLotOpen] = useState(false);
  const [lotName, setLotName] = useState('');
  const [lotCategory, setLotCategory] = useState('');
  const [lotTotal, setLotTotal] = useState('');
  const [lotPhotos, setLotPhotos] = useState<string[]>([]); // foto del lotto (es. pagina raccoglitore carte)
  const onLotPhotoFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const max = 1100; let { width, height } = img;
        if (width > height && width > max) { height = height * max / width; width = max; }
        else if (height >= width && height > max) { width = width * max / height; height = max; }
        const c = document.createElement('canvas'); c.width = width; c.height = height;
        const ctx = c.getContext('2d'); if (!ctx) return;
        ctx.drawImage(img, 0, 0, width, height);
        setLotPhotos([c.toDataURL('image/jpeg', 0.74)]);
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };
  const [lotQty, setLotQty] = useState('');
  const [lotBrand, setLotBrand] = useState('');
  const [lotNotes, setLotNotes] = useState('');
  const [lotWarehouseId, setLotWarehouseId] = useState(''); // magazzino scelto per il lotto (default: base)
  const [isCreatingLot, setIsCreatingLot] = useState(false);

  // ----- SPEDIZIONE PACKLINK (solo admin) -----
  const SHIPPING_PRESETS = [
    { label: 'Busta',      weight: '0.5', width: '30', height: '5',  length: '22' },
    { label: 'Scatola S',  weight: '1',   width: '30', height: '15', length: '20' },
    { label: 'Scatola M',  weight: '2',   width: '40', height: '20', length: '30' },
    { label: 'Scatola L',  weight: '5',   width: '50', height: '30', length: '40' },
  ];
  const [shippingProduct, setShippingProduct] = useState<any | null>(null);
  const [shippingStep, setShippingStep] = useState<'form' | 'rates' | 'done'>('form');
  const [shippingRates, setShippingRates] = useState<any[]>([]);
  const [selectedRate, setSelectedRate] = useState<any | null>(null);
  const [isLoadingRates, setIsLoadingRates] = useState(false);
  const [isBooking, setIsBooking] = useState(false);
  const [shippingLabel, setShippingLabel] = useState<string | null>(null);
  const [shippingRef, setShippingRef] = useState<string | null>(null);
  const [shipPreset, setShipPreset] = useState(SHIPPING_PRESETS[1]);
  const [shipTo, setShipTo] = useState({ name: '', address: '', city: '', zip: '', phone: '' });
  const [shipFrom, setShipFrom] = useState(() => {
    try { return JSON.parse(localStorage.getItem('hq_ship_from') || '{}'); } catch { return {}; }
  });

  const openShipping = (group: any) => {
    setShippingProduct(group);
    setShippingStep('form');
    setShippingRates([]);
    setSelectedRate(null);
    setShippingLabel(null);
    setShippingRef(null);
    setShipTo({ name: '', address: '', city: '', zip: '', phone: '' });
  };

  const fetchRates = async () => {
    if (!shipTo.zip || shipTo.zip.length < 5) { showToast(t('ts.enterRecipientZip'), 'err'); return; }
    localStorage.setItem('hq_ship_from', JSON.stringify(shipFrom));
    setIsLoadingRates(true);
    const { ok, data } = await apiCall(
      `/shipping/rates?fromZip=${shipFrom.zip || '20100'}&toZip=${shipTo.zip}&weight=${shipPreset.weight}&width=${shipPreset.width}&height=${shipPreset.height}&length=${shipPreset.length}`
    );
    setIsLoadingRates(false);
    if (ok && Array.isArray(data) && data.length > 0) {
      setShippingRates(data);
      setSelectedRate(data[0]);
      setShippingStep('rates');
    } else {
      showToast(data?.error || 'Nessun corriere disponibile per questa tratta', 'err');
    }
  };

  const bookShipment = async () => {
    if (!selectedRate) return;
    setIsBooking(true);
    const { ok, data } = await apiCall('/shipping/book', {
      method: 'POST',
      body: JSON.stringify({
        productId: shippingProduct?.ids?.[0] || null,
        serviceId: selectedRate.id,
        from: { ...shipFrom },
        to: { ...shipTo },
        pkg: { weight: shipPreset.weight, width: shipPreset.width, height: shipPreset.height, length: shipPreset.length },
        content: shippingProduct ? `${fullName(shippingProduct.brand, shippingProduct.name)}` : 'Articolo',
      }),
    });
    setIsBooking(false);
    if (ok) {
      setShippingRef(data.reference);
      setShippingLabel(data.labelUrl);
      setShippingStep('done');
      if (data.labelUrl && !data.demo) {
        window.open(data.labelUrl, '_blank'); // etichetta reale (PDF del corriere)
      } else {
        // Demo: mostra l'etichetta DENTRO l'app (niente nuova finestra che intrappola su mobile)
        openDemoLabel(
          shippingProduct ? `${fullName(shippingProduct.brand, shippingProduct.name)}` : 'Articolo',
          shipFrom?.name || user?.name || 'Venditore',
          shipTo?.name || 'Acquirente',
          data.reference || data.trackingCode || 'HQ-DEMO',
          selectedRate?.carrier || selectedRate?.name || 'Corriere',
        );
      }
      await fetchProducts();
      showToast(data.demo ? 'Etichetta demo generata!' : 'Spedizione creata! Tracking salvato sul prodotto.');
    } else {
      showToast(data?.error || 'Errore prenotazione spedizione', 'err');
    }
  };

  // ----- GENERATORE ANNUNCI -----
  const [listingModalProduct, setListingModalProduct] = useState<any | null>(null);
  const [listingPlatform, setListingPlatform] = useState<'vinted' | 'ebay' | 'depop' | 'wallapop' | 'subito'>('vinted');
  const [listingResult, setListingResult] = useState<any | null>(null);
  const [isGeneratingListing, setIsGeneratingListing] = useState(false);
  const [copiedField, setCopiedField] = useState<string | null>(null);

  const openListingModal = (group: any) => {
    setListingModalProduct(group);
    setListingResult(null);
    setListingPlatform('vinted');
  };

  const generateListingForProduct = async (platform: 'vinted' | 'ebay' | 'depop' | 'wallapop' | 'subito') => {
    if (!listingModalProduct) return;
    setIsGeneratingListing(true);
    setListingResult(null);
    const { ok, data } = await apiCall('/api/ai/generate-listing', {
      method: 'POST',
      body: JSON.stringify({ productId: listingModalProduct.ids[0], platform }),
    });
    setIsGeneratingListing(false);
    if (ok) setListingResult(data);
    else showToast(data?.error || 'Errore generazione annuncio', 'err');
  };

  const copyToClipboard = (text: string, field: string) => {
    navigator.clipboard.writeText(text);
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 2000);
  };

  // ----- NOTE PRODOTTO -----
  const [notesModalProduct, setNotesModalProduct] = useState<Product | null>(null);
  const [notesInput, setNotesInput] = useState('');
  const [isSavingNotes, setIsSavingNotes] = useState(false);

  // ----- TEMPLATE DINAMICO (campi JSONB per categoria) -----
  const [activeTemplate, setActiveTemplate] = useState<{ fields: any[] } | null>(null);
  const [dynamicAttrs, setDynamicAttrs] = useState<Record<string, any>>({});

  // ----- TRACKING -----
  const [trackingModalOpen, setTrackingModalOpen] = useState(false);
  const [trackingProduct, setTrackingProduct] = useState<any>(null);
  const [trackingInput, setTrackingInput] = useState('');
  const [trackingCarrierSel, setTrackingCarrierSel] = useState('Auto');
  const [trackingDetail, setTrackingDetail] = useState<any>(null);
  const [isRefreshingTracking, setIsRefreshingTracking] = useState(false);
  const [isSavingTracking, setIsSavingTracking] = useState(false);
  const [carrierList, setCarrierList] = useState<{key: string; label: string}[]>([]);
  const [isRefreshingAll, setIsRefreshingAll] = useState(false);
  // ----- ACQUISTO IN ARRIVO (crea prodotto IN STOCK + tracking INBOUND dalla pagina Tracking) -----
  const [incomingOpen, setIncomingOpen] = useState(false);
  const [incCategory, setIncCategory] = useState('');
  const [incBrand, setIncBrand] = useState('');
  const [incName, setIncName] = useState('');
  const [incPrice, setIncPrice] = useState('');
  const [incTrackCode, setIncTrackCode] = useState('');
  const [incTrackCarrier, setIncTrackCarrier] = useState('Auto');
  const [incWarehouseId, setIncWarehouseId] = useState(''); // magazzino per il prodotto in arrivo (default: base)
  const [incSaving, setIncSaving] = useState(false);
  
  // ----- DERIVED -----
  // Reparti = SOLO quelli che hanno davvero dei prodotti (niente template "fantasma":
  // i beta tester si lamentavano di reparti mai creati). Nuovi reparti si creano
  // scrivendoli a mano nel form prodotto.
  const userCategories = useMemo(() => {
    const set = new Set<string>();
    for (const p of products) if ((p as any)?.category) set.add((p as any).category);
    return Array.from(set);
  }, [products]);
  // Magazzini (partnership) dell'utente. Il magazzino base è "Il mio magazzino" o il più vecchio top-level.
  const warehouses = user?.warehouses || [];
  const baseWarehouse = warehouses.find(w => !w.parentId && w.name === 'Il mio magazzino')
    || warehouses.find(w => !w.parentId && w.role === 'OWNER')
    || warehouses[0]
    || null;
  // Snapshot delle quote (percentuali soci) di un magazzino, per applicarle ai prodotti
  // creati: usato da prodotto singolo, lotto, import e "in arrivo" così sono coerenti.
  const snapshotSharesFor = (whId?: string | null): { userId: string; name: string; percentage: any }[] | undefined => {
    const team = teamData.find((t: any) => t.warehouseId === (whId || baseWarehouse?.id));
    return team?.members?.length > 0
      ? team.members.map((m: any) => ({ userId: m.userId, name: m.name, percentage: m.percentage }))
      : undefined;
  };
  // Icona di una categoria dal catalogo (emoji del template), se presente.
  const categoryIcon = (name: string) => categories.find(c => c.name === name)?.icon || null;

  // Match tollerante tra la categoria rilevata dall'IA e i reparti esistenti:
  // gestisce maiuscole, accenti, spazi e SINONIMI (es. "Sneakers"/"Calzature" → reparto "Scarpe").
  // Così se un reparto esiste già, il prodotto ci finisce dentro invece di crearne un duplicato.
  const REPARTO_SYNONYMS: Record<string, string> = {
    scarpe: 'scarpe', scarpa: 'scarpe', sneakers: 'scarpe', sneaker: 'scarpe', calzature: 'scarpe', calzatura: 'scarpe', shoes: 'scarpe', shoe: 'scarpe', ginnastica: 'scarpe',
    vestiti: 'vestiti', vestito: 'vestiti', vestiario: 'vestiti', abbigliamento: 'vestiti', apparel: 'vestiti', clothes: 'vestiti', clothing: 'vestiti', felpa: 'vestiti', felpe: 'vestiti', hoodie: 'vestiti', maglia: 'vestiti', maglietta: 'vestiti', magliette: 'vestiti', tshirt: 'vestiti', tee: 'vestiti', pantaloni: 'vestiti', giacca: 'vestiti', giacche: 'vestiti', streetwear: 'vestiti',
    orologi: 'orologi', orologio: 'orologi', watch: 'orologi', watches: 'orologi',
    pokemon: 'pokemon', carte: 'pokemon', carta: 'pokemon', tcg: 'pokemon',
    borse: 'borse', borsa: 'borse', bag: 'borse', bags: 'borse',
    accessori: 'accessori', accessorio: 'accessori', accessories: 'accessori',
  };
  const normCat = (s: string) => (s || '').toLowerCase().trim().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, '').trim();
  const canonGroup = (s: string) => { const n = normCat(s); return REPARTO_SYNONYMS[n] || n; };
  const findMatchingReparto = (detected: string): string | null => {
    const direct = userCategories.find((uc: string) => normCat(uc) === normCat(detected));
    if (direct) return direct;
    const g = canonGroup(detected);
    return userCategories.find((uc: string) => canonGroup(uc) === g) || null;
  };
  // Reparti DUPLICATI (stesso significato, nome diverso: es. Vestiti/Vestiario/Abbigliamento).
  // Ognuno è un gruppo di 2+ nomi che andrebbero uniti in uno solo.
  const dupCategoryGroups = useMemo(() => {
    const byGroup: Record<string, string[]> = {};
    for (const c of userCategories) { const g = canonGroup(c); (byGroup[g] ||= []).push(c); }
    return Object.values(byGroup).filter(arr => arr.length > 1);
  }, [userCategories]);
  const [mergingCat, setMergingCat] = useState(false);
  const [dismissedMerge, setDismissedMerge] = useState(false);
  // Unisce tutti i reparti del gruppo nel nome scelto (riassegna i prodotti sul server).
  const mergeCategoryGroup = async (group: string[], target: string) => {
    setMergingCat(true);
    let moved = 0;
    for (const from of group) {
      if (from === target) continue;
      const { ok, data } = await apiCall<any>('/products/merge-category', { method: 'POST', body: JSON.stringify({ from, to: target }) });
      if (ok) moved += data?.moved || 0;
    }
    await fetchProducts();
    setMergingCat(false);
    showToast(t('cat.merged').replace('{name}', target).replace('{n}', String(moved)), 'ok');
  };
  const userInviteCodes = user?.warehouses?.filter(w => w.role === 'OWNER' && w.inviteCode) || [];
  // Piano dell'utente → gating feature. 'advanced_analytics' è incluso da Pro in su.
  const PLAN_RANK: Record<string, number> = { free: 0, starter: 1, pro: 2, business: 3 };
  const planRank = PLAN_RANK[(user?.plan as string) || 'free'] ?? 0;
  const isAdminUser = isAdminEmail(user?.email);
  const hasAdvancedAnalytics = planRank >= 1 || isAdminUser; // Starter in su (admin sempre)
  const teamFounderName = teamData.length > 0 
    ? teamData[0].members.find((m: any) => m.role === 'OWNER')?.name 
    : null;
  const isFounder = teamFounderName === user?.name;
  
  // ==========================================
  // BOOTSTRAP: tenta auto-login via cookie
  // ==========================================
  useEffect(() => {
    (async () => {
      try {
        const { ok, data, status } = await apiCall<{ user: AppUser }>('/auth/me');
        if (ok && data.user) {
          setUser(data.user);          // aggiorna i dati (piano, reparti…) e la cache
          setIsAuthenticated(true);
        } else if (status === 401 || status === 403) {
          // Sessione davvero scaduta (anche dopo il refresh): torna al login e svuota la cache.
          setUser(null);
          setIsAuthenticated(false);
        }
        // Altri errori (rete/cold start): teniamo l'utente in cache, non sloggare.
      } catch {
        // errore di rete: manteniamo la sessione ottimistica (non sloggare per un timeout)
      } finally {
        setBootLoading(false);
      }
    })();
  }, []);

  // Persisti l'utente in cache così al riavvio l'app parte già loggata (no flicker "primo accesso").
  useEffect(() => {
    try {
      if (user) localStorage.setItem('hq_user', JSON.stringify(user));
      else localStorage.removeItem('hq_user');
    } catch { /* storage pieno/non disponibile: ignora */ }
  }, [user]);
  
  // ==========================================
  // FETCH DATI
  // ==========================================
  const fetchProducts = useCallback(async () => {
    const { ok, data } = await apiCall<Product[]>('/products');
    if (ok && Array.isArray(data)) { setProducts(data); setProductsLoaded(true); }
  }, []);
  
  const fetchTeam = useCallback(async () => {
    const { ok, data } = await apiCall<any[]>('/team');
    if (ok && Array.isArray(data)) setTeamData(data);
  }, []);

  // Catalogo categorie (CategoryTemplate). Seed di sistema lato server al primo GET.
  const fetchCategories = useCallback(async () => {
    const { ok, data } = await apiCall<any[]>('/templates');
    if (ok && Array.isArray(data)) {
      setCategories(data.map((t: any) => ({ name: t.name, icon: t.icon || null })));
    }
  }, []);

  // Costi extra (solo OWNER; per i MEMBER l'endpoint risponde comunque coi loro magazzini-owner o vuoto)
  const fetchExpenses = useCallback(async () => {
    const { ok, data } = await apiCall<any[]>('/analytics/expenses');
    if (ok && Array.isArray(data)) setExpenses(data);
  }, []);

  const addExpense = async () => {
    if (!requireFeatureOrUpgrade('accounting')) return;
    const amt = parseFloat(expAmount);
    const whId = expWarehouse || baseWarehouse?.id;
    if (!whId || !expDesc.trim() || isNaN(amt) || amt <= 0) { showToast(t('ts.enterAmountDesc'), 'err'); return; }
    setIsAddingExp(true);
    const { ok, data } = await apiCall('/analytics/expenses', {
      method: 'POST',
      body: JSON.stringify({ warehouseId: whId, amount: amt, description: expDesc.trim(), category: expCat }),
    });
    setIsAddingExp(false);
    if (ok) { setExpAmount(''); setExpDesc(''); await fetchExpenses(); showToast(t('ts.extraCostAdded')); }
    else showToast(data.error || 'Errore', 'err');
  };

  const deleteExpense = async (id: string) => {
    const { ok } = await apiCall(`/analytics/expenses/${id}`, { method: 'DELETE' });
    if (ok) setExpenses(prev => prev.filter(e => e.id !== id));
  };

  // ----- TASK / NOTE -----
  const fetchTasks = useCallback(async () => {
    const { ok, data } = await apiCall<any[]>('/tasks');
    if (ok && Array.isArray(data)) setTasks(data);
  }, []);
  const addTask = async () => {
    const text = taskInput.trim();
    if (!text) return;
    const remindAt = taskRemind ? new Date(taskRemind).toISOString() : null;
    setTaskSaving(true);
    const { ok, data } = await apiCall<any>('/tasks', { method: 'POST', body: JSON.stringify({ text, remindAt }) });
    setTaskSaving(false);
    if (ok && data?.id) {
      setTaskInput(''); setTaskRemind(''); setTasks(prev => [data, ...prev]);
      // Promemoria impostato ma notifiche spente → chiedi di attivarle.
      if (remindAt && !pushEnabled) setNotifyPrompt(true);
    } else showToast(t('ts.error'), 'err');
  };
  const toggleTask = async (tk: any) => {
    const { ok, data } = await apiCall<any>(`/tasks/${tk.id}`, { method: 'PATCH', body: JSON.stringify({ done: !tk.done }) });
    if (ok && data?.id) setTasks(prev => prev.map(x => x.id === tk.id ? data : x).sort((a: any, b: any) => (a.done ? 1 : 0) - (b.done ? 1 : 0) || new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()));
  };
  // Salva la MODIFICA di una nota (testo + promemoria). Editabile toccando la nota.
  const saveTaskEdit = async (id: string) => {
    const text = editText.trim();
    if (!text) return;
    const remindAt = editRemind ? new Date(editRemind).toISOString() : null;
    const { ok, data } = await apiCall<any>(`/tasks/${id}`, { method: 'PATCH', body: JSON.stringify({ text, remindAt }) });
    if (ok && data?.id) {
      setTasks(prev => prev.map(x => x.id === id ? data : x));
      setEditingTask(null);
      if (remindAt && !pushEnabled) setNotifyPrompt(true);
    } else showToast(t('ts.error'), 'err');
  };
  // Entra in modalità modifica di una nota (precompila testo + promemoria).
  const startEditTask = (tk: any) => {
    setEditingTask(tk.id); setEditText(tk.text || '');
    // datetime-local vuole "YYYY-MM-DDTHH:mm" in ora locale
    setEditRemind(tk.remindAt ? new Date(new Date(tk.remindAt).getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '');
  };
  const deleteTask = async (id: string) => {
    const { ok } = await apiCall(`/tasks/${id}`, { method: 'DELETE' });
    if (ok) setTasks(prev => prev.filter(x => x.id !== id));
  };

  // ----- Mesi STORICI (dati economici di mesi precedenti all'apertura del conto) -----
  const fetchManualMonths = useCallback(async () => {
    const { ok, data } = await apiCall<any[]>('/analytics/manual-months');
    if (ok && Array.isArray(data)) setManualMonths(data);
  }, []);

  const addManualMonth = async () => {
    const rev = parseFloat(mmRevenue) || 0;
    const cst = parseFloat(mmCost) || 0;
    if (rev <= 0 && cst <= 0) { showToast(t('mm.enterData'), 'warn'); return; }
    setIsAddingMM(true);
    const { ok, data } = await apiCall('/analytics/manual-months', {
      method: 'POST',
      body: JSON.stringify({ year: parseInt(mmYear), month: parseInt(mmMonth), revenue: rev, cost: cst }),
    });
    setIsAddingMM(false);
    if (ok) { setMmRevenue(''); setMmCost(''); await fetchManualMonths(); showToast(t('mm.saved')); }
    else showToast(data?.error || 'Errore', 'err');
  };

  const deleteManualMonth = async (id: string) => {
    const { ok } = await apiCall(`/analytics/manual-months/${id}`, { method: 'DELETE' });
    if (ok) setManualMonths(prev => prev.filter(m => m.id !== id));
  };

  // Scarica il CSV per il commercialista (fetch con cookie + refresh, poi blob download).
  const downloadAccountantCsv = async () => {
    if (!requireFeatureOrUpgrade('accounting')) return;
    try {
      let res = await fetch(`${API_URL}/analytics/export.csv`, { credentials: 'include' });
      if (res.status === 401) { await refreshSession(); res = await fetch(`${API_URL}/analytics/export.csv`, { credentials: 'include' }); }
      if (!res.ok) { showToast(t('ts.csvError'), 'err'); return; }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `resellerhq-commercialista-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch { showToast(t('ts.csvError'), 'err'); }
  };

  // ----- MARKETPLACE -----
  const fetchMarket = useCallback(async () => {
    setMarketLoading(true);
    const params = new URLSearchParams();
    if (marketQuery.trim()) params.set('q', marketQuery.trim());
    if (marketCat) params.set('category', marketCat);
    const { ok, data } = await apiCall<any[]>(`/market?${params.toString()}`);
    setMarketLoading(false);
    if (ok && Array.isArray(data)) setMarketItems(data);
  }, [marketQuery, marketCat]);

  const fetchMarketCats = useCallback(async () => {
    const { ok, data } = await apiCall<string[]>('/market/categories');
    if (ok && Array.isArray(data)) setMarketCats(data);
  }, []);

  const openMarketDetail = async (id: string) => {
    const { ok, data } = await apiCall<any>(`/market/${id}`);
    if (ok) setMarketDetail(data);
  };

  // Acquisto con pagamento in-app (Stripe Connect): reindirizza al checkout.
  const payProduct = async (productId: string) => {
    if (!isAuthenticated) { setPublicMarket(false); showToast(t('market.loginToBuy'), 'warn'); return; }
    const { ok, data } = await apiCall<any>(`/market/${productId}/buy`, { method: 'POST', body: JSON.stringify({}) });
    if (ok && data?.url) { window.location.href = data.url; return; }
    if (data?.sellerNotReady) { showToast(t('ts.sellerNotReady'), 'warn'); return; }
    showToast(data?.error || 'Errore pagamento', 'err');
  };

  const contactSeller = async (productId: string, message?: string) => {
    if (!isAuthenticated) { setPublicMarket(false); showToast(t('auth.loginToContact'), 'warn'); return; }
    const { ok, data } = await apiCall<any>(`/market/${productId}/contact`, { method: 'POST', body: JSON.stringify(message ? { message } : {}) });
    if (ok && data?.conversationId) {
      setMarketDetail(null);
      await fetchConversations();
      await openConversation({ id: data.conversationId });
      setCurrentView('chat');
    } else showToast(data?.error || 'Errore', 'err');
  };

  // ----- CHAT -----
  const fetchConversations = useCallback(async () => {
    const { ok, data } = await apiCall<any[]>('/chat/conversations');
    if (ok && Array.isArray(data)) setConversations(data);
  }, []);

  const openConversation = async (convo: any) => {
    // Merge: passando {id} (es. dopo un'azione) non perdiamo i metadati già caricati.
    setActiveConvo((prev: any) => prev && prev.id === convo.id ? { ...prev, ...convo } : convo);
    const { ok, data } = await apiCall<any[]>(`/chat/${convo.id}/messages`);
    if (ok && Array.isArray(data)) setChatMessages(data);
  };

  // Ricarica conversazione attiva: metadati freschi (stato, tracking) + messaggi.
  const reloadConversation = async () => {
    if (!activeConvo) return;
    const { ok, data } = await apiCall<any[]>('/chat/conversations');
    if (ok && Array.isArray(data)) {
      setConversations(data);
      const fresh = data.find((c: any) => c.id === activeConvo.id);
      if (fresh) setActiveConvo((prev: any) => ({ ...prev, ...fresh }));
    }
    const m = await apiCall<any[]>(`/chat/${activeConvo.id}/messages`);
    if (m.ok && Array.isArray(m.data)) setChatMessages(m.data);
  };

  // Blocco link lato client (oltre al backend): i link sono il primo vettore di truffa.
  const CHAT_LINK_RE = /(https?:\/\/|www\.|\b[a-z0-9][a-z0-9-]*\.(com|net|org|it|io|co|me|app|shop|store|xyz|info|eu|de|fr|es|uk|gg|to|link)\b|t\.me\/|wa\.me\/|@[a-z0-9_.]+)/i;
  const sendMessage = async () => {
    const text = chatInput.trim();
    if (!text || !activeConvo) return;
    if (CHAT_LINK_RE.test(text)) { showToast(t('ts.noLinks'), 'err'); return; }
    setChatSending(true);
    const { ok, data } = await apiCall<any>(`/chat/${activeConvo.id}/messages`, { method: 'POST', body: JSON.stringify({ text }) });
    setChatSending(false);
    if (ok && data?.id) { setChatMessages(prev => [...prev, data]); setChatInput(''); }
    else showToast(data?.error || 'Errore invio', 'err');
  };

  // Venditore: completa la vendita e (opzionale) registra la spedizione, dalla chat.
  const confirmShip = async () => {
    if (!activeConvo) return;
    const alreadyPaid = activeConvo.productStatus === 'PAGATO';
    const price = parseFloat(shipForm.price);
    if (!alreadyPaid && !(price > 0)) { showToast(t('ts.enterAgreedPrice'), 'warn'); return; }
    if (alreadyPaid && shipForm.code.trim().length < 4) { showToast(t('ts.enterTracking'), 'warn'); return; }
    if (shipForm.code && CHAT_LINK_RE.test(shipForm.code)) { showToast(t('ts.invalidTracking'), 'err'); return; }
    setShipping(true);
    const { ok, data } = await apiCall<any>(`/chat/${activeConvo.id}/ship`, {
      method: 'POST',
      body: JSON.stringify({ salePrice: price, trackingCode: shipForm.code.trim(), carrier: shipForm.carrier }),
    });
    setShipping(false);
    if (ok && data?.success) {
      setShipForm({ open: false, price: '', code: '', carrier: 'Auto' });
      await reloadConversation();
      await fetchProducts();
      showToast(data.tracked ? 'Venduto e spedizione registrata!' : 'Vendita confermata!', 'ok');
    } else showToast(data?.error || 'Errore', 'err');
  };
  
  const fetchNotifications = useCallback(async () => {
    const { ok, data } = await apiCall<{ notifications: AINotification[]; unreadCount: number }>('/notifications');
    if (ok) {
      setNotifications(data.notifications || []);
      setUnreadCount(data.unreadCount || 0);
    }
  }, []);
  
  const checkStaleProducts = useCallback(async () => {
    const { ok, data } = await apiCall<any>(`/notifications/stale?days=${staleThreshold}`);
    if (ok) setStaleProducts(data.products || []);
  }, [staleThreshold]);
  
  useEffect(() => {
    if (!isAuthenticated) return;
    fetchProducts();
    fetchTeam();
    fetchCategories();
    fetchExpenses();
    fetchManualMonths();
    fetchTasks();
    apiCall<any>('/api/stockx/status').then(({ ok, data }) => { if (ok) setStockxStatus(data); });
    apiCall<any>('/products/auto-publish').then(({ ok, data }) => { if (ok) setAutoPublishOn(!!data?.enabled); });
    fetchNotifications();
    checkStaleProducts();
    refreshMyPlan();
    
    // Polling notifiche: ogni 2 minuti e SOLO quando la scheda è in primo piano.
    // (Prima era ogni 30s sempre: con più utenti teneva sveglio il DB di continuo →
    // ore di calcolo Neon sprecate. Ora in background si ferma e riprende al ritorno.)
    let interval: ReturnType<typeof setInterval> | null = null;
    const startPolling = () => { if (!interval) interval = setInterval(fetchNotifications, 120000); };
    const stopPolling = () => { if (interval) { clearInterval(interval); interval = null; } };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') { fetchNotifications(); startPolling(); }
      else stopPolling();
    };
    if (document.visibilityState === 'visible') startPolling();
    document.addEventListener('visibilitychange', onVisibility);
    // Controllo prodotti fermi ogni ora
    const staleInterval = setInterval(checkStaleProducts, 60 * 60 * 1000);
    return () => { stopPolling(); clearInterval(staleInterval); document.removeEventListener('visibilitychange', onVisibility); };
  }, [isAuthenticated, fetchProducts, fetchTeam, fetchCategories, fetchExpenses, fetchNotifications, checkStaleProducts]);

  // Se Marketplace/Chat sono disattivati, non lasciare l'utente su quelle viste.
  useEffect(() => {
    if (!MARKETPLACE_ENABLED && (currentView === 'market' || currentView === 'chat' || currentView === 'wallet')) {
      setCurrentView('dashboard');
    }
  }, [currentView]);

  // Marketplace: carica vetrina e categorie quando si apre la sezione o cambia la ricerca
  useEffect(() => {
    if (currentView !== 'market') return;
    fetchMarket();
    fetchMarketCats();
  }, [currentView, fetchMarket, fetchMarketCats]);

  // Vetrina pubblica (senza login)
  useEffect(() => {
    if (isAuthenticated || !publicMarket) return;
    fetchMarket();
    fetchMarketCats();
  }, [isAuthenticated, publicMarket, fetchMarket, fetchMarketCats]);

  // Chat: carica conversazioni entrando nella sezione; polling messaggi della chat aperta
  useEffect(() => {
    if (!isAuthenticated) return;
    if (currentView === 'chat') fetchConversations();
    if (currentView === 'settings' || currentView === 'wallet') { refreshConnectStatus(); refreshWallet(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentView, isAuthenticated, fetchConversations]);

  useEffect(() => {
    if (currentView !== 'chat' || !activeConvo) return;
    const iv = setInterval(async () => {
      const { ok, data } = await apiCall<any[]>(`/chat/${activeConvo.id}/messages`);
      if (ok && Array.isArray(data)) setChatMessages(data);
    }, 5000);
    return () => clearInterval(iv);
  }, [currentView, activeConvo]);

  // Admin: badge richieste sempre aggiornato; carica dati quando si entra nella pagina Admin
  useEffect(() => {
    if (!isAuthenticated || !isAdminEmail(user?.email)) return;
    fetchAdminFeedback();
    if (currentView === 'admin' && !adminLoaded) fetchAdminUsers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, currentView, user]);

  // Condividi nell'app: arrivati da uno share (/?share=1), leggi la foto dalla
  // cache (messa lì da sw-share.js), apri il form in Automatico e lancia lo scan.
  useEffect(() => {
    if (!isAuthenticated || !('caches' in window)) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('share') !== '1') return;
    (async () => {
      try {
        const cache = await caches.open('hq-shared');
        const res = await cache.match('/__shared_image');
        if (res) {
          const blob = await res.blob();
          await cache.delete('/__shared_image');
          const file = new File([blob], 'condivisa.jpg', { type: blob.type || 'image/jpeg' });
          const compressed = await compressImage(file, 1024, 0.6);
          // Apri il form in Automatico SENZA fotocamera (la foto ce l'abbiamo già)
          setCategory(AUTO_CATEGORY);
          setDetectedReparto('');
          setShowRepartoGrid(false);
          setScanResult(null);
          setPriceEstimate(null);
          setProductPhotos([compressed]);
          setIsFormOpen(true);
          runAIScan(compressed, AUTO_CATEGORY);
        }
      } catch { /* ignora */ }
      window.history.replaceState({}, '', '/app');
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated]);

  // RETE DI SICUREZZA pagamenti: al ritorno dal checkout (/?upgraded=...&session_id=...)
  // verifichiamo direttamente con Stripe e aggiorniamo il piano, anche se il webhook non scatta.
  useEffect(() => {
    if (!isAuthenticated) return;
    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get('session_id');
    const upgraded = params.get('upgraded');
    const bought = params.get('bought');
    const connect = params.get('connect');
    if (!sessionId && !upgraded && !bought && !connect) return;
    (async () => {
      try {
        if (sessionId && bought) {
          // Acquisto prodotto: rete di sicurezza (evade l'ordine anche senza webhook).
          const { ok, data } = await apiCall<any>('/billing/verify', { method: 'POST', body: JSON.stringify({ sessionId }) });
          if (ok && data?.updated) {
            await fetchProducts(); await fetchConversations();
            showToast(t('ts.purchaseDone'), 'ok');
          } else {
            showToast(t('ts.paymentReceived'), 'ok');
          }
        } else if (sessionId) {
          const { ok, data } = await apiCall<any>('/billing/verify', { method: 'POST', body: JSON.stringify({ sessionId }) });
          if (ok && data?.updated && data?.plan) {
            setUser(u => u ? { ...u, plan: data.plan } : u);
            await refreshMyPlan();
            showToast(t('ts.subActivated'), 'ok');
          } else {
            await refreshMyPlan();
            showToast(t('ts.paymentUpdatingPlan'), 'ok');
          }
        }
        if (connect === 'done') {
          await refreshConnectStatus();
          showToast(t('ts.accountLinked'), 'ok');
        }
      } catch { /* ignora */ }
      window.history.replaceState({}, '', '/app');
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated]);

  // Rileva se le notifiche push sono già attive su questo dispositivo
  useEffect(() => {
    if (!isAuthenticated || !pushSupported) return;
    navigator.serviceWorker.ready
      .then(reg => reg.pushManager.getSubscription())
      .then(sub => { if (sub && Notification.permission === 'granted') setPushEnabled(true); })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated]);

  // Chiudi la tendina notifiche al tap fuori dal riquadro.
  // (Un backdrop in overlay non basta: l'header ha backdrop-blur, che "intrappola"
  //  il position:fixed dentro l'header — quindi usiamo un listener globale + ref.)
  useEffect(() => {
    if (!notifPanelOpen) return;
    const onDown = (e: PointerEvent) => {
      if (notifRef.current && !notifRef.current.contains(e.target as Node)) setNotifPanelOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [notifPanelOpen]);

  // Chiusura UNIVERSALE delle finestre: ESC (desktop) e click FUORI dal riquadro chiudono la
  // modale aperta in cima — esattamente come premere la X. Gli sfondi modali usano "fixed
  // inset-0": se il target del click è proprio lo sfondo (classe inset-0) = click fuori dal box.
  useEffect(() => {
    const stack: Array<[boolean, () => void]> = [
      [!!contactsPage, () => { setContactsPage(null); setContactSearch(''); }],
      [taskPanelOpen, () => setTaskPanelOpen(false)],
      [periodPickerOpen, () => setPeriodPickerOpen(false)],
      [!!swipeDelete, () => setSwipeDelete(null)],
      [!!zoomPhoto, () => setZoomPhoto(null)],
      [!!lotDetail, () => setLotDetail(null)],
      [!!modelDetail, () => setModelDetail(null)],
      [!!marketDetail, () => setMarketDetail(null)],
      [notifPanelOpen, () => setNotifPanelOpen(false)],
      [cmdOpen, () => setCmdOpen(false)],
      [barcodeModalOpen, () => setBarcodeModalOpen(false)],
      [deleteConfirmOpen, () => setDeleteConfirmOpen(false)],
      [bulkDeleteConfirmOpen, () => setBulkDeleteConfirmOpen(false)],
      [planModalOpen, () => setPlanModalOpen(false)],
      [twoFaDisableOpen, () => setTwoFaDisableOpen(false)],
      [twoFaSetupOpen, () => setTwoFaSetupOpen(false)],
      [changePwdOpen, () => setChangePwdOpen(false)],
      [trackingModalOpen, () => setTrackingModalOpen(false)],
      [sourcingOpen, () => setSourcingOpen(false)],
      [showProfitSharesModal, () => setShowProfitSharesModal(false)],
      [bulkSellOpen, () => setBulkSellOpen(false)],
      [sellModalOpen, () => setSellModalOpen(false)],
      [lotOpen, () => setLotOpen(false)],
      [incomingOpen, () => setIncomingOpen(false)],
      [importOpen, () => setImportOpen(false)],
      [isFormOpen, () => setIsFormOpen(false)],
      [editModalOpen, () => setEditModalOpen(false)],
      [notifPrefsOpen, () => setNotifPrefsOpen(false)],
      [teamPanelOpen, () => setTeamPanelOpen(false)],
      [adminPanelOpen, () => setAdminPanelOpen(false)],
      [guideOpen, () => setGuideOpen(false)],
      [supportOpen, () => setSupportOpen(false)],
      [privacyOpen, () => setPrivacyOpen(false)],
    ];
    const closeTop = (): boolean => {
      const top = stack.find(([o]) => o);
      if (top) { top[1](); return true; }
      return false;
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && closeTop()) e.preventDefault(); };
    const onDown = (e: MouseEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && el.classList && el.classList.contains('inset-0')) closeTop();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('mousedown', onDown); };
  }, [contactsPage, taskPanelOpen, periodPickerOpen, swipeDelete, zoomPhoto, lotDetail, modelDetail, marketDetail, notifPanelOpen, cmdOpen, barcodeModalOpen, deleteConfirmOpen, bulkDeleteConfirmOpen, planModalOpen, twoFaDisableOpen, twoFaSetupOpen, changePwdOpen, trackingModalOpen, sourcingOpen, showProfitSharesModal, bulkSellOpen, sellModalOpen, lotOpen, incomingOpen, importOpen, isFormOpen, editModalOpen, notifPrefsOpen, teamPanelOpen, adminPanelOpen, guideOpen, supportOpen, privacyOpen]);

  // Tasti FRECCIA ← → su PC: scorrono i set di 4 mesi del grafico a barre (solo in Analytics).
  useEffect(() => {
    if (currentView !== 'analytics') return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (periodPickerOpen || contactsPage || taskPanelOpen) return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); setReportMonth(({ y, m }) => { const nm = m - 1; return { y: y + Math.floor(nm / 12), m: ((nm % 12) + 12) % 12 }; }); }
      else if (e.key === 'ArrowRight') {
        e.preventDefault();
        const now = new Date();
        setReportMonth(({ y, m }) => {
          if (y === now.getFullYear() && m === now.getMonth()) return { y, m };
          const nm = m + 1; return { y: y + Math.floor(nm / 12), m: ((nm % 12) + 12) % 12 };
        });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [currentView, periodPickerOpen, contactsPage, taskPanelOpen]);

  // BLOCCO SCROLL: quando un modale è aperto, la pagina sotto NON deve muoversi/scrollare.
  useEffect(() => {
    const anyModalOpen = cmdOpen || barcodeModalOpen || deleteConfirmOpen || bulkDeleteConfirmOpen || planModalOpen || twoFaDisableOpen || twoFaSetupOpen || changePwdOpen || trackingModalOpen || sourcingOpen || showProfitSharesModal || bulkSellOpen || sellModalOpen || lotOpen || incomingOpen || importOpen || isFormOpen || editModalOpen || notifPrefsOpen || teamPanelOpen || adminPanelOpen || guideOpen || supportOpen || privacyOpen;
    if (!anyModalOpen) return;
    const prevBody = document.body.style.overflow;
    const prevHtml = document.documentElement.style.overflow;
    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prevBody; document.documentElement.style.overflow = prevHtml; };
  }, [cmdOpen, barcodeModalOpen, deleteConfirmOpen, bulkDeleteConfirmOpen, planModalOpen, twoFaDisableOpen, twoFaSetupOpen, changePwdOpen, trackingModalOpen, sourcingOpen, showProfitSharesModal, bulkSellOpen, sellModalOpen, lotOpen, incomingOpen, importOpen, isFormOpen, editModalOpen, notifPrefsOpen, teamPanelOpen, adminPanelOpen, guideOpen, supportOpen, privacyOpen]);

  useEffect(() => {
    if (userCategories.length > 0 && category === '') setCategory(userCategories[0]);
    // NB: niente reset di `size` qui. `userCategories` è un array ricreato a ogni render,
    // quindi questo effect gira di continuo: forzare la taglia qui la riazzerava a ogni
    // battitura (impossibile modificarla) e cancellava la taglia rilevata dall'IA.
    // Il default di taglia si imposta SOLO quando l'utente sceglie il reparto a mano
    // (vedi defaultSizeForCategory nei bottoni Reparto) e all'apertura del form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category, userCategories]);

  // Carica il template dinamico dal backend quando la categoria cambia nel form
  useEffect(() => {
    if (!category || !isFormOpen) { setActiveTemplate(null); return; }
    setDynamicAttrs({});
    apiCall(`/templates/${encodeURIComponent(category)}`).then(({ ok, data }) => {
      // fields arriva dal DB come STRINGA JSON: va parsato in array, altrimenti
      // DynamicForm fa string.map → crash (schermo nero).
      let fields: any = (data as any)?.fields;
      if (typeof fields === 'string') { try { fields = JSON.parse(fields); } catch { fields = []; } }
      setActiveTemplate(ok && Array.isArray(fields) && fields.length ? { ...(data as any), fields } : null);
    }).catch(() => setActiveTemplate(null));
  }, [category, isFormOpen]);
  
  // Init quote per acquisto condiviso (usa percentuali salvate del team, non divisione uguale)
  useEffect(() => {
    if (isSharedPurchase) {
      const whId = selectedWarehouseId || baseWarehouse?.id;
      const currentTeam = teamData.find(t => t.warehouseId === whId);
      if (currentTeam && currentTeam.members.length > 0) {
        setProductShares(currentTeam.members.map((m: any) => ({
          userId: m.userId, name: m.name, percentage: m.percentage,
        })));
      }
    }
  }, [isSharedPurchase, selectedWarehouseId, baseWarehouse?.id, teamData]);
  
  // Calcolo fees automatico (vendita)
  useEffect(() => {
    if (!sellModalOpen) return;
    const targetPrice = parseFloat(sellPrice) || 0;
    let autoFees = 0;
    if (sellPlatform === 'StockX') autoFees += targetPrice * 0.12;
    if (sellPaymentMethod === 'PayPal Beni e Servizi') autoFees += (targetPrice * 0.034) + 0.35;
    setSellFees(autoFees.toFixed(2));
  }, [sellPrice, sellPlatform, sellPaymentMethod, sellModalOpen]);
  
  // Icone reparto: lucide professionali (scalano col font-size grazie a size="1em").
  // Match per parola chiave sul nome categoria, così funziona anche per reparti custom.
  const getCategoryIcon = (cat: any) => {
    const n = (cat || '').toString().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    const pairs: [string[], any][] = [
      [['scarp', 'sneaker', 'shoe', 'calzatur'], Footprints],
      [['vestit', 'abbigliam', 'maglia', 'felpa', 'hoodie', 'shirt', 'giacc', 'cloth'], Shirt],
      [['orolog', 'watch'], Watch],
      [['pokemon', 'cart', 'card', 'tcg', 'magic', 'yugioh'], Layers],
      [['bors', 'bag', 'pochette', 'zaino', 'tracoll'], ShoppingBag],
      [['gioiell', 'bracc', 'anell', 'collan', 'jewel', 'orecchin'], Gem],
      [['occhial', 'sunglass', 'eyewear', 'glasses'], Glasses],
      [['wallet', 'portafogl', 'portacart'], Wallet],
      [['profum', 'fragran', 'perfume'], SprayCan],
      [['cosmetic', 'makeup', 'beauty', 'trucco', 'skincare'], Palette],
      [['elettron', 'electron', 'tech', 'phone', 'telefon', 'smartphone', 'console'], Smartphone],
      [['vinil', 'disco', 'dischi', 'vinyl', 'record'], Disc3],
      [['collezion', 'funko', 'lego', 'giocattol', 'toy', 'figure'], ToyBrick],
      [['monet', 'coin', 'numismat', 'banconot'], Coins],
      [['fumett', 'libr', 'manga', 'comic', 'book', 'rivist'], BookOpen],
      [['strument', 'chitarr', 'guitar', 'music', 'basso', 'piano'], Guitar],
      [['francoboll', 'stamp', 'filatel'], Stamp],
    ];
    const Icon = pairs.find(([keys]) => keys.some(k => n.includes(k)))?.[1] || Package;
    return <Icon size="1em" className="inline-block align-[-0.125em]" />;
  };
  
  const shoeSizes = Array.from({ length: 25 }, (_, i) => (36 + i * 0.5).toString());
  const clothingSizes = ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL'];
  // Taglia di default suggerita quando si sceglie un reparto a mano (modificabile liberamente).
  const defaultSizeForCategory = (cat: string) => cat === 'Scarpe' ? '42' : cat === 'Vestiti' ? 'M' : '';
  
  // ==========================================
  // CALCOLI FINANZIARI
  // ==========================================
  const getShares = (p: Product) => {
    try {
      return p.customShares && p.customShares !== '[]' ? JSON.parse(p.customShares) : null;
    } catch { return null; }
  };

  // Frazione (0-1) del profitto di un prodotto che spetta A ME (in base alle quote socio).
  const myProfitFactor = (p: Product) => {
    const shares = getShares(p);
    if (shares && shares.length > 0) {
      const myShare = shares.find((s: any) => s.userId === user?.id);
      return (myShare?.percentage || 0) / 100;
    }
    const team = teamData.find((t: any) => t.warehouseId === (p as any).warehouseId);
    const myMember = team?.members?.find((m: any) => m.userId === user?.id);
    const myPct = myMember?.percentage ?? (team?.members?.length > 0 ? 100 / team.members.length : 100);
    return myPct / 100;
  };

  // Frazione (0-1) del COSTO d'acquisto di un prodotto che ho pagato IO.
  // Se il team ha quote costi separate (costPercentage) le uso; altrimenti i costi
  // seguono le quote utili (myProfitFactor, che rispetta anche le customShares).
  const myCostFactor = (p: Product) => {
    const team = teamData.find((t: any) => t.warehouseId === (p as any).warehouseId);
    if (team?.members?.length) {
      const hasCostSplit = team.members.some((m: any) => Number(m.costPercentage) > 0);
      if (hasCostSplit) {
        const myMember = team.members.find((m: any) => m.userId === user?.id);
        return (Number(myMember?.costPercentage) || 0) / 100;
      }
    }
    return myProfitFactor(p);
  };

  const activeProducts = filterCat === 'all' ? products : products.filter(p => p.category === filterCat);
  // Valore stock PERSONALE: capitale immobilizzato in base alla mia quota di costo.
  const stockValore = activeProducts.filter(p => p.status === 'IN STOCK').reduce((acc, p) => acc + p.purchasePrice * myCostFactor(p), 0);
  // Sell panic: valore di LIQUIDAZIONE dello stock = quanto incasseresti vendendo tutto SUBITO.
  // Per pezzo usa il prezzo di svendita se impostato, altrimenti il valore di mercato, altrimenti il costo.
  const liquidationValue = activeProducts.filter(p => p.status === 'IN STOCK')
    .reduce((acc, p) => acc + ((p.quickSalePrice ?? (p as any).marketPriceAvg ?? p.purchasePrice) || 0), 0);
  const soldItemsTotal = activeProducts.filter(p => p.status === 'VENDUTO');
  const ricaviTotali = soldItemsTotal.reduce((acc, p) => acc + (p.salePrice || 0), 0);
  const costoVenduto = soldItemsTotal.reduce((acc, p) => acc + p.purchasePrice, 0);
  const totalFees = soldItemsTotal.reduce((acc, p) => acc + (p.fees || 0), 0);
  const profittoNetto = ricaviTotali - costoVenduto - totalFees;
  const roi = costoVenduto > 0 ? ((profittoNetto / costoVenduto) * 100).toFixed(2) : '0.00';
  
  const globalSold = products.filter(p => p.status === 'VENDUTO');
  const globalProfitto = globalSold.reduce((acc, p) => acc + ((p.salePrice || 0) - p.purchasePrice - (p.fees || 0)), 0);

  // Rientra nel PERIODO scelto in "Personal"? (7g / 30g / anno corrente / sempre / intervallo custom)
  // DEVE stare PRIMA di periodProfit/trendData che la usano (const in TDZ → altrimenti crash/schermo nero).
  const inPersonalPeriod = (dateString?: string) => {
    if (!dateString) return true;
    const d = new Date(dateString);
    const now = new Date();
    const days = (now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24);
    switch (personalPeriod.kind) {
      case '7d': return days <= 7;
      case '30d': return days <= 30;
      case 'year': return d.getFullYear() === now.getFullYear();
      case 'custom': {
        const from = personalPeriod.from ? new Date(personalPeriod.from) : null;
        const to = personalPeriod.to ? new Date(personalPeriod.to + 'T23:59:59') : null;
        if (from && d < from) return false;
        if (to && d > to) return false;
        return true;
      }
      default: return true; // 'all'
    }
  };

  const mioProfitto = globalSold.reduce((acc, p) => {
    const profit = (p.salePrice || 0) - p.purchasePrice - (p.fees || 0);
    return acc + (profit * myProfitFactor(p));
  }, 0);
  // Profitto personale limitato al PERIODO scelto in "Personal" (per il valore mostrato nella card).
  const periodProfit = globalSold.filter(p => inPersonalPeriod(p.soldAt || p.createdAt)).reduce((acc, p) => {
    const profit = (p.salePrice || 0) - p.purchasePrice - (p.fees || 0);
    return acc + (profit * myProfitFactor(p));
  }, 0);
  // Etichetta del periodo attivo (mostrata su Personal e sul grafico).
  const periodLabel = personalPeriod.kind === '7d' ? t('per.7d')
    : personalPeriod.kind === '30d' ? t('per.30d')
    : personalPeriod.kind === 'year' ? t('per.year')
    : personalPeriod.kind === 'custom' ? `${personalPeriod.from || '…'} → ${personalPeriod.to || '…'}`
    : t('per.all');

  const sociProfits: Record<string, { name: string, profit: number }> = {};
  globalSold.forEach(p => {
    const profit = (p.salePrice || 0) - p.purchasePrice - (p.fees || 0);
    const shares = getShares(p);
    if (shares && shares.length > 0) {
      shares.forEach((s: any) => {
        if (!sociProfits[s.userId]) sociProfits[s.userId] = { name: s.name, profit: 0 };
        sociProfits[s.userId].profit += (profit * (s.percentage / 100));
      });
    } else {
      const team = teamData.find((t: any) => t.warehouseId === p.warehouseId) || teamData.find((t: any) => t.warehouseName.replace('Magazzino ', '') === p.category);
      if (team) {
        (team.members || []).forEach((m: any) => {
          if (!sociProfits[m.userId]) sociProfits[m.userId] = { name: m.name, profit: 0 };
          sociProfits[m.userId].profit += (profit * (m.percentage / 100));
        });
      }
    }
  });
  
  // Grafico dashboard: SOLO LA MIA QUOTA (come la card Personale), su TUTTE le vendite del periodo
  // (NON filtrate per la categoria del Magazzino). Ricavi e Profitto sono moltiplicati per la mia
  // frazione (myProfitFactor): se sono da solo = 100% (nessun cambio); in team = solo la mia parte.
  const trendData = useMemo(() => (Object.values(
    products.filter(p => p.status === 'VENDUTO' && inPersonalPeriod(p.soldAt || p.createdAt)).reduce((acc, p) => {
      const day = p.soldAt ? new Date(p.soldAt) : new Date();
      const dateKey = day.toLocaleDateString('it-IT', { day: '2-digit', month: 'short' });
      if (!acc[dateKey]) acc[dateKey] = { date: dateKey, Ricavi: 0, Profitto: 0, _ts: new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime() };
      const mine = myProfitFactor(p);
      acc[dateKey].Ricavi += (p.salePrice || 0) * mine;
      acc[dateKey].Profitto += ((p.salePrice || 0) - p.purchasePrice - (p.fees || 0)) * mine;
      return acc;
    }, {} as Record<string, any>)
  ) as any[]).sort((a, b) => a._ts - b._ts)   // ordine CRONOLOGICO sull'asse X
  // eslint-disable-next-line react-hooks/exhaustive-deps
  , [products, personalPeriod]);

  const platformBreakdown = useMemo(() => {
    const bd: Record<string, { revenue: number; profit: number; count: number; fees: number }> = {};
    globalSold.forEach(p => {
      const plat = p.platform || 'Privato';
      if (!bd[plat]) bd[plat] = { revenue: 0, profit: 0, count: 0, fees: 0 };
      bd[plat].revenue += (p.salePrice || 0);
      bd[plat].profit += ((p.salePrice || 0) - p.purchasePrice - (p.fees || 0));
      bd[plat].count += 1;
      bd[plat].fees += (p.fees || 0);
    });
    return Object.entries(bd).sort((a, b) => b[1].revenue - a[1].revenue);
  }, [globalSold]);

  // ---- SMART METRICS ----
  const inStockItems = products.filter(p => p.status === 'IN STOCK');
  const staleCount = inStockItems.filter(p => p.createdAt && Math.floor((Date.now() - new Date(p.createdAt).getTime()) / 86400000) > 30).length;
  const week7d = new Date(Date.now() - 7 * 86400000);
  const weekSales = globalSold.filter(p => p.soldAt && new Date(p.soldAt) >= week7d);
  // Profitto settimanale PERSONALE (la mia quota, non il totale del team).
  const weekProfit = weekSales.reduce((a, p) => a + (((p.salePrice || 0) - p.purchasePrice - (p.fees || 0)) * myProfitFactor(p)), 0);
  const totalItems = products.length;
  const sellThroughRate = totalItems > 0 ? Math.round((globalSold.length / totalItems) * 100) : 0;
  const avgMarginPct = globalSold.length > 0
    ? globalSold.reduce((a, p) => {
        const m = p.purchasePrice > 0 ? ((p.salePrice || 0) - p.purchasePrice - (p.fees || 0)) / p.purchasePrice * 100 : 0;
        return a + m;
      }, 0) / globalSold.length
    : 0;
  const avgDaysToSell = globalSold.filter(p => p.createdAt && p.soldAt).length > 0
    ? globalSold.filter(p => p.createdAt && p.soldAt).reduce((a, p) => {
        return a + Math.floor((new Date(p.soldAt!).getTime() - new Date(p.createdAt!).getTime()) / 86400000);
      }, 0) / globalSold.filter(p => p.createdAt && p.soldAt).length
    : 0;
  const bestCategoryEntry = userCategories.map(cat => {
    const sold = globalSold.filter(p => p.category === cat);
    const profit = sold.reduce((a, p) => a + ((p.salePrice || 0) - p.purchasePrice - (p.fees || 0)), 0);
    return { cat, profit, count: sold.length };
  }).sort((a, b) => b.profit - a.profit)[0];

  const searchedProducts = activeProducts.filter(p => {
    const search = searchTerm.toLowerCase();
    return (p.name && p.name.toLowerCase().includes(search)) || (p.brand && p.brand.toLowerCase().includes(search));
  });

  const groupedInStockArray = useMemo(() => {
    const base = searchedProducts.filter(p => {
      if (p.status !== 'IN STOCK') return false;
      if (filterCondition !== 'all' && p.condition !== filterCondition) return false;
      const minP = parseFloat(filterPriceMin); const maxP = parseFloat(filterPriceMax);
      if (!isNaN(minP) && p.purchasePrice < minP) return false;
      if (!isNaN(maxP) && p.purchasePrice > maxP) return false;
      if (staleOnly && !(p.createdAt && Math.floor((Date.now() - new Date(p.createdAt).getTime()) / 86400000) > 30)) return false;
      return true;
    });
    const grouped = Object.values(base.reduce((acc, p) => {
      const cat = p.category || 'Scarpe';
      // LOTTO = UNA card "prodotto" (che è il lotto): tutti i pezzi con lo stesso lotName
      // collassano in un'unica card; cliccandola si entra nel sotto-inventario del lotto.
      if ((p as any).lotName) {
        const key = `lot:${(p as any).lotName}`;
        if (!acc[key]) acc[key] = {
          ...p, category: cat, isLot: true, name: (p as any).lotName, brand: t('lot.lot'),
          quantity: 0, ids: [], purchasePrice: 0, oldestDate: p.createdAt,
        };
        acc[key].quantity += 1;
        acc[key].ids.push(p.id);
        acc[key].purchasePrice += (p.purchasePrice || 0); // costo TOTALE del lotto
        if (p.createdAt && (!acc[key].oldestDate || p.createdAt < acc[key].oldestDate)) acc[key].oldestDate = p.createdAt;
        return acc;
      }
      // Prodotti normali: stesso nome/taglia/condizione + STESSO COSTO + stesso venditore + STESSO
      // FORNITORE = una riga. Così se Marco e Luca ti danno la STESSA taglia restano DISTINTI
      // (vedi da chi arriva ogni paia), non fusi sotto l'ultimo nome/data.
      const seller = `${(p as any).userId || ''}|${(p as any).consignmentName || ''}`;
      const supKey = ((p as any).supplier || '').trim().toLowerCase();
      const key = `${cat}-${p.brand.toLowerCase()}-${p.name.toLowerCase()}-${p.size}-${p.condition}-${p.purchasePrice}-${seller}-${supKey}`;
      if (!acc[key]) acc[key] = {
        ...p, category: cat, quantity: 0, ids: [], oldestDate: p.createdAt,
      };
      acc[key].quantity += 1;
      acc[key].ids.push(p.id);
      if (p.createdAt && (!acc[key].oldestDate || p.createdAt < acc[key].oldestDate)) {
        acc[key].oldestDate = p.createdAt;
      }
      return acc;
    }, {} as Record<string, any>));

    // COLLASSA per MODELLO: scarpe uguali in UNA card; dentro, la suddivisione per TAGLIA.
    // Chiave "morbida": normalizzo brand+nome (minuscole, tolgo punteggiatura, parole di rumore
    // tipo "retro", e brand ripetuti tipo "Jordan Jordan") così varianti di battitura della STESSA
    // scarpa si uniscono. NON includo la condizione: DS/usato dello stesso modello stanno insieme
    // (la condizione la vedi sulla riga della taglia). Taglia unica → card normale. Lotti a sé.
    const NOISE = new Set(['retro', 'og', 'wmns', 'gs', 'td', 'ps', 'sneaker', 'sneakers', 'shoes', 'scarpe', 'low', 'mid', 'high']);
    const modelKeyOf = (g: any) => {
      const words = `${g.brand || ''} ${g.name || ''}`.toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(w => w && !NOISE.has(w));
      const dedup: string[] = [];
      for (const w of words) if (dedup[dedup.length - 1] !== w) dedup.push(w); // "jordan jordan" → "jordan"
      return `${g.category}|${dedup.join(' ')}`;
    };
    const modelMap: Record<string, any[]> = {};
    for (const g of grouped as any[]) {
      if (g.isLot) continue;
      const mk = modelKeyOf(g);
      (modelMap[mk] = modelMap[mk] || []).push(g);
    }
    const cards: any[] = [];
    const seen = new Set<string>();
    for (const g of grouped as any[]) {
      if (g.isLot) { cards.push(g); continue; }
      const mk = modelKeyOf(g);
      if (seen.has(mk)) continue;
      seen.add(mk);
      const groups = modelMap[mk];
      if (groups.length === 1) { cards.push(groups[0]); continue; } // una sola taglia → card normale
      let quantity = 0; const ids: string[] = []; let oldestDate = groups[0].oldestDate;
      const sizes = groups
        .map(gr => { quantity += gr.quantity; ids.push(...gr.ids); if (gr.oldestDate && (!oldestDate || gr.oldestDate < oldestDate)) oldestDate = gr.oldestDate; return { size: gr.size, quantity: gr.quantity, purchasePrice: gr.purchasePrice, condition: gr.condition, supplier: (gr.supplier || '').trim(), date: gr.oldestDate || gr.createdAt, group: gr }; })
        .sort((a, b) => (parseFloat(a.size) || 999) - (parseFloat(b.size) || 999) || String(a.size).localeCompare(String(b.size)) || String(a.supplier).localeCompare(String(b.supplier)));
      const sizeCount = new Set(sizes.map(s => s.size)).size; // taglie DISTINTE (43 di Marco + 43 di Luca = 1 taglia, 2 righe)
      cards.push({ ...groups[0], isModel: true, size: '', sizes, sizeCount, quantity, ids, oldestDate });
    }

    return cards.sort((a: any, b: any) => {
      let av: any, bv: any;
      if (sortField === 'price') { av = a.purchasePrice; bv = b.purchasePrice; }
      else if (sortField === 'name') { av = `${fullName(a.brand, a.name)}`; bv = `${fullName(b.brand, b.name)}`; }
      else { av = a.oldestDate || a.createdAt || ''; bv = b.oldestDate || b.createdAt || ''; }
      if (sortDir === 'asc') return av > bv ? 1 : -1;
      return av < bv ? 1 : -1;
    });
  }, [searchedProducts, filterCondition, filterPriceMin, filterPriceMax, sortField, sortDir, staleOnly, lang]);

  // Sottotitolo di una card MODELLO: "N taglie · M pezzi", oppure "Taglia 43 · M pezzi" quando è
  // un'unica taglia con più fornitori (es. la 43 di Marco + la 43 di Luca).
  const modelSub = (g: any) => (g.sizeCount ?? g.sizes?.length ?? 0) === 1
    ? `${t('form.size')} ${g.sizes[0].size} · ${g.quantity} ${t('mag.pieces')}`
    : `${g.sizeCount ?? g.sizes.length} ${t('mag.sizesWord')} · ${g.quantity} ${t('mag.pieces')}`;

  // Aggregati del mese per le BOLLE (memoizzati): così cliccare una bolla NON ricalcola i filtri
  // pesanti — la nuova sotto-bolla appare all'istante.
  const bubbleMonth = useMemo(() => {
    const inM = (d: any) => { const x = new Date(d); return x.getFullYear() === reportMonth.y && x.getMonth() === reportMonth.m; };
    const sold = products.filter((p: any) => p.status === 'VENDUTO' && p.soldAt && inM(p.soldAt));
    const bought = products.filter((p: any) => p.createdAt && inM(p.createdAt));
    const ricavi = sold.reduce((a: number, p: any) => a + (p.salePrice || 0), 0);
    const merce = sold.reduce((a: number, p: any) => a + (p.purchasePrice || 0), 0);
    const feeTot = sold.reduce((a: number, p: any) => a + (p.fees || 0), 0);
    const speseM = expenses.filter((e: any) => inM(e.date)).reduce((a: number, e: any) => a + (e.amount || 0), 0);
    return { sold, bought, ricavi, merce, feeTot, speseM, uscite: merce + feeTot + speseM, investiti: bought.reduce((a: number, p: any) => a + (p.purchasePrice || 0), 0) };
  }, [products, reportMonth, expenses]);

  // Serie ULTIMI 6 MESI (fino al mese selezionato) per il grafico a BARRE SOVRAPPOSTE.
  const barMonths = useMemo(() => {
    const arr: { y: number; m: number; label: string; ricavi: number; uscite: number; investiti: number }[] = [];
    // 4 mesi per vista (barre grosse e leggibili) → si scorre coi tasti freccia/‹›.
    for (let i = 3; i >= 0; i--) {
      const raw = reportMonth.m - i;
      const y = reportMonth.y + Math.floor(raw / 12);
      const m = ((raw % 12) + 12) % 12;
      const inM = (d: any) => { const x = new Date(d); return x.getFullYear() === y && x.getMonth() === m; };
      const sold = products.filter((p: any) => p.status === 'VENDUTO' && p.soldAt && inM(p.soldAt));
      const bought = products.filter((p: any) => p.createdAt && inM(p.createdAt));
      const ricavi = sold.reduce((a: number, p: any) => a + (p.salePrice || 0), 0);
      const uscite = sold.reduce((a: number, p: any) => a + (p.purchasePrice || 0) + (p.fees || 0), 0) + expenses.filter((e: any) => inM(e.date)).reduce((a: number, e: any) => a + (e.amount || 0), 0);
      const investiti = bought.reduce((a: number, p: any) => a + (p.purchasePrice || 0), 0);
      arr.push({ y, m, label: new Date(y, m, 1).toLocaleDateString(dateLocale, { month: 'short' }), ricavi, uscite, investiti });
    }
    return arr;
  }, [products, expenses, reportMonth, dateLocale]);

  // Venduti: SOLO gli articoli realmente venduti (i PAGATI in attesa stanno in "Da spedire").
  const groupedSoldArray = Object.values(searchedProducts.filter(p => p.status === 'VENDUTO').reduce((acc, p) => {
    const cat = p.category || 'Scarpe';
    const plat = p.platform || 'Privato';
    const key = `${cat}-${p.brand.toLowerCase()}-${p.name.toLowerCase()}-${p.size}-${p.salePrice}-${plat}`;
    if (!acc[key]) acc[key] = { ...p, category: cat, platform: plat, quantity: 0, totalRevenue: 0, totalProfit: 0, totalFees: 0, ids: [], sales: [] };
    // tieni la data di vendita PIÙ RECENTE del gruppo (per ordinare i venduti)
    if (p.soldAt && (!acc[key].soldAt || new Date(p.soldAt) > new Date(acc[key].soldAt))) acc[key].soldAt = p.soldAt;
    acc[key].quantity += 1;
    acc[key].ids.push(p.id);
    // Ogni singola vendita del gruppo (per la tendina compratori + reso del pezzo GIUSTO):
    // stesso paio/prezzo può essere venduto a persone diverse o in date diverse.
    acc[key].sales.push({ id: p.id, customer: (p.customer || '').trim() || null, soldAt: p.soldAt || null, salePrice: p.salePrice || 0, fees: p.fees || 0, purchasePrice: p.purchasePrice });
    acc[key].totalRevenue += (p.salePrice || 0);
    acc[key].totalFees += (p.fees || 0);
    acc[key].totalProfit += ((p.salePrice || 0) - p.purchasePrice - (p.fees || 0));
    return acc;
  }, {} as Record<string, any>))
    // VENDITA PIÙ RECENTE IN CIMA (idea utente)
    .sort((a: any, b: any) => new Date(b.soldAt || b.createdAt || 0).getTime() - new Date(a.soldAt || a.createdAt || 0).getTime());

  // Da spedire: pagati in-app (PAGATO) + quelli marcati a mano (venduti altrove, toShip).
  const toShipItems = products.filter((p: any) =>
    p.status === 'PAGATO' || (p.toShip && p.status === 'IN STOCK')
  );

  // Carica lo stato Face ID quando si è loggati (per il toggle in Impostazioni).
  useEffect(() => {
    if (!isAuthenticated) { setFaceIdOn(false); return; }
    apiCall<any>('/auth/webauthn/status').then(({ ok, data }) => { if (ok) setFaceIdOn(!!data?.enabled); }).catch(() => {});
  }, [isAuthenticated]);

  // Catalogo "che scorre" in dashboard: carica i popolari una volta.
  useEffect(() => {
    if (!isAuthenticated) return;
    apiCall<any[]>('/api/catalog/popular?type=').then(({ ok, data }) => {
      if (ok && Array.isArray(data)) setDashPopular(data.filter((x: any) => x.image).slice(0, 20));
    }).catch(() => {});
  }, [isAuthenticated]);

  // Onboarding: messaggio di benvenuto una tantum al primo accesso.
  useEffect(() => {
    if (!isAuthenticated) return;
    try {
      if (!localStorage.getItem('hq_welcomed')) {
        localStorage.setItem('hq_welcomed', '1');
        setTimeout(() => showToast('👋 Benvenuto in HQVault! Aggiungi un prodotto col + verde in basso, o chiedi a HQ nella chat. Buon resell!', 'ok'), 1400);
      }
    } catch { /* storage non disponibile */ }
  }, [isAuthenticated]);

  // ==========================================
  // HANDLERS AUTH
  // ==========================================
  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    setAuthPasswordErrors([]);
    
    setAuthLoading(true);
    try {
      const endpoint = authMode === 'login' ? '/auth/login' : '/auth/register';
      const body: any = authMode === 'login'
        ? { email: authEmail, password: authPassword, twoFactorCode: require2FA ? twoFactorCode : undefined }
        : {
            email: authEmail, password: authPassword, name: authName,
            categories: regType === 'new_team' ? regCategories : undefined,
            joinCode: regType === 'join_team' ? joinCode : undefined,
            marketingConsent,
          };
      
      const { ok, data } = await apiCall(endpoint, { method: 'POST', body: JSON.stringify(body) });
      
      if (!ok) {
        if (data.details && Array.isArray(data.details)) {
          setAuthPasswordErrors(data.details);
        }
        setAuthError(data.error || 'Errore sconosciuto');
        return;
      }
      
      if (data.require2FA) {
        setRequire2FA(true);
        return;
      }

      // Email da verificare (registrazione o login di account non ancora verificato)
      if (data.needsVerification) {
        setNeedVerifyEmail(data.email || authEmail);
        setVerifyCode('');
        showToast(data.message || 'Ti abbiamo inviato un codice via email');
        return;
      }

      if (authMode === 'register') {
        showToast(data.message || 'Registrazione completata!');
        setAuthMode('login');
        setAuthPassword('');
      } else {
        setUser(data.user);
        setIsAuthenticated(true);
        setRequire2FA(false);
        setTwoFactorCode('');
      }
    } catch (err) {
      setAuthError('Errore di connessione con il server.');
    } finally {
      setAuthLoading(false);
    }
  };
  
  // ===== FACE ID (Passkey / WebAuthn) =====
  const loginFaceId = async () => {
    const email = authEmail.trim().toLowerCase();
    if (!email) { setAuthError('Inserisci prima la tua email'); return; }
    setAuthError(null);
    try {
      const { ok, data: options } = await apiCall<any>('/auth/webauthn/auth/options', { method: 'POST', body: JSON.stringify({ email }) });
      if (!ok) { setAuthError(options?.error || 'Face ID non configurato per questo account'); return; }
      const authResp = await startAuthentication({ optionsJSON: options });
      const { ok: ok2, data } = await apiCall<any>('/auth/webauthn/auth/verify', { method: 'POST', body: JSON.stringify({ email, response: authResp }) });
      if (ok2 && data?.user) { setUser(data.user); setIsAuthenticated(true); }
      else setAuthError(data?.error || 'Login Face ID fallito');
    } catch (e: any) {
      setAuthError(e?.name === 'NotAllowedError' ? 'Face ID annullato' : 'Face ID non disponibile su questo dispositivo');
    }
  };
  const enableFaceId = async () => {
    try {
      const { ok, data: options } = await apiCall<any>('/auth/webauthn/register/options', { method: 'POST' });
      if (!ok) { showToast('Errore Face ID', 'err'); return; }
      const regResp = await startRegistration({ optionsJSON: options });
      const { ok: ok2 } = await apiCall<any>('/auth/webauthn/register/verify', { method: 'POST', body: JSON.stringify({ response: regResp }) });
      if (ok2) { setFaceIdOn(true); showToast('✅ Face ID attivato! Da ora puoi entrare col volto.', 'ok'); }
      else showToast('Verifica Face ID fallita', 'err');
    } catch (e: any) {
      showToast(e?.name === 'NotAllowedError' ? 'Face ID annullato' : 'Face ID non disponibile su questo dispositivo', 'warn');
    }
  };
  const disableFaceId = async () => {
    await apiCall('/auth/webauthn', { method: 'DELETE' });
    setFaceIdOn(false);
    showToast('Face ID disattivato', 'ok');
  };

  const submitVerify = async () => {
    if (verifyCode.trim().length < 4) { setAuthError('Inserisci il codice ricevuto via email'); return; }
    setAuthLoading(true); setAuthError(null);
    const { ok, data } = await apiCall<any>('/auth/verify-email', { method: 'POST', body: JSON.stringify({ email: needVerifyEmail, code: verifyCode.trim() }) });
    setAuthLoading(false);
    if (ok && data?.user) {
      setUser(data.user); setIsAuthenticated(true);
      setNeedVerifyEmail(null); setVerifyCode(''); setAuthPassword('');
    } else setAuthError(data?.error || 'Codice non valido');
  };
  const resendVerify = async () => {
    await apiCall('/auth/resend-verification', { method: 'POST', body: JSON.stringify({ email: needVerifyEmail }) });
    showToast(t('ts.codeResent'));
  };

  const handleLogout = async () => {
    await apiCall('/auth/logout', { method: 'POST' });
    setUser(null);
    setIsAuthenticated(false);
    setProducts([]);
    setTeamData([]);
    setNotifications([]);
  };
  
  // ==========================================
  // 2FA SETUP
  // ==========================================
  const handle2FASetupStart = async () => {
    setTwoFaLoading(true);
    const { ok, data } = await apiCall('/auth/2fa/setup', { method: 'POST' });
    setTwoFaLoading(false);
    if (ok) {
      setTwoFaQR(data.qrCode);
      setTwoFaSetupOpen(true);
    } else showToast(data.error || 'Errore setup 2FA', 'err');
  };
  
  const handle2FAVerify = async () => {
    setTwoFaLoading(true);
    const { ok, data } = await apiCall('/auth/2fa/verify', { 
      method: 'POST', body: JSON.stringify({ code: twoFaCode }) 
    });
    setTwoFaLoading(false);
    if (ok) {
      setTwoFaBackupCodes(data.backupCodes);
      setUser(u => u ? { ...u, twoFactorEnabled: true } : u);
    } else showToast(data.error || 'Codice non valido', 'err');
  };
  
  const handle2FADisable = () => {
    setTwoFaDisablePwd('');
    setTwoFaDisableOtp('');
    setTwoFaDisableOpen(true);
  };

  const confirm2FADisable = async () => {
    const { ok, data } = await apiCall('/auth/2fa/disable', {
      method: 'POST', body: JSON.stringify({ password: twoFaDisablePwd, code: twoFaDisableOtp }),
    });
    if (ok) {
      showToast('2FA disabilitato con successo');
      setUser(u => u ? { ...u, twoFactorEnabled: false } : u);
      setTwoFaDisableOpen(false);
    } else {
      showToast(data.error || 'Errore', 'err');
    }
  };
  
  // ==========================================
  // CATEGORIE / WAREHOUSE
  // ==========================================
  // Crea un sotto-magazzino dentro un reparto (parentId = id del reparto)
  const createSubWarehouse = async (parentId: string, name: string) => {
    if (!name.trim()) return;
    setCreatingSub(true);
    const { ok, data } = await apiCall('/warehouses/sub', {
      method: 'POST', body: JSON.stringify({ parentId, name: name.trim() }),
    });
    setCreatingSub(false);
    if (ok) {
      setUser(data.user);
      fetchTeam();
      setNewSubName(''); setAddingSubTo('');
      showToast(`Sotto-magazzino "${name.trim()}" creato`);
    } else showToast(data.error || 'Errore creazione sotto-magazzino', 'err');
  };

  // Crea una nuova CATEGORIA (trasversale) generando i campi con l'IA.
  const handleAddCategory = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newCatName) return;
    setIsAddingCat(true);
    showToast(t('ts.creatingCategory'), 'ok');
    const { ok, data } = await apiCall('/templates/auto', {
      method: 'POST', body: JSON.stringify({ name: newCatName.trim() })
    });
    setIsAddingCat(false);
    if (ok) {
      await fetchCategories();
      const created = data?.name || newCatName.trim();
      setNewCatName('');
      showToast(`Categoria "${created}" aggiunta!`);
    } else showToast(data.error || 'Errore', 'err');
  };

  // Apre il form "Aggiungi prodotto" in modalità FOTO-FIRST: parte in Automatico,
  // l'utente mette solo la foto e i campi/tabelle compaiono dopo il riconoscimento.
  const openAddForm = () => {
    setCategory(AUTO_CATEGORY);
    setDetectedReparto('');
    setShowRepartoGrid(false);
    setProductPhotos([]);
    setScanResult(null);
    setScanMarket(null);
    setPriceEstimate(null);
    // Reset COMPLETO dei campi: evita che restino dati del prodotto precedente
    // (bug: scansionavi un nuovo paio e teneva brand/nome di quello prima).
    setBrand(''); setName(''); setSku(''); setPrice(''); setQuantity('1'); setProductSupplier('');
    setCondition('DS'); setSize(''); // taglia vuota: la riempie l'IA o l'utente (niente piu' "42" imposto)
    setPokeName(''); setPokeGraded('No'); setPokeGrade(''); setCardNumber(''); setCardGame('pokemon');
    setWatchBrand(''); setWatchModel(''); setWatchCase(''); setWatchStrap(''); setWatchMaterial('');
    setDynamicAttrs({});
    setIsSharedPurchase(false); setProductShares([]);
    setSelectedWarehouseId('');
    setIsConsignment(false); setConsignmentName(''); setConsignmentPercent('');
    setIsFormOpen(true);
    // NB: la fotocamera NON si apre più in automatico col "+". Si apre solo quando l'utente
    // tocca "Scatta" dentro il form (addCameraInputRef). Così il "+" porta alla pagina prodotto.
  };

  // Aggiungi dal CATALOGO con DETTAGLI (idea utente): apre il form già precompilato
  // (categoria, marca, nome, SKU, foto ufficiale) così aggiungi taglia/costo/condizione.
  const addFromCatalogDetailed = (item: any) => {
    setDetectedReparto(''); setShowRepartoGrid(false);
    setScanResult(null); setScanMarket(null); setPriceEstimate(null);
    setCategory(item.category || AUTO_CATEGORY);
    setBrand(item.brand || ''); setName(stripDupBrand(item.brand, item.name)); setSku(item.sku || '');
    setPrice(''); setQuantity('1'); setCondition('DS'); setSize('');
    setPokeName(''); setPokeGraded('No'); setPokeGrade(''); setCardNumber(''); setCardGame('pokemon');
    setWatchBrand(''); setWatchModel(''); setWatchCase(''); setWatchStrap(''); setWatchMaterial('');
    setDynamicAttrs({});
    setIsSharedPurchase(false); setProductShares([]);
    setSelectedWarehouseId('');
    setIsConsignment(false); setConsignmentName(''); setConsignmentPercent('');
    setProductPhotos(item.image ? [item.image] : []); // foto ufficiale (URL StockX/Pokémon)
    setCurrentView('magazzino'); // torna al magazzino: il form si apre sopra
    setIsFormOpen(true);
  };

  // Avvia l'OAuth StockX: chiede al server l'URL e ci reindirizza (login una tantum).
  const connectStockX = async () => {
    setStockxConnecting(true);
    const { ok, data } = await apiCall<any>('/api/stockx/connect');
    if (ok && data?.url) {
      window.location.href = data.url;
    } else {
      setStockxConnecting(false);
      showToast(data?.error || 'StockX non configurato', 'err');
    }
  };

  // Applica la categoria scritta a mano: crea se non esiste, altrimenti seleziona.
  const useManualCategory = async () => {
    const v = formCatInput.trim();
    if (!v || isAddingCat) return;
    const created = await createRepartoFromDetected(v);
    if (created) { setSize(defaultSizeForCategory(created)); setFormCatInput(''); setShowRepartoGrid(false); }
  };

  // ===== BARCODE: scansiona + cerca prodotto =====
  const stopBarcodeScan = () => {
    if (barcodeLoopRef.current) { cancelAnimationFrame(barcodeLoopRef.current); barcodeLoopRef.current = null; }
    barcodeStreamRef.current?.getTracks().forEach(t => t.stop());
    barcodeStreamRef.current = null;
  };

  // Dal codice letto: salva il barcode negli attributi e prova a riconoscere il prodotto.
  const lookupBarcode = async (rawCode: string) => {
    const code = (rawCode || '').trim();
    if (!code) return;
    setDynamicAttrs(prev => ({ ...prev, barcode: code }));
    setBarcodeBusy(true);
    const { ok, data } = await apiCall<any>('/api/ai/barcode-lookup', {
      method: 'POST', body: JSON.stringify({ barcode: code }),
    });
    setBarcodeBusy(false);
    if (ok && data?.found) {
      if (data.brand) setBrand(data.brand);
      if (data.name) setName(data.name);
      if (data.value) setScanMarket({ value: data.value, reliable: true, source: 'StockX' });
      showToast(`Trovato: ${[data.brand, data.name].filter(Boolean).join(' ') || code}`);
    } else {
      showToast(t('ts.barcodeSaved'), 'warn');
    }
  };

  const onBarcodeFound = async (code: string) => {
    stopBarcodeScan();
    setBarcodeModalOpen(false);
    await lookupBarcode(code);
  };

  const openBarcodeScanner = () => {
    setBarcodeManual('');
    setBarcodeSupported(typeof (window as any).BarcodeDetector !== 'undefined');
    setBarcodeModalOpen(true);
  };

  // Avvia/ferma la fotocamera + il loop di rilevamento quando il modale è aperto.
  useEffect(() => {
    if (!barcodeModalOpen) { stopBarcodeScan(); return; }
    const BarcodeDetectorCtor = (window as any).BarcodeDetector;
    if (!BarcodeDetectorCtor) { setBarcodeSupported(false); return; }
    let cancelled = false;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        if (cancelled) { stream.getTracks().forEach(t => t.stop()); return; }
        barcodeStreamRef.current = stream;
        const video = barcodeVideoRef.current;
        if (video) { video.srcObject = stream; await video.play().catch(() => {}); }
        const detector = new BarcodeDetectorCtor({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'qr_code'] });
        const tick = async () => {
          if (cancelled || !barcodeStreamRef.current || !barcodeVideoRef.current) return;
          try {
            const codes = await detector.detect(barcodeVideoRef.current);
            if (codes && codes.length && codes[0].rawValue) { onBarcodeFound(codes[0].rawValue); return; }
          } catch { /* frame non leggibile, continua */ }
          barcodeLoopRef.current = requestAnimationFrame(tick);
        };
        barcodeLoopRef.current = requestAnimationFrame(tick);
      } catch {
        if (!cancelled) setBarcodeSupported(false);
      }
    })();
    return () => { cancelled = true; stopBarcodeScan(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [barcodeModalOpen]);

  // Crea un nuovo MAGAZZINO (partnership a nome libero). I soci entrano col codice invito.
  const handleAddWarehouse = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!requireFeatureOrUpgrade('partners')) return;
    const nm = newWarehouseName.trim();
    if (!nm) return;
    setIsAddingWarehouse(true);
    const { ok, data } = await apiCall('/warehouses', {
      method: 'POST', body: JSON.stringify({ name: nm })
    });
    setIsAddingWarehouse(false);
    if (ok) {
      setUser(data.user);
      setNewWarehouseName('');
      fetchTeam();
      showToast(`Magazzino "${nm}" creato!`);
    } else showToast(data.error || 'Errore', 'err');
  };

  // Crea al volo la CATEGORIA rilevata dall'IA (modalità Automatica) e la seleziona.
  // Restituisce il nome della categoria creata (o null), così il salvataggio può usarlo subito.
  const createRepartoFromDetected = async (rawName: string): Promise<string | null> => {
    const nm = (rawName || '').trim();
    if (!nm || isAddingCat) return null;
    setIsAddingCat(true);
    showToast(`Creo la categoria "${nm}" con IA…`, 'ok');
    const { ok, data } = await apiCall('/templates/auto', {
      method: 'POST', body: JSON.stringify({ name: nm })
    });
    setIsAddingCat(false);
    if (ok) {
      await fetchCategories();
      const created = data?.name || nm;
      setCategory(created);   // seleziona la nuova categoria
      setDetectedReparto('');
      showToast(`Categoria "${created}" creata e selezionata`);
      return created;
    }
    showToast(data.error || 'Errore creazione categoria', 'err');
    return null;
  };

  // ==========================================
  // PIANI & STRUMENTI PRO
  // ==========================================
  const refreshMyPlan = async () => {
    const me = await apiCall<any>('/api/plans/me');
    if (me.ok) { setMyPlan(me.data.plan); setMyFeatures(me.data.features || []); }
  };
  // Abbonamento Stripe: avvia il checkout e reindirizza alla pagina di pagamento.
  const subscribeToPlan = async (planId: string) => {
    const { ok, data } = await apiCall<any>('/billing/checkout', { method: 'POST', body: JSON.stringify({ planId }) });
    if (ok && data?.url) window.location.href = data.url;
    else showToast(data?.error || 'Pagamenti non ancora attivi', 'err');
  };
  // Portale Stripe per gestire/disdire l'abbonamento.
  const manageBilling = async () => {
    const { ok, data } = await apiCall<any>('/billing/portal', { method: 'POST', body: JSON.stringify({}) });
    if (ok && data?.url) window.location.href = data.url;
    else showToast(data?.error || 'Nessun abbonamento attivo', 'err');
  };
  // Stripe Connect: stato del conto venditore + avvio onboarding.
  const refreshConnectStatus = async () => {
    const { ok, data } = await apiCall<any>('/billing/connect/status');
    if (ok) setConnectStatus(data);
  };
  const connectStripe = async () => {
    setConnecting(true);
    const { ok, data } = await apiCall<any>('/billing/connect/onboard', { method: 'POST', body: JSON.stringify({}) });
    setConnecting(false);
    if (ok && data?.url) window.location.href = data.url;
    else showToast(data?.error || 'Pagamenti non ancora attivi', 'err');
  };
  // Portafoglio: saldo + riscossione (onboarding minimo solo al primo prelievo).
  const refreshWallet = async () => {
    const { ok, data } = await apiCall<any>('/billing/payout/balance');
    if (ok) setWallet(data);
  };
  const withdrawFunds = async () => {
    setWithdrawing(true);
    const { ok, data } = await apiCall<any>('/billing/payout/withdraw', { method: 'POST', body: JSON.stringify({}) });
    setWithdrawing(false);
    if (ok && data?.needsOnboarding && data?.url) { window.location.href = data.url; return; }
    if (ok && data?.withdrawn != null) { showToast(`Riscossione avviata: ${data.withdrawn.toFixed(2)}€ in arrivo sul tuo conto`, 'ok'); await refreshWallet(); return; }
    showToast(data?.error || 'Errore riscossione', 'err');
  };
  // Offerte: il compratore propone un prezzo, il venditore accetta/rifiuta.
  const [chatOffer, setChatOffer] = useState<{ open: boolean; amount: string }>({ open: false, amount: '' });
  const makeOffer = () => {
    if (!activeConvo) return;
    setChatOffer({ open: true, amount: activeConvo.price != null ? String(activeConvo.price) : '' });
  };
  const submitChatOffer = async () => {
    if (!activeConvo) return;
    const amount = parseFloat((chatOffer.amount || '').replace(',', '.'));
    if (!(amount > 0)) { showToast(t('ts.invalidAmount'), 'warn'); return; }
    const { ok, data } = await apiCall<any>(`/chat/${activeConvo.id}/offer`, { method: 'POST', body: JSON.stringify({ amount }) });
    if (ok && data?.id) { setChatOffer({ open: false, amount: '' }); await reloadConversation(); }
    else showToast(data?.error || 'Errore offerta', 'err');
  };
  // ---- Conferma / prompt IN-APP (sostituiscono i brutti popup del browser) ----
  const [confirmState, setConfirmState] = useState<{ title: string; message: string; confirmLabel: string; danger: boolean } | null>(null);
  const confirmResolver = useRef<((v: boolean) => void) | null>(null);
  const askConfirm = (opts: { title: string; message: string; confirmLabel?: string; danger?: boolean }) =>
    new Promise<boolean>(resolve => {
      confirmResolver.current = resolve;
      setConfirmState({ title: opts.title, message: opts.message, confirmLabel: opts.confirmLabel || 'Conferma', danger: !!opts.danger });
    });
  const closeConfirm = (v: boolean) => { setConfirmState(null); confirmResolver.current?.(v); confirmResolver.current = null; };

  const [promptState, setPromptState] = useState<{ title: string; message: string; placeholder: string; value: string } | null>(null);
  const promptResolver = useRef<((v: string | null) => void) | null>(null);
  const askPrompt = (opts: { title: string; message?: string; placeholder?: string; initial?: string }) =>
    new Promise<string | null>(resolve => {
      promptResolver.current = resolve;
      setPromptState({ title: opts.title, message: opts.message || '', placeholder: opts.placeholder || '', value: opts.initial || '' });
    });
  const closePrompt = (v: string | null) => { setPromptState(null); promptResolver.current?.(v); promptResolver.current = null; };

  const respondOffer = async (msgId: string, action: 'accept' | 'decline') => {
    if (!activeConvo) return;
    const { ok, data } = await apiCall<any>(`/chat/${activeConvo.id}/offer/${msgId}/${action}`, { method: 'POST', body: JSON.stringify({}) });
    if (ok && data?.success) { await reloadConversation(); showToast(action === 'accept' ? 'Offerta accettata' : 'Offerta rifiutata', 'ok'); }
    else showToast(data?.error || 'Errore', 'err');
  };
  // Mostra l'etichetta dimostrativa DENTRO l'app (su telefono una nuova finestra intrappola l'utente).
  const openDemoLabel = (productName: string, sender: string, recipient: string, code: string, carrier: string) => {
    setLabelData({ productName: productName || 'Articolo', sender: sender || 'Venditore', recipient: recipient || 'Acquirente', code, carrier: carrier || 'Test Express' });
  };
  // Riapre l'etichetta GIÀ creata e salvata sul prodotto (non ne genera un'altra).
  const viewSavedLabel = (p: any) => {
    let snap: any = null;
    try { snap = p.shippingLabel ? JSON.parse(p.shippingLabel) : null; } catch {}
    if (snap?.labelUrl) { window.open(snap.labelUrl, '_blank'); return; } // etichetta reale (PDF corriere)
    if (snap) {
      openDemoLabel(`${fullName(p.brand, p.name)}`, snap.from?.name || user?.name || 'Venditore', snap.to?.name || 'Acquirente', snap.trackingCode || p.trackingCode, snap.carrier || p.trackingCarrier || 'Corriere');
      return;
    }
    // Nessuno snapshot ma c'è un tracking: ricostruisci la stessa etichetta dai dati salvati.
    openDemoLabel(`${fullName(p.brand, p.name)}`, user?.name || 'Venditore', 'Acquirente', p.trackingCode, p.trackingCarrier || 'Corriere');
  };
  // Apre la pagina pubblica di tracciamento del corriere (azione di sistema, non un link in chat).
  const trackShipment = (code: string) => {
    if (!code) return;
    window.open(`https://t.17track.net/it#nums=${encodeURIComponent(code)}`, '_blank');
  };
  // TEST: genera etichetta + tracking finti e spedisce l'articolo pagato (per provare il flusso).
  const shipTestLabel = async () => {
    if (!activeConvo) return;
    const code = 'TEST' + Date.now().toString().slice(-9);
    setShipping(true);
    const { ok, data } = await apiCall<any>(`/chat/${activeConvo.id}/ship`, {
      method: 'POST', body: JSON.stringify({ trackingCode: code, carrier: 'Test' }),
    });
    setShipping(false);
    if (!(ok && data?.success)) { showToast(data?.error || 'Errore', 'err'); return; }
    setShipForm(f => ({ ...f, open: false }));
    await reloadConversation();
    openDemoLabel(activeConvo.productName, user?.name || 'Venditore', activeConvo.otherName, code, 'Test Express');
    showToast(t('ts.testLabelGenerated'), 'ok');
  };
  // Compratore: conferma di aver ricevuto il pacco → sblocca il pagamento al venditore.
  const confirmDelivery = async () => {
    if (!activeConvo) return;
    if (!(await askConfirm({ title: 'Conferma consegna', message: 'Confermi di aver ricevuto l\'articolo come descritto? Il pagamento verrà sbloccato per il venditore.', confirmLabel: 'Confermo' }))) return;
    const { ok, data } = await apiCall<any>(`/chat/${activeConvo.id}/confirm-delivery`, { method: 'POST', body: JSON.stringify({}) });
    if (ok && data?.success) { await reloadConversation(); showToast(t('ts.deliveryConfirmed'), 'ok'); }
    else showToast(data?.error || 'Errore', 'err');
  };

  // ---- Contestazioni / resi ----
  const [disputeForm, setDisputeForm] = useState<{ open: boolean; reason: string; note: string; photos: string[] }>({ open: false, reason: 'NOT_AS_DESCRIBED', note: '', photos: [] });
  const [disputeInfo, setDisputeInfo] = useState<any>(null); // dettaglio disputa per venditore/admin
  const [disputeSaving, setDisputeSaving] = useState(false);
  const DISPUTE_REASONS_FE: { v: string; l: string }[] = [
    { v: 'NOT_AS_DESCRIBED', l: t('dispute.rNotAsDescribed') },
    { v: 'COUNTERFEIT', l: t('dispute.rCounterfeit') },
    { v: 'DAMAGED', l: t('dispute.rDamaged') },
    { v: 'NOT_ARRIVED', l: t('dispute.rNotArrived') },
    { v: 'WRONG_ITEM', l: t('dispute.rWrongItem') },
  ];
  const reasonLabelFE = (r?: string) => DISPUTE_REASONS_FE.find(x => x.v === r)?.l || t('chat.problem');

  // Compratore: invia la contestazione
  const submitDispute = async () => {
    if (!activeConvo) return;
    setDisputeSaving(true);
    const { ok, data } = await apiCall<any>(`/chat/${activeConvo.id}/dispute`, {
      method: 'POST', body: JSON.stringify({ reason: disputeForm.reason, note: disputeForm.note.trim(), photos: disputeForm.photos }),
    });
    setDisputeSaving(false);
    if (ok && data?.success) {
      setDisputeForm({ open: false, reason: 'NOT_AS_DESCRIBED', note: '', photos: [] });
      await reloadConversation();
      showToast(t('ts.disputeSent'), 'ok');
    } else showToast(data?.error || 'Errore', 'err');
  };

  // Carica il dettaglio disputa (per il banner venditore)
  const loadDispute = async () => {
    if (!activeConvo) { setDisputeInfo(null); return; }
    const { ok, data } = await apiCall<any>(`/chat/${activeConvo.id}/dispute`);
    setDisputeInfo(ok && data?.open ? data : null);
  };

  // Venditore: risponde alla contestazione (refund / partial / contest)
  const respondDispute = async (action: 'refund' | 'partial' | 'contest') => {
    if (!activeConvo) return;
    let body: any = { action };
    if (action === 'refund' && !(await askConfirm({ title: 'Rimborso totale', message: 'Confermi il rimborso TOTALE al compratore? L\'articolo tornerà invenduto nel tuo magazzino.', confirmLabel: 'Rimborsa tutto', danger: true }))) return;
    if (action === 'partial') {
      const raw = await askPrompt({ title: 'Rimborso parziale', message: 'Quanto vuoi rimborsare al compratore? (€)', placeholder: 'es. 30' });
      if (raw == null) return;
      const amount = Math.round((parseFloat((raw || '').replace(',', '.')) || 0) * 100) / 100;
      if (!(amount > 0)) { showToast(t('ts.invalidAmount'), 'warn'); return; }
      body.amount = amount;
    }
    if (action === 'contest' && !(await askConfirm({ title: 'Contesta', message: 'Contestare apre una mediazione con l\'assistenza HQVault. Procedere?', confirmLabel: 'Contesta' }))) return;
    setDisputeSaving(true);
    const { ok, data } = await apiCall<any>(`/chat/${activeConvo.id}/dispute/respond`, { method: 'POST', body: JSON.stringify(body) });
    setDisputeSaving(false);
    if (ok && data?.success) { setDisputeInfo(null); await reloadConversation(); showToast(t('ts.done'), 'ok'); }
    else showToast(data?.error || 'Errore', 'err');
  };

  // Carica/azzera il dettaglio disputa quando cambia conversazione o stato.
  useEffect(() => {
    if (currentView !== 'chat' || !activeConvo?.disputeStatus) { setDisputeInfo(null); return; }
    loadDispute();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentView, activeConvo?.id, activeConvo?.disputeStatus]);
  const openPlanModal = async (_tab: 'plans' | 'repricing' | 'offer' | 'channels' = 'plans') => {
    setPlanModalOpen(true);
    // Per ora la modale mostra solo "Piani" (gli strumenti Pro sono temporaneamente nascosti).
    setProTab('plans');
    const cat = await apiCall<any>('/api/plans');
    if (cat.ok) setPlanCatalog(cat.data.plans || []);
    refreshMyPlan();
  };
  // Apre l'assistente trattative già puntato su un prodotto (dalla card)
  const openOfferFor = (g: any) => {
    setOfferProductId(g.ids?.[0] || g.id || '');
    setOfferAmount(''); setOfferResult(null);
    openPlanModal('offer');
  };
  // Apre il tracker multi-canale già puntato su un prodotto (dalla card)
  const openChannelsFor = (g: any) => {
    setChProductId(g.ids?.[0] || g.id || '');
    let existing: string[] = [];
    try { existing = (g.salesChannels ? JSON.parse(g.salesChannels) : []).map((c: any) => c.platform); } catch {}
    setChSelected(existing);
    openPlanModal('channels');
  };
  // Solo admin: cambia il piano di un utente (qui lo usa su se stesso per testare)
  const setUserPlan = async (userId: string, plan: string) => {
    const { ok, data } = await apiCall(`/admin/users/${userId}/plan`, {
      method: 'POST', body: JSON.stringify({ plan }),
    });
    if (ok) {
      showToast(`Piano impostato: ${plan}`);
      if (adminLoaded) fetchAdminUsers();
      refreshMyPlan();
    } else showToast(data?.error || 'Errore cambio piano', 'err');
  };
  const loadRepricing = async () => {
    setRepricingLoading(true); setRepricingList(null);
    const { ok, data } = await apiCall<any>('/api/pro/repricing?days=30');
    setRepricingLoading(false);
    if (ok) setRepricingList(data.products || []);
    else showToast(data?.error || 'Non disponibile nel tuo piano', 'err');
  };
  const runOffer = async () => {
    if (!offerProductId || !offerAmount) { showToast(t('ts.chooseProductOffer'), 'warn'); return; }
    setOfferLoading(true); setOfferResult(null);
    const { ok, data } = await apiCall<any>('/api/pro/offer', {
      method: 'POST',
      body: JSON.stringify({ productId: offerProductId, offer: parseFloat(offerAmount), minMarginPct: parseFloat(offerMargin) || 20 }),
    });
    setOfferLoading(false);
    if (ok) setOfferResult(data);
    else showToast(data?.error || 'Non disponibile nel tuo piano', 'err');
  };
  const saveChannels = async () => {
    if (!chProductId) { showToast(t('ts.chooseProduct'), 'warn'); return; }
    setChSaving(true);
    const channels = chSelected.map(p => ({ platform: p, status: 'listed' }));
    const { ok, data } = await apiCall<any>(`/api/pro/channels/${chProductId}`, {
      method: 'PUT', body: JSON.stringify({ channels }),
    });
    setChSaving(false);
    if (ok) showToast(t('ts.channelsSaved'));
    else showToast(data?.error || 'Non disponibile nel tuo piano', 'err');
  };
  // Schermata "bloccato": mostra il piano minimo che include la feature
  const proLocked = (feature: string) => {
    const req = planCatalog.find((p: any) => (p.features || []).includes(feature));
    return (
      <div className="text-center py-8 px-4">
        <Lock size={28} className="mx-auto text-[var(--text-faint)] mb-3" />
        <p className="text-sm font-bold">Funzione del piano {req?.name || 'superiore'}</p>
        <p className="text-xs text-[var(--text-soft)] mt-1">Disponibile da {req ? `${req.name} (${req.priceMonthly}€/mese)` : 'un piano superiore'}.</p>
        <button onClick={() => setProTab('plans')} className="mt-4 px-4 py-2 rounded-xl text-xs font-bold bg-[#8397aa] hover:bg-[#9fb0bd] text-white">Vedi i piani</button>
      </div>
    );
  };

  // ==========================================
  // TEAM QUOTE
  // ==========================================
  const updateMemberPercentage = (warehouseId: string, membershipId: string, newPct: string, field: 'percentage' | 'costPercentage' = 'percentage') => {
    setTeamData(prev => prev.map(team => {
      if (team.warehouseId === warehouseId) {
        return { ...team, members: team.members.map((m: any) =>
          m.membershipId === membershipId ? { ...m, [field]: newPct } : m
        ) };
      }
      return team;
    }));
  };

  const savePercentages = async (warehouseId: string, members: any[]) => {
    const total = members.reduce((s, m) => s + (Number(m.percentage) || 0), 0);
    if (Math.round(total) !== 100) {
      showToast(t('ts.profitShares100'), 'err');
      return;
    }
    // I costi sono opzionali: se qualcuno li ha impostati, devono sommare a 100%.
    const costTotal = members.reduce((s, m) => s + (Number(m.costPercentage) || 0), 0);
    if (costTotal > 0 && Math.round(costTotal) !== 100) {
      showToast(t('ts.costShares100'), 'err');
      return;
    }
    setIsSavingTeam(true);
    const { ok, data } = await apiCall('/team/percentage', {
      method: 'PUT',
      body: JSON.stringify({
        warehouseId,
        updates: members.map(m => ({
          userId: m.userId, membershipId: m.membershipId,
          percentage: Number(m.percentage),
          costPercentage: Number(m.costPercentage) || 0,
        })),
      }),
    });
    setIsSavingTeam(false);
    if (ok) {
      showToast(t('ts.sharesSaved'));
      fetchTeam();
    } else showToast(data.error || 'Errore', 'err');
  };
  
  // ==========================================
  // FOTO & IA — multi-photo (1-5)
  // ==========================================
  const applyAIScanResult = async (data: any, cat: string, signal?: AbortSignal) => {
    if (signal?.aborted) return; // foto rimossa durante lo scan → non applicare
    const scan = data.scan;
    setScanResult(scan);
    setScanMarket(null);
    setScanStockxMatch(null);
    if (!scan) return;
    const d = scan.details || {};

    // Modalità automatica: la categoria effettiva la decide l'IA (scan.detectedCategory).
    // Se coincide con un reparto esistente, lo seleziono; altrimenti lo CREO da solo
    // (niente click): il reparto rilevato viene generato e selezionato in automatico.
    let effCat = cat;
    if (!cat || cat === AUTO_CATEGORY) {
      effCat = scan.detectedCategory || 'Generico';
      // Match tollerante: se un reparto compatibile esiste già (anche sinonimo), ci finisce dentro
      const match = findMatchingReparto(String(effCat));
      if (match) {
        setCategory(match);
        effCat = match;
      } else {
        // Auto-creazione del reparto rilevato dall'IA (elimina il click manuale)
        const created = await createRepartoFromDetected(String(effCat));
        if (created) effCat = created;
        else setDetectedReparto(String(effCat)); // fallback solo se la creazione fallisce
      }
    }

    // Riempi i campi disponibili anche con confidence MEDIA/BASSA: meglio un brand
    // pre-compilato da correggere che un form vuoto.
    // Se l'IA non dà un modello preciso (prompt: meglio null che inventare), uso come
    // nome il tipo/colorway rilevato → il campo nome non resta mai vuoto (sbloccca il salvataggio).
    const fallbackName = (scan.model || d.type || d.colorway || '').toString();
    // SKU / style code letto dalla scatola (es. DV1748-100): utile per match esatto e marketplace
    const detectedSku = (d.sku || d.styleCode || d.style || d.styleId || d.articleNumber || '').toString().trim();
    if (detectedSku) setSku(detectedSku);
    if (effCat === 'Pokemon') {
      if (scan.model) setPokeName(scan.model);
      // Numero/set/gioco rilevati dall'IA (per la valutazione carta esatta).
      setCardNumber((d.cardNumber || d.number || d.collectorNumber || '').toString());
      setCardGame((d.game || 'pokemon').toString().toLowerCase());
    } else if (effCat === 'Scarpe') {
      if (scan.brand) setBrand(scan.brand);
      if (fallbackName) setName(fallbackName);
      // Taglia rilevata dall'etichetta/scatola
      if (d.size) setSize(d.size.toString());
    } else if (effCat === 'Vestiti') {
      if (scan.brand) setBrand(scan.brand);
      if (fallbackName) setName(fallbackName);
      if (d.size) setSize(d.size.toString());
    } else if (effCat === 'Orologi') {
      if (scan.brand) setWatchBrand(scan.brand);
      if (scan.model || d.type) setWatchModel((scan.model || d.type).toString());
      if (d.caseSize) setWatchCase(d.caseSize.toString().replace(/[^\d.]/g, ''));
      if (d.bracelet) setWatchStrap(d.bracelet);
      if (d.caseMaterial) setWatchMaterial(d.caseMaterial);
    } else {
      // Categoria personalizzata: riempi brand/model se presenti
      if (scan.brand) setBrand(scan.brand);
      if (fallbackName) setName(fallbackName);
    }

    // Valutazione GIÀ allegata dallo scan (orologi/borse via Apify): usala direttamente,
    // così NON facciamo una seconda ricerca Apify (il tetto mensile è prezioso).
    if (d.marketValue != null) {
      setScanMarket({ value: d.marketValue, currency: 'EUR', source: d.marketSource || 'Valutazione di mercato', reliable: true, sample: 1 });
    } else {
    // === Valutazione UNIFICATA (il server instrada per categoria: carte→catalogo,
    // vinili→Discogs, resto→eBay indicativo). Non blocca: gira in background. ===
    const valName = (effCat === 'Pokemon' ? (d.name || scan.model) : (scan.model || fallbackName)) || '';
    if (valName.toString().length >= 2 || scan.brand) {
      apiCall<any>('/api/ai/value', {
        method: 'POST',
        signal,
        body: JSON.stringify({
          category: effCat,
          game: effCat === 'Pokemon' ? (d.game || 'pokemon') : undefined,
          brand: scan.brand || undefined,
          name: valName.toString() || undefined,
          size: (d.size || '').toString() || undefined,
          number: (d.cardNumber || d.number || '').toString() || undefined,
          setName: (d.setName || d.set || '').toString() || undefined,
          condition: condition || undefined,
          sku: detectedSku || undefined,
        }),
      }).then(r => { if (r.ok && !signal?.aborted) setScanMarket(r.data); }).catch(() => {});
    }
    }

    // === Conferma visiva StockX: SOLO per categorie che StockX copre davvero (scarpe/streetwear/
    // elettronica/generico). NON per carte, LEGO, orologi, borse, vinili: hanno la LORO fonte
    // (Cardmarket, BrickLink, Chrono24, Vestiaire, Discogs) e StockX darebbe un match SBAGLIATO. ===
    const stockxUsefulCat = !/pokemon|cart|\bcard\b|tcg|lego|minifig|orolog|watch|bors|\bbag\b|vinil/i.test(effCat);
    const matchQuery = [scan.brand, scan.model || fallbackName].filter(Boolean).join(' ').trim();
    if (stockxUsefulCat && matchQuery.length >= 2) {
      apiCall<any>('/api/ai/stockx-match', {
        method: 'POST',
        signal,
        body: JSON.stringify({ query: matchQuery, size: (d.size || '').toString() || undefined, category: effCat, sku: detectedSku || undefined }),
      }).then(r => { if (r.ok && r.data?.found && !signal?.aborted) setScanStockxMatch(r.data); }).catch(() => {});
    }
  };

  // Ricalcola il prezzo carta quando l'utente corregge nome/numero a mano.
  const revalueCard = async () => {
    const name = pokeName.trim();
    if (name.length < 2 && !cardNumber.trim()) return;
    setRevaluingCard(true);
    // Passo anche la gradazione: il backend, se gradata, stima il valore col moltiplicatore per grado.
    const condition = pokeGraded === 'Si' ? `Gradata ${pokeGrade || ''}`.trim() : 'Raw (Non Gradata)';
    const { ok, data } = await apiCall<any>('/api/ai/value', {
      method: 'POST',
      body: JSON.stringify({ category: 'Pokemon', game: cardGame, name: name || undefined, number: cardNumber.trim() || undefined, condition }),
    });
    setRevaluingCard(false);
    if (ok) setScanMarket(data);
  };

  // Annulla lo scan in corso (richiesta IA): usato quando si rimuove la foto in analisi.
  const cancelAIScan = () => {
    if (scanAbortRef.current) { scanAbortRef.current.abort(); scanAbortRef.current = null; }
    scanningImageRef.current = null;
    setIsScanning(false);
  };

  const runAIScan = async (imageBase64: string, cat: string) => {
    // Annulla un eventuale scan precedente ancora in volo prima di partire col nuovo.
    if (scanAbortRef.current) scanAbortRef.current.abort();
    const controller = new AbortController();
    scanAbortRef.current = controller;
    scanningImageRef.current = imageBase64;
    setIsScanning(true);
    setScanResult(null); setScanMarket(null); setPriceEstimate(null);
    try {
      // Modalità automatica (cat vuota o sentinella): non inviamo la categoria,
      // l'IA la rileva dalla foto e adatta i campi.
      const isAuto = !cat || cat === AUTO_CATEGORY;
      const { ok, data } = await apiCall('/api/ai/full-scan', {
        method: 'POST',
        signal: controller.signal,
        body: JSON.stringify(isAuto ? { imageBase64, existingCategories: userCategories } : { imageBase64, category: cat }),
      });
      // Se nel frattempo la foto è stata rimossa (scan annullato), non applicare nulla.
      if (controller.signal.aborted) return;
      if (ok) await applyAIScanResult(data, cat, controller.signal);
      else showToast(data.error || 'Errore IA', 'err');
    } catch (err: any) {
      // Abort = annullamento volontario (foto rimossa): nessun errore da mostrare.
      if (err?.name === 'AbortError' || controller.signal.aborted) return;
      showToast(t('ts.aiError'), 'err');
    }
    finally {
      // Pulisci solo se siamo ancora "noi" lo scan attivo (non un nuovo scan partito dopo).
      if (scanAbortRef.current === controller) { scanAbortRef.current = null; scanningImageRef.current = null; setIsScanning(false); }
    }
  };

  const handlePhotoAdd = async (e: React.ChangeEvent<HTMLInputElement>, isEdit = false) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    const current = isEdit ? editPhotos : productPhotos;
    const remaining = 5 - current.length;
    if (remaining <= 0) { showToast(t('ts.max5photos'), 'warn'); return; }
    const toProcess = files.slice(0, remaining);
    const newPhotos: string[] = [];
    for (const file of toProcess) {
      const compressed = await compressImage(file, 1024, 0.6);
      newPhotos.push(compressed);
    }
    if (isEdit) {
      setEditPhotos(prev => [...prev, ...newPhotos]);
    } else {
      setProductPhotos(prev => [...prev, ...newPhotos]);
      // AUTO-SCAN: ogni nuova foto avvia da sola il riconoscimento (sulla foto appena
      // aggiunta). La UI non è bloccata: puoi aggiungere altre foto mentre elabora — lo
      // scan riparte sull'ultima caricata (quello precedente viene annullato).
      if (newPhotos.length > 0 && category) {
        setScanResult(null);
        setPriceEstimate(null);
        runAIScan(newPhotos[0], category);
      }
    }
    e.target.value = '';
  };

  const removePhoto = (index: number, isEdit = false) => {
    if (isEdit) {
      setEditPhotos(prev => prev.filter((_, i) => i !== index));
    } else {
      setProductPhotos(prev => {
        const removed = prev[index];
        const next = prev.filter((_, i) => i !== index);
        // Se sto rimuovendo proprio l'immagine in scansione, o resto senza foto,
        // annullo lo scan in corso così l'IA smette di elaborarla.
        if (removed === scanningImageRef.current || next.length === 0) cancelAIScan();
        return next;
      });
      // Reset risultati IA quando si rimuove una foto
      setScanResult(null);
      setScanMarket(null);
      setScanStockxMatch(null);
      setPriceEstimate(null);
    }
  };

  // Sposta una foto in PRIMA posizione = diventa la foto PRINCIPALE (quella mostrata sul prodotto).
  const setPrimaryPhoto = (index: number, isEdit = false) => {
    const upd = (prev: string[]) => { if (index <= 0 || index >= prev.length) return prev; const next = [...prev]; const [p] = next.splice(index, 1); next.unshift(p); return next; };
    if (isEdit) setEditPhotos(upd); else setProductPhotos(upd);
  };

  
  // ==========================================
  // ==========================================
  // CREA LOTTO
  // ==========================================
  const handleCreateLot = async (e: React.FormEvent) => {
    e.preventDefault();
    const total = parseFloat(lotTotal);
    const qty = parseInt(lotQty);
    if (!lotName || !lotCategory || isNaN(total) || total <= 0 || isNaN(qty) || qty < 2) return;
    setIsCreatingLot(true);
    // Magazzino scelto (default: base) + snapshot delle quote di quel magazzino,
    // così il lotto rispetta le percentuali dei soci come il prodotto singolo.
    const lotWhId = lotWarehouseId || baseWarehouse?.id;
    const lotTeam = teamData.find(t => t.warehouseId === lotWhId);
    const lotShares = lotTeam?.members?.length > 0
      ? lotTeam.members.map((m: any) => ({ userId: m.userId, name: m.name, percentage: m.percentage }))
      : undefined;
    const { ok, data } = await apiCall('/products/lot', {
      method: 'POST',
      body: JSON.stringify({
        category: lotCategory,
        lotName: lotName.trim(),
        totalPrice: total,
        quantity: qty,
        brand: lotBrand.trim() || null,
        notes: lotNotes.trim() || null,
        warehouseId: lotWhId || undefined,
        customShares: lotShares,
        photos: lotPhotos.length ? lotPhotos : undefined,
      }),
    });
    if (ok) {
      await fetchProducts();
      setLotOpen(false);
      setLotName(''); setLotCategory(''); setLotTotal(''); setLotQty(''); setLotBrand(''); setLotNotes(''); setLotWarehouseId(''); setLotPhotos([]);
      showToast(`✓ Lotto creato: ${data.created} prodotti a ${data.pricePerUnit.toFixed(2)}€ cad.`);
    }
    setIsCreatingLot(false);
  };

  // ==========================================
  // SALVA NOTE
  // ==========================================
  const saveNotes = async () => {
    if (!notesModalProduct) return;
    setIsSavingNotes(true);
    const { ok } = await apiCall(`/products/${notesModalProduct.id}/notes`, {
      method: 'PATCH',
      body: JSON.stringify({ notes: notesInput }),
    });
    if (ok) {
      setProducts(prev => prev.map(p => p.id === notesModalProduct.id ? { ...p, notes: notesInput || undefined } : p));
      setNotesModalProduct(null);
    }
    setIsSavingNotes(false);
  };

  // ==========================================
  // SALVA / MODIFICA / VENDI
  // ==========================================
  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (isSharedPurchase && productShares.length > 0) {
      const total = productShares.reduce((s, x) => s + (Number(x.percentage) || 0), 0);
      if (Math.round(total) !== 100) {
        showToast(t('ts.sharesSumMustBe100'), 'err');
        return;
      }
    }
    
    setIsSaving(true);
    const qty = parseInt(quantity) || 1;
    // Il costo inserito è il TOTALE dell'acquisto (es. 12 scarpe uguali): il costo per pezzo
    // = totale / quantità. Per quantità 1 coincide col totale.
    const totalPaid = parseFloat(price);
    const unitPrice = (isNaN(totalPaid) ? NaN : totalPaid / qty);
    
    let finalBrand = brand, finalName = name, finalSize = size, finalCondition = condition;
    // Categoria effettiva: se non è selezionata ma l'IA ha rilevato un reparto, lo creo al volo e lo uso.
    let effCategory = category;
    if (!effCategory || effCategory === AUTO_CATEGORY) {
      if (detectedReparto) {
        const created = await createRepartoFromDetected(detectedReparto);
        if (!created) { setIsSaving(false); return; }
        effCategory = created;
      } else {
        showToast(t('ts.addPhotoOrDept'), 'err'); setIsSaving(false); return;
      }
    }
    if (isNaN(unitPrice) || unitPrice <= 0) { showToast(t('ts.enterValidPrice'), 'err'); setIsSaving(false); return; }
    if (isConsignment && !consignmentName.trim()) { showToast(t('ts.enterConsignmentName'), 'err'); setIsSaving(false); return; }

    if (effCategory === 'Pokemon') {
      if (!pokeName) { showToast(t('ts.enterCardName'), 'err'); setIsSaving(false); return; }
      finalBrand = 'Pokémon'; finalName = `${pokeName}${cardNumber.trim() ? ` ${cardNumber.trim()}` : ''}`; finalSize = cardNumber.trim() || 'Unisize';
      finalCondition = pokeGraded === 'Si' ? `Gradata ${pokeGrade}` : 'Raw (Non Gradata)';
    } else if (effCategory === 'Orologi') {
      if (!watchBrand || !watchModel) { showToast(t('ts.fillWatchBrandModel'), 'err'); setIsSaving(false); return; }
      finalBrand = watchBrand; finalName = watchModel;
      finalSize = watchCase ? `${watchCase}mm${watchStrap ? ', ' + watchStrap : ''}` : (watchStrap || '-');
      finalCondition = watchMaterial ? `${condition} (${watchMaterial})` : condition;
    } else if (effCategory === 'Scarpe') {
      // Scarpe: serve solo il modello (il brand è inutile, il nome StockX lo contiene già).
      if (!name) { showToast(t('ts.fillModel'), 'err'); setIsSaving(false); return; }
      finalName = name;
      // Brand comunque salvato (prima parola del modello) per compatibilità col backend.
      finalBrand = brand || name.trim().split(/\s+/)[0] || 'Sneaker';
    } else {
      if (!brand || !name) { showToast(t('ts.fillBrandName'), 'err'); setIsSaving(false); return; }
      // Per categorie custom, arricchisci il nome con materiale/colore se compilati
      if (effCategory !== 'Vestiti') {
        const extras = [watchMaterial, watchStrap].filter(Boolean);
        if (extras.length > 0) finalName = `${name} — ${extras.join(', ')}`;
      }
    }
    
    // Snapshot delle percentuali attuali del team: rende ogni prodotto indipendente
    // dalle future modifiche alle quote nelle impostazioni
    const currentTeam = teamData.find(t => t.warehouseId === (selectedWarehouseId || baseWarehouse?.id));
    const snapshotShares = currentTeam?.members?.length > 0
      ? currentTeam.members.map((m: any) => ({ userId: m.userId, name: m.name, percentage: m.percentage }))
      : undefined;
    const finalShares = isSharedPurchase && productShares.length > 0 ? productShares : snapshotShares;

    let hasError = false;
    try {
      for (let i = 0; i < qty; i++) {
        const { ok } = await apiCall('/products', {
          method: 'POST',
          body: JSON.stringify({
            category: effCategory, brand: finalBrand, name: finalName,
            size: finalSize, condition: finalCondition, price: unitPrice,
            sku: sku.trim() || undefined,
            supplier: productSupplier.trim() || undefined, // fornitore (da chi ho comprato)
            warehouseId: selectedWarehouseId || baseWarehouse?.id || undefined, // magazzino scelto (default: base)
            customShares: finalShares,
            ...(isConsignment && consignmentName.trim() ? {
              consignmentName: consignmentName.trim(),
              ...(consignmentPercent && !isNaN(parseFloat(consignmentPercent)) ? { consignmentPercent: parseFloat(consignmentPercent) } : {}),
            } : {}),
            photos: productPhotos.length > 0 ? productPhotos : undefined,
            attributes: Object.keys(dynamicAttrs).length > 0 ? dynamicAttrs : undefined,
            // Valore di mercato verificato da eBay durante lo scan: lo salviamo nel
            // prodotto così listing generator e riprezzamento usano dati reali.
            ...(scanMarket?.value && scanMarket?.reliable ? { marketPriceAvg: Math.round(scanMarket.value) } : {}),
          }),
        });
        if (!ok) hasError = true;
      }
      
      if (hasError) showToast(t('ts.saveError2'), 'err');
      else {
        await fetchProducts();
        setIsFormOpen(false);
        showToast(t('ts.productAdded'));
      }

      // Reset
      setBrand(''); setName(''); setPrice(''); setQuantity('1');
      setCardNumber(''); setCardGame('pokemon');
      setPokeName(''); setWatchBrand(''); setWatchModel('');
      setWatchCase(''); setWatchStrap(''); setWatchMaterial('');
      setIsSharedPurchase(false); setProductShares([]);
      setIsConsignment(false); setConsignmentName(''); setConsignmentPercent('');
      setScanResult(null); setPriceEstimate(null);
      setProductPhotos([]);
      setDynamicAttrs({});
    } catch (err) {
      showToast(t('ts.connectionError'), 'err');
    } finally { setIsSaving(false); }
  };
  
  const openSellModal = (ids: string[], itemName: string, p: Product) => {
    setProductToSell({
      ids, name: itemName, maxQty: ids.length,
      purchasePrice: p.purchasePrice,
    });
    // Default: vendi UNA sola paia (il caso normale). Se ne hai più della stessa taglia
    // e ne vendi più di una, alzi tu la quantità (max = disponibili).
    setSellQuantity('1');
    setSellPrice('');
    setSellCustomer('');
    setSellExtraCosts([]); setSellExtraOpen(false);
    setSellTrackingCode(''); setSellTrackingCarrier('Auto');
    setSellModalOpen(true);
  };
  
  const confirmSell = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!productToSell) return;
    
    const qtyToProcess = parseInt(sellQuantity) || 1;
    const idsToProcess = productToSell.ids.slice(0, qtyToProcess);
    const unitSalePrice = parseFloat(sellPrice) / qtyToProcess;
    // Costi extra (scatola, etichetta, dogana…): somma totale, divisa per le unità e
    // aggiunta alle fees → così viene sottratta dal ricavo nel calcolo del profitto.
    const extraTotal = sellExtraCosts.reduce((a, c) => a + (parseFloat(c.amount) || 0), 0);
    const unitFees = ((parseFloat(sellFees) || 0) + extraTotal) / qtyToProcess;
    
    let hasError = false;
    for (const id of idsToProcess) {
      const { ok } = await apiCall(`/products/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ salePrice: unitSalePrice, platform: sellPlatform, fees: unitFees, customer: sellCustomer.trim() || null }),
      });
      if (!ok) hasError = true;
    }
    // Tracking spedizione di vendita (OUTBOUND), se inserito
    if (!hasError && sellTrackingCode.trim().length >= 4) {
      for (const id of idsToProcess) {
        await apiCall(`/tracking/${id}`, {
          method: 'POST',
          body: JSON.stringify({ trackingCode: sellTrackingCode.trim(), carrier: sellTrackingCarrier, direction: 'OUTBOUND' }),
        });
      }
    }
    if (hasError) showToast(t('ts.sellError'), 'err');
    else {
      await fetchProducts();
      setSellModalOpen(false);
      setProductToSell(null);
      showToast(t('ts.saleRecorded'), 'ok', { label: t('common.cancel'), onClick: () => undoSellIds(idsToProcess) });
    }
  };
  
  const openEditModal = (group: any) => {
    if (swipeActed.current) { swipeActed.current = false; return; } // tap subito dopo una swipe → ignora
    // I lotti aprono il dettaglio (lista pezzi), non la modifica diretta.
    if (group?.isLot) { setLotDetail(group); return; }
    // I MODELLI (più taglie) aprono la suddivisione per taglia.
    if (group?.isModel) { setModelDetail(group); return; }
    setProductToEdit(group);
    setEditBrand(group.brand); setEditName(group.name);
    setEditSize(group.size); setEditCondition(group.condition);
    setEditPrice(group.purchasePrice.toString());
    // Campi vendita (solo se venduto)
    setEditSalePrice(group.salePrice != null ? String(group.salePrice) : '');
    setEditSalePlatform(group.platform || 'Vinted');
    setEditSaleFees(group.fees != null ? String(group.fees) : '');
    setEditSaleCustomer(group.customer || '');
    setEditSupplier(group.supplier || '');
    setEditQuickSale(group.quickSalePrice != null ? String(group.quickSalePrice) : '');
    const toDateInput = (v: any) => { if (!v) return ''; try { return new Date(v).toISOString().slice(0, 10); } catch { return ''; } };
    setEditPurchaseDate(toDateInput(group.createdAt));
    setEditSoldDate(toDateInput(group.soldAt));
    setEditWarehouseId(group.warehouseId || baseWarehouse?.id || '');
    // I pezzi di un lotto ora sono righe singole: la modifica opera SOLO su questo gruppo
    // (come un prodotto normale), non su tutto il lotto.
    setEditLotIds([]);
    setEditQuantity(String(group.ids?.length || 1));
    const shares = group.customShares && group.customShares !== '[]'
      ? JSON.parse(group.customShares) : [];
    setEditShares(shares);
    setIsEditShared(shares.length > 0);
    try {
      const photos = group.photos ? JSON.parse(group.photos) : [];
      setEditPhotos(Array.isArray(photos) ? photos : []);
    } catch { setEditPhotos([]); }
    // La lista contiene solo la prima foto (per risparmiare memoria): carica le foto
    // complete on-demand così nella Modifica le vedi/gestisci tutte.
    const pid = group.ids?.[0] || group.id;
    if (pid && !group.lotName) {
      apiCall<any>(`/products/${pid}/photos`).then(({ ok, data }) => {
        if (ok && Array.isArray(data?.photos)) setEditPhotos(data.photos);
      }).catch(() => {});
    }
    setEditIsPublic(!!group.isPublic);
    setEditPublicPrice(group.publicPrice != null ? String(group.publicPrice) : (group.salePrice != null ? String(group.salePrice) : ''));
    setEditShippingCost(group.shippingCost != null ? String(group.shippingCost) : '');
    setValuation(null);
    setEditModalOpen(true);
  };

  // Toggle rapido pubblico/privato dalla card del magazzino (senza aprire la modifica)
  const quickTogglePublic = async (group: any) => {
    const makePublic = !group.isPublic;
    if (makePublic && !requireFeatureOrUpgrade('marketplace')) return;
    const price = group.publicPrice ?? group.salePrice ?? group.marketPriceAvg ?? null;
    if (makePublic && (price == null || price <= 0)) {
      showToast(t('ts.setPublicPrice'), 'warn');
      openEditModal(group);
      return;
    }
    const ids = (group.ids as string[]) || [group.id];
    await Promise.allSettled(ids.map(id =>
      apiCall(`/products/${id}/publish`, { method: 'PATCH', body: JSON.stringify({ isPublic: makePublic, publicPrice: makePublic ? price : null }) })
    ));
    await fetchProducts();
    showToast(makePublic ? 'Pubblicato nel marketplace' : 'Reso privato');
  };

  // Aggiungi/togli un prodotto dalla lista "Da spedire" (es. venduto su un'altra piattaforma).
  const toggleToShip = async (group: any, value: boolean) => {
    const ids = (group.ids as string[]) || [group.id];
    await Promise.allSettled(ids.map(id =>
      apiCall(`/products/${id}/toship`, { method: 'PATCH', body: JSON.stringify({ toShip: value }) })
    ));
    await fetchProducts();
    showToast(value ? 'Aggiunto a "Da spedire"' : 'Rimosso da "Da spedire"');
  };

  // Pubblica/ritira TUTTO un magazzino (dalle impostazioni)
  const toggleWarehousePublic = async (warehouseId: string, makePublic: boolean) => {
    if (makePublic && !requireFeatureOrUpgrade('marketplace')) return;
    const { ok, data } = await apiCall<any>('/products/publish-all', {
      method: 'PATCH', body: JSON.stringify({ warehouseId, isPublic: makePublic }),
    });
    if (ok) {
      await fetchProducts();
      showToast(makePublic
        ? `Pubblicati ${data.published || 0} articoli${data.skipped ? ` · ${data.skipped} senza prezzo saltati` : ''}`
        : 'Magazzino reso privato');
    } else showToast(data?.error || 'Errore', 'err');
  };

  // Pubblica/ritira l'articolo dal marketplace (applica a tutti i pezzi del gruppo)
  const savePublish = async (group: any, makePublic: boolean) => {
    if (makePublic && !requireFeatureOrUpgrade('marketplace')) return;
    const price = parseFloat(editPublicPrice);
    if (makePublic && (isNaN(price) || price <= 0)) { showToast(t('ts.enterPublicPrice'), 'err'); return; }
    const ship = parseFloat(editShippingCost);
    setIsPublishing(true);
    const ids = (group.ids as string[]) || [group.id];
    const results = await Promise.allSettled(ids.map(id =>
      apiCall(`/products/${id}/publish`, { method: 'PATCH', body: JSON.stringify({ isPublic: makePublic, publicPrice: makePublic ? price : null, shippingCost: makePublic && !isNaN(ship) && ship > 0 ? ship : null }) })
    ));
    setIsPublishing(false);
    const ok = results.every(r => r.status === 'fulfilled' && (r.value as any).ok);
    if (ok) { setEditIsPublic(makePublic); await fetchProducts(); showToast(makePublic ? 'Pubblicato nel marketplace' : 'Ritirato dal marketplace'); }
    else showToast(t('ts.publishError'), 'err');
  };

  // Valutazione di mercato del prodotto (fonte reale, anti-falsi)
  const fetchValuation = async (group: any) => {
    if (!requireFeatureOrUpgrade('stockx_pricing')) return;
    const id = group?.ids?.[0];
    if (!id) return;
    setValLoading(true); setValuation(null);
    const { ok, data } = await apiCall(`/products/${id}/valuation`);
    setValLoading(false);
    setValuation(ok ? data : { configured: false, error: true });
  };

  // ===== SOURCING "Quanto lo pago?" =====
  const openSourcing = () => {
    setSourcingBrand(''); setSourcingModel(''); setSourcingSize('');
    setSourcingVal(null); setSourcingMargin(50);
    setSourcingOpen(true);
  };

  // Solo foto: l'IA riconosce il prodotto dalla foto e ne calcola subito il valore.
  const sourcingPhoto = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setSourcingScanning(true);
    setSourcingVal(null); setSourcingBrand(''); setSourcingModel(''); setSourcingSize('');
    try {
      const compressed = await compressImage(file, 1024, 0.6);
      const { ok, data } = await apiCall<any>('/api/ai/full-scan', {
        method: 'POST', body: JSON.stringify({ imageBase64: compressed }),
      });
      const brand = data?.scan?.brand || '';
      const model = data?.scan?.model || '';
      const size = (data?.scan?.details?.size || '').toString();
      if (!ok || (!brand && !model)) {
        setSourcingScanning(false);
        showToast(t('ts.notRecognized'), 'warn');
        return;
      }
      setSourcingBrand(brand); setSourcingModel(model); setSourcingSize(size);
      const query = [brand, model].filter(Boolean).join(' ').trim();
      // Valuta subito
      setSourcingScanning(false);
      setSourcingCalcLoading(true);
      const res = await apiCall<any>('/api/ai/market-value', {
        method: 'POST', body: JSON.stringify({ query, size: size || undefined }),
      });
      setSourcingCalcLoading(false);
      setSourcingVal(res.ok ? res.data : { configured: false, error: true });
    } catch {
      showToast(t('ts.error'), 'err');
      setSourcingScanning(false); setSourcingCalcLoading(false);
    }
  };
  
  const handleSaveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (isEditShared && editShares.length > 0) {
      const total = editShares.reduce((s, x) => s + (Number(x.percentage) || 0), 0);
      if (Math.round(total) !== 100) { showToast(t('ts.sharesMustBe100'), 'err'); return; }
    }
    
    // Se l'utente non ha toccato le quote, usa le shares originali del prodotto come snapshot
    // (così non vengono sovrascritte con null nel DB)
    const originalShares = productToEdit.customShares && productToEdit.customShares !== '[]'
      ? JSON.parse(productToEdit.customShares) : undefined;
    // Spostamento magazzino: se cambia, le quote seguono il NUOVO magazzino (re-snapshot).
    const warehouseChanged = !!editWarehouseId && editWarehouseId !== productToEdit.warehouseId;
    const editSnapshotShares = warehouseChanged
      ? snapshotSharesFor(editWarehouseId)
      : snapshotSharesFor(productToEdit.warehouseId);
    const finalEditShares = isEditShared && editShares.length > 0
      ? editShares
      : (warehouseChanged ? editSnapshotShares : (originalShares ?? editSnapshotShares));

    setIsSaving(true);
    let hasError = false;
    for (const id of productToEdit.ids) {
      const { ok } = await apiCall(`/products/${id}/edit`, {
        method: 'PUT',
        body: JSON.stringify({
          category: productToEdit.category,
          brand: productToEdit.category === 'Scarpe' ? (editBrand || editName.trim().split(/\s+/)[0] || 'Sneaker') : editBrand,
          name: editName, size: editSize, condition: editCondition,
          purchasePrice: parseFloat(editPrice),
          customShares: finalEditShares,
          ...(warehouseChanged ? { warehouseId: editWarehouseId } : {}),
          photos: editPhotos.length > 0 ? editPhotos : undefined,
          // Sell panic: prezzo di svendita rapida (facoltativo, per il valore di liquidazione).
          quickSalePrice: editQuickSale.trim() ? parseFloat(editQuickSale) : null,
          // Fornitore: da chi ho acquistato (facoltativo).
          supplier: editSupplier.trim() || null,
          // Date facoltative: acquisto sempre, vendita solo se venduto.
          purchaseDate: editPurchaseDate || null,
          ...(productToEdit.status === 'VENDUTO' ? { soldDate: editSoldDate || null } : {}),
          // Modifica VENDITA: solo per prodotti già venduti.
          ...(productToEdit.status === 'VENDUTO' ? {
            salePrice: editSalePrice.trim() ? parseFloat(editSalePrice) : undefined,
            platform: editSalePlatform || undefined,
            fees: editSaleFees.trim() ? parseFloat(editSaleFees) : 0,
            customer: editSaleCustomer.trim() || null,
          } : {}),
        }),
      });
      if (!ok) hasError = true;
    }

    // ----- Spostamento magazzino di un intero LOTTO -----
    // Se sposto in un altro magazzino un pezzo che appartiene a un lotto, sposto TUTTI gli altri
    // pezzi in stock dello stesso lotto (il lotto "appartiene" al nuovo magazzino/socio).
    if (warehouseChanged && productToEdit.lotName) {
      const already = new Set(productToEdit.ids as string[]);
      const otherLotPieces = products.filter((p: any) =>
        p.lotName === productToEdit.lotName && p.status === 'IN STOCK' && !already.has(p.id) && (p.purchasePrice || 0) > 0);
      for (const p of otherLotPieces) {
        const { ok } = await apiCall(`/products/${p.id}/edit`, {
          method: 'PUT',
          body: JSON.stringify({
            category: p.category, brand: p.brand || p.name || 'Articolo', name: p.name,
            size: p.size || undefined, condition: p.condition || undefined,
            purchasePrice: p.purchasePrice,
            warehouseId: editWarehouseId,
            customShares: editSnapshotShares,
          }),
        });
        if (!ok) hasError = true;
      }
    }

    // ----- Riconciliazione quantità pezzi (lotti e gruppi multi-pezzo) -----
    // Per i lotti opera su tutti i pezzi in stock dello stesso lotName; altrimenti sul gruppo.
    const targetProducts = (productToEdit.lotName && editLotIds.length > 0)
      ? products.filter((p: any) => editLotIds.includes(p.id))
      : products.filter((p: any) => (productToEdit.ids as string[]).includes(p.id));
    targetProducts.sort((a: any, b: any) => ((a.createdAt || '') < (b.createdAt || '') ? -1 : 1));
    const currentCount = targetProducts.length;
    const desiredCount = Math.max(0, parseInt(editQuantity) || currentCount);

    if (desiredCount < currentCount) {
      // Elimina i pezzi in eccesso partendo dai più recenti
      const toDelete = targetProducts.slice(desiredCount).map((p: any) => p.id);
      const results = await Promise.allSettled(
        toDelete.map((id: string) => apiCall(`/products/${id}`, { method: 'DELETE' }))
      );
      if (results.some(r => r.status === 'rejected' || (r.status === 'fulfilled' && !(r.value as any).ok))) hasError = true;
    } else if (desiredCount > currentCount) {
      const toAdd = desiredCount - currentCount;
      // Cloniamo il prodotto/pezzo del lotto mantenendo il suo nome (niente più numerazione "#N").
      for (let i = 0; i < toAdd; i++) {
        const { ok } = await apiCall('/products', {
          method: 'POST',
          body: JSON.stringify({
            category: productToEdit.category,
            warehouseId: productToEdit.warehouseId || undefined,
            brand: editBrand,
            name: editName,
            size: editSize, condition: editCondition,
            price: parseFloat(editPrice),
            lotName: productToEdit.lotName || undefined,
            customShares: finalEditShares,
          }),
        });
        if (!ok) hasError = true;
      }
    }

    setIsSaving(false);
    if (hasError) showToast(t('ts.editError'), 'err');
    else {
      await fetchProducts();
      setEditModalOpen(false);
      setProductToEdit(null);
      showToast(t('ts.productEdited'));
    }
  };
  
  // ==========================================
  // NOTIFICHE
  // ==========================================
  const markNotificationRead = async (id: string) => {
    await apiCall(`/notifications/${id}/read`, { method: 'POST' });
    fetchNotifications();
  };
  
  const markAllNotificationsRead = async () => {
    await apiCall('/notifications/read-all', { method: 'POST' });
    fetchNotifications();
  };
  
  const navigateTo = (view: typeof currentView) => {
    setCurrentView(view);
    if (view === 'magazzino' || view === 'analytics') setSearchTerm('');
    // Scroll to top smoothly on navigation
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // Scorciatoie da tastiera (desktop): ⌘/Ctrl+K o "/" apre la palette, "n" nuovo prodotto
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      const typing = el?.tagName === 'INPUT' || el?.tagName === 'TEXTAREA' || el?.tagName === 'SELECT' || el?.isContentEditable;
      if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setCmdQuery(''); setCmdIndex(0); setCmdOpen(o => !o);
        return;
      }
      if (typing) return;
      if (e.key === '/') { e.preventDefault(); setCmdQuery(''); setCmdIndex(0); setCmdOpen(true); }
      else if (e.key === 'n' || e.key === 'N') { e.preventDefault(); openAddForm(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ==========================================
  // BULK ACTIONS
  // ==========================================
  const toggleBulkMode = () => {
    setBulkMode(b => !b);
    setSelectedGroupKeys(new Set());
  };

  const toggleGroupSelection = (key: string) => {
    setSelectedGroupKeys(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const selectAllGroups = () => {
    setSelectedGroupKeys(new Set((groupedInStockArray as any[]).map((g: any) => g.ids.join(','))));
  };

  const getBulkSelectedIds = () => {
    const ids = new Set<string>();
    (groupedInStockArray as any[]).forEach((g: any) => {
      if (selectedGroupKeys.has(g.ids.join(','))) g.ids.forEach((id: string) => ids.add(id));
    });
    // Pezzi singoli (es. da un lotto) selezionati a mano
    selectedPieceIds.forEach(id => ids.add(id));
    return Array.from(ids);
  };

  // Selezione/deselezione di un singolo pezzo (lotto) → entra in bulkMode per venderli insieme
  const togglePieceSelection = (id: string) => {
    setBulkMode(true);
    setSelectedPieceIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
    if ('vibrate' in navigator) { try { navigator.vibrate(20); } catch {} }
  };
  // Long-press su un pezzo del lotto per avviare la selezione multipla
  const startPieceLongPress = (id: string) => {
    longPressFired.current = false;
    longPressTimer.current = setTimeout(() => {
      longPressFired.current = true;
      togglePieceSelection(id);
    }, 400);
  };
  // Blocca lo scroll della pagina sotto quando è aperto un modale a tutto schermo.
  // Su iOS overflow:hidden non basta → fissiamo il body alla posizione attuale.
  useEffect(() => {
    if (!lotDetail && !marketDetail) return;
    const scrollY = window.scrollY;
    const body = document.body;
    const prev = { position: body.style.position, top: body.style.top, width: body.style.width, overflow: body.style.overflow };
    body.style.position = 'fixed';
    body.style.top = `-${scrollY}px`;
    body.style.width = '100%';
    body.style.overflow = 'hidden';
    return () => {
      body.style.position = prev.position;
      body.style.top = prev.top;
      body.style.width = prev.width;
      body.style.overflow = prev.overflow;
      window.scrollTo(0, scrollY);
    };
  }, [lotDetail, marketDetail]);

  // Chat aperta: blocca lo scroll della pagina (su mobile, digitando un messaggio iOS
  // muoveva tutta la pagina). Così resta ferma l'intestazione e l'input; scorre solo la chat.
  useEffect(() => {
    if (currentView !== 'chat' || !activeConvo) return;
    const scrollY = window.scrollY;
    const body = document.body;
    const prev = { position: body.style.position, top: body.style.top, width: body.style.width, overflow: body.style.overflow };
    body.style.position = 'fixed';
    body.style.top = `-${scrollY}px`;
    body.style.width = '100%';
    body.style.overflow = 'hidden';
    return () => {
      body.style.position = prev.position;
      body.style.top = prev.top;
      body.style.width = prev.width;
      body.style.overflow = prev.overflow;
      window.scrollTo(0, scrollY);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentView, activeConvo?.id]);

  // Undo: ripristina prodotti eliminati / riporta in stock prodotti venduti
  const undoDeleteIds = async (ids: string[]) => {
    await Promise.allSettled(ids.map(id => apiCall(`/products/${id}/restore`, { method: 'POST' })));
    await fetchProducts();
    showToast(t('ts.deleteUndone'));
  };
  const undoSellIds = async (ids: string[]) => {
    await Promise.allSettled(ids.map(id => apiCall(`/products/${id}/return`, { method: 'POST' })));
    await fetchProducts();
    showToast(t('ts.saleUndone'));
  };

  const handleBulkDelete = async () => {
    setIsBulkProcessing(true);
    const ids = getBulkSelectedIds();
    // Chiamate in parallelo per velocità
    const results = await Promise.allSettled(
      ids.map(id => apiCall(`/products/${id}`, { method: 'DELETE' }))
    );
    const errors = results.filter(r => r.status === 'rejected' || (r.status === 'fulfilled' && !r.value.ok)).length;
    setIsBulkProcessing(false);
    setBulkDeleteConfirmOpen(false);
    setSelectedGroupKeys(new Set());
    setSelectedPieceIds(new Set());
    setBulkMode(false);
    await fetchProducts();
    errors > 0 ? showToast(t('ts.deletedWithErrors').replace('{n}', String(errors)), 'warn') : showToast(t('ts.nProductsDeleted').replace('{n}', String(ids.length)), 'ok', { label: t('common.cancel'), onClick: () => undoDeleteIds(ids) });
  };

  // ----- CONDIVIDI PRODOTTI SELEZIONATI (vetrina pubblica, solo campi sicuri) -----
  const [shareResult, setShareResult] = useState<{ url: string; count: number } | null>(null);
  const [shareCreating, setShareCreating] = useState(false);
  const shareSelected = async () => {
    const ids = getBulkSelectedIds();
    if (!ids.length) return;
    setShareCreating(true);
    const { ok, data } = await apiCall<any>('/share', { method: 'POST', body: JSON.stringify({ productIds: ids, sellerName: user?.name || '' }) });
    setShareCreating(false);
    if (ok && data?.url) {
      const full = `${window.location.origin}${data.url}`;
      setShareResult({ url: full, count: data.count });
      try { await navigator.clipboard.writeText(full); } catch {}
      setBulkMode(false); setSelectedGroupKeys(new Set()); setSelectedPieceIds(new Set());
    } else showToast(data?.error || t('ts.error'), 'err');
  };

  const handleBulkSell = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsBulkProcessing(true);
    const ids = getBulkSelectedIds();
    const n = ids.length || 1;
    // Prezzo TOTALE inserito → diviso per N = prezzo unitario fittizio del singolo pezzo.
    const total = parseFloat(bulkSellPrice) || 0;
    const totalFees = parseFloat(bulkSellFees) || 0;
    const salePrice = Math.round((total / n) * 100) / 100;
    const fees = Math.round((totalFees / n) * 100) / 100;
    let errors = 0;
    for (const id of ids) {
      const { ok } = await apiCall(`/products/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ salePrice, platform: bulkSellPlatform, fees }),
      });
      if (!ok) errors++;
    }
    setIsBulkProcessing(false);
    setBulkSellOpen(false);
    setSelectedGroupKeys(new Set());
    setSelectedPieceIds(new Set());
    setBulkMode(false);
    await fetchProducts();
    errors > 0 ? showToast(t('ts.salesWithErrors').replace('{n}', String(errors)), 'warn') : showToast(t('ts.nProductsSold').replace('{n}', String(ids.length)), 'ok', { label: t('common.cancel'), onClick: () => undoSellIds(ids) });
  };

  // Reso: riporta un pezzo venduto in stock (operazione inversa della vendita) — immediato, niente conferma
  const handleReturn = async (group: any) => {
    const id = group.ids?.[0];
    if (!id) return;
    await handleReturnIds([id], `${fullName(group.brand, group.name)}`);
  };

  // Reso di UNO o più pezzi SPECIFICI (per id) — così si rende il paio giusto, non l'ultimo/primo.
  const handleReturnIds = async (ids: string[], label?: string) => {
    if (!ids.length) return;
    // GATING: il reso è dal piano Starter in su. Nel Free il tasto c'è ma al tap invita all'upgrade.
    if (!hasFeature('returns')) {
      showToast(t('plan.returnsLocked'), 'warn', { label: t('set.seePlans'), onClick: () => openPlanModal() });
      return;
    }
    const results = await Promise.allSettled(ids.map(id => apiCall(`/products/${id}/return`, { method: 'POST' })));
    const okCount = results.filter(r => r.status === 'fulfilled' && (r.value as any).ok).length;
    await fetchProducts();
    if (okCount > 0) showToast(label ? `↩ ${t('mag.return')}: ${label}` : t('ts.returnRecorded'), 'ok');
    else showToast(t('ts.returnError'), 'err');
  };

  // ==========================================
  // IMPORT EXCEL — funziona con QUALSIASI file: l'utente abbina le sue colonne ai campi.
  // ==========================================
  // Campi dell'app + alias per l'auto-rilevamento delle colonne.
  const IMPORT_ALIASES: Record<string, string[]> = {
    brand: ['brand', 'marca', 'marchio'],
    name: ['nome', 'modello', 'name', 'model', 'descrizione', 'prodotto', 'articolo'],
    size: ['taglia', 'size', 'misura'],
    condition: ['condizione', 'condition', 'stato'],
    price: ['prezzo', 'price', 'prezzo acquisto', 'costo', 'purchase price', 'acquisto', 'pagato'],
    category: ['categoria', 'category', 'reparto', 'tipo'],
  };
  // Deduce la MARCA dal nome completo (quando nel file non c'è una colonna marca).
  const BRAND_HINTS: [RegExp, string][] = [
    [/\bair jordan\b|\bjordan\b|\baj ?\d/i, 'Jordan'],
    [/\bdunk\b|\bair force\b|\baf1\b|\bblazer\b|\bcortez\b|\bvapormax\b|\bair max\b|\bzoom\b|\bnike\b|\bsb\b/i, 'Nike'],
    [/\byeezy\b|\bfoam\b/i, 'Yeezy'],
    [/\badidas\b|\bsamba\b|\bgazelle\b|\bcampus\b|\bsuperstar\b|\bforum\b|\bspezial\b/i, 'Adidas'],
    [/\bnew balance\b|\bnb\b/i, 'New Balance'],
    [/\bbalenciaga\b|\btriple s\b|\btrack\b|\barena\b/i, 'Balenciaga'],
    [/\bsupreme\b/i, 'Supreme'],
    [/\brick owens\b|\bramones\b|\bgeobasket\b/i, 'Rick Owens'],
    [/\basics\b|\bgel\b/i, 'Asics'],
    [/\bsalomon\b|\bxt-?6\b/i, 'Salomon'],
    [/\bconverse\b|\bchuck\b/i, 'Converse'],
    [/\bvans\b/i, 'Vans'], [/\bpuma\b/i, 'Puma'], [/\bcrocs\b/i, 'Crocs'],
    [/\btimberland\b/i, 'Timberland'], [/\bugg\b/i, 'UGG'],
    [/\boff-?white\b/i, 'Off-White'], [/\btravis\b|\bcactus jack\b/i, 'Travis Scott'],
    [/\bnocta\b/i, 'Nike'], [/\bterra\b/i, 'Adidas'],
  ];
  const deriveBrand = (name: string): string => {
    for (const [re, b] of BRAND_HINTS) if (re.test(name)) return b;
    return (name.trim().split(/\s+/)[0] || ''); // fallback: prima parola
  };
  // Costruisce le righe-prodotto dalle righe grezze usando l'abbinamento colonna→campo scelto.
  // Se manca la marca, la DEDUCE dal nome (e la toglie dal nome per non duplicarla).
  const applyImportMap = (raw: any[], map: Record<string, string>) => raw.map((row: any) => {
    let brand = map.brand ? String(row[map.brand] ?? '').trim() : '';
    let name = map.name ? String(row[map.name] ?? '').trim() : '';
    if (!brand && name) {
      brand = deriveBrand(name);
      if (brand && name.toLowerCase().startsWith(brand.toLowerCase())) {
        name = name.slice(brand.length).trim() || name;
      }
    }
    return {
      brand, name,
      size: map.size ? String(row[map.size] ?? '').trim() : '',
      condition: map.condition ? String(row[map.condition] ?? '').trim() : '',
      // prezzo robusto: gestisce "150,00", "€150", "1007,5" → numero
      price: map.price ? (parseFloat(String(row[map.price] ?? '').replace(/[^0-9,.-]/g, '').replace(',', '.')) || 0) : 0,
      category: map.category ? String(row[map.category] ?? '').trim() : '',
    };
  });
  // Cambia l'abbinamento di un campo e ricalcola l'anteprima.
  const setImportField = (field: string, header: string) => {
    const m = { ...importMap }; if (header) m[field] = header; else delete m[field];
    setImportMap(m);
    setImportRows(applyImportMap(importRaw, m));
  };

  const handleExcelFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // Limite dimensione (anti-DoS del parser nel browser): max 5MB.
    if (file.size > 5 * 1024 * 1024) { showToast('File troppo grande (max 5MB).', 'err'); e.target.value = ''; return; }
    try {
      const data = await file.arrayBuffer();
      const XLSX = await import('xlsx');
      // Parsing sicuro: niente macro/VBA/HTML/link esterni (mitiga contenuti attivi/XXE).
      const workbook = XLSX.read(data, { type: 'array', bookVBA: false, cellHTML: false, cellFormula: false });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const raw: any[] = XLSX.utils.sheet_to_json(sheet, { defval: '' });
      if (raw.length === 0) { showToast(t('ts.emptyFile'), 'err'); return; }
      const headers = Object.keys(raw[0] || {});
      const normalize = (k: string) => k.toLowerCase().trim().replace(/[_\s]+/g, ' ');
      // Auto-rileva l'abbinamento colonna→campo (poi l'utente può correggerlo nella modale).
      const map: Record<string, string> = {};
      Object.keys(IMPORT_ALIASES).forEach(field => {
        const h = headers.find(hh => IMPORT_ALIASES[field].includes(normalize(hh)));
        if (h) map[field] = h;
      });
      // Fallback "smart" (file senza intestazioni chiare, es. una colonna nome + una prezzo):
      // colonna più NUMERICA = prezzo, colonna più TESTUALE = nome.
      const stats = headers.map(h => {
        let num = 0, len = 0, n = 0;
        for (const row of raw.slice(0, 40)) {
          const v = row[h]; if (v === '' || v == null) continue; n++;
          const parsed = parseFloat(String(v).replace(/[^0-9,.-]/g, '').replace(',', '.'));
          if (!isNaN(parsed) && /\d/.test(String(v))) num++;
          len += String(v).length;
        }
        return { h, numRatio: n ? num / n : 0, avgLen: n ? len / n : 0 };
      });
      const used = () => Object.values(map);
      if (!map.price) {
        const best = stats.filter(c => !used().includes(c.h)).sort((a, b) => b.numRatio - a.numRatio)[0];
        if (best && best.numRatio > 0.6) map.price = best.h;
      }
      if (!map.name) {
        const best = stats.filter(c => !used().includes(c.h) && c.numRatio < 0.5).sort((a, b) => b.avgLen - a.avgLen)[0];
        if (best && best.avgLen >= 3) map.name = best.h;
      }
      setImportRaw(raw);
      setImportHeaders(headers);
      setImportMap(map);
      setImportRows(applyImportMap(raw, map));
      setImportCategory(userCategories[0] || '');
      setImportErrors([]);
      setImportOpen(true);
    } catch { showToast(t('ts.fileReadError'), 'err'); }
    e.target.value = '';
  };

  const downloadImportTemplate = async () => {
    const XLSX = await import('xlsx');
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([
      ['Brand', 'Nome', 'Taglia', 'Condizione', 'Prezzo', 'Categoria'],
      ['Nike', 'Air Jordan 1', '42', 'DS', '150', userCategories[0] || 'Scarpe'],
      ['Supreme', 'Box Logo Hoodie', 'L', 'DS', '200', userCategories[1] || 'Vestiti'],
    ]);
    ws['!cols'] = [{ wch: 15 }, { wch: 25 }, { wch: 10 }, { wch: 12 }, { wch: 10 }, { wch: 15 }];
    XLSX.utils.book_append_sheet(wb, ws, 'Prodotti');
    XLSX.writeFile(wb, 'template-importazione.xlsx');
  };

  const confirmImport = async () => {
    const errors: string[] = [];
    const valid = importRows.filter((r, i) => {
      if (!r.brand) { errors.push(`Riga ${i + 1}: Brand mancante`); return false; }
      if (!r.name) { errors.push(`Riga ${i + 1}: Nome mancante`); return false; }
      if (!r.price || r.price <= 0) { errors.push(`Riga ${i + 1}: Prezzo non valido`); return false; }
      return true;
    });
    if (errors.length > 0 && valid.length === 0) { setImportErrors(errors); return; }
    setIsImporting(true);
    // Magazzino scelto (default base) + quote di quel magazzino, applicate a tutte le righe.
    const impWhId = importWarehouseId || baseWarehouse?.id;
    const impShares = snapshotSharesFor(impWhId);
    let success = 0, fail = 0;
    const createdIds: string[] = [];
    for (const row of valid) {
      // Reparto della riga: usa QUALSIASI reparto scritto nell'Excel (nuovo o esistente);
      // se la cella è vuota, ripiega sul reparto selezionato nella modale.
      const cat = (row.category && String(row.category).trim()) ? String(row.category).trim() : importCategory;
      const { ok, data } = await apiCall<any>('/products', {
        method: 'POST',
        body: JSON.stringify({
          category: cat, brand: row.brand, name: row.name,
          size: row.size || 'Unisize', condition: row.condition || 'DS', price: row.price,
          warehouseId: impWhId || undefined,
          customShares: impShares,
          skipAutoPhoto: true, // import veloce: le foto le agganciamo in batch dopo
        }),
      });
      if (ok) { success++; if (data?.id) createdIds.push(data.id); } else fail++;
    }
    setIsImporting(false);
    await fetchProducts();
    setImportOpen(false); setImportRows([]); setImportErrors([]);
    fail > 0 ? showToast(`Importati ${success}, errori: ${fail}`, 'warn') : showToast(`${success} prodotti importati!`);
    // Aggancio AUTOMATICO delle foto dal catalogo (in background).
    if (createdIds.length) {
      showToast('🖼️ Cerco le foto dei prodotti…', 'ok');
      const { data: er } = await apiCall<any>('/products/enrich-photos', { method: 'POST', body: JSON.stringify({ ids: createdIds }) }).catch(() => ({ data: null } as any));
      await fetchProducts();
      if (er?.updated) showToast(`✅ ${er.updated} foto agganciate`, 'ok');
    }
  };

  // ==========================================
  // ELIMINA PRODOTTO
  // ==========================================
  const handleDeleteProduct = async () => {
    if (!productToDelete) return;
    const ids = productToDelete.ids as string[];
    // Ottimisticamente rimuovi dalla UI prima della chiamata API
    setProducts(prev => prev.filter(p => !ids.includes(p.id)));
    setDeleteConfirmOpen(false);
    setProductToDelete(null);
    setEditModalOpen(false);

    const results = await Promise.allSettled(
      ids.map(id => apiCall(`/products/${id}`, { method: 'DELETE' }))
    );
    const errors = results.filter(r => r.status === 'rejected' || (r.status === 'fulfilled' && !r.value.ok)).length;

    if (errors > 0) {
      showToast(t('ts.deleteErrorReload'), 'err');
      await fetchProducts(); // Re-sync se ci sono stati errori
    } else {
      showToast(t('ts.productDeleted'), 'ok', { label: t('common.cancel'), onClick: () => undoDeleteIds(ids) });
    }
  };

  // ==========================================
  // TRACKING HANDLERS
  // ==========================================
  const openTrackingModal = async (group: any) => {
    setTrackingProduct(group);
    setTrackingInput(group.trackingCode || '');
    setTrackingCarrierSel(group.trackingCarrier || 'Auto');
    setTrackingDetail(null);
    setTrackingModalOpen(true);

    if (carrierList.length === 0) {
      const { ok, data } = await apiCall('/tracking/carriers');
      if (ok && Array.isArray(data)) setCarrierList(data);
    }

    if (group.trackingCode) {
      setIsRefreshingTracking(true);
      const { ok, data } = await apiCall(`/tracking/${group.ids[0]}`);
      if (ok) setTrackingDetail(data);
      setIsRefreshingTracking(false);
    }
  };

  const handleSaveTracking = async () => {
    if (!trackingProduct || !trackingInput.trim()) return;
    setIsSavingTracking(true);
    // Prodotto in stock = pacco in ARRIVO (acquisto). Venduto = spedizione di vendita.
    const direction = trackingProduct.status === 'VENDUTO' ? 'OUTBOUND' : 'INBOUND';
    const { ok, data } = await apiCall(`/tracking/${trackingProduct.ids[0]}`, {
      method: 'POST',
      body: JSON.stringify({ trackingCode: trackingInput.trim(), carrier: trackingCarrierSel, direction }),
    });
    setIsSavingTracking(false);
    if (ok) {
      showToast(t('ts.trackingSaved'));
      await fetchProducts();
      setTrackingModalOpen(false);
    } else {
      showToast((data as any).error || 'Errore salvataggio tracking', 'err');
    }
  };

  // Apre il form "acquisto in arrivo" (pre-seleziona il primo reparto, carica i vettori)
  const openIncoming = async () => {
    setIncCategory(userCategories[0] || '');
    setIncBrand(''); setIncName(''); setIncPrice(''); setIncTrackCode(''); setIncTrackCarrier('Auto');
    setIncomingOpen(true);
    if (carrierList.length === 0) {
      const { ok, data } = await apiCall('/tracking/carriers');
      if (ok) setCarrierList(data as any);
    }
  };

  // Crea un prodotto IN STOCK e gli attacca un tracking INBOUND (pacco in arrivo)
  const createIncoming = async () => {
    if (!incName.trim()) { showToast(t('ts.enterName'), 'warn'); return; }
    if (incTrackCode.trim().length < 4) { showToast(t('ts.enterValidTracking'), 'warn'); return; }
    setIncSaving(true);
    // Minimal: serve solo il nome. Reparto/brand/prezzo si mettono dopo dalla Modifica.
    const cat = incCategory || userCategories[0] || 'Altro';
    const incWhId = incWarehouseId || baseWarehouse?.id;
    const { ok, data } = await apiCall<any>('/products', {
      method: 'POST',
      body: JSON.stringify({
        category: cat, brand: incBrand.trim() || '-', name: incName.trim(), price: parseFloat(incPrice) || 0,
        warehouseId: incWhId || undefined,
        customShares: snapshotSharesFor(incWhId),
      }),
    });
    if (!ok || !data?.id) { setIncSaving(false); showToast(data?.error || t('ts.createProductError'), 'err'); return; }
    const trk = await apiCall(`/tracking/${data.id}`, {
      method: 'POST',
      body: JSON.stringify({ trackingCode: incTrackCode.trim(), carrier: incTrackCarrier, direction: 'INBOUND' }),
    });
    setIncSaving(false);
    await fetchProducts();
    setIncomingOpen(false);
    showToast(trk.ok ? t('ts.incomingAdded') : t('ts.productCreatedNoTracking'), trk.ok ? 'ok' : 'warn');
  };

  const handleRefreshTracking = async () => {
    if (!trackingProduct) return;
    setIsRefreshingTracking(true);
    const { ok, data } = await apiCall(`/tracking/${trackingProduct.ids[0]}/refresh`, { method: 'POST' });
    setIsRefreshingTracking(false);
    if (ok) {
      setTrackingDetail(data);
      await fetchProducts();
      showToast(t('ts.trackingUpdated'));
    } else {
      showToast(t('ts.trackingUpdateError'), 'err');
    }
  };

  // Stato manuale (senza API esterna): l'utente segna lo stato a mano
  const setManualStatus = async (status: string) => {
    if (!trackingProduct) return;
    const { ok, data } = await apiCall(`/tracking/${trackingProduct.ids[0]}/status`, {
      method: 'POST', body: JSON.stringify({ status }),
    });
    if (ok) {
      await fetchProducts();
      setTrackingProduct((prev: any) => prev ? { ...prev, trackingStatus: status } : prev);
      showToast(t('ts.statusUpdated'));
      if (status === 'DELIVERED') setTrackingModalOpen(false);
    } else showToast(data?.error || 'Errore aggiornamento stato', 'err');
  };

  // Swipe dal bordo sinistro → destra per tornare indietro (gesto stile iOS).
  // Si applica ai pannelli a schermo intero con {...swipeBack(closeFn)}.
  const swipeBack = (onBack: () => void) => {
    let startX = 0, startY = 0, tracking = false;
    return {
      onTouchStart: (e: any) => {
        const tch = e.touches[0];
        startX = tch.clientX; startY = tch.clientY;
        tracking = startX <= 40; // parte solo dal bordo sinistro
      },
      onTouchEnd: (e: any) => {
        if (!tracking) return;
        tracking = false;
        const tch = e.changedTouches[0];
        const dx = tch.clientX - startX;
        const dy = Math.abs(tch.clientY - startY);
        if (dx > 80 && dy < 60) onBack(); // trascinamento orizzontale deciso
      },
    };
  };

  // Link pubblico di tracciamento (nessun account/API): AfterShip rileva il corriere da solo
  // dal formato del numero e mostra lo stato reale della spedizione.
  const trackingPublicUrl = (code: string) => `https://track.aftership.com/${encodeURIComponent(code)}`;

  const handleRemoveTracking = async () => {
    if (!trackingProduct) return;
    const { ok } = await apiCall(`/tracking/${trackingProduct.ids[0]}`, { method: 'DELETE' });
    if (ok) {
      showToast(t('ts.trackingRemoved'));
      await fetchProducts();
      setTrackingModalOpen(false);
    }
  };

  const handleRefreshAllTrackings = async () => {
    const active = products.filter(p =>
      p.trackingCode && ['PENDING', 'IN_TRANSIT', 'OUT_FOR_DELIVERY'].includes(p.trackingStatus || 'PENDING')
    );
    if (active.length === 0) return;
    setIsRefreshingAll(true);
    let updated = 0;
    for (const p of active) {
      const { ok } = await apiCall(`/tracking/${p.id}/refresh`, { method: 'POST' });
      if (ok) updated++;
    }
    await fetchProducts();
    setIsRefreshingAll(false);
    showToast(`${updated} tracking aggiornati`);
  };

  // ==========================================
  // CAMBIO PASSWORD
  // ==========================================
  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (changePwdNew !== changePwdConfirm) {
      showToast(t('ts.pwdMismatch'), 'err');
      return;
    }
    setChangePwdLoading(true);
    const { ok, data } = await apiCall('/auth/password', {
      method: 'PUT',
      body: JSON.stringify({ currentPassword: changePwdCurrent, newPassword: changePwdNew }),
    });
    setChangePwdLoading(false);
    if (ok) {
      showToast(t('ts.pwdChanged'));
      setChangePwdOpen(false);
      setChangePwdCurrent(''); setChangePwdNew(''); setChangePwdConfirm('');
      setTimeout(handleLogout, 2200);
    } else {
      showToast(data.error || 'Errore cambio password', 'err');
    }
  };

  // ==========================================
  // EXPORT CSV
  // ==========================================
  const exportCSV = () => {
    const headers = ['Brand','Nome','Taglia','Condizione','Prezzo Acquisto','Prezzo Vendita','Piattaforma','Fees','Profitto','Status','Data Acquisto','Data Vendita'];
    const rows = products.map(p => [
      p.brand, p.name, p.size, p.condition,
      p.purchasePrice, p.salePrice ?? '', p.platform ?? '', p.fees ?? 0,
      p.salePrice ? ((p.salePrice - p.purchasePrice - (p.fees || 0)).toFixed(2)) : '',
      p.status,
      p.createdAt ? new Date(p.createdAt).toLocaleDateString('it-IT') : '',
      p.soldAt ? new Date(p.soldAt).toLocaleDateString('it-IT') : '',
    ]);
    const csv = [headers, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `hq-${new Date().toISOString().slice(0,10)}.csv`;
    a.click(); URL.revokeObjectURL(url);
    showToast(`Esportati ${products.length} prodotti`);
  };
  
  // ==========================================
  // RENDER: BOOT LOADING
  // ==========================================
  if (bootLoading) {
    return (
      <div className="min-h-screen relative flex flex-col items-center justify-center gap-4 overflow-hidden"
        style={{ background: 'radial-gradient(125% 80% at 50% 24%, #1b1b21 0%, #0b0b0e 55%, #050506 100%)' }}>
        {/* Loader minimale (niente animazione caveau): logo cromato + spinner sottile. */}
        <span className="text-3xl font-black tracking-[0.02em]" style={{ background: 'linear-gradient(177deg,#fbfbfc,#d2d5d9 40%,#83878f 58%,#eceef0)', WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent' }}>HQ</span>
        <Loader2 size={22} className="animate-spin text-[var(--text-faint)]" />
        <p className="relative text-[10px] font-extrabold uppercase tracking-[0.4em] text-[var(--text-faint)] pl-[0.4em]">HQVault</p>
      </div>
    );
  }
  
  // ==========================================
  // RENDER: SCHERMATA AUTH
  // ==========================================
  // Vetrina pubblica accessibile a CHIUNQUE (senza login), su /market
  if (!isAuthenticated && publicMarket) {
    return (
      <div className="min-h-screen bg-[var(--bg)] text-[var(--text)] font-sans">
        <header className="sticky top-0 z-40 bg-[var(--bg-blur)] backdrop-blur-xl border-b border-[var(--border)] px-4 py-3 flex items-center justify-between">
          <span className="font-black text-lg">HQVault <span className="text-[var(--text-soft)]">Market</span></span>
          <button onClick={() => setPublicMarket(false)} className="px-4 py-2 rounded-xl bg-[#8397aa] text-white text-sm font-bold">{t('auth.signIn')}</button>
        </header>
        <div className="max-w-[1100px] mx-auto p-4 space-y-4">
          <div className="flex gap-2">
            <div className="flex-1 relative">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-faint)]" />
              <input value={marketQuery} onChange={e => setMarketQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') fetchMarket(); }}
                placeholder="Cerca modello, colore, SKU…"
                className="w-full bg-[var(--surface)] border border-[var(--border-2)] rounded-xl pl-9 pr-3 py-2.5 text-sm outline-none focus:border-[#8397aa]" />
            </div>
            <button onClick={fetchMarket} className="px-4 py-2.5 rounded-xl bg-[#8397aa] text-white text-sm font-bold">Cerca</button>
          </div>
          {marketCats.length > 0 && (
            <div className="flex gap-2 flex-wrap">
              <button onClick={() => setMarketCat('')} className={`px-3 py-1.5 rounded-lg text-xs font-bold border ${!marketCat ? 'bg-[#8397aa]/10 border-[#8397aa]' : 'bg-[var(--surface-2)] border-[var(--border-2)] text-[var(--text-soft)]'}`}>Tutte</button>
              {marketCats.map((c: string) => (
                <button key={c} onClick={() => setMarketCat(c)} className={`px-3 py-1.5 rounded-lg text-xs font-bold border ${marketCat === c ? 'bg-[#8397aa]/10 border-[#8397aa]' : 'bg-[var(--surface-2)] border-[var(--border-2)] text-[var(--text-soft)]'}`}>{c}</button>
              ))}
            </div>
          )}
          {marketLoading ? (
            <div className="flex justify-center py-16"><Loader2 className="animate-spin text-[#8397aa]" size={28} /></div>
          ) : marketItems.length === 0 ? (
            <div className="text-center py-16 text-[var(--text-soft)]">Nessun articolo in vetrina.</div>
          ) : (
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              {marketItems.map((it: any) => (
                <button key={it.id} onClick={() => openMarketDetail(it.id)}
                  className="text-left bg-[var(--surface)] border border-[var(--border)] rounded-2xl overflow-hidden hover:-translate-y-0.5 hover:shadow-lg transition-all">
                  <div className="aspect-square bg-white flex items-center justify-center overflow-hidden">
                    {it.photo ? <img src={it.photo} alt="" className="w-full h-full object-cover" /> : <span className="text-4xl">{getCategoryIcon(it.category)}</span>}
                  </div>
                  <div className="p-3">
                    <p className="font-bold text-sm truncate">{fullName(it.brand, it.name)}</p>
                    <p className="text-[11px] text-[var(--text-soft)]">{it.size} · {it.condition}</p>
                    <p className="text-lg font-bold mt-1">{it.price != null ? `${it.price}€` : '—'}</p>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
        {marketDetail && (
          <div className="fixed inset-0 z-[60] bg-black/60 backdrop-blur-sm sm:flex sm:items-center sm:justify-center sm:p-4" onClick={() => setMarketDetail(null)} {...swipeBack(() => setMarketDetail(null))}>
            <div className="bg-[var(--card)] w-full h-full sm:h-auto sm:rounded-3xl sm:max-w-lg sm:max-h-[90vh] flex flex-col overflow-hidden" onClick={e => e.stopPropagation()}>
              <div className="flex items-center justify-between p-3 border-b border-[var(--border)] shrink-0"
                style={{ paddingTop: 'calc(0.75rem + env(safe-area-inset-top))' }}>
                <span className="font-bold text-sm truncate">{fullName(marketDetail.brand, marketDetail.name)}</span>
                <button onClick={() => setMarketDetail(null)} aria-label="Chiudi"
                  className="p-3 -mr-1 hover:bg-[var(--fill)] rounded-xl shrink-0 active:scale-95 transition-transform"><X size={22} /></button>
              </div>
              <div className="flex-1 overflow-y-auto overscroll-contain">
                <div className="aspect-square bg-white flex items-center justify-center overflow-hidden">
                  {marketDetail.photos?.[0] ? <img src={marketDetail.photos[0]} alt="" className="w-full h-full object-contain" /> : <img src="/logo.png" alt="" className="w-1/3 h-1/3 object-contain opacity-20" />}
                </div>
                <div className="p-5">
                  <p className="text-xl font-bold">{fullName(marketDetail.brand, marketDetail.name)}</p>
                  <p className="text-sm text-[var(--text-soft)] mt-1">{marketDetail.size} · {marketDetail.condition} · {marketDetail.category}</p>
                  <p className="text-3xl font-bold mt-3">{marketDetail.price != null ? `${marketDetail.price}€` : '—'}</p>
                  {marketDetail.breakdown && (
                    <p className="text-sm font-bold text-[#8397aa] mt-0.5">
                      {t('market.total')} {marketDetail.breakdown.total.toFixed(2)}€
                      <span className="font-normal text-[var(--text-soft)]"> · {t('market.totalIncl')}</span>
                    </p>
                  )}
                  <p className="text-xs text-[var(--text-soft)] mt-1">{t('market.seller')}: {marketDetail.sellerName}</p>
                </div>
              </div>
              <div className="border-t border-[var(--border)] p-3 shrink-0" style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom))' }}>
                <button onClick={() => { setMarketDetail(null); setPublicMarket(false); }}
                  className="w-full py-3 rounded-xl bg-[#8397aa] hover:bg-[#6f8394] text-white font-bold transition-colors">
                  {t('market.loginToBuy')}
                </button>
              </div>
            </div>
          </div>
        )}
        {toast && (
          <div className="fixed left-4 right-4 bottom-4 mx-auto max-w-sm px-4 py-3 rounded-2xl bg-[var(--surface)] border border-[var(--border-2)] text-sm text-center">{toast.msg}</div>
        )}
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen bg-[var(--surface-2)] flex items-center justify-center p-4 font-sans">
        <div className="bg-[var(--surface)] border border-[var(--border)] p-8 rounded-3xl w-full max-w-md">
          {/* Logo HQVault */}
          <div className="flex flex-col items-center gap-3 mb-6">
            <img src="/logo.png" alt="HQVault" width={64} height={64} className="rounded-2xl" />
            <span className="text-2xl font-black tracking-tight txt-chrome">HQVault</span>
          </div>
          {needVerifyEmail ? (
            <div className="space-y-4">
              <p className="text-center text-[var(--text-soft)] text-sm">{t('auth.verifyEmail')}<br/><span className="text-[var(--text)] font-semibold">{needVerifyEmail}</span></p>
              <p className="text-center text-[11px] text-[var(--text-faint)]">{t('auth.codeSent')}</p>
              <input value={verifyCode} onChange={e => setVerifyCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                inputMode="numeric" placeholder="______" maxLength={6}
                className="w-full text-center tracking-[0.5em] text-xl font-bold bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl py-3 outline-none focus:border-[#8397aa]" />
              {authError && <p className="text-red-400 text-sm text-center">{authError}</p>}
              <button type="button" onClick={submitVerify} disabled={authLoading}
                className="w-full bg-[#8397aa] hover:bg-[#9fb0bd] py-3 rounded-xl text-white font-bold transition-all disabled:opacity-50 flex items-center justify-center">
                {authLoading ? <Loader2 className="animate-spin" size={20} /> : t('auth.verifyAndEnter')}
              </button>
              <div className="flex items-center justify-between text-sm">
                <button type="button" onClick={resendVerify} className="text-[var(--text-soft)] hover:text-[var(--text)] font-bold">{t('auth.resendCode')}</button>
                <button type="button" onClick={() => { setNeedVerifyEmail(null); setVerifyCode(''); setAuthError(null); }} className="text-[var(--text-soft)] hover:text-[var(--text)] font-bold">{t('del.back')}</button>
              </div>
            </div>
          ) : (<>
          <p className="text-center text-[var(--text-soft)] text-sm mb-8">
            {authMode === 'login' ? t('auth.loginSub') : t('auth.registerSub')}
          </p>

          <form onSubmit={handleAuth} className="space-y-4">
            {require2FA ? (
              <div className="bg-blue-500/10 border border-blue-500/30 p-5 rounded-2xl">
                <div className="flex items-center gap-2 mb-3">
                  <Shield className="text-blue-500" size={20} />
                  <h3 className="text-[var(--text)] font-bold">{t('auth.verify2fa')}</h3>
                </div>
                <p className="text-xs text-[var(--text-muted)] mb-4">
                  {t('auth.twofaHint')}
                </p>
                <input 
                  type="text" autoFocus inputMode="numeric" required
                  value={twoFactorCode} onChange={e => setTwoFactorCode(e.target.value)}
                  className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-[var(--text)] outline-none focus:border-blue-500 font-mono text-center text-2xl tracking-widest"
                  placeholder="000000" maxLength={8}
                />
              </div>
            ) : (
              <>
                {authMode === 'register' && (
                  <>
                    <div className="flex bg-[var(--surface-2)] p-1 rounded-xl border border-[var(--border-2)] mb-6">
                      <button type="button" onClick={() => setRegType('new_team')}
                        className={`flex-1 py-2 text-xs font-bold rounded-lg transition-colors ${
                          regType === 'new_team' ? 'bg-[#8397aa] text-[var(--text)]' : 'text-[var(--text-soft)]'
                        }`}>{t('auth.foundCompany')}</button>
                      <button type="button" onClick={() => setRegType('join_team')}
                        className={`flex-1 py-2 text-xs font-bold rounded-lg transition-colors ${
                          regType === 'join_team' ? 'bg-blue-600 text-[var(--text)]' : 'text-[var(--text-soft)]'
                        }`}>{t('tp.joinTeam')}</button>
                    </div>

                    <div>
                      <label className="text-xs font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">{t('auth.yourName')}</label>
                      <input type="text" required value={authName} onChange={e => setAuthName(e.target.value)}
                        className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-[var(--text)] focus:border-[#8397aa] outline-none"
                        placeholder={t('auth.namePlaceholder')} />
                    </div>
                    
                    {regType === 'new_team' && (
                      <div className="mt-6 mb-4 border-t border-[var(--border-2)] pt-6">
                        <h3 className="text-lg font-bold text-[var(--text)] flex items-center gap-2 mb-1">
                          <Layers className="text-[var(--text)]" size={18} /> {t('auth.yourWarehouse')}
                        </h3>
                        <p className="text-xs text-[var(--text-soft)]">
                          {t('auth.warehouseDesc1')} <b className="text-[var(--text)]">{t('auth.myWarehouse')}</b>{t('auth.warehouseDesc2')}
                        </p>
                      </div>
                    )}

                    {regType === 'join_team' && (
                      <div className="mt-6 mb-4 border-t border-[var(--border-2)] pt-6">
                        <h3 className="text-lg font-bold text-[var(--text)] flex items-center gap-2 mb-1">
                          <UserPlus className="text-blue-500" size={18} /> {t('auth.inviteCode')}
                        </h3>
                        <p className="text-xs text-[var(--text-soft)] mb-4">{t('auth.inviteDesc')}</p>
                        <input type="text" required value={joinCode}
                          onChange={e => setJoinCode(e.target.value.toUpperCase())}
                          className="w-full bg-[var(--surface-2)] border border-blue-500/50 rounded-xl p-3 text-[var(--text)] outline-none font-mono"
                          placeholder="INV-XXXXXXXX" />
                      </div>
                    )}
                  </>
                )}
                
                <div className="pt-2">
                  <label className="text-xs font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">Email</label>
                  <input type="email" required value={authEmail}
                    onChange={e => setAuthEmail(e.target.value)}
                    className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-[var(--text)] focus:border-[#8397aa] outline-none"
                    placeholder="mario@email.com" />
                </div>
                
                <div>
                  <label className="text-xs font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">Password</label>
                  <div className="relative">
                    <input type={showPassword ? 'text' : 'password'} required value={authPassword}
                      onChange={e => setAuthPassword(e.target.value)}
                      className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 pr-12 text-[var(--text)] focus:border-[#8397aa] outline-none"
                      placeholder="••••••••" />
                    <button type="button" onClick={() => setShowPassword(s => !s)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--text-soft)] hover:text-[var(--text)]">
                      {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                    </button>
                  </div>
                  {authMode === 'register' && (
                    <p className="text-[10px] text-[var(--text-soft)] mt-2">
                      {t('auth.pwdRule')}
                    </p>
                  )}
                </div>
              </>
            )}
            
            {authError && (
              <div className="bg-red-500/10 border border-red-500/30 p-3 rounded-lg text-red-400 text-sm">
                {authError}
                {authPasswordErrors.length > 0 && (
                  <ul className="mt-2 list-disc list-inside text-xs">
                    {authPasswordErrors.map((e: any, i) => <li key={i}>{typeof e === 'string' ? e : e.message}</li>)}
                  </ul>
                )}
              </div>
            )}
            
            {authMode === 'register' && (
              <div className="space-y-2 mt-4">
                {/* Privacy (obbligatorio) — riga grande tappabile, niente più mini-checkbox */}
                <button type="button" onClick={() => setPrivacyAccepted(v => !v)}
                  className="w-full flex items-start gap-3 text-left p-2.5 rounded-xl border border-[var(--border-2)] active:bg-white/5 transition-colors">
                  <span className={`mt-0.5 shrink-0 w-6 h-6 rounded-md border-2 flex items-center justify-center transition-colors ${privacyAccepted ? 'bg-[#8397aa] border-[#8397aa]' : 'border-[var(--border-3)]'}`}>
                    {privacyAccepted && <Check size={16} className="text-white" />}
                  </span>
                  <span className="text-[12px] text-[var(--text-soft)] leading-relaxed">
                    {t('auth.privacyPre')}{' '}
                    <span onClick={e => { e.stopPropagation(); setPrivacyOpen(true); }} className="text-[var(--text)] underline underline-offset-2">
                      {t('cookie.privacy')}
                    </span>
                    {' '}{t('auth.privacyPost')}{' '}
                    <span className="text-[var(--text-faint)]">{t('auth.required')}</span>
                  </span>
                </button>
                {/* Marketing (opzionale) */}
                <button type="button" onClick={() => setMarketingConsent(v => !v)}
                  className="w-full flex items-start gap-3 text-left p-2.5 rounded-xl border border-[var(--border-2)] active:bg-white/5 transition-colors">
                  <span className={`mt-0.5 shrink-0 w-6 h-6 rounded-md border-2 flex items-center justify-center transition-colors ${marketingConsent ? 'bg-[#8397aa] border-[#8397aa]' : 'border-[var(--border-3)]'}`}>
                    {marketingConsent && <Check size={16} className="text-white" />}
                  </span>
                  <span className="text-[12px] text-[var(--text-soft)] leading-relaxed">
                    {t('auth.marketingConsent')}{' '}
                    <span className="text-[var(--text-faint)]">{t('auth.optional')}</span>
                  </span>
                </button>
              </div>
            )}

            <button type="submit" disabled={authLoading}
              className="w-full bg-[#8397aa] hover:bg-[#9fb0bd] py-3 rounded-xl text-[var(--text)] font-bold transition-all disabled:opacity-50 mt-4 flex items-center justify-center">
              {authLoading ? <Loader2 className="animate-spin" size={20} /> :
                require2FA ? t('auth.verify2fa') : (authMode === 'login' ? t('auth.enter') : t('auth.register'))}
            </button>

            {authMode === 'login' && !require2FA && (
              <>
                {FACE_ID_ENABLED && (
                <button type="button" onClick={loginFaceId}
                  className="w-full mt-3 py-3 rounded-xl border border-[var(--border-2)] text-[var(--text)] font-bold text-sm flex items-center justify-center gap-2 hover:border-[#8397aa] transition-colors">
                  <ScanFace size={18} className="text-[#8397aa]" /> Entra con Face ID
                </button>
                )}
                <button type="button"
                  onClick={() => { setForgotEmail(authEmail); setForgotStep('email'); setForgotCode(''); setForgotNewPw(''); setForgotMsg(null); setForgotOpen(true); }}
                  className="w-full text-center text-xs text-[var(--text-soft)] hover:text-[var(--text)] mt-3 transition-colors font-semibold">
                  Password dimenticata?
                </button>
              </>
            )}
          </form>

          {/* Modale recupero password */}
          {forgotOpen && (
            <div className="fixed inset-0 z-[70] bg-black/80 backdrop-blur-sm flex items-center justify-center p-5" onClick={() => { if (!forgotBusy) setForgotOpen(false); }}>
              <div className="w-full max-w-sm bg-[var(--surface)] border border-[var(--border-2)] rounded-3xl p-6" onClick={e => e.stopPropagation()}>
                <div className="flex items-center justify-between mb-1">
                  <h3 className="text-lg font-extrabold text-[var(--text)]">Recupero password</h3>
                  <button onClick={() => setForgotOpen(false)} className="p-1.5 rounded-full text-[var(--text-faint)] hover:text-[var(--text)]"><X size={20} /></button>
                </div>
                {forgotStep === 'email' ? (
                  <>
                    <p className="text-sm text-[var(--text-soft)] mb-4">Inserisci la tua email: ti invieremo un codice per reimpostare la password.</p>
                    <input type="email" value={forgotEmail} onChange={e => setForgotEmail(e.target.value)} placeholder="mario@email.com" autoFocus
                      className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm text-[var(--text)] outline-none focus:border-[#8397aa]" />
                    {forgotMsg && <p className="text-xs text-red-400 mt-2">{forgotMsg}</p>}
                    <button disabled={forgotBusy || !forgotEmail.trim()}
                      onClick={async () => {
                        setForgotBusy(true); setForgotMsg(null);
                        const { ok, data } = await apiCall<any>('/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email: forgotEmail.trim() }) });
                        setForgotBusy(false);
                        if (!ok) { setForgotMsg(data?.error || 'Errore. Riprova.'); return; }
                        setForgotStep('code');
                      }}
                      className="w-full mt-4 py-3 rounded-xl bg-[#8397aa] hover:bg-[#6f8394] text-white font-bold disabled:opacity-40 flex items-center justify-center gap-2">
                      {forgotBusy && <Loader2 size={18} className="animate-spin" />} Invia codice
                    </button>
                  </>
                ) : (
                  <>
                    <p className="text-sm text-[var(--text-soft)] mb-4">Se l'email è registrata, ti abbiamo inviato un codice a <b className="text-[var(--text)]">{forgotEmail}</b>. Inseriscilo e scegli una nuova password.</p>
                    <input value={forgotCode} onChange={e => setForgotCode(e.target.value)} placeholder="Codice (6 cifre)" inputMode="numeric"
                      className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm text-[var(--text)] outline-none focus:border-[#8397aa] mb-2.5 tracking-[0.3em]" />
                    <input type="password" value={forgotNewPw} onChange={e => setForgotNewPw(e.target.value)} placeholder="Nuova password"
                      className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm text-[var(--text)] outline-none focus:border-[#8397aa]" />
                    <p className="text-[10px] text-[var(--text-faint)] mt-1.5">Min 10 caratteri: maiuscola, minuscola, numero e simbolo.</p>
                    {forgotMsg && <p className="text-xs text-red-400 mt-2">{forgotMsg}</p>}
                    <button disabled={forgotBusy || !forgotCode.trim() || !forgotNewPw}
                      onClick={async () => {
                        setForgotBusy(true); setForgotMsg(null);
                        const { ok, data } = await apiCall<any>('/auth/reset-password', { method: 'POST', body: JSON.stringify({ email: forgotEmail.trim(), code: forgotCode.trim(), newPassword: forgotNewPw }) });
                        setForgotBusy(false);
                        if (!ok) { setForgotMsg(data?.error || 'Codice non valido o scaduto.'); return; }
                        setForgotOpen(false);
                        setAuthEmail(forgotEmail.trim());
                        showToast('Password reimpostata. Accedi con la nuova password.', 'ok');
                      }}
                      className="w-full mt-4 py-3 rounded-xl bg-[#8397aa] hover:bg-[#6f8394] text-white font-bold disabled:opacity-40 flex items-center justify-center gap-2">
                      {forgotBusy && <Loader2 size={18} className="animate-spin" />} Reimposta password
                    </button>
                    <button onClick={() => { setForgotStep('email'); setForgotMsg(null); }} className="w-full mt-2 text-xs text-[var(--text-soft)] hover:text-[var(--text)]">← Rimanda il codice / cambia email</button>
                  </>
                )}
              </div>
            </div>
          )}
          
          <div className="mt-6 text-center">
            <button type="button"
              onClick={() => { setAuthMode(authMode === 'login' ? 'register' : 'login'); setAuthError(null); }}
              className="text-[var(--text-soft)] hover:text-[var(--text)] text-sm transition-colors font-bold">
              {authMode === 'login' ? t('auth.noAccount') : t('auth.haveAccount')}
            </button>
          </div>
          {/* Entra nella DEMO senza credenziali (utile per provare / registrare video). */}
          <div className="mt-3 text-center">
            <a href="/auth/demo-login"
              className="inline-flex items-center gap-1.5 text-[var(--text-faint)] hover:text-[var(--text)] text-[13px] transition-colors">
              👀 Prova la demo senza registrarti
            </a>
          </div>
          </>)}
        </div>
      </div>
    );
  }
  

  // ========================================
  // RENDER PRINCIPALE - APP AUTENTICATA
  // ========================================
  // Desktop = COCKPIT: altezza fissa, lo scroll avviene SOLO dentro <main> (cruscotto
  // inamovibile). Mobile resta a scroll di pagina normale.
  return (
    <div className="min-h-screen lg:h-screen lg:overflow-hidden lg:flex lg:flex-col text-[var(--text)] pb-[calc(var(--bottom-nav-h,84px)+84px)] lg:pb-0" style={{ fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'SF Pro Text', 'Helvetica Neue', system-ui, sans-serif", background: 'radial-gradient(120% 70% at 50% -25%, var(--page-glow, rgba(160,170,185,0.05)), transparent 55%), var(--bg)', paddingTop: 'var(--top-bar-h, 0px)' }}>

      {/* ========== TOP NAV (solo desktop) — barra orizzontale stile private banking ========== */}
      <header className="hidden lg:flex items-center gap-1 h-16 shrink-0 z-40 px-6 border-b border-[var(--border)] bg-[var(--surface)]">
        {/* Brand */}
        <span className="text-lg font-black mr-5 shrink-0 font-display txt-chrome">HQVault</span>
        {/* Nav orizzontale */}
        <nav className="flex items-center gap-0.5">
          {[
            { id: 'dashboard', label: t('nav.dashboard'), icon: LayoutDashboard },
            { id: 'magazzino', label: t('nav.magazzino'), icon: Package },
            { id: 'catalog', label: t('nav.catalog'), icon: Layers },
            ...(MARKETPLACE_ENABLED ? [
              { id: 'market', label: t('nav.market'), icon: Store },
              { id: 'chat', label: t('nav.messages'), icon: Mail },
            ] : []),
            { id: 'analytics', label: t('nav.analytics'), icon: BarChart3 },
            { id: 'tracking', label: t('nav.tracking'), icon: Truck },
          ].map(tab => {
            const Icon = tab.icon;
            const active = currentView === tab.id;
            const badge = tab.id === 'tracking'
              ? products.filter(p => p.trackingCode && ['PENDING','IN_TRANSIT','OUT_FOR_DELIVERY'].includes(p.trackingStatus || 'PENDING')).length
              : 0;
            return (
              <button key={tab.id} onClick={() => navigateTo(tab.id as any)}
                className={`relative flex items-center gap-2 px-3.5 py-2 rounded-xl text-[13.5px] font-semibold transition-colors ${
                  active ? 'bg-[#8397aa]/[0.12] text-[var(--text)]' : 'text-[var(--text-soft)] hover:bg-[var(--fill)] hover:text-[var(--text)]'
                }`}>
                {active && <span className="absolute left-1/2 -translate-x-1/2 bottom-0 w-6 h-[2px] bg-[#8397aa] rounded-full" />}
                <Icon size={16} /> {tab.label}
                {badge > 0 && <span className="min-w-[18px] h-[18px] px-1 bg-blue-500 text-white rounded-full text-[10px] font-bold flex items-center justify-center">{badge}</span>}
              </button>
            );
          })}
        </nav>
        {/* Cluster azioni a destra */}
        <div className="ml-auto flex items-center gap-1.5 shrink-0">
          <button onClick={() => setNotifPanelOpen(!notifPanelOpen)} aria-label={t('set.notifications')}
            className="relative p-2 rounded-xl hover:bg-[var(--fill)] text-[var(--text-muted)] hover:text-[var(--text)] transition-colors">
            <Bell size={18} />
            {unreadCount > 0 && <span className="absolute -top-0.5 -right-0.5 bg-[#8397aa] text-white text-[9px] font-bold rounded-full w-4 h-4 flex items-center justify-center">{unreadCount > 9 ? '9+' : unreadCount}</span>}
          </button>
          <button onClick={() => navigateTo('settings')} aria-label={t('nav.settings')}
            className={`p-2 rounded-xl transition-colors ${currentView === 'settings' ? 'text-[#8397aa]' : 'text-[var(--text-muted)] hover:bg-[var(--fill)] hover:text-[var(--text)]'}`}>
            <Settings size={18} />
          </button>
          {/* Menu "Altro" — Guide/Assistenza/Privacy/Wallet/Logout */}
          <div className="relative">
            <button onClick={() => setTopMenuOpen(o => !o)} aria-label={t('hdr.general')}
              className="p-2 rounded-xl text-[var(--text-muted)] hover:bg-[var(--fill)] hover:text-[var(--text)] transition-colors">
              <MoreHorizontal size={18} />
            </button>
            {topMenuOpen && (
              <>
                <div className="fixed inset-0 z-[59]" onClick={() => setTopMenuOpen(false)} />
                <div className="absolute right-0 top-full mt-2 w-56 z-[60] bg-[var(--surface)] border border-[var(--border-2)] rounded-2xl shadow-2xl overflow-hidden py-1">
                  {MARKETPLACE_ENABLED && (
                    <button onClick={() => { setTopMenuOpen(false); navigateTo('wallet'); }} className="w-full flex items-center gap-3 px-4 py-2.5 text-[13px] font-medium text-[var(--text-soft)] hover:bg-[var(--fill)] hover:text-[var(--text)] transition-colors"><Wallet size={16} /> {t('nav.wallet')}</button>
                  )}
                  <button onClick={() => { setTopMenuOpen(false); setGuideOpen(true); }} className="w-full flex items-center gap-3 px-4 py-2.5 text-[13px] font-medium text-[var(--text-soft)] hover:bg-[var(--fill)] hover:text-[var(--text)] transition-colors"><BookOpen size={16} /> {t('hdr.guide')}</button>
                  <button onClick={() => { setTopMenuOpen(false); setSupportOpen(true); }} className="w-full flex items-center gap-3 px-4 py-2.5 text-[13px] font-medium text-[var(--text-soft)] hover:bg-[var(--fill)] hover:text-[var(--text)] transition-colors"><HelpCircle size={16} /> {t('hdr.support')}</button>
                  <button onClick={() => { setTopMenuOpen(false); setPrivacyOpen(true); }} className="w-full flex items-center gap-3 px-4 py-2.5 text-[13px] font-medium text-[var(--text-soft)] hover:bg-[var(--fill)] hover:text-[var(--text)] transition-colors"><Lock size={16} /> {t('hdr.privacy')}</button>
                  <div className="h-px bg-[var(--border)] my-1" />
                  <button onClick={() => { setTopMenuOpen(false); handleLogout(); }} className="w-full flex items-center gap-3 px-4 py-2.5 text-[13px] font-medium text-[var(--text-soft)] hover:bg-red-500/10 hover:text-red-400 transition-colors"><LogOut size={16} /> {t('cmd.logout')}</button>
                </div>
              </>
            )}
          </div>
        </div>
      </header>

      {/* ========== HEADER (solo MOBILE) — in PORTAL su document.body così il `fixed` aggancia SEMPRE
           al viewport, fuori da qualsiasi antenato con transform/filter/contain che romperebbe il fixed. ========== */}
      {createPortal(
      <header ref={topBarRef} className="lux-underline fixed top-0 inset-x-0 z-40 lg:hidden bg-[var(--bg-blur)] backdrop-blur-xl"
        style={{ paddingTop: 'max(env(safe-area-inset-top), 12px)' }}>
        {/* Fascia PIENA sotto lo status bar (orario/batteria): resta opaca per tutta l'area di sicurezza
            (con fallback minimo se safe-area=0, es. webview senza notch) e poi sfuma → scorrendo, il
            contenuto svanisce sotto orario/batteria invece di collidere. Solo mobile. */}
        <div className="lg:hidden pointer-events-none absolute top-0 left-0 right-0" aria-hidden="true"
          style={{ height: 'calc(max(env(safe-area-inset-top), 12px) + 30px)',
                   background: 'linear-gradient(to bottom, var(--bg) 0%, var(--bg) calc(max(env(safe-area-inset-top), 12px) + 10px), transparent 100%)' }} />
        {/* Sfumatura SOTTO l'header (mobile): quando scorri, il contenuto sfuma dolcemente sotto la
            barra invece di tagliarsi con una linea netta. */}
        <div className="lg:hidden pointer-events-none absolute left-0 right-0 top-full h-6 bg-gradient-to-b from-[var(--bg-blur)] to-transparent" aria-hidden="true" />
        <div className="relative w-full max-w-[1280px] 2xl:max-w-[1440px] mx-auto px-4 lg:px-8 py-3.5 flex items-center">
          {/* Spacer sinistro (desktop): spinge le azioni a destra. Mobile: il logo resta a sinistra. */}
          <div className="hidden lg:block flex-1" />
          {/* Wordmark HQVault — su mobile a sinistra, nascosto su desktop (è nella sidebar) */}
          <div className="flex items-center lg:hidden">
            <span className="text-base font-black font-display txt-chrome">HQVault</span>
          </div>

          {/* Azioni a destra */}
          <div className="flex-1 flex items-center justify-end gap-1.5">
            {/* (Add spostato accanto al saluto della dashboard; Notifiche desktop nella sidebar.) */}
            {/* Portafoglio (solo mobile: icona in alto a destra, accesso rapido agli incassi) */}
            {MARKETPLACE_ENABLED && (
            <button onClick={() => navigateTo('wallet')}
              className={`lg:hidden p-2 rounded-xl transition-colors ${currentView === 'wallet' ? 'text-[#8397aa]' : 'text-[var(--text-muted)] hover:bg-[var(--fill)]'}`}>
              <Wallet size={18} />
            </button>
            )}
            {/* Impostazioni (solo mobile: in alto, visto che non è più nella barra in basso) */}
            <button onClick={() => navigateTo('settings')}
              className={`lg:hidden p-2 rounded-xl transition-colors ${currentView === 'settings' ? 'text-[#8397aa]' : 'text-[var(--text-muted)] hover:bg-[var(--fill)]'}`}>
              <Settings size={18} />
            </button>

            {/* Notifiche — SOLO mobile (su desktop la campanella è nella sidebar GENERAL). */}
            <button onClick={() => setNotifPanelOpen(!notifPanelOpen)}
              className="lg:hidden relative p-2 rounded-xl hover:bg-[var(--fill)] transition-colors">
              <Bell size={18} className="text-[var(--text-muted)]" />
              {unreadCount > 0 && (
                <span className="absolute -top-0.5 -right-0.5 bg-[#8397aa] text-[var(--text)] text-[9px] font-bold rounded-full w-4 h-4 flex items-center justify-center">
                  {unreadCount > 9 ? '9+' : unreadCount}
                </span>
              )}
            </button>

            {/* Pulsante Admin rimosso: la gestione è ora nel pannello separato su /admin */}

            <button onClick={() => navigateTo('settings')}
              className="p-2 rounded-xl hover:bg-[var(--fill)] transition-colors hidden sm:block lg:hidden">
              <Settings size={18} className="text-[var(--text-muted)]" />
            </button>

            <button onClick={handleLogout} title={t('cmd.logout')}
              className="p-2 rounded-xl hover:bg-[var(--fill)] transition-colors lg:hidden">
              <LogOut size={18} className="text-[var(--text-muted)]" />
            </button>
            
          </div>
        </div>
        
        {/* Tabs orizzontali rimosse: su desktop c'è la sidebar, sotto la barra in basso */}
        <nav className="border-t border-[var(--border)] hidden">
          <div className="w-full max-w-[1280px] 2xl:max-w-[1440px] mx-auto px-8">
            <div className="flex gap-0 justify-center">
              {[
                { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
                { id: 'magazzino', label: 'Magazzino', icon: Package },
                { id: 'analytics', label: 'Analytics', icon: BarChart3 },
                { id: 'tracking', label: 'Tracking', icon: Truck },
                { id: 'settings', label: 'Impostazioni', icon: Settings },
              ].map(tab => {
                const Icon = tab.icon;
                const active = currentView === tab.id;
                const trackingBadge = tab.id === 'tracking'
                  ? products.filter(p => p.trackingCode && ['PENDING','IN_TRANSIT','OUT_FOR_DELIVERY'].includes(p.trackingStatus || 'PENDING')).length
                  : 0;
                return (
                  <button key={tab.id} onClick={() => navigateTo(tab.id as any)}
                    className={`relative flex items-center gap-2.5 px-6 py-4 text-[15px] font-semibold tracking-wide transition-colors ${
                      active ? 'text-[var(--text)]' : 'text-[var(--text-soft)] hover:text-gray-300'
                    }`}>
                    {active && (
                      <span className="absolute bottom-0 left-1/2 -translate-x-1/2 w-10 h-0.5 bg-[#8397aa] rounded-full" />
                    )}
                    <Icon size={18} /> {tab.label}
                    {trackingBadge > 0 && (
                      <span className="w-4 h-4 bg-blue-500 text-[var(--text)] rounded-full text-[9px] font-semibold flex items-center justify-center">
                        {trackingBadge}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        </nav>
      </header>, document.body)}

      {/* ===== PANNELLO NOTIFICHE (indipendente): mobile in alto centrato, desktop ancorato in
           basso a sinistra vicino alla sidebar. Backdrop trasparente per chiudere al tap-fuori. ===== */}
      {notifPanelOpen && (
        <>
          <div className="fixed inset-0 z-[59]" onClick={() => setNotifPanelOpen(false)} />
          <div className="fixed z-[60] left-1/2 -translate-x-1/2 top-16 w-[calc(100vw-1.5rem)] max-w-sm lg:left-auto lg:right-5 lg:translate-x-0 lg:top-[68px] lg:w-96 bg-[var(--surface-blur)] backdrop-blur-2xl border border-[var(--border-2)] rounded-2xl shadow-2xl overflow-hidden">
            <div className="p-4 border-b border-[var(--border)] flex justify-between items-center">
              <h3 className="font-semibold text-sm">{t('set.notifications')}</h3>
              {unreadCount > 0 && (
                <button onClick={markAllNotificationsRead} className="text-xs text-[var(--text-soft)] hover:text-gray-300 transition-colors">{t('hdr.markAllRead')}</button>
              )}
            </div>
            <div className="max-h-96 overflow-y-auto">
              {notifications.length === 0 ? (
                <p className="p-8 text-center text-[var(--text-soft)] text-sm">{t('hdr.noNotifs')}</p>
              ) : (
                notifications.map((n: any) => (
                  <button key={n.id} onClick={() => markNotificationRead(n.id)}
                    className={`w-full text-left p-3.5 border-b border-[var(--border)] hover:bg-[var(--fill)] transition-colors ${!n.read ? 'bg-[var(--fill)]' : ''}`}>
                    <div className="flex items-start gap-3">
                      {!n.read && <div className="w-1.5 h-1.5 rounded-full bg-[#8397aa] mt-1.5 shrink-0" />}
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold text-[var(--text)] truncate">{n.title}</p>
                        <p className="text-xs text-[var(--text-soft)] mt-0.5">{n.message}</p>
                        <p className="text-[10px] text-[var(--text-faint)] mt-1">{new Date(n.createdAt).toLocaleString('it-IT')}</p>
                      </div>
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>
        </>
      )}

      <main key={currentView} className="w-full max-w-[1280px] 2xl:max-w-[1440px] mx-auto px-4 lg:px-8 py-5 lg:py-8 pb-36 lg:pb-40 animate-fade-in lg:flex-1 lg:overflow-y-auto lg:min-h-0">

        {/* ========== DASHBOARD ========== */}
        {currentView === 'dashboard' && (
          <div className="space-y-5 lg:space-y-7">

            {/* Header: saluto a sinistra + Add sulla STESSA riga (desktop), allineati in alto. */}
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <h2 className="text-[26px] sm:text-3xl lg:text-[34px] font-black leading-tight pb-0.5 tracking-tight">
                  {(() => {
                    const h = new Date().getHours();
                    return (h >= 5 && h < 12) ? (lang === 'en' ? 'Good morning' : 'Buongiorno')
                      : (h >= 12 && h < 14) ? (lang === 'en' ? 'Hello' : 'Salve')             // mezzogiorno
                      : (h >= 14 && h < 18) ? (lang === 'en' ? 'Good afternoon' : 'Buon pomeriggio')
                      : (h >= 18 && h < 23) ? (lang === 'en' ? 'Good evening' : 'Buonasera')
                      : (lang === 'en' ? 'Hello' : 'Salve');                                    // notte
                  })()}, <span className="text-[var(--text)] font-black">{user.name.split(' ')[0]}</span>
                </h2>
                <p className="text-[12px] lg:text-[13px] text-[var(--text-faint)] font-semibold uppercase tracking-[0.1em] mt-1.5 capitalize truncate">{new Date().toLocaleDateString(dateLocale, { weekday: 'long', day: 'numeric', month: 'long' })}</p>
              </div>
              {/* Add — sulla riga del saluto (desktop). Su mobile resta il "+" nella chatbox. */}
              <button onClick={() => openAddForm()}
                className="hidden lg:flex shrink-0 items-center gap-2 bg-[#8397aa] hover:bg-[#6f8394] text-white px-4 py-2.5 rounded-xl text-sm font-semibold transition-colors active:scale-95 mt-1">
                <Plus size={16} /> {t('common.add')}
              </button>
            </div>

            {/* Quanto lo pago? — strumento sourcing (prezzo max d'acquisto). DISATTIVATO finché
                non colleghiamo fonti affidabili per categoria (eBay generico dava prezzi falsi). */}
            {VALUATION_ENABLED && (
            <button onClick={openSourcing}
              className="w-full flex items-center justify-center gap-2 py-3 rounded-2xl border border-[#8397aa]/30 bg-[#8397aa]/[0.06] hover:bg-[#8397aa]/[0.12] text-sm font-bold text-[var(--text)] transition-colors">
              <DollarSign size={16} className="text-[#8397aa]" />
              {t('dash.valueLookup')} <span className="text-[var(--text-soft)] font-medium hidden sm:inline">· {t('dash.valueLookupSub')}</span>
            </button>
            )}

            {/* Welcome / primo avvio — solo DOPO il caricamento, se davvero vuoto (niente flash ad ogni apertura) */}
            {productsLoaded && products.length === 0 && (
              <section className="bg-[var(--surface)] border border-[#8397aa]/30 rounded-2xl p-6 lg:p-7 relative overflow-hidden">
                <div className="absolute inset-0 bg-[#8397aa]/[0.04] pointer-events-none" />
                <div className="relative">
                  <p className="text-[10px] font-bold text-[#8397aa] uppercase tracking-[0.12em] mb-2 flex items-center gap-1.5"><Sparkles size={12} /> {t('dash.welcome')}</p>
                  <h3 className="text-xl lg:text-2xl font-bold mb-1.5">{t('dash.welcomeTitle')}</h3>
                  <p className="text-sm text-[var(--text-soft)] mb-5 max-w-md">{t('dash.welcomeDesc')}</p>
                  <div className="flex flex-wrap gap-2">
                    <button onClick={() => openAddForm()}
                      className="bg-[#8397aa] hover:bg-[#6f8394] text-white px-5 py-2.5 rounded-xl font-bold text-sm flex items-center gap-2 transition-colors active:scale-95">
                      <Plus size={16} /> {t('dash.addFirst')}
                    </button>
                    <button onClick={() => navigateTo('settings')}
                      className="bg-[var(--surface-2)] border border-[var(--border-2)] hover:border-[var(--border-3)] text-[var(--text-soft)] hover:text-[var(--text)] px-5 py-2.5 rounded-xl font-bold text-sm flex items-center gap-2 transition-colors">
                      <Download size={15} /> {t('mag.importExcel')}
                    </button>
                  </div>
                </div>
              </section>
            )}

            {/* KPI + NOTE + GRAFICO — mobile: Personal+Note in riga, poi grafico. Desktop:
                Personal in alto-sx, GRAFICO grande in basso-sx, NOTE alte a destra (coprono il lato). */}
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 lg:gap-5 lg:items-stretch">
              {/* Riga Personal: su desktop divisa a metà — sx PERSONAL (profitto/periodo), dx DA SPEDIRE
                  (pacchi in attesa → apre il Tracking). Su mobile: solo Personal (il tracking è nella bottom-nav). */}
              <div className="lg:col-span-2 grid grid-cols-1 lg:grid-cols-2 gap-3 lg:gap-5">
                <button onClick={() => { setPpFrom(personalPeriod.from || ''); setPpTo(personalPeriod.to || ''); setPeriodPickerOpen(true); }}
                  className="mech text-left bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-3.5 lg:p-4 hover:border-[var(--border-2)] group flex flex-col">
                  <div className="flex items-center justify-between mb-2 lg:mb-2.5">
                    <span className="flex items-center gap-2 text-[10px] lg:text-[11px] uppercase tracking-[0.14em] font-bold text-[var(--text-faint)]">
                      <span className="w-6 h-6 lg:w-7 lg:h-7 rounded-lg bg-[var(--fill)] flex items-center justify-center"><Wallet size={13} className="text-[var(--text-soft)]" /></span>
                      {t('dash.personal')}
                    </span>
                    <ChevronDown size={14} className="text-[var(--text-faint)] group-hover:text-[var(--text-soft)] transition-colors shrink-0" />
                  </div>
                  <p className="text-[26px] lg:text-[30px] font-black num text-[var(--teal)] leading-none tracking-tight">{periodProfit.toFixed(0)}€</p>
                  <p className="text-[12px] lg:text-[13px] text-[var(--text-faint)] mt-1.5 truncate capitalize font-semibold">{periodLabel}</p>
                </button>
                {/* Box SMART: mostra la cosa più urgente — da spedire → fermi >30gg → valore stock. */}
                {(() => {
                  const shipN = toShipItems.length;
                  const staleN = products.filter((p: any) => p.status === 'IN STOCK' && (p.oldestDate || p.createdAt) && (Date.now() - new Date(p.oldestDate || p.createdAt).getTime()) / 86400000 > 30).length;
                  let icon, label, value, sub, onClick, valColor;
                  if (shipN > 0) {
                    icon = <Truck size={13} />; label = t('nav.tracking'); value = String(shipN); sub = t('dash.toShip'); valColor = 'text-[var(--text)]';
                    onClick = () => navigateTo('tracking');
                  } else if (staleN > 0) {
                    icon = <AlertTriangle size={13} />; label = t('dash.stale'); value = String(staleN); sub = t('dash.staleSub'); valColor = 'text-amber-400';
                    onClick = () => { setStaleOnly(true); navigateTo('magazzino'); };
                  } else {
                    icon = <Wallet size={13} />; label = t('mag.stockValue'); value = `${Math.round(stockValore).toLocaleString('it-IT')}€`; sub = t('dash.stock'); valColor = 'text-[#9fb0bd]';
                    onClick = () => navigateTo('magazzino');
                  }
                  return (
                    <button onClick={onClick}
                      className="mech text-left bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-3.5 lg:p-4 hover:border-[var(--border-2)] group hidden lg:flex lg:flex-col">
                      <div className="flex items-center justify-between mb-2 lg:mb-2.5">
                        <span className="flex items-center gap-2 text-[10px] lg:text-[11px] uppercase tracking-[0.14em] font-bold text-[var(--text-faint)]">
                          <span className="w-6 h-6 lg:w-7 lg:h-7 rounded-lg bg-[var(--fill)] flex items-center justify-center text-[var(--text-soft)]">{icon}</span>
                          {label}
                        </span>
                        <ChevronDown size={14} className="-rotate-90 text-[var(--text-faint)] group-hover:text-[var(--text-soft)] transition-colors shrink-0" />
                      </div>
                      <p className={`text-[26px] lg:text-[30px] font-black num leading-none tracking-tight ${valColor}`}>{value}</p>
                      <p className="text-[12px] lg:text-[13px] text-[var(--text-faint)] mt-1.5 truncate font-semibold">{sub}</p>
                    </button>
                  );
                })()}
              </div>

              {/* NOTE / TASK — desktop: colonna ALTA a destra (row-span-2). */}
              <button onClick={() => setTaskPanelOpen(true)}
                className="mech text-left bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-4 lg:p-5 hover:border-[var(--border-2)] group flex flex-col lg:row-span-2 lg:h-full">
                {/* Header NOTE — icona in chip + conteggio (coerente con le KPI). */}
                <div className="flex items-center justify-between mb-3 lg:mb-4">
                  <span className="flex items-center gap-2 text-[10px] lg:text-[11px] uppercase tracking-[0.14em] font-bold text-[var(--text-faint)]">
                    <span className="w-6 h-6 lg:w-7 lg:h-7 rounded-lg bg-[var(--fill)] flex items-center justify-center"><StickyNote size={13} className="text-[var(--text-soft)]" /></span>
                    {t('task.title')}
                  </span>
                  {tasks.filter(x => !x.done).length > 0 && <span className="text-[10px] lg:text-[11px] font-bold bg-[#8397aa]/15 text-[#9fb0bd] px-2 py-0.5 rounded-full num">{tasks.filter(x => !x.done).length}</span>}
                </div>
                {tasks.filter(x => !x.done).length === 0 ? (
                  <p className="text-[12px] lg:text-sm text-[var(--text-faint)] leading-snug flex-1">{t('task.empty')}</p>
                ) : (
                  <div className="space-y-2 lg:space-y-3 flex-1">
                    {/* 2 note su mobile, fino a 7 su desktop (la card è alta). Testo più grande su PC. */}
                    {tasks.filter(x => !x.done).slice(0, 2).map(tk => (
                      <p key={tk.id} className="text-[12.5px] lg:text-[14.5px] text-[var(--text-soft)] truncate flex items-center gap-2.5"><span className="w-1.5 h-1.5 rounded-full bg-[#8397aa] shrink-0" />{tk.summary || tk.text}</p>
                    ))}
                    {tasks.filter(x => !x.done).slice(2, 7).map(tk => (
                      <p key={tk.id} className="hidden lg:flex text-[14.5px] text-[var(--text-soft)] truncate items-center gap-2.5"><span className="w-1.5 h-1.5 rounded-full bg-[#8397aa] shrink-0" />{tk.summary || tk.text}</p>
                    ))}
                  </div>
                )}
                <p className="text-[11px] lg:text-[13px] text-[#9fb0bd] font-bold mt-3 lg:mt-4 group-hover:text-[#c0cbd6] transition-colors">{t('dash.see')} →</p>
              </button>

              {/* Grafico Andamento Vendite — nella STESSA griglia: mobile a tutta larghezza sotto,
                  desktop grande in basso-sinistra (col-span-2) accanto alle Note alte. */}
              {hasAdvancedAnalytics ? (
              <section className="col-span-2 lg:col-span-2 flex flex-col bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-4">
                <div className="flex items-start justify-between gap-2 mb-3 flex-wrap">
                  <div className="min-w-0">
                    <h3 className="text-lg lg:text-xl font-bold">{t('an.salesTrend')}</h3>
                    {/* Legenda subito sotto il titolo (colori allineati al grafico). */}
                    <div className="flex items-center gap-4 mt-1.5">
                      <div className="flex items-center gap-2 text-[13px] font-semibold text-[var(--text-soft)]"><span className="w-4 h-[3px] rounded-full inline-block" style={{ background: '#5e86b5' }} />{t('an.revenue')}</div>
                      <div className="flex items-center gap-2 text-[13px] font-semibold text-[var(--text-soft)]"><span className="w-4 h-[3px] rounded-full inline-block" style={{ background: '#e6ebf0' }} />{t('dash.profit')}</div>
                    </div>
                  </div>
                  {/* Il periodo si sceglie dalla card "Personal": qui mostro solo l'etichetta (tap → selettore). */}
                  <button onClick={() => { setPpFrom(personalPeriod.from || ''); setPpTo(personalPeriod.to || ''); setPeriodPickerOpen(true); }}
                    className="flex items-center gap-1.5 bg-[var(--surface-2)] px-3.5 py-2 rounded-xl border border-[var(--border-2)] text-[13px] font-bold text-[var(--text-soft)] hover:text-[var(--text)] shrink-0 capitalize">
                    {periodLabel} <ChevronDown size={14} />
                  </button>
                </div>
                {trendData.length === 0 ? (
                  <div className="flex-1 flex flex-col items-center justify-center py-10 text-center">
                    <BarChart3 className="text-[var(--text-faint)] mb-3" size={36} />
                    <p className="text-[var(--text-soft)] text-sm">{t('an.noDataPeriod')}</p>
                  </div>
                ) : (
                  <div className="h-[200px] lg:h-[300px]">
                    <Suspense fallback={<div className="h-full flex items-center justify-center"><Loader2 className="animate-spin text-[var(--text-faint)]" size={28} /></div>}>
                      <TrendChart trendData={trendData} />
                    </Suspense>
                  </div>
                )}
              </section>
              ) : (
              <section className="col-span-2 lg:col-span-2 flex flex-col items-center justify-center text-center bg-[var(--surface)] border border-[#8397aa]/30 rounded-2xl p-5">
                <div className="w-12 h-12 rounded-2xl bg-[#8397aa]/15 flex items-center justify-center mb-3"><BarChart3 size={22} className="text-[#8397aa]" /></div>
                <h3 className="font-bold mb-1">Andamento e analisi avanzate</h3>
                <p className="text-sm text-[var(--text-soft)] mb-4 max-w-xs">ROI, trend storico e performance per categoria/piattaforma sono inclusi nel piano Pro.</p>
                <button onClick={() => openPlanModal()} className="bg-[#8397aa] hover:bg-[#6f8394] text-white px-5 py-2.5 rounded-xl font-bold text-sm transition-colors">Sblocca con Pro</button>
              </section>
              )}
            </div>

            {/* MOBILE: al posto del Libro Paga, due tabelle affiancate — migliori Buyer e Seller.
                Tocca "Vedi tutti" per l'elenco completo con il numero di operazioni. Su desktop
                queste (+ Insights + Libro Paga) vivono in Analytics. */}
            <div className="grid grid-cols-2 gap-3 lg:hidden">
              {(() => {
                // Buyer/seller del PERIODO scelto in Personal (vendite per soldAt, acquisti per createdAt).
                const buyerAgg: any[] = Object.values(products.filter((p: any) => p.status === 'VENDUTO' && (p.customer || '').trim() && inPersonalPeriod(p.soldAt || p.createdAt)).reduce((acc: any, p: any) => {
                  const n = (p.customer || '').trim(); if (!acc[n]) acc[n] = { name: n, count: 0, revenue: 0 };
                  acc[n].count++; acc[n].revenue += (p.salePrice || 0); return acc;
                }, {})).sort((a: any, b: any) => b.revenue - a.revenue);
                const sellerAgg: any[] = Object.values(products.filter((p: any) => (p.supplier || '').trim() && inPersonalPeriod(p.createdAt)).reduce((acc: any, p: any) => {
                  const n = (p.supplier || '').trim(); if (!acc[n]) acc[n] = { name: n, count: 0, spent: 0 };
                  acc[n].count++; acc[n].spent += (p.purchasePrice || 0); return acc;
                }, {})).sort((a: any, b: any) => b.spent - a.spent);
                const Card = ({ title, icon, rows, accent, onAll }: any) => (
                  <div className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-3">
                    <div className="flex items-center gap-1.5 mb-2">{icon}<p className="text-[11px] font-bold truncate">{title}</p></div>
                    {rows.length === 0 ? <p className="text-[10px] text-[var(--text-faint)] py-2">{t('ct.noneYet')}</p> : (
                      <div className="space-y-1">
                        {rows.slice(0, 3).map((r: any, i: number) => (
                          <div key={i} className="flex items-center justify-between gap-1 text-[11px]">
                            <span className="truncate text-[var(--text-soft)]">{r.name}</span>
                            <span className={`shrink-0 font-bold num ${accent}`}>×{r.count}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    {rows.length > 0 && (
                      <button onClick={onAll} className="mt-2 text-[10px] font-bold text-[#8397aa]">{t('ct.seeAll')}</button>
                    )}
                  </div>
                );
                return (<>
                  <Card title={t('ct.topBuyers')} icon={<Users size={12} className="text-emerald-400" />} rows={buyerAgg} accent="text-emerald-400"
                    onAll={() => { setContactPageExpanded(null); setContactsPage('buyers'); }} />
                  <Card title={t('ct.topSellers')} icon={<Package size={12} className="text-[#8397aa]" />} rows={sellerAgg} accent="text-[#8397aa]"
                    onAll={() => { setContactPageExpanded(null); setContactsPage('sellers'); }} />
                </>);
              })()}
            </div>

            {/* Spedizioni in corso */}
            {(() => {
              const active = products.filter((p: any) => p.trackingCode && ['PENDING', 'IN_TRANSIT', 'OUT_FOR_DELIVERY'].includes(p.trackingStatus || 'PENDING'));
              const stLabel = (s?: string) => {
                if (s === 'IN_TRANSIT') return { t: t('track.stInTransit'), c: 'bg-blue-500/20 text-blue-400' };
                if (s === 'OUT_FOR_DELIVERY') return { t: t('track.stOutForDelivery'), c: 'bg-[#8397aa]/20 text-[#9fb0bd]' };
                if (s === 'EXCEPTION') return { t: t('track.stException'), c: 'bg-red-500/20 text-red-400' };
                return { t: t('track.stPending'), c: 'bg-[var(--fill)] text-[var(--text-soft)]' };
              };
              return (
                <section className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-5">
                  <div className="flex items-center justify-between mb-4">
                    <p className="text-[9px] font-semibold text-[var(--text-faint)] tracking-[0.12em] uppercase flex items-center gap-2"><Truck size={12} /> {t('home.shipmentsInProgress')}{active.length > 0 ? ` (${active.length})` : ''}</p>
                    <button onClick={() => navigateTo('tracking')} className="text-[10px] text-[var(--text-faint)] hover:text-[var(--text-muted)] transition-colors">{t('home.seeAll')}</button>
                  </div>
                  {active.length === 0 ? (
                    <p className="text-sm text-[var(--text-soft)] text-center py-4">{t('home.noShipments')}</p>
                  ) : (
                    <div className="space-y-2">
                      {active.slice(0, 5).map((p: any) => {
                        const st = stLabel(p.trackingStatus);
                        return (
                          <div key={p.id} onClick={() => navigateTo('tracking')}
                            className="flex items-center gap-3 p-2.5 rounded-xl hover:bg-[var(--fill)] cursor-pointer transition-colors">
                            <span className="text-xl shrink-0">{getCategoryIcon(p.category)}</span>
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-bold truncate">{fullName(p.brand, p.name)}</p>
                              <p className="text-[10px] text-[var(--text-faint)] font-mono truncate">{p.trackingCarrier || t('home.carrier')} · {p.trackingCode}</p>
                            </div>
                            <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold shrink-0 ${st.c}`}>{st.t}</span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </section>
              );
            })()}

            {/* Catalogo che scorre — SOTTO tutto (scambiato con le spedizioni). */}
            {dashPopular.length > 0 && (
              <section>
                <div className="flex items-center justify-between mb-3">
                  <p className="sys-label">{t('dash.fromCatalog')}</p>
                  <button onClick={() => navigateTo('catalog')} className="text-xs font-bold text-[#8397aa] hover:text-[#9fb0bd] transition-colors">{t('dash.openCatalog')}</button>
                </div>
                <div className="relative overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] py-3 cursor-pointer"
                  onClick={() => navigateTo('catalog')}>
                  <div className="flex gap-3.5 px-3 animate-marquee" style={{ width: 'max-content' }}>
                    {[...dashPopular, ...dashPopular].map((it, i) => (
                      <div key={i} className="w-28 shrink-0">
                        <div className="w-28 h-28 rounded-xl bg-[#ededf1] overflow-hidden flex items-center justify-center border border-[var(--border-2)] p-1.5">
                          {it.image ? <img src={proxyImg(it.image)} alt="" loading="lazy" className="w-full h-full object-contain" /> : null}
                        </div>
                        <p className="text-[11.5px] text-[var(--text-soft)] mt-1.5 truncate leading-tight">{it.name}</p>
                      </div>
                    ))}
                  </div>
                  <div className="pointer-events-none absolute inset-y-0 left-0 w-10 bg-gradient-to-r from-[var(--surface)] to-transparent" />
                  <div className="pointer-events-none absolute inset-y-0 right-0 w-10 bg-gradient-to-l from-[var(--surface)] to-transparent" />
                </div>
              </section>
            )}
          </div>
        )}

        {/* ========== MAGAZZINO ========== */}
        {currentView === 'magazzino' && (
          <div className="space-y-3 lg:space-y-5">
            {/* Banner UNIONE REPARTI: rileva reparti sinonimi (Vestiti/Vestiario/Abbigliamento) e
                propone di unirli in uno solo. Riassegna i prodotti sul server. */}
            {!dismissedMerge && dupCategoryGroups.length > 0 && (
              <div className="bg-[#8397aa]/10 border border-[#8397aa]/30 rounded-2xl p-4">
                <div className="flex items-start gap-2">
                  <Layers size={16} className="text-[#8397aa] shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-bold text-[var(--text)]">{t('cat.mergeTitle')}</p>
                    <p className="text-[11px] text-[var(--text-soft)] mb-2">{t('cat.mergeHint')}</p>
                    <div className="space-y-2">
                      {dupCategoryGroups.map((group, gi) => (
                        <div key={gi} className="flex items-center gap-2 flex-wrap bg-[var(--surface)] border border-[var(--border)] rounded-xl px-3 py-2">
                          <span className="text-xs text-[var(--text-soft)] min-w-0">{group.join(' · ')}</span>
                          <span className="text-[11px] text-[var(--text-faint)]">{t('cat.mergeInto')}</span>
                          {group.map(target => (
                            <button key={target} disabled={mergingCat} onClick={() => mergeCategoryGroup(group, target)}
                              className="text-[11px] font-bold px-2.5 py-1 rounded-full bg-[#8397aa]/15 text-[#8397aa] hover:bg-[#8397aa]/25 disabled:opacity-50 transition-colors">
                              {mergingCat ? '…' : target}
                            </button>
                          ))}
                        </div>
                      ))}
                    </div>
                  </div>
                  <button onClick={() => setDismissedMerge(true)} className="text-[var(--text-faint)] hover:text-[var(--text)] shrink-0"><X size={16} /></button>
                </div>
              </div>
            )}

            {/* Banner riprezzamento: prodotti fermi da oltre 30 giorni → apre lo strumento Pro */}
            {magazzinoView === 'instock' && (() => {
              const staleCount = products.filter((p: any) => p.status === 'IN STOCK' && (p.oldestDate || p.createdAt) && (Date.now() - new Date(p.oldestDate || p.createdAt).getTime()) / 86400000 > 30).length;
              if (staleCount === 0) return null;
              return (
                <button onClick={() => openPlanModal('repricing')}
                  className="w-full flex items-center justify-between gap-3 bg-yellow-500/10 border border-yellow-500/30 rounded-2xl px-4 py-3 hover:bg-yellow-500/15 transition-colors">
                  <span className="flex items-center gap-2 text-sm font-bold text-yellow-500"><AlertTriangle size={16} /> {staleCount} {t('mag.staleProducts')}</span>
                  <span className="text-xs font-bold text-yellow-400 shrink-0">{t('mag.reprice')}</span>
                </button>
              );
            })()}
            {/* Riga 1: titolo + toggle IN STOCK/VENDUTI accanto, ricerca inline su desktop */}
            <div className="flex flex-col lg:flex-row lg:items-center gap-3">
              <div className="flex flex-col gap-2 lg:flex-row lg:items-center shrink-0 w-full lg:w-auto lg:gap-4">
                <h2 className="text-xl lg:text-3xl font-semibold leading-none lg:mt-0.5">{t('mag.title')}</h2>
                <div className="flex bg-[var(--surface-2)] p-1 rounded-xl border border-[var(--border-2)] w-full lg:w-auto lg:ml-1">
                  <button onClick={() => { setMagazzinoView('instock'); setBulkMode(false); setSelectedGroupKeys(new Set()); }}
                    className={`flex-1 lg:flex-none px-2 lg:px-4 py-1.5 text-[11px] lg:text-xs font-bold rounded-lg transition-colors whitespace-nowrap ${
                      magazzinoView === 'instock' ? 'bg-[#8397aa] text-[var(--text)]' : 'text-[var(--text-soft)]'
                    }`}>{t('mag.inStock')}</button>
                  <button onClick={() => { setMagazzinoView('sold'); setBulkMode(false); setSelectedGroupKeys(new Set()); }}
                    className={`flex-1 lg:flex-none px-2 lg:px-4 py-1.5 text-[11px] lg:text-xs font-bold rounded-lg transition-colors whitespace-nowrap ${
                      magazzinoView === 'sold' ? 'bg-green-600 text-[var(--text)]' : 'text-[var(--text-soft)]'
                    }`}>{t('mag.sold')}</button>
                </div>
                {bulkMode && (
                  <button onClick={() => { setBulkMode(false); setSelectedGroupKeys(new Set()); }}
                    className="px-3 py-1.5 text-xs font-bold rounded-xl border bg-[#8397aa] border-[#8397aa] text-[var(--text)] transition-colors">
                    ✕ {t('common.cancel')}
                  </button>
                )}
              </div>

              {/* Ricerca + reparto — inline su desktop, impilati su mobile */}
              <div className="flex flex-col lg:flex-row gap-2 lg:gap-3 lg:flex-1 lg:justify-end mt-2 lg:mt-0">
                <div className="relative flex-1 lg:max-w-md">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-soft)]" size={16} />
                  <input type="text" placeholder={t('mag.searchPlaceholder')}
                    value={searchTerm} onChange={(e: any) => setSearchTerm(e.target.value)}
                    className="w-full bg-[var(--surface-2)] border border-[var(--border)] rounded-xl pl-10 pr-4 py-2.5 text-sm focus:border-[#8397aa] outline-none" />
                </div>
                <select value={filterCat} onChange={(e: any) => setFilterCat(e.target.value)}
                  className="w-full lg:w-auto bg-[var(--surface-2)] border border-[var(--border)] rounded-xl px-3 py-2.5 text-sm focus:border-[#8397aa] outline-none shrink-0">
                  <option value="all">{t('mag.allDepartments')}</option>
                  {userCategories.map((c: string) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
            </div>

            {magazzinoView === 'instock' && (
              <div className="flex flex-col lg:flex-row lg:flex-wrap gap-2 lg:items-center">
                {/* Ordina */}
                <div className="flex flex-wrap gap-2 items-center">
                  <span className="w-full lg:w-auto text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest flex items-center gap-1">
                    <ArrowUpDown size={12} /> {t('mag.sortBy')}
                  </span>
                  {(['date','price','name'] as const).map(f => (
                    <button key={f} onClick={() => {
                      if (sortField === f) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
                      else { setSortField(f); setSortDir('desc'); }
                    }}
                      className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-colors ${
                        sortField === f ? 'bg-[#8397aa] text-[var(--text)]' : 'bg-[var(--surface-2)] border border-[var(--border)] text-[var(--text-soft)] hover:text-[var(--text)]'
                      }`}>
                      {f === 'date' ? t('mag.sortDate') : f === 'price' ? t('mag.sortPrice') : f === 'name' ? t('mag.sortName') : t('mag.sortMargin')}
                      {sortField === f && (sortDir === 'desc' ? ' ↓' : ' ↑')}
                    </button>
                  ))}
                  {/* Filtro rapido: Fermi (+30gg in stock) */}
                  <button onClick={() => setStaleOnly(s => !s)}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold transition-colors ${
                      staleOnly ? 'bg-red-500/20 text-red-400 border border-red-500/40' : 'bg-[var(--surface-2)] border border-[var(--border)] text-[var(--text-soft)] hover:text-[var(--text)]'
                    }`}>
                    <AlertTriangle size={12} /> {t('dash.stale')}
                  </button>
                </div>
                {/* Condizione */}
                <select value={filterCondition} onChange={(e: any) => setFilterCondition(e.target.value)}
                  className="w-full lg:w-auto lg:ml-auto bg-[var(--surface-2)] border border-[var(--border)] rounded-xl px-3 py-1.5 text-xs focus:border-[#8397aa] outline-none text-[var(--text-muted)]">
                  <option value="all">{t('mag.condition')}</option>
                  <option value="DS">DS</option>
                  <option value="VNDS">VNDS</option>
                  <option value="Used">Used</option>
                </select>
                {/* Prezzo */}
                <div className="flex gap-2">
                  <input type="number" placeholder="Min €" value={filterPriceMin}
                    onChange={(e: any) => setFilterPriceMin(e.target.value)}
                    className="w-16 bg-[var(--surface-2)] border border-[var(--border)] rounded-xl px-2.5 py-1.5 text-xs focus:border-[#8397aa] outline-none text-[var(--text-muted)]" />
                  <input type="number" placeholder="Max €" value={filterPriceMax}
                    onChange={(e: any) => setFilterPriceMax(e.target.value)}
                    className="w-16 bg-[var(--surface-2)] border border-[var(--border)] rounded-xl px-2.5 py-1.5 text-xs focus:border-[#8397aa] outline-none text-[var(--text-muted)]" />
                </div>
              </div>
            )}
            
            {/* Barra riassuntiva del set filtrato (solo in stock) */}
            {magazzinoView === 'instock' && groupedInStockArray.length > 0 && (() => {
              const pezzi = groupedInStockArray.reduce((a: number, g: any) => a + g.quantity, 0);
              const costo = groupedInStockArray.reduce((a: number, g: any) => a + g.purchasePrice * g.quantity, 0);
              return (
                <div className="flex flex-wrap items-center gap-x-5 gap-y-2 px-4 lg:px-5 py-3 lg:py-3.5 bg-[var(--surface)] border border-[var(--border)] rounded-2xl">
                  {/* Lettura "strumento": numero grande + micro-etichetta, divisori a filo. */}
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-lg lg:text-xl font-black num text-[var(--text)] leading-none">{pezzi}</span>
                    <span className="text-[10px] lg:text-[11px] uppercase tracking-[0.12em] font-bold text-[var(--text-faint)]">{t('mag.pieces')}</span>
                  </div>
                  <span className="hidden sm:block w-px h-4 bg-[var(--border-2)]" />
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-lg lg:text-xl font-black num text-[var(--text)] leading-none">{groupedInStockArray.length}</span>
                    <span className="text-[10px] lg:text-[11px] uppercase tracking-[0.12em] font-bold text-[var(--text-faint)]">{t('mag.models')}</span>
                  </div>
                  <div className="flex items-baseline gap-2 sm:ml-auto">
                    <span className="sys-label">{t('mag.stockValue')}</span>
                    <span className="text-lg lg:text-xl font-black num text-[var(--teal)] leading-none">{costo.toFixed(0)}€</span>
                  </div>
                  <button onClick={() => setSmartLotOpen(true)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-[#8397aa]/15 text-[#8397aa] hover:bg-[#8397aa]/25 text-xs font-bold transition-colors">
                    <Sparkles size={13} /> Lotto smart
                  </button>
                </div>
              );
            })()}

            {/* Lista prodotti */}
            <div className="space-y-2.5">
              {magazzinoView === 'toship' ? (
                toShipItems.length === 0 ? (
                  <div className="text-center py-16 px-5 bg-[var(--surface)] rounded-2xl border border-[var(--border)]">
                    <Truck className="mx-auto text-[var(--text-faint)] mb-3" size={40} />
                    <p className="font-bold">{t('mag.noShip')}</p>
                    <p className="text-sm text-[var(--text-soft)] mt-1">{t('mag.noShipDesc')}</p>
                  </div>
                ) : (
                  <div className="flex flex-col gap-2.5">
                    {toShipItems.map((p: any) => {
                      let ph: string[] = []; try { ph = p.photos ? JSON.parse(p.photos) : []; } catch {}
                      const paid = p.status === 'PAGATO';
                      const g = { ...p, ids: [p.id], quantity: 1 };
                      return (
                        <div key={p.id} className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-3.5">
                          <div className="flex items-center gap-3">
                            {ph.length > 0
                              ? <div className="w-14 h-14 rounded-xl overflow-hidden shrink-0 border border-[var(--border-2)]"><img src={ph[0]} alt="" className="w-full h-full object-cover" /></div>
                              : <span className="text-2xl shrink-0 w-14 text-center">{getCategoryIcon(p.category)}</span>}
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-1.5 flex-wrap">
                                <span className="font-bold text-sm truncate">{fullName(p.brand, p.name)}</span>
                                <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full uppercase ${paid ? 'text-[#8397aa] bg-[#8397aa]/15' : 'text-amber-400 bg-amber-500/15'}`}>{paid ? t('mag.paidInApp') : t('mag.soldOutside')}</span>
                                {p.trackingCode && <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full uppercase text-green-400 bg-green-500/15">{t('mag.shipped')}</span>}
                              </div>
                              <p className="text-[11px] text-[var(--text-soft)]">{p.size} · {p.condition}</p>
                              {p.trackingCode
                                ? <p className="text-[11px] text-blue-400 mt-0.5">📦 {p.trackingCode}{paid ? t('mag.awaitingBuyer') : ''}</p>
                                : <p className="text-[11px] text-[var(--text-faint)] mt-0.5">{t('mag.toShipHint')}</p>}
                            </div>
                          </div>
                          <div className="flex gap-2 mt-3">
                            {hasFeature('labels') ? (
                              (p.trackingCode || p.shippingLabel)
                                ? <button onClick={() => viewSavedLabel(p)} className="flex-1 py-2 rounded-lg text-xs font-bold bg-[#8397aa]/15 text-[#8397aa] flex items-center justify-center gap-1.5"><Package size={13} /> {t('mag.viewLabel')}</button>
                                : <button onClick={() => openShipping(g)} className="flex-1 py-2 rounded-lg text-xs font-bold bg-[#8397aa]/15 text-[#8397aa] flex items-center justify-center gap-1.5"><Package size={13} /> {t('mag.createLabel')}</button>
                            ) : (
                              <button onClick={() => openTrackingModal(g)} className="flex-1 py-2 rounded-lg text-xs font-bold bg-[var(--fill)] text-[var(--text-muted)] flex items-center justify-center gap-1.5"><Truck size={13} /> {t('mag.tracking')}</button>
                            )}
                            {!paid && (
                              <button onClick={() => toggleToShip(g, false)} className="px-3 py-2 rounded-lg text-xs font-bold bg-[var(--fill)] text-[var(--text-muted)]">{t('mag.shipped')}</button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )
              ) : magazzinoView === 'instock' ? (
                groupedInStockArray.length === 0 ? (
                  inStockItems.length === 0 ? (
                    /* Magazzino davvero vuoto → onboarding */
                    <div className="text-center py-16 px-5 bg-[var(--surface)] rounded-2xl border border-[var(--border)]">
                      <Package className="mx-auto text-[var(--text-faint)] mb-3" size={44} />
                      <p className="font-bold text-lg">{t('mag.empty')}</p>
                      <p className="text-sm text-[var(--text-soft)] mt-1 mb-5 max-w-sm mx-auto">{t('mag.emptyDesc')}</p>
                      <div className="flex flex-wrap gap-2 justify-center">
                        <button onClick={() => openAddForm()}
                          className="bg-[#8397aa] hover:bg-[#6f8394] text-white px-5 py-2.5 rounded-xl font-bold text-sm flex items-center gap-2 transition-colors active:scale-95">
                          <Plus size={16} /> {t('mag.addProduct')}
                        </button>
                        <button onClick={() => navigateTo('settings')}
                          className="bg-[var(--surface-2)] border border-[var(--border-2)] hover:border-[var(--border-3)] text-[var(--text-soft)] hover:text-[var(--text)] px-5 py-2.5 rounded-xl font-bold text-sm flex items-center gap-2 transition-colors">
                          <Download size={15} /> {t('mag.importExcel')}
                        </button>
                      </div>
                    </div>
                  ) : (
                    /* Filtri/ricerca attivi → nessun risultato */
                    <div className="text-center py-16 px-5 bg-[var(--surface)] rounded-2xl border border-[var(--border)]">
                      <Search className="mx-auto text-[var(--text-faint)] mb-3" size={40} />
                      <p className="font-bold">{t('mag.noResults')}</p>
                      <p className="text-sm text-[var(--text-soft)] mt-1 mb-4">{t('mag.noResultsDesc')}</p>
                      <button onClick={() => { setSearchTerm(''); setFilterCat('all'); setFilterCondition('all'); setFilterPriceMin(''); setFilterPriceMax(''); setStaleOnly(false); }}
                        className="bg-[var(--surface-2)] border border-[var(--border-2)] hover:border-[var(--border-3)] text-[var(--text-soft)] hover:text-[var(--text)] px-4 py-2 rounded-xl font-bold text-xs transition-colors">
                        {t('mag.clearFilters')}
                      </button>
                    </div>
                  )
                ) : (
                  <div className="flex flex-col gap-2.5 lg:grid lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 lg:gap-3">
                  {groupedInStockArray.map((g: any) => {
                    const groupKey = g.ids.join(',');
                    // Selezione: gruppo intero (selectedGroupKeys) OPPURE alcuni pezzi (selectedPieceIds).
                    const selPieceCount = (g.ids as string[]).filter((id: string) => selectedPieceIds.has(id)).length;
                    const isSelected = selectedGroupKeys.has(groupKey) || selPieceCount > 0;
                    const isPartialSel = selPieceCount > 0 && selPieceCount < g.ids.length && !selectedGroupKeys.has(groupKey);
                    const isAdmin = isAdminEmail(user!.email);
                    let photoUrl: string | null = null;
                    try { const ph = g.photos ? JSON.parse(g.photos) : []; if (ph.length > 0) photoUrl = realPhoto(ph[0]); } catch {}
                    const days = g.oldestDate || g.createdAt ? Math.floor((Date.now() - new Date(g.oldestDate || g.createdAt).getTime()) / 86400000) : null;
                    const shares = getShares(g);
                    const daysBadge = days !== null ? (
                      <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${days > 30 ? 'bg-red-500/20 text-red-400' : days > 14 ? 'bg-yellow-500/20 text-yellow-400' : 'bg-[var(--fill)] text-[var(--text-faint)]'}`}>{days}g</span>
                    ) : null;
                    const trackBadge = g.trackingStatus ? (
                      <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold flex items-center gap-0.5 ${g.trackingStatus === 'IN_TRANSIT' ? 'bg-blue-500/20 text-blue-400' : g.trackingStatus === 'DELIVERED' ? 'bg-green-500/20 text-green-400' : g.trackingStatus === 'EXCEPTION' ? 'bg-red-500/20 text-red-400' : 'bg-[var(--fill)] text-[var(--text-soft)]'}`}><Truck size={9} />{g.trackingStatus === 'IN_TRANSIT' ? 'Transito' : g.trackingStatus === 'DELIVERED' ? 'Consegnato' : g.trackingStatus === 'OUT_FOR_DELIVERY' ? 'In consegna' : 'Track'}</span>
                    ) : null;

                    return (
                    <React.Fragment key={groupKey}>

                      {/* ===== MOBILE/TABLET: card a riga (SWIPE: → Vendi · ← Elimina) ===== */}
                      <div data-cardswipe className="lg:hidden relative overflow-hidden rounded-2xl">
                        {!bulkMode && ((g.isModel || g.isLot) ? (
                          // Modello/Lotto = contenitore: lo swipe APRE il dettaglio (dove scegli la taglia/pezzo).
                          <div className="absolute inset-0 flex items-center justify-between px-5 rounded-2xl bg-[#8397aa]/25 text-[#c0cbd6] font-bold pointer-events-none" style={{ opacity: swipe?.key === groupKey && Math.abs(swipe.dx) > 8 ? 1 : 0 }}>
                            <span className="flex items-center gap-1.5"><Layers size={17} /> {t('mag.open')}</span>
                            <span className="flex items-center gap-1.5">{t('mag.open')} <Layers size={17} /></span>
                          </div>
                        ) : (<>
                          <div className="absolute inset-0 flex items-center pl-5 rounded-2xl bg-green-600/25 text-green-200 font-bold pointer-events-none" style={{ opacity: swipe?.key === groupKey && swipe.dx > 8 ? 1 : 0 }}><DollarSign size={18} className="mr-1.5" /> {t('mag.sell')}</div>
                          <div className="absolute inset-0 flex items-center justify-end pr-5 rounded-2xl bg-red-600/25 text-red-200 font-bold pointer-events-none" style={{ opacity: swipe?.key === groupKey && swipe.dx < -8 ? 1 : 0 }}>{t('sw.delete')} <Trash2 size={18} className="ml-1.5" /></div>
                        </>))}
                      <div
                        onClick={() => cardClick(groupKey, g)}
                        {...cardTouchProps(groupKey, g)}
                        style={{ transform: swipe?.key === groupKey ? `translateX(${swipe.dx}px)` : undefined, transition: swipe?.key === groupKey ? 'none' : 'transform .22s ease', touchAction: 'pan-y' }}
                        className={`bg-[var(--surface)] border ring-1 ring-white/[0.02] rounded-2xl overflow-hidden ease-out active:scale-[0.99] relative ${
                          bulkMode ? 'cursor-pointer select-none' : ''
                        } ${isSelected ? 'border-[#8397aa] shadow-sm' : 'border-[var(--border)]'}`}>
                        {bulkMode && (
                          <div className={`absolute top-3 right-3 z-10 min-w-6 h-6 px-1 rounded-full border-2 flex items-center justify-center ${isSelected ? 'bg-[#8397aa] border-[#8397aa]' : 'border-[var(--border-2)] bg-[var(--surface-2)]'}`}>
                            {isPartialSel ? <span className="text-[10px] font-black text-white">{selPieceCount}</span> : isSelected ? <CheckCircle size={14} className="text-[var(--text)]" /> : null}
                          </div>
                        )}
                        <div className="flex items-center gap-3 p-3.5">
                          {photoUrl
                            ? <div onClick={!bulkMode ? () => openEditModal(g) : undefined} className={`w-16 h-16 rounded-xl overflow-hidden shrink-0 border border-[var(--border-2)] bg-white ${!bulkMode ? 'cursor-pointer' : ''}`}><img src={proxyImg(photoUrl)} alt="" className="w-full h-full object-contain" /></div>
                            : <div className="w-16 h-16 rounded-xl shrink-0 border border-[var(--border-2)] bg-white flex items-center justify-center overflow-hidden"><img src="/logo.png" alt="" className="w-3/5 h-3/5 object-contain opacity-25" /></div>}
                          <div className={`flex-1 min-w-0 ${!bulkMode ? 'cursor-pointer' : ''}`}
                            onClick={!bulkMode ? () => openEditModal(g) : undefined}>
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span className="font-bold text-sm truncate">{fullName(g.brand, g.name)}</span>
                              {g.quantity > 1 && <span className="text-[10px] bg-[#8397aa]/20 text-[var(--text)] px-1.5 py-0.5 rounded-full font-bold shrink-0">×{g.quantity}</span>}
                              {daysBadge}{trackBadge}
                            </div>
                            <p className="text-xs text-[var(--text-soft)] mt-1">{g.isModel ? modelSub(g) : <>{g.size} · {g.condition} · <span className="text-[var(--text-muted)] font-semibold">{g.purchasePrice.toFixed(0)}€</span></>}</p>
                            {shares?.length > 0 && <p className="text-[10px] text-blue-400/70 mt-0.5 truncate">{shares.map((x:any)=>`${x.name} ${x.percentage}%`).join(' · ')}</p>}
                            {!bulkMode && (
                              <button onClick={(e) => { e.stopPropagation(); setNotesModalProduct(g); setNotesInput(g.notes || ''); }}
                                className={`mt-1 text-[11px] flex items-center gap-1 max-w-full w-full overflow-hidden ${g.notes ? 'text-[var(--text-soft)]' : 'text-[var(--text-faint)]'}`}>
                                <StickyNote size={10} className="shrink-0" /><span className="truncate">{g.notes || t('mag.addNote')}</span>
                              </button>
                            )}
                          </div>
                          {!bulkMode && (
                            <div className="flex flex-col gap-1 shrink-0">
                              <button onClick={() => openTrackingModal(g)} className="px-3 py-1.5 bg-[var(--fill)] text-[var(--text-muted)] rounded-lg text-xs font-bold">{t('mag.track')}</button>
                              <button onClick={() => toggleToShip(g, !g.toShip)}
                                className={`px-3 py-1.5 rounded-lg text-xs font-bold ${g.toShip ? 'bg-amber-500/20 text-amber-400' : 'bg-[var(--fill)] text-[var(--text-muted)]'}`}>{g.toShip ? t('mag.inList') : t('dash.toShip')}</button>
                              {MARKETPLACE_ENABLED && (
                              <button onClick={() => quickTogglePublic(g)}
                                className={`px-3 py-1.5 rounded-lg text-xs font-bold ${g.isPublic ? 'bg-[#8397aa]/20 text-[#8397aa]' : 'bg-[var(--fill)] text-[var(--text-muted)]'}`}>
                                {g.isPublic ? t('mag.published') : t('mag.publish')}
                              </button>
                              )}
                            </div>
                          )}
                        </div>
                        {/* Riga azioni sotto: Vendi sempre presente (mobile) */}
                        {!bulkMode && (
                          <div className="flex border-t border-[var(--border)]">
                            {isAdmin && (
                              <>
                                <button onClick={() => openShipping(g)} className="flex-1 flex items-center justify-center gap-1.5 py-2.5 text-xs font-bold text-[#9fb0bd] hover:bg-[var(--surface-2)]/15"><Package size={13} /> {t('mag.ship')}</button>
                                <div className="w-px bg-[var(--fill)]" />
                              </>
                            )}
                            <button onClick={() => openSellModal(g.ids, `${fullName(g.brand, g.name)}`, g)} className="flex-1 flex items-center justify-center gap-1.5 py-2.5 text-xs font-bold text-green-400 hover:bg-green-900/15"><DollarSign size={13} /> {t('mag.sell')}</button>
                          </div>
                        )}
                      </div>
                      </div>

                      {/* ===== DESKTOP: card a cubetto ===== */}
                      <div
                        onClick={() => cardClick(groupKey, g)}
                        {...cardPressProps(groupKey)}
                        className={`hidden lg:flex flex-col bg-[var(--surface)] border rounded-2xl overflow-hidden transition-colors relative ${
                          bulkMode ? 'cursor-pointer select-none' : ''
                        } ${isSelected ? 'border-[#8397aa] shadow-sm' : 'border-[var(--border)] hover:border-[var(--border-2)]'}`}>
                        <div
                          className={`relative aspect-square bg-white flex items-center justify-center overflow-hidden ${!bulkMode ? 'cursor-pointer' : ''}`}
                          onClick={!bulkMode && isAdmin ? () => openEditModal(g) : undefined}>
                          {photoUrl
                            ? <img src={proxyImg(photoUrl)} alt="" className="w-full h-full object-contain" />
                            : <img src="/logo.png" alt="" className="w-1/2 h-1/2 object-contain opacity-20" />}
                          <div className="absolute top-2 left-2 flex flex-col gap-1 items-start">
                            {g.quantity > 1 && <span className="text-[10px] bg-[#8397aa] text-[var(--text)] px-2 py-0.5 rounded-full font-bold shadow">×{g.quantity}</span>}
                            {days !== null && <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold shadow ${days > 30 ? 'bg-red-500 text-[var(--text)]' : days > 14 ? 'bg-yellow-500 text-black' : 'bg-black/50 backdrop-blur text-[var(--text-muted)]'}`}>{days}g</span>}
                            {g.trackingStatus && <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold flex items-center gap-0.5 shadow ${g.trackingStatus === 'IN_TRANSIT' ? 'bg-blue-500 text-[var(--text)]' : g.trackingStatus === 'DELIVERED' ? 'bg-green-500 text-[var(--text)]' : g.trackingStatus === 'EXCEPTION' ? 'bg-red-500 text-[var(--text)]' : 'bg-black/50 backdrop-blur text-[var(--text-muted)]'}`}><Truck size={9} />{g.trackingStatus === 'IN_TRANSIT' ? t('mag.trTransit') : g.trackingStatus === 'DELIVERED' ? t('mag.trDelivered') : g.trackingStatus === 'OUT_FOR_DELIVERY' ? t('mag.trOutForDelivery') : t('mag.track')}</span>}
                          </div>
                          {bulkMode && (
                            <div className={`absolute top-2 right-2 z-10 min-w-6 h-6 px-1 rounded-full border-2 flex items-center justify-center ${isSelected ? 'bg-[#8397aa] border-[#8397aa]' : 'border-[var(--border-3)] bg-black/40 backdrop-blur'}`}>
                              {isPartialSel ? <span className="text-[10px] font-black text-white">{selPieceCount}</span> : isSelected ? <CheckCircle size={14} className="text-[var(--text)]" /> : null}
                            </div>
                          )}
                        </div>
                        <div className="p-4 flex-1 flex flex-col items-start text-left">
                          <p className="font-bold text-base leading-tight line-clamp-2 w-full tracking-tight">{fullName(g.brand, g.name)}</p>
                          <p className="text-sm text-[var(--text-muted)] mt-1.5">{g.isModel ? modelSub(g) : `${g.size} · ${g.condition}`}</p>
                          <p className="text-2xl font-black text-[var(--text)] mt-auto pt-2 num tracking-tight leading-none">{g.purchasePrice.toFixed(0)}€</p>
                          {shares?.length > 0 && <p className="text-[11px] text-blue-400/70 mt-1.5 truncate max-w-full">{shares.map((x:any)=>`${x.name} ${x.percentage}%`).join(' · ')}</p>}
                          {!bulkMode && (
                            <button onClick={(e) => { e.stopPropagation(); setNotesModalProduct(g); setNotesInput(g.notes || ''); }}
                              className={`mt-2 text-xs flex items-center justify-start gap-1 max-w-full ${g.notes ? 'text-[var(--text-soft)] hover:text-[var(--text-muted)]' : 'text-[var(--text-faint)] hover:text-[var(--text-soft)]'}`}>
                              <StickyNote size={11} className="shrink-0" /><span className="truncate">{g.notes || t('mag.addNote')}</span>
                            </button>
                          )}
                        </div>
                        {!bulkMode && (
                          <div className="border-t border-[var(--border)] p-2.5 flex flex-col gap-1.5">
                            <div className="grid grid-cols-2 gap-1.5">
                              <button onClick={() => openTrackingModal(g)} className={`py-2 rounded-lg text-xs font-bold transition-colors flex items-center justify-center gap-1 ${g.trackingCode ? 'bg-blue-500/15 text-blue-400 hover:bg-blue-500/25' : 'bg-[var(--fill)] text-[var(--text-muted)] hover:bg-[var(--fill-2)] hover:text-[var(--text)]'}`}><Truck size={12} /> {t('mag.track')}</button>
                              <button onClick={() => toggleToShip(g, !g.toShip)}
                                className={`py-2 rounded-lg text-xs font-bold transition-colors flex items-center justify-center gap-1 ${g.toShip ? 'bg-amber-500/20 text-amber-400' : 'bg-[var(--fill)] text-[var(--text-muted)] hover:bg-[var(--fill-2)] hover:text-[var(--text)]'}`}><Truck size={12} /> {g.toShip ? t('mag.inList') : t('dash.toShip')}</button>
                            </div>
                            {isAdmin ? (
                              <div className="grid grid-cols-2 gap-1.5">
                                <button onClick={() => openShipping(g)} className="py-2 rounded-lg text-xs font-bold bg-[#8397aa]/15 text-[#9fb0bd] hover:bg-[#8397aa]/25 hover:text-[#9fb0bd] transition-colors flex items-center justify-center gap-1"><Package size={12} /> {t('mag.ship')}</button>
                                <button onClick={() => openSellModal(g.ids, `${fullName(g.brand, g.name)}`, g)} className="py-2 rounded-lg text-xs font-bold bg-green-500/20 text-green-400 hover:bg-green-500/30 hover:text-green-300 transition-colors flex items-center justify-center gap-1"><DollarSign size={12} /> {t('mag.sell')}</button>
                              </div>
                            ) : (
                              <button onClick={() => openSellModal(g.ids, `${fullName(g.brand, g.name)}`, g)} className="py-2 rounded-lg text-sm font-bold bg-green-500/20 text-green-400 hover:bg-green-500/30 hover:text-green-300 transition-colors flex items-center justify-center gap-1.5"><DollarSign size={14} /> {t('mag.sell')}</button>
                            )}
                            {MARKETPLACE_ENABLED && (
                            <button onClick={() => quickTogglePublic(g)}
                              className={`py-2 rounded-lg text-xs font-bold transition-colors flex items-center justify-center gap-1 ${g.isPublic ? 'bg-[#8397aa]/20 text-[#8397aa]' : 'bg-[var(--fill)] text-[var(--text-muted)] hover:text-[var(--text)]'}`}>
                              <Store size={12} /> {g.isPublic ? t('mag.inShowcase') : t('mag.publish')}
                            </button>
                            )}
                          </div>
                        )}
                      </div>

                    </React.Fragment>
                  );
                  })}
                  </div>
                )
              ) : (
                groupedSoldArray.length === 0 ? (
                  <div className="text-center py-16 px-5 bg-[var(--surface)] rounded-2xl border border-[var(--border)]">
                    <CheckCircle className="mx-auto text-[var(--text-faint)] mb-4" size={40} />
                    <p className="text-[var(--text-muted)] font-semibold">{t('mag.soldNoneTitle')}</p>
                    <p className="text-[var(--text-faint)] text-sm mt-1 mb-5">{t('mag.soldNoneDesc')}</p>
                    <button onClick={() => setMagazzinoView('instock')}
                      className="bg-[var(--surface-2)] border border-[var(--border-2)] hover:border-[var(--border-3)] text-[var(--text-soft)] hover:text-[var(--text)] px-5 py-2.5 rounded-xl font-bold text-sm transition-colors">
                      {t('mag.goInStock')}
                    </button>
                  </div>
                ) : (
                  (() => {
                    const platColors: Record<string, string> = {
                      'Vinted': 'text-teal-300 bg-teal-500/15 border-teal-500/20',
                      'StockX': 'text-green-300 bg-green-500/15 border-green-500/20',
                      'eBay': 'text-yellow-300 bg-yellow-500/15 border-yellow-500/20',
                      'Subito': 'text-[#9fb0bd] bg-[#8397aa]/15 border-[#8397aa]/20',
                      'Privato': 'text-[var(--text-muted)] bg-[var(--fill)] border-[var(--border-2)]',
                    };
                    return <div className="grid grid-cols-1 lg:grid-cols-2 2xl:grid-cols-3 gap-2.5 lg:gap-3">{groupedSoldArray.map((g: any) => {
                      const marginPct = g.totalRevenue > 0 && g.purchasePrice > 0
                        ? ((g.totalProfit / (g.purchasePrice * g.quantity)) * 100)
                        : null;
                      const soldDate = g.soldAt ? new Date(g.soldAt).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' }) : null;
                      let photos: string[] = [];
                      try { photos = g.photos ? JSON.parse(g.photos) : []; } catch {}
                      const platCls = platColors[g.platform] || 'text-[var(--text-muted)] bg-[var(--fill)] border-[var(--border-2)]';
                      const soldKey = g.ids.join(',');
                      const buyers = buyersFromSales(g.sales || []); // compratori del gruppo (nome + pezzi)
                      const isExpanded = expandedSoldKey === soldKey;

                      // PAGATO in attesa: pagato dal compratore, soldi in attesa di consegna.
                      if (g.isHeld) {
                        return (
                          <div key={g.ids.join(',')} className="bg-[var(--surface)] border border-[#8397aa]/25 rounded-2xl overflow-hidden">
                            <div className="flex items-center gap-3 p-4">
                              {photos.length > 0
                                ? <div className="w-12 h-12 rounded-xl overflow-hidden shrink-0 border border-[var(--border)]"><img src={photos[0]} alt="" className="w-full h-full object-cover" /></div>
                                : <span className="text-2xl shrink-0 opacity-60">{getCategoryIcon(g.category)}</span>}
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-1.5 flex-wrap">
                                  <p className="font-bold text-sm truncate">{fullName(g.brand, g.name)}</p>
                                  <span className="text-[9px] font-bold text-[#8397aa] bg-[#8397aa]/15 px-1.5 py-0.5 rounded-full uppercase">{t('mag.paidPending')}</span>
                                </div>
                                <p className="text-[10px] text-[var(--text-soft)]">{g.size} · {g.condition} · {(g.heldAmount ?? g.publicPrice ?? 0).toFixed(0)}€</p>
                              </div>
                            </div>
                            <div className="px-4 pb-3 flex flex-col gap-2">
                              <p className="text-[10px] text-[var(--text-soft)]">{t('mag.fundsReleaseHint')}</p>
                              {hasFeature('labels') ? (
                                <button onClick={() => openShipping(g)}
                                  className="w-full py-2 rounded-xl text-xs font-bold bg-[#8397aa]/15 text-[#8397aa] hover:bg-[#8397aa]/25 transition-colors flex items-center justify-center gap-1.5">
                                  <Package size={13} /> {t('mag.createLabelShip')}
                                </button>
                              ) : (
                                <p className="text-[10px] text-[var(--text-faint)]">{t('mag.shipFromChatHint')}</p>
                              )}
                            </div>
                          </div>
                        );
                      }

                      if (g.salePrice === 0) {
                        return (
                          <div key={g.ids.join(',')} className="bg-[var(--surface)] border border-yellow-500/20 rounded-2xl overflow-hidden">
                            <div className="flex items-center gap-3 p-4">
                              {photos.length > 0
                                ? <div className="w-12 h-12 rounded-xl overflow-hidden shrink-0 border border-[var(--border)]"><img src={photos[0]} alt="" className="w-full h-full object-cover" /></div>
                                : <span className="text-2xl shrink-0 opacity-60">{getCategoryIcon(g.category)}</span>}
                              <div className="flex-1 min-w-0">
                                <p className="font-bold text-sm">{fullName(g.brand, g.name)}</p>
                                <p className="text-[10px] text-[var(--text-soft)]">{g.size} · {g.condition}</p>
                              </div>
                              <button onClick={() => openSellModal(g.ids, `${fullName(g.brand, g.name)}`, g)}
                                className="shrink-0 text-xs bg-yellow-500/15 border border-yellow-500/25 text-yellow-400 hover:bg-yellow-500/25 px-3 py-2 rounded-xl font-semibold transition-colors flex items-center gap-1.5">
                                <Truck size={12} /> Completa
                              </button>
                            </div>
                            <div className="px-4 pb-3">
                              <p className="text-[10px] text-yellow-600">📦 Consegnato via tracking — inserisci prezzo e piattaforma</p>
                            </div>
                          </div>
                        );
                      }

                      return (
                        <div key={soldKey} className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl overflow-hidden hover:border-[var(--border-2)] transition-colors group">
                          <div className={`flex items-center gap-3 p-4 ${g.quantity > 1 || buyers.some(b => b.name !== '—') ? 'cursor-pointer' : ''}`}
                            onClick={() => setExpandedSoldKey(isExpanded ? null : soldKey)}>
                            {photos.length > 0
                              ? <div className="w-12 h-12 rounded-xl overflow-hidden shrink-0 border border-[var(--border)] group-hover:border-[var(--border-2)] transition-colors"><img src={photos[0]} alt="" className="w-full h-full object-cover" /></div>
                              : <span className="text-2xl shrink-0 opacity-40">{getCategoryIcon(g.category)}</span>}
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-1.5 flex-wrap mb-0.5">
                                <p className="font-bold text-sm">{fullName(g.brand, g.name)}</p>
                                {g.quantity > 1 && (
                                  <span className="text-[9px] bg-green-500/15 border border-green-500/25 text-green-400 px-1.5 py-0.5 rounded-full font-semibold shrink-0">×{g.quantity}</span>
                                )}
                              </div>
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="text-[10px] text-[var(--text-faint)]">{g.size}</span>
                                <span className={`text-[9px] font-semibold px-2 py-0.5 rounded-full border ${platCls}`}>{g.platform}</span>
                                {soldDate && <span className="text-[10px] text-[var(--text-faint)]">{soldDate}</span>}
                                {/* Compratori: un nome se unico, "N compratori" se diversi (apri la tendina per vederli). */}
                                {buyers.length === 1 && buyers[0].name !== '—' && (
                                  <span className="text-[9px] font-semibold px-2 py-0.5 rounded-full bg-[var(--fill)] text-[var(--text-soft)] flex items-center gap-1"><Users size={9} /> {buyers[0].name}</span>
                                )}
                                {buyers.length > 1 && (
                                  <span className="text-[9px] font-semibold px-2 py-0.5 rounded-full bg-[#8397aa]/15 text-[#8397aa] flex items-center gap-1"><Users size={9} /> {buyers.length} {t('ct.buyersWord')} {isExpanded ? '▲' : '▼'}</span>
                                )}
                              </div>
                            </div>
                            <div className="text-right shrink-0 ml-2">
                              <p className={`font-black text-base num tracking-tight leading-none ${g.totalProfit >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                                {g.totalProfit >= 0 ? '+' : ''}{g.totalProfit.toFixed(0)}€
                              </p>
                              {marginPct !== null && (
                                <p className={`text-[10px] font-semibold ${marginPct >= 0 ? 'text-green-700' : 'text-red-700'}`}>
                                  {marginPct >= 0 ? '+' : ''}{marginPct.toFixed(0)}%
                                </p>
                              )}
                            </div>
                          </div>
                          <div className="flex items-center gap-2 px-4 pb-3 border-t border-[var(--border)] pt-2.5">
                            <span className="text-[10px] text-[var(--text-faint)] flex items-center gap-1">
                              {g.purchasePrice?.toFixed(0)}€
                              <span className="text-gray-800 mx-0.5">→</span>
                              <span className="text-[var(--text-soft)] font-bold">{g.totalRevenue.toFixed(0)}€</span>
                            </span>
                            {g.totalFees > 0 && (
                              <span className="text-[10px] text-[var(--text-faint)]">· {g.totalFees.toFixed(0)}€ fee</span>
                            )}
                            <button onClick={() => openEditModal(g)}
                              className="ml-auto flex items-center gap-1.5 bg-[var(--fill)] border border-[var(--border-2)] text-[var(--text-soft)] hover:text-[var(--text)] px-3 py-1.5 rounded-xl text-xs font-bold transition-colors">
                              <Edit size={12} /> Modifica
                            </button>
                            <button onClick={() => g.quantity > 1 ? setExpandedSoldKey(isExpanded ? null : soldKey) : handleReturn(g)}
                              className="flex items-center gap-1.5 bg-blue-500/15 border border-blue-500/25 text-blue-400 hover:bg-blue-500/25 px-3 py-1.5 rounded-xl text-xs font-bold transition-colors">
                              ↩ {t('mag.return')}
                            </button>
                          </div>
                          {/* Tendina compratori: nome a sinistra, quantità a destra; sotto ogni compratore
                              le singole vendite (con data) e il RESO del pezzo esatto (non dell'ultimo). */}
                          {isExpanded && (
                            <div className="px-4 pb-3 pt-1 border-t border-[var(--border)] space-y-2 bg-[var(--surface-2)]/40">
                              {buyers.map((b, bi) => (
                                <div key={bi} className="rounded-xl bg-[var(--fill)] border border-[var(--border)] px-3 py-2">
                                  <div className="flex items-center justify-between gap-2">
                                    <span className="text-xs font-bold text-[var(--text)] flex items-center gap-1.5 min-w-0"><Users size={11} className="shrink-0 text-[#8397aa]" /> <span className="truncate">{b.name === '—' ? t('ct.noName') : b.name}</span></span>
                                    <span className="text-[11px] font-bold text-[var(--text-soft)] shrink-0">×{b.qty}</span>
                                  </div>
                                  <div className="mt-1.5 space-y-1">
                                    {b.sales.map((s: any) => (
                                      <div key={s.id} className="flex items-center justify-between gap-2 text-[11px]">
                                        <span className="text-[var(--text-faint)]">
                                          {s.soldAt ? new Date(s.soldAt).toLocaleDateString('it-IT', { day: 'numeric', month: 'short', year: '2-digit' }) : '—'} · {s.salePrice.toFixed(0)}€
                                        </span>
                                        <button onClick={(e) => { e.stopPropagation(); handleReturnIds([s.id], `${fullName(g.brand, g.name)}`); }}
                                          className="flex items-center gap-1 text-blue-400 hover:text-blue-300 font-semibold px-2 py-0.5 rounded-lg hover:bg-blue-500/10 transition-colors">
                                          ↩ {t('mag.return')}
                                        </button>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}</div>;
                  })()
                )
              )}
            </div>
          </div>
        )}
        
        {/* ========== ANALYTICS ========== */}
        {/* Gating: ROI, trend e performance sono incluse dal piano Pro in su. */}
        {currentView === 'analytics' && !hasAdvancedAnalytics && (
          <div className="space-y-5">
            <h2 className="text-3xl font-semibold">{t('nav.analytics')}</h2>
            <section className="bg-[var(--surface)] border border-[#8397aa]/30 rounded-2xl p-8 text-center relative overflow-hidden">
              <div className="absolute inset-0 bg-[#8397aa]/[0.05] pointer-events-none" />
              <div className="relative max-w-md mx-auto">
                <div className="w-14 h-14 rounded-2xl bg-[#8397aa]/15 flex items-center justify-center mx-auto mb-4"><BarChart3 size={26} className="text-[#8397aa]" /></div>
                <h3 className="text-xl font-bold mb-2">{t('an.lockedTitle')}</h3>
                <p className="text-sm text-[var(--text-soft)] mb-5">{t('an.lockedDesc')}</p>
                <ul className="text-sm text-[var(--text-muted)] text-left space-y-2 mb-6 inline-block">
                  {[t('an.feat1'), t('an.feat2'), t('an.feat3'), t('an.feat4'), t('an.feat5')].map(x => (
                    <li key={x} className="flex items-center gap-2"><CheckCircle size={15} className="text-[#8397aa] shrink-0" /> {x}</li>
                  ))}
                </ul>
                <button onClick={() => openPlanModal()} className="bg-[#8397aa] hover:bg-[#6f8394] text-white px-6 py-3 rounded-xl font-bold text-sm transition-colors">{t('an.unlockStarter')}</button>
                <p className="text-[11px] text-[var(--text-faint)] mt-4">{t('an.lockedNote')}</p>
              </div>
            </section>
          </div>
        )}
        {currentView === 'analytics' && hasAdvancedAnalytics && (
          <div className="space-y-5">
            <div className="flex items-center justify-between">
              <h2 className="text-3xl font-semibold">{t('nav.analytics')}</h2>
              <button onClick={downloadAccountantCsv}
                className="flex items-center gap-2 bg-[var(--surface)] border border-[var(--border-2)] hover:border-[var(--border-3)] px-4 py-2 rounded-xl text-sm font-bold transition-colors text-[var(--text-soft)] hover:text-[var(--text)] active:scale-95">
                <Download size={15} /> {t('an.accountantCsv')}
              </button>
            </div>

            {/* ===== GRAFICO A BARRE SOVRAPPOSTE (ultimi 6 mesi): Entrate/Uscite/Investimenti impilate.
                Tocca una barra per selezionare quel mese (aggiorna il conto economico sotto). ===== */}
            {(() => {
              // Palette FREDDA "private banking": rampa titanio/acciaio (light → steel → graphite),
              // monocroma e sobria — niente arcobaleno. Entrate = titanio chiaro (spicca),
              // Investimenti = acciaio medio, Uscite = graphite scuro (recede).
              const COL = { Entrate: '#c0cbd6', Uscite: '#57626f', Investimenti: '#8397aa' };
              const legend = [
                { k: 'Entrate', c: COL.Entrate, lbl: t('bub.income'), val: bubbleMonth.ricavi },
                { k: 'Uscite', c: COL.Uscite, lbl: t('bub.expenses'), val: bubbleMonth.uscite },
                { k: 'Investimenti', c: COL.Investimenti, lbl: t('bub.invest'), val: bubbleMonth.investiti },
              ];
              const maxTot = Math.max(...barMonths.map(mm => mm.ricavi + mm.uscite + mm.investiti), 1);
              const H = 200;
              // Frecce: scorri il set di 6 mesi (sposta il mese selezionato di ±6).
              const shiftSet = (dd: number) => setReportMonth(({ y, m }) => { const nm = m + dd; return { y: y + Math.floor(nm / 12), m: ((nm % 12) + 12) % 12 }; });
              const now = new Date(); const isCurrent = reportMonth.y === now.getFullYear() && reportMonth.m === now.getMonth();
              return (
                <section className="bg-[var(--surface)] border border-[var(--border)] rounded-3xl p-5">
                  <div className="flex items-start justify-between gap-2 mb-4 flex-wrap">
                    <div>
                      <h3 className="font-bold text-lg">{t('bub.analysis')}</h3>
                      <div className="flex items-center gap-3.5 mt-1.5 flex-wrap">
                        {legend.map(l => (
                          <div key={l.k} className="flex items-center gap-1.5 text-[11px] lg:text-xs text-[var(--text-soft)]"><span className="w-2.5 h-2.5 rounded-[3px] shrink-0" style={{ background: l.c }} />{l.lbl}</div>
                        ))}
                      </div>
                    </div>
                    {/* Frecce: scorrono di UN mese alla volta (anche coi tasti ← → su PC) */}
                    <div className="flex items-center gap-1 shrink-0">
                      <button onClick={() => shiftSet(-1)} aria-label="Mese precedente" className="w-10 h-10 rounded-lg hover:bg-[var(--fill)] text-[var(--text-muted)] text-2xl flex items-center justify-center">‹</button>
                      <button onClick={() => shiftSet(1)} disabled={isCurrent} aria-label="Mese successivo" className="w-10 h-10 rounded-lg hover:bg-[var(--fill)] text-[var(--text-muted)] text-2xl disabled:opacity-30 flex items-center justify-center">›</button>
                    </div>
                  </div>
                  {/* Barre — più grandi e visibili */}
                  <div className="flex items-end justify-between gap-2 sm:gap-3" style={{ height: H + 26 }}>
                    {barMonths.map(mm => {
                      const sum = mm.ricavi + mm.uscite + mm.investiti;
                      const h = maxTot > 0 ? (sum / maxTot) * H : 0;
                      const seg = (v: number) => sum > 0 ? Math.max(0, (v / sum) * h) : 0;
                      const active = mm.y === reportMonth.y && mm.m === reportMonth.m;
                      return (
                        <button key={`${mm.y}-${mm.m}`} onClick={() => setReportMonth({ y: mm.y, m: mm.m })}
                          className="flex-1 flex flex-col items-center gap-2 group min-w-0">
                          <div className="w-full flex flex-col justify-end" style={{ height: H }}>
                            <div className={`w-full max-w-[96px] mx-auto rounded-t-xl overflow-hidden flex flex-col-reverse transition-all ${active ? 'ring-2 ring-white/30 brightness-110' : 'opacity-85 group-hover:opacity-100'}`} style={{ height: h || 3 }}>
                              <div style={{ height: seg(mm.ricavi), background: COL.Entrate }} />
                              <div style={{ height: seg(mm.uscite), background: COL.Uscite }} />
                              <div style={{ height: seg(mm.investiti), background: COL.Investimenti }} />
                            </div>
                          </div>
                          <span className={`text-[11.5px] lg:text-[13px] capitalize truncate max-w-full ${active ? 'text-[var(--text)] font-black' : 'text-[var(--text-faint)]'}`}>{mm.label}</span>
                        </button>
                      );
                    })}
                  </div>
                  {/* Dettaglio del mese selezionato */}
                  <div className="space-y-2 border-t border-[var(--border)] pt-3 mt-3">
                    {legend.map(l => (
                      <div key={l.k} className="flex items-center gap-3">
                        <span className="w-3 h-3 rounded-[3px] shrink-0" style={{ background: l.c }} />
                        <span className="text-sm font-bold flex-1 truncate">{l.lbl}</span>
                        <span className="text-sm font-bold num text-[var(--text-soft)]">{l.val.toFixed(2)}€</span>
                      </div>
                    ))}
                  </div>
                </section>
              );
            })()}

            {/* ===== STOCK (spostato qui dalla dashboard) ===== */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <button onClick={() => { setCurrentView('magazzino'); setMagazzinoView('instock'); }}
                className="text-left bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-4 hover:border-[var(--border-2)] transition-colors">
                <p className="sys-label mb-1 flex items-center gap-1.5"><Layers size={10} /> {t('dash.stock')}</p>
                <p className="text-xl lg:text-2xl font-extrabold num">{stockValore.toFixed(0)}€</p>
                <p className="text-[10px] text-[var(--text-faint)] mt-1">{inStockItems.length} {t('dash.pieces')} · {t('dash.see')} →</p>
              </button>
              {liquidationValue > 0 && (
                <div className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-4">
                  <p className="sys-label mb-1 flex items-center gap-1.5"><TrendingDown size={10} /> Svendita</p>
                  <p className="text-xl lg:text-2xl font-extrabold num text-amber-400/90">{liquidationValue.toFixed(0)}€</p>
                  <p className="text-[10px] text-[var(--text-faint)] mt-1">{t('dash.stock')}</p>
                </div>
              )}
            </div>

            {/* ===== SMART INSIGHTS (spostati qui dalla dashboard) ===== */}
            {(staleCount > 0 || weekSales.length > 0 || bestCategoryEntry?.profit > 0 || sellThroughRate > 0) && (
            <section className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-5">
              <p className="text-[9px] font-semibold text-[var(--text-soft)] uppercase tracking-[0.12em] mb-4 flex items-center gap-2"><Sparkles size={10} /> Insights</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {staleCount > 0 && (
                  <div className="flex items-center gap-3 p-3 bg-[var(--surface-2)] border border-[var(--border)] rounded-xl cursor-pointer hover:border-[var(--border-2)] transition-colors"
                    onClick={() => { setCurrentView('magazzino'); setSortField('date'); setSortDir('asc'); }}>
                    <AlertTriangle size={16} className="text-red-400 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-bold text-[var(--text)]">{staleCount} {staleCount === 1 ? t('home.staleOne') : t('home.staleMany')} {t('home.over30')}</p>
                      <p className="text-[10px] text-[var(--text-soft)]">{t('home.staleHint')}</p>
                    </div>
                    <span className="text-[10px] text-[var(--text-soft)] shrink-0">{t('dash.see')} →</span>
                  </div>
                )}
                {weekSales.length > 0 && (
                  <div className="flex items-center gap-3 p-3 bg-[var(--surface-2)] border border-[var(--border)] rounded-xl">
                    <TrendingUp size={16} className="text-emerald-400 shrink-0" />
                    <div>
                      <p className="text-sm font-bold text-[var(--text)]">{weekSales.length} {weekSales.length === 1 ? t('dash.sale') : t('dash.salesPlural')} {t('home.thisWeek')}{weekProfit > 0 && ` · +${weekProfit.toFixed(0)}€`}</p>
                      <p className="text-[10px] text-[var(--text-soft)]">{t('home.goodPace')}</p>
                    </div>
                  </div>
                )}
                {bestCategoryEntry?.profit > 0 && (
                  <div className="flex items-center gap-3 p-3 bg-[var(--surface-2)] border border-[var(--border)] rounded-xl">
                    <span className="text-xl shrink-0">{getCategoryIcon(bestCategoryEntry.cat)}</span>
                    <div>
                      <p className="text-sm font-bold">{bestCategoryEntry.cat} {t('home.bestDeptSuffix')}</p>
                      <p className="text-[10px] text-[var(--text-soft)]">+{bestCategoryEntry.profit.toFixed(0)}€ · {bestCategoryEntry.count} {t('dash.salesPlural')}</p>
                    </div>
                  </div>
                )}
                {sellThroughRate > 0 && (
                  <div className="flex items-center gap-3 p-3 bg-[var(--surface-2)] border border-[var(--border)] rounded-xl">
                    <div className="flex-1">
                      <div className="flex items-center justify-between mb-1.5">
                        <p className="text-xs text-[var(--text-muted)] font-semibold">{t('home.sellThrough')}</p>
                        <p className="text-xs font-bold text-[var(--text)] num">{sellThroughRate}%</p>
                      </div>
                      <div className="h-1.5 bg-black/40 rounded-full overflow-hidden">
                        <div className={`h-full rounded-full transition-all ${sellThroughRate >= 60 ? 'bg-green-500' : sellThroughRate >= 30 ? 'bg-yellow-500' : 'bg-gray-600'}`} style={{ width: `${sellThroughRate}%` }} />
                      </div>
                      <p className="text-[10px] text-[var(--text-faint)] mt-1">{globalSold.length} {t('home.soldOf')} {totalItems} {t('home.totalWord')}</p>
                    </div>
                  </div>
                )}
              </div>
            </section>
            )}

            {/* ===== LIBRO PAGA SOCI (spostato qui dalla dashboard) ===== */}
            {Object.keys(sociProfits).length > 1 && (
              <section className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-5">
                <div className="flex items-center justify-between mb-4">
                  <p className="sys-label flex items-center gap-1.5"><Trophy size={10} /> {t('home.payroll')}</p>
                  <button onClick={() => setTeamPanelOpen(true)} className="text-[9px] text-[var(--text-faint)] hover:text-[var(--text-muted)] transition-colors">{t('home.detail')} →</button>
                </div>
                <div className="space-y-1.5">
                  {Object.values(sociProfits).sort((a: any, b: any) => b.profit - a.profit).map((socio: any, idx: number) => {
                    const maxP = Math.max(...Object.values(sociProfits).map((s: any) => s.profit), 1);
                    return (
                      <div key={idx} className={`flex items-center gap-3 p-3 rounded-xl transition-colors ${socio.name === user.name ? 'bg-[var(--fill)] border border-[var(--border)]' : ''}`}>
                        <div className="w-7 h-7 rounded-full bg-[var(--fill)] flex items-center justify-center text-xs font-semibold text-[var(--text-muted)] shrink-0">{socio.name[0]?.toUpperCase()}</div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1.5">
                            <span className="font-semibold text-sm truncate">{socio.name}</span>
                            {socio.name === user.name && <span className="text-[9px] bg-[var(--fill)] text-[var(--text-muted)] px-1.5 py-0.5 rounded-full shrink-0">{t('home.you')}</span>}
                          </div>
                          <div className="h-0.5 bg-[var(--fill)] rounded-full overflow-hidden"><div className="h-full bg-[var(--fill-3)] rounded-full transition-all" style={{ width: `${(socio.profit / maxP) * 100}%` }} /></div>
                        </div>
                        <span className="font-extrabold text-[var(--teal)] shrink-0 text-sm num">{socio.profit.toFixed(0)}€</span>
                      </div>
                    );
                  })}
                </div>
              </section>
            )}

            {/* ===== COSTI EXTRA (accordion, chiuso di default per non invadere le analytics) ===== */}
            <section className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-5">
              <button type="button" onClick={() => setExpensesOpen(o => !o)} className="w-full flex items-center gap-2">
                <Wallet size={18} className="text-amber-400" />
                <h3 className="text-lg font-bold tracking-tighter">{t('an.extraCosts')}</h3>
                {!hasFeature('accounting') && <PlanLock plan="Pro" />}
                <span className="text-[11px] text-[var(--text-faint)] ml-auto num">
                  {expenses.length > 0 ? `${expenses.length} ${t('an.entries')} · -${expenses.reduce((a: number, e: any) => a + (e.amount || 0), 0).toFixed(0)}€` : t('an.none')}
                </span>
                <ChevronDown size={18} className={`text-[var(--text-soft)] transition-transform ${expensesOpen ? 'rotate-180' : ''}`} />
              </button>
              {!expensesOpen && <p className="text-[11px] text-[var(--text-faint)] mt-1">{t('an.extraCostsHint')}</p>}
              {expensesOpen && (<>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3 mt-4">
                <input type="number" step="0.01" min="0" value={expAmount} onChange={e => setExpAmount(e.target.value)}
                  placeholder={t('an.amount')} className="bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl px-3 py-2 text-sm outline-none focus:border-[#8397aa]" />
                <input type="text" value={expDesc} onChange={e => setExpDesc(e.target.value)}
                  placeholder={t('an.description')} className="bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl px-3 py-2 text-sm outline-none focus:border-[#8397aa]" />
                <select value={expCat} onChange={e => setExpCat(e.target.value)}
                  className="bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl px-3 py-2 text-sm outline-none focus:border-[#8397aa]">
                  {[['Sacchetti', t('an.catBags')], ['Spedizioni', t('an.catShipping')], ['Materiali', t('an.catMaterials')], ['Commissioni', t('an.catFees')], ['Altro', t('an.catOther')]].map(([v, lbl]) => <option key={v} value={v}>{lbl}</option>)}
                </select>
                {warehouses.filter((w: any) => !w.parentId).length > 1 ? (
                  <select value={expWarehouse || baseWarehouse?.id || ''} onChange={e => setExpWarehouse(e.target.value)}
                    className="bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl px-3 py-2 text-sm outline-none focus:border-[#8397aa]">
                    {warehouses.filter((w: any) => !w.parentId).map((w: any) => <option key={w.id} value={w.id}>{w.name}</option>)}
                  </select>
                ) : <div className="hidden sm:block" />}
              </div>
              <button onClick={addExpense} disabled={isAddingExp}
                className="w-full sm:w-auto px-5 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 text-black text-sm font-bold transition-colors disabled:opacity-50 mb-3">
                {isAddingExp ? <Loader2 className="animate-spin inline" size={16} /> : t('an.addCost')}
              </button>
              {expenses.length > 0 && (
                <div className="space-y-1.5 max-h-48 overflow-y-auto">
                  {expenses.slice(0, 30).map((e: any) => (
                    <div key={e.id} className="flex items-center justify-between gap-2 bg-[var(--surface-2)] rounded-lg px-3 py-2">
                      <div className="min-w-0">
                        <span className="text-sm text-[var(--text)] truncate">{e.description}</span>
                        <span className="text-[10px] text-[var(--text-faint)] ml-2">{e.category} · {e.date ? new Date(e.date).toLocaleDateString('it-IT') : ''}</span>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className="text-sm font-bold num text-amber-400">-{(e.amount || 0).toFixed(2)}€</span>
                        <button onClick={() => deleteExpense(e.id)} className="text-[var(--text-faint)] hover:text-red-400"><Trash2 size={14} /></button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              </>)}
            </section>

            {/* ===== MESI STORICI (dati economici PRIMA dell'apertura del conto) ===== */}
            <section className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-5">
              <button type="button" onClick={() => setManualOpen(o => !o)} className="w-full flex items-center gap-2">
                <BarChart3 size={18} className="text-[var(--teal)]" />
                <h3 className="text-lg font-bold tracking-tighter">{t('mm.title')}</h3>
                <span className="text-[11px] text-[var(--text-faint)] ml-auto num">
                  {manualMonths.length > 0 ? `${manualMonths.length} · +${manualMonths.reduce((a, m) => a + ((m.revenue || 0) - (m.cost || 0)), 0).toFixed(0)}€` : t('ct.none')}
                </span>
                <ChevronDown size={18} className={`text-[var(--text-soft)] transition-transform ${manualOpen ? 'rotate-180' : ''}`} />
              </button>
              {!manualOpen && <p className="text-[11px] text-[var(--text-faint)] mt-1">{t('mm.hint')}</p>}
              {manualOpen && (<>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-4 mb-3">
                  <select value={mmMonth} onChange={e => setMmMonth(e.target.value)}
                    className="bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl px-3 py-2 text-sm outline-none focus:border-[#8397aa]">
                    {Array.from({ length: 12 }, (_, i) => <option key={i} value={i} className="capitalize">{new Date(2000, i, 1).toLocaleDateString(dateLocale, { month: 'long' })}</option>)}
                  </select>
                  <input type="number" value={mmYear} onChange={e => setMmYear(e.target.value)} placeholder={t('mm.year')}
                    className="bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl px-3 py-2 text-sm outline-none focus:border-[#8397aa] num" />
                  <input type="number" step="0.01" min="0" value={mmRevenue} onChange={e => setMmRevenue(e.target.value)} placeholder={t('mm.revenue')}
                    className="bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl px-3 py-2 text-sm outline-none focus:border-[#8397aa] num" />
                  <input type="number" step="0.01" min="0" value={mmCost} onChange={e => setMmCost(e.target.value)} placeholder={t('mm.cost')}
                    className="bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl px-3 py-2 text-sm outline-none focus:border-[#8397aa] num" />
                </div>
                <button onClick={addManualMonth} disabled={isAddingMM}
                  className="w-full sm:w-auto px-5 py-2 rounded-xl bg-[var(--teal)] hover:opacity-90 text-black text-sm font-bold transition-opacity disabled:opacity-50 mb-3">
                  {isAddingMM ? <Loader2 className="animate-spin inline" size={16} /> : t('mm.save')}
                </button>
                {manualMonths.length > 0 && (
                  <div className="space-y-1.5 max-h-64 overflow-y-auto">
                    {manualMonths.map((m: any) => {
                      const prof = (m.revenue || 0) - (m.cost || 0);
                      const mn = new Date(2000, m.month, 1).toLocaleDateString(dateLocale, { month: 'short' });
                      return (
                        <div key={m.id} className="flex items-center justify-between gap-2 bg-[var(--surface-2)] rounded-lg px-3 py-2">
                          <span className="text-sm font-bold text-[var(--text)] w-20 shrink-0">{mn} {m.year}</span>
                          <span className="text-[11px] text-[var(--text-soft)] flex-1 num">{(m.revenue || 0).toFixed(0)}€ − {(m.cost || 0).toFixed(0)}€</span>
                          <span className={`text-sm font-bold num shrink-0 ${prof >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{prof >= 0 ? '+' : ''}{prof.toFixed(0)}€</span>
                          <button onClick={() => deleteManualMonth(m.id)} className="text-[var(--text-faint)] hover:text-red-400 shrink-0"><Trash2 size={14} /></button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </>)}
            </section>

            {/* ===== COMPRATORI & FORNITORI (accordion, chiusi di default) ===== */}
            {(() => {
              // Migliori COMPRATORI: da chi mi ha comprato (VENDUTO con nome cliente).
              const buyerStats: any[] = Object.values(products.filter((p: any) => p.status === 'VENDUTO' && (p.customer || '').trim()).reduce((acc: any, p: any) => {
                const name = (p.customer || '').trim();
                if (!acc[name]) acc[name] = { name, count: 0, revenue: 0, profit: 0, items: [] };
                acc[name].count++; acc[name].revenue += (p.salePrice || 0);
                acc[name].profit += ((p.salePrice || 0) - p.purchasePrice - (p.fees || 0));
                acc[name].items.push(p);
                return acc;
              }, {})).sort((a: any, b: any) => b.revenue - a.revenue);
              // Migliori FORNITORI: da chi ho acquistato (qualsiasi stato, campo supplier).
              const sellerStats: any[] = Object.values(products.filter((p: any) => (p.supplier || '').trim()).reduce((acc: any, p: any) => {
                const name = (p.supplier || '').trim();
                if (!acc[name]) acc[name] = { name, count: 0, spent: 0, items: [] };
                acc[name].count++; acc[name].spent += (p.purchasePrice || 0);
                acc[name].items.push(p);
                return acc;
              }, {})).sort((a: any, b: any) => b.spent - a.spent);
              const dfmt = (v: any) => v ? new Date(v).toLocaleDateString('it-IT', { day: 'numeric', month: 'short', year: '2-digit' }) : '—';

              return (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                  {/* COMPRATORI */}
                  <section className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-5">
                    <button type="button" onClick={() => { setContactSearch(''); setContactsPage('buyers'); }} className="w-full flex items-center gap-2">
                      <Users size={18} className="text-emerald-400" />
                      <h3 className="text-lg font-bold tracking-tighter">{t('ct.buyers')}</h3>
                      <span className="text-[11px] text-[var(--text-faint)] ml-auto num">{buyerStats.length > 0 ? `${buyerStats.length} · ${buyerStats.reduce((a, b) => a + b.revenue, 0).toFixed(0)}€` : t('ct.none')}</span>
                      <ChevronDown size={18} className="text-[var(--text-soft)] -rotate-90" />
                    </button>
                    <p className="text-[11px] text-[var(--text-faint)] mt-1">{t('ct.buyersHint')}</p>
                    {false && (
                      <div className="mt-3 space-y-1.5 max-h-96 overflow-y-auto">
                        {buyerStats.length === 0 && <p className="text-sm text-[var(--text-faint)] py-3 text-center">{t('ct.noBuyers')}</p>}
                        {buyerStats.map((b, i) => {
                          const ck = `buyer:${b.name}`; const open = expandedContact === ck;
                          return (
                            <div key={ck} className="rounded-xl bg-[var(--surface-2)] border border-[var(--border)]">
                              <button onClick={() => setExpandedContact(open ? null : ck)} className="w-full flex items-center gap-2 px-3 py-2.5 text-left">
                                <span className="w-6 text-[11px] font-black text-[var(--text-faint)] shrink-0">{i + 1}</span>
                                <span className="text-sm font-bold text-[var(--text)] truncate flex-1">{b.name}</span>
                                <span className="text-[11px] font-bold text-emerald-400 shrink-0 num">{b.revenue.toFixed(0)}€</span>
                                <span className="text-[10px] text-[var(--text-faint)] shrink-0 num">×{b.count}</span>
                                <ChevronDown size={14} className={`text-[var(--text-faint)] shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
                              </button>
                              {open && (
                                <div className="px-3 pb-2.5 space-y-1 border-t border-[var(--border)] pt-2">
                                  {b.items.map((p: any) => (
                                    <div key={p.id} className="flex items-center justify-between gap-2 text-[11px]">
                                      <span className="text-[var(--text-soft)] truncate">{fullName(p.brand, p.name)} <span className="text-[var(--text-faint)]">· {p.size}</span></span>
                                      <span className="text-[var(--text-faint)] shrink-0 num">{dfmt(p.soldAt)} · {(p.salePrice || 0).toFixed(0)}€</span>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </section>

                  {/* FORNITORI */}
                  <section className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-5">
                    <button type="button" onClick={() => { setContactSearch(''); setContactsPage('sellers'); }} className="w-full flex items-center gap-2">
                      <Package size={18} className="text-[#8397aa]" />
                      <h3 className="text-lg font-bold tracking-tighter">{t('ct.sellers')}</h3>
                      <span className="text-[11px] text-[var(--text-faint)] ml-auto num">{sellerStats.length > 0 ? `${sellerStats.length} · ${sellerStats.reduce((a, b) => a + b.spent, 0).toFixed(0)}€` : t('ct.none')}</span>
                      <ChevronDown size={18} className="text-[var(--text-soft)] -rotate-90" />
                    </button>
                    <p className="text-[11px] text-[var(--text-faint)] mt-1">{t('ct.sellersHint')}</p>
                    {false && (
                      <div className="mt-3 space-y-1.5 max-h-96 overflow-y-auto">
                        {sellerStats.length === 0 && <p className="text-sm text-[var(--text-faint)] py-3 text-center">{t('ct.noSellers')}</p>}
                        {sellerStats.map((s, i) => {
                          const ck = `seller:${s.name}`; const open = expandedContact === ck;
                          return (
                            <div key={ck} className="rounded-xl bg-[var(--surface-2)] border border-[var(--border)]">
                              <button onClick={() => setExpandedContact(open ? null : ck)} className="w-full flex items-center gap-2 px-3 py-2.5 text-left">
                                <span className="w-6 text-[11px] font-black text-[var(--text-faint)] shrink-0">{i + 1}</span>
                                <span className="text-sm font-bold text-[var(--text)] truncate flex-1">{s.name}</span>
                                <span className="text-[11px] font-bold text-[#8397aa] shrink-0 num">{s.spent.toFixed(0)}€</span>
                                <span className="text-[10px] text-[var(--text-faint)] shrink-0 num">×{s.count}</span>
                                <ChevronDown size={14} className={`text-[var(--text-faint)] shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
                              </button>
                              {open && (
                                <div className="px-3 pb-2.5 space-y-1 border-t border-[var(--border)] pt-2">
                                  {s.items.map((p: any) => (
                                    <div key={p.id} className="flex items-center justify-between gap-2 text-[11px]">
                                      <span className="text-[var(--text-soft)] truncate">{fullName(p.brand, p.name)} <span className="text-[var(--text-faint)]">· {p.size}</span></span>
                                      <span className="text-[var(--text-faint)] shrink-0 num">{dfmt(p.createdAt)} · {(p.purchasePrice || 0).toFixed(0)}€</span>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </section>
                </div>
              );
            })()}

            {/* ===== CONTO ECONOMICO MENSILE ===== */}
            {(() => {
              const monthSold = products.filter((p: any) => {
                if (p.status !== 'VENDUTO' || !p.soldAt) return false;
                const d = new Date(p.soldAt);
                return d.getFullYear() === reportMonth.y && d.getMonth() === reportMonth.m;
              });
              const ricavi = monthSold.reduce((a: number, p: any) => a + (p.salePrice || 0), 0);
              const costo = monthSold.reduce((a: number, p: any) => a + p.purchasePrice, 0);
              const fees = monthSold.reduce((a: number, p: any) => a + (p.fees || 0), 0);
              // Costi extra del mese (sacchetti, spedizioni…): entrano nell'utile netto
              const speseMese = expenses.filter((e: any) => { const d = new Date(e.date); return d.getFullYear() === reportMonth.y && d.getMonth() === reportMonth.m; });
              const totSpese = speseMese.reduce((a: number, e: any) => a + (e.amount || 0), 0);
              const netto = ricavi - costo - fees - totSpese;
              const roi = costo > 0 ? (netto / costo * 100) : 0;
              // Investimenti del mese = capitale immesso in magazzino (pezzi ACQUISTATI nel mese).
              const investiti = products.filter((p: any) => { const d = new Date(p.createdAt); return d.getFullYear() === reportMonth.y && d.getMonth() === reportMonth.m; }).reduce((a: number, p: any) => a + (p.purchasePrice || 0), 0);
              // Bolle stile "Trade Republic": Entrate / Uscite / Investimenti (area ∝ valore).
              const usciteTot = costo + fees + totSpese;
              const bubbleMax = Math.max(ricavi, usciteTot, investiti, 1);
              const bubbleR = (v: number) => Math.round(56 + 96 * Math.sqrt(Math.max(v, 0) / bubbleMax)); // diametro px
              // Confronto col mese precedente
              const pm = reportMonth.m === 0 ? { y: reportMonth.y - 1, m: 11 } : { y: reportMonth.y, m: reportMonth.m - 1 };
              const prevSold = products.filter((p: any) => { if (p.status !== 'VENDUTO' || !p.soldAt) return false; const d = new Date(p.soldAt); return d.getFullYear() === pm.y && d.getMonth() === pm.m; });
              const prevNetto = prevSold.reduce((a: number, p: any) => a + ((p.salePrice || 0) - p.purchasePrice - (p.fees || 0)), 0);
              const hasPrev = prevSold.length > 0;
              const deltaPct = prevNetto !== 0 ? ((netto - prevNetto) / Math.abs(prevNetto) * 100) : (netto > 0 ? 100 : 0);
              // Export CSV del mese
              const exportMonth = () => {
                const rows = [['Brand', 'Nome', 'Taglia', 'Acquisto', 'Vendita', 'Fee', 'Profitto', 'Piattaforma', 'Data vendita']];
                monthSold.forEach((p: any) => rows.push([
                  p.brand, p.name, p.size || '', String(p.purchasePrice), String(p.salePrice || 0), String(p.fees || 0),
                  ((p.salePrice || 0) - p.purchasePrice - (p.fees || 0)).toFixed(2), p.platform || '',
                  p.soldAt ? new Date(p.soldAt).toLocaleDateString('it-IT') : '',
                ]));
                // Costi extra del mese in coda al CSV (per il commercialista)
                speseMese.forEach((e: any) => rows.push([
                  'COSTO EXTRA', e.description || '', '', '0', '0', '0',
                  (-(e.amount || 0)).toFixed(2), e.category || '',
                  e.date ? new Date(e.date).toLocaleDateString('it-IT') : '',
                ]));
                const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
                const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url; a.download = `report-${reportMonth.y}-${String(reportMonth.m + 1).padStart(2, '0')}.csv`; a.click();
                URL.revokeObjectURL(url);
              };
              const label = new Date(reportMonth.y, reportMonth.m, 1).toLocaleDateString(lang === 'it' ? 'it-IT' : lang === 'es' ? 'es-ES' : lang === 'de' ? 'de-DE' : 'en-US', { month: 'long', year: 'numeric' });
              const shift = (delta: number) => setReportMonth(({ y, m }) => {
                const nm = m + delta;
                return { y: y + Math.floor(nm / 12), m: ((nm % 12) + 12) % 12 };
              });
              const byPlat: Record<string, number> = {};
              monthSold.forEach((p: any) => { const k = p.platform || 'Privato'; byPlat[k] = (byPlat[k] || 0) + ((p.salePrice || 0) - p.purchasePrice - (p.fees || 0)); });
              const topPlat = Object.entries(byPlat).sort((a, b) => b[1] - a[1])[0];
              // Profitto per reparto (del mese)
              const byCat: Record<string, number> = {};
              monthSold.forEach((p: any) => { const k = p.category || 'Altro'; byCat[k] = (byCat[k] || 0) + ((p.salePrice || 0) - p.purchasePrice - (p.fees || 0)); });
              const catRows = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
              const maxCatAbs = Math.max(...catRows.map(([, v]) => Math.abs(v)), 1);
              const now = new Date();
              const isCurrent = reportMonth.y === now.getFullYear() && reportMonth.m === now.getMonth();
              return (
                <section className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-5">
                  <div className="flex items-center justify-between mb-4 gap-2">
                    <h3 className="font-semibold">{t('an.incomeStatement')}</h3>
                    <div className="flex items-center gap-2">
                      {monthSold.length > 0 && (
                        <button onClick={exportMonth} title="Esporta CSV del mese"
                          className="flex items-center gap-1.5 bg-[var(--surface-2)] border border-[var(--border-2)] hover:border-[var(--border-3)] text-[var(--text-soft)] hover:text-[var(--text)] px-2.5 py-1.5 rounded-lg text-xs font-bold transition-colors">
                          <Download size={13} /> <span className="hidden sm:inline">{t('an.export')}</span>
                        </button>
                      )}
                      <div className="flex items-center gap-1">
                        <button onClick={() => shift(-1)} className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-[var(--fill)] text-[var(--text-muted)] text-lg">‹</button>
                        <span className="text-sm font-bold capitalize min-w-[110px] sm:min-w-[130px] text-center">{label}</span>
                        <button onClick={() => shift(1)} disabled={isCurrent}
                          className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-[var(--fill)] text-[var(--text-muted)] text-lg disabled:opacity-30">›</button>
                      </div>
                    </div>
                  </div>
                  {monthSold.length === 0 ? (
                    <p className="text-center py-8 text-sm text-[var(--text-soft)] capitalize">{t('an.noSalesIn')} {label}</p>
                  ) : (
                    <>
                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                      <div className="bg-[var(--surface-2)] ring-1 ring-white/[0.02] rounded-xl p-4">
                        <p className="sys-label mb-1">{t('an.revenue')}</p>
                        <p className="text-2xl font-extrabold num text-[var(--teal)]">{ricavi.toFixed(0)}€</p>
                        <p className="text-[11px] text-[var(--text-soft)] mt-1">{monthSold.length} {monthSold.length === 1 ? t('dash.sale') : t('dash.salesPlural')}</p>
                      </div>
                      <div className="bg-[var(--surface-2)] ring-1 ring-white/[0.02] rounded-xl p-4">
                        <p className="sys-label mb-1">{t('an.costsFees')}</p>
                        <p className="text-2xl font-extrabold num text-[var(--text-soft)]">-{(costo + fees).toFixed(0)}€</p>
                        <p className="text-[11px] text-[var(--text-soft)] mt-1">{costo.toFixed(0)}€ {t('an.goods')} · {fees.toFixed(0)}€ {t('an.fee')}</p>
                      </div>
                      <div className="bg-[var(--surface-2)] ring-1 ring-white/[0.02] rounded-xl p-4">
                        <p className="sys-label mb-1">{t('an.netProfit')}</p>
                        <p className={`text-2xl font-extrabold num ${netto >= 0 ? 'text-[var(--teal)]' : 'text-[var(--rust)]'}`}>{netto >= 0 ? '+' : ''}{netto.toFixed(0)}€</p>
                        <p className="text-[11px] text-[var(--text-soft)] mt-1">
                          ROI {roi >= 0 ? '+' : ''}{roi.toFixed(0)}%
                          {hasPrev && <span className={`ml-1.5 font-bold ${deltaPct >= 0 ? 'text-[var(--teal)]' : 'text-[var(--rust)]'}`}>{deltaPct >= 0 ? '▲' : '▼'}{Math.abs(deltaPct).toFixed(0)}% <span className="font-normal text-[var(--text-faint)]">{t('an.vsPrevMonth')}</span></span>}
                        </p>
                      </div>
                      <div className="bg-[var(--surface-2)] ring-1 ring-white/[0.02] rounded-xl p-4">
                        <p className="sys-label mb-1">{t('an.topPlatform')}</p>
                        <p className="text-2xl font-extrabold truncate">{topPlat ? topPlat[0] : '—'}</p>
                        {topPlat && <p className="text-[11px] text-[var(--text-soft)] mt-1 num">{topPlat[1] >= 0 ? '+' : ''}{topPlat[1].toFixed(0)}€ {t('an.profit')}</p>}
                      </div>
                    </div>
                    {catRows.length > 0 && (
                      <div className="mt-4 pt-4 border-t border-[var(--border)]">
                        <p className="text-[10px] uppercase tracking-widest text-[var(--text-faint)] font-bold mb-3">{t('an.profitByDept')}</p>
                        <div className="space-y-2">
                          {catRows.map(([cat, val]) => (
                            <div key={cat} className="flex items-center gap-3">
                              <span className="text-xs w-24 shrink-0 truncate flex items-center gap-1.5"><span>{getCategoryIcon(cat)}</span>{cat}</span>
                              <div className="flex-1 h-2 bg-[var(--fill)] rounded-full overflow-hidden">
                                <div className={`h-full rounded-full ${val >= 0 ? 'bg-emerald-500' : 'bg-red-500'}`} style={{ width: `${(Math.abs(val) / maxCatAbs) * 100}%` }} />
                              </div>
                              <span className={`text-xs font-bold num w-16 text-right ${val >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{val >= 0 ? '+' : ''}{val.toFixed(0)}€</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    </>
                  )}
                </section>
              );
            })()}

            {/* KPI row 1: principali */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <div className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-4">
                <p className="text-[10px] lg:text-xs font-semibold text-[var(--text-muted)] tracking-[0.12em] uppercase mb-3 flex items-center gap-1.5">
                  <TrendingUp size={10} /> ROI
                </p>
                <p className={`text-2xl lg:text-3xl font-bold num ${parseFloat(roi) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{roi}%</p>
                <p className="text-[11px] text-[var(--text-faint)] mt-1.5">{t('an.roiSub')}</p>
              </div>
              <div className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-4">
                <p className="text-[10px] lg:text-xs font-semibold text-[var(--text-muted)] tracking-[0.12em] uppercase mb-3 flex items-center gap-1.5">
                  <Wallet size={10} /> {t('an.netProfitKpi')}
                </p>
                <p className={`text-2xl lg:text-3xl font-bold num ${profittoNetto >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{profittoNetto.toFixed(0)}€</p>
                <p className="text-[11px] text-[var(--text-faint)] mt-1.5">{t('an.afterFees')} · {ricaviTotali.toFixed(0)}€ {t('an.revenueLower')}</p>
              </div>
              <div className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-4">
                <p className="text-[10px] lg:text-xs font-semibold text-[var(--text-muted)] tracking-[0.12em] uppercase mb-3 flex items-center gap-1.5">
                  <Layers size={10} /> {t('dash.stock')}
                </p>
                <p className="text-2xl lg:text-3xl font-bold num">{stockValore.toFixed(0)}€</p>
                <p className="text-[11px] text-[var(--text-faint)] mt-1.5">{t('an.capitalLocked')}</p>
              </div>
              <div className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-4">
                <p className="text-[10px] lg:text-xs font-semibold text-[var(--text-muted)] tracking-[0.12em] uppercase mb-3 flex items-center gap-1.5">
                  <DollarSign size={10} /> {t('an.sales')}
                </p>
                <p className="text-2xl lg:text-3xl font-bold text-[#9fb0bd] num">{soldItemsTotal.length}</p>
                <p className="text-[11px] text-[var(--text-faint)] mt-1.5">{t('an.totals')} · {sellThroughRate}% sell-through</p>
              </div>
            </div>

            {/* KPI row 2: metriche operative */}
            <div className="grid grid-cols-3 gap-2">
              <div className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-3 text-center">
                <p className={`text-[clamp(14px,4.2vw,20px)] font-bold num tracking-tight leading-none whitespace-nowrap ${avgMarginPct >= 20 ? 'text-emerald-400' : avgMarginPct >= 0 ? 'text-[#9fb0bd]' : 'text-red-400'}`}>
                  {avgMarginPct >= 0 ? '+' : ''}{avgMarginPct.toFixed(1)}%
                </p>
                <p className="text-[9px] text-[var(--text-faint)] font-semibold mt-1.5 leading-tight">
                  <span className="sm:hidden">{t('an.marginShort')}</span>
                  <span className="hidden sm:inline">{t('an.marginAvg')}</span>
                </p>
              </div>
              <div className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-3 text-center">
                <p className="text-xl font-bold text-[#9fb0bd] num">{Math.round(avgDaysToSell)}</p>
                <p className="text-[9px] text-[var(--text-faint)] font-semibold mt-1.5 leading-tight">
                  <span className="sm:hidden">{t('an.daysPerSaleShort')}</span>
                  <span className="hidden sm:inline">{t('an.daysPerSaleLong')}</span>
                </p>
              </div>
              <div className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-3 text-center">
                <p className="text-xl font-bold text-[var(--text)] num">{sellThroughRate}%</p>
                <p className="text-[9px] text-[var(--text-faint)] font-semibold mt-1.5 leading-tight">Sell-through</p>
              </div>
            </div>

            {/* Grafico Andamento rimosso da Analytics: è già in Dashboard (niente duplicati). */}

            {/* Piattaforme + Soci — 2 colonne su desktop */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
              {platformBreakdown.length > 0 && (
                <section className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-5">
                  <div className="flex items-center gap-2 mb-4">
                    <Store className="text-[var(--text)]" size={15} />
                    <h3 className="font-semibold">{t('an.platforms')}</h3>
                  </div>
                  <div className="space-y-4">
                    {platformBreakdown.map(([plat, stats]) => {
                      const maxRev = platformBreakdown[0]?.[1]?.revenue || 1;
                      const platMargin = stats.count > 0 ? stats.profit / stats.count : 0;
                      return (
                        <div key={plat}>
                          <div className="flex items-center justify-between mb-1.5">
                            <span className="text-sm font-bold">{plat}</span>
                            <div className="flex items-center gap-3">
                              <span className="text-[10px] text-[var(--text-soft)]">{stats.count} {t('an.salesAbbr')}</span>
                              <span className="text-sm font-semibold text-green-400">+{stats.profit.toFixed(0)}€</span>
                            </div>
                          </div>
                          <div className="h-2 bg-black/40 rounded-full overflow-hidden mb-1">
                            <div className="h-full bg-gradient-to-r from-[#8397aa] to-[#9fb0bd] rounded-full"
                              style={{ width: `${(stats.revenue / maxRev) * 100}%` }} />
                          </div>
                          <div className="flex justify-between">
                            <span className="text-[10px] text-[var(--text-faint)]">{stats.revenue.toFixed(0)}€ {t('an.revenueLower')} · {stats.fees.toFixed(0)}€ {t('an.fee')}</span>
                            <span className="text-[10px] text-[var(--text-soft)]">{platMargin >= 0 ? '+' : ''}{platMargin.toFixed(0)}€/{t('an.salesAbbr')}</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </section>
              )}

              {Object.keys(sociProfits).length > 0 && (
                <section className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-5">
                  <div className="flex items-center gap-2 mb-4">
                    <Users className="text-[#9fb0bd]" size={15} />
                    <h3 className="font-semibold">{t('an.partners')}</h3>
                  </div>
                  <div className="space-y-4">
                    {Object.values(sociProfits)
                      .sort((a: any, b: any) => b.profit - a.profit)
                      .map((socio: any, idx) => {
                        const maxP = Math.max(...Object.values(sociProfits).map((s: any) => s.profit), 1);
                        const medals = ['🥇', '🥈', '🥉'];
                        return (
                          <div key={idx}>
                            <div className="flex items-center justify-between mb-1.5">
                              <div className="flex items-center gap-2">
                                <span className="text-sm w-5">{medals[idx] || ''}</span>
                                <div className="w-6 h-6 rounded-full bg-gradient-to-br from-blue-500 to-blue-700 flex items-center justify-center font-black text-[10px]">
                                  {socio.name[0]?.toUpperCase()}
                                </div>
                                <span className="text-sm font-bold">{socio.name}</span>
                                {socio.name === user.name && (
                                  <span className="text-[9px] bg-[#8397aa]/20 text-[var(--text)] px-1.5 py-0.5 rounded-full">{t('an.you')}</span>
                                )}
                              </div>
                              <span className="font-semibold text-green-400">{socio.profit.toFixed(0)}€</span>
                            </div>
                            <div className="h-2 bg-black/40 rounded-full overflow-hidden">
                              <div className="h-full bg-gradient-to-r from-blue-600 to-blue-400 rounded-full"
                                style={{ width: `${(socio.profit / maxP) * 100}%` }} />
                            </div>
                          </div>
                        );
                      })}
                  </div>
                </section>
              )}
            </div>

            {/* Top 3 prodotti più redditizi */}
            {globalSold.filter(p => p.salePrice && p.salePrice > 0).length >= 3 && (() => {
              const top = [...globalSold]
                .filter(p => p.salePrice && p.salePrice > 0)
                .map(p => ({ ...p, profit: (p.salePrice || 0) - p.purchasePrice - (p.fees || 0) }))
                .sort((a, b) => b.profit - a.profit)
                .slice(0, 3);
              return (
                <section className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-5">
                  <div className="flex items-center gap-2 mb-4">
                    <Trophy className="text-[var(--text)]" size={15} />
                    <h3 className="font-semibold">{t('an.top3')}</h3>
                  </div>
                  <div className="space-y-3">
                    {top.map((p, i) => {
                      const medals = ['🥇', '🥈', '🥉'];
                      const margin = p.purchasePrice > 0 ? ((p.profit / p.purchasePrice) * 100) : 0;
                      return (
                        <div key={p.id} className="flex items-center gap-3 p-3 bg-[var(--surface-2)] rounded-xl">
                          <span className="text-lg shrink-0">{medals[i]}</span>
                          <div className="flex-1 min-w-0">
                            <p className="font-bold text-sm truncate">{fullName(p.brand, p.name)}</p>
                            <p className="text-[10px] text-[var(--text-soft)]">{p.size} · {p.platform} · {p.purchasePrice.toFixed(0)}€→{(p.salePrice || 0).toFixed(0)}€</p>
                          </div>
                          <div className="text-right shrink-0">
                            <p className="font-semibold text-green-400">+{p.profit.toFixed(0)}€</p>
                            <p className="text-[10px] text-green-600">+{margin.toFixed(0)}%</p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </section>
              );
            })()}

            {/* ---- Tabella Sell-Through per Categoria ---- */}
            {userCategories.length > 0 && (() => {
              const rows = userCategories.map(cat => {
                const catP = products.filter(p => p.category === cat);
                const catSold = catP.filter(p => p.status === 'VENDUTO');
                const catStock = catP.filter(p => p.status === 'IN STOCK');
                const profit = catSold.reduce((s, p) => s + ((p.salePrice || 0) - p.purchasePrice - (p.fees || 0)), 0);
                const capital = catStock.reduce((s, p) => s + p.purchasePrice, 0);
                const daysArr = catSold.filter(p => p.soldAt && p.createdAt)
                  .map(p => Math.floor((new Date(p.soldAt!).getTime() - new Date(p.createdAt!).getTime()) / 86400000));
                const avgDays = daysArr.length ? Math.round(daysArr.reduce((a, b) => a + b, 0) / daysArr.length) : null;
                const st = catP.length > 0 ? Math.round((catSold.length / catP.length) * 100) : 0;
                return { cat, total: catP.length, sold: catSold.length, inStock: catStock.length, profit, capital, avgDays, st };
              }).filter(r => r.total > 0);
              if (rows.length === 0) return null;
              return (
                <section className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-5">
                  <div className="flex items-center gap-2 mb-4">
                    <PieChartIcon className="text-[var(--text)]" size={15} />
                    <h3 className="font-semibold">{t('an.depts')}</h3>
                  </div>
                  <div className="overflow-x-auto -mx-1">
                    <table className="w-full text-[11px]">
                      <thead>
                        <tr className="border-b border-[var(--border-2)]">
                          {[t('an.thDept'), t('an.thTotal'), t('an.thSold'), t('an.thStock'), t('an.sellThrough'), t('an.thCapital'), t('an.thProfit'), t('an.daysPerSaleShort')].map(h => (
                            <th key={h} className="text-left text-[var(--text-faint)] font-semibold uppercase tracking-wider py-2 pr-4 last:pr-0">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[var(--border)]">
                        {rows.map(r => (
                          <tr key={r.cat} className="hover:bg-[var(--fill)] transition-colors">
                            <td className="py-2.5 pr-4 font-bold text-[var(--text)]">{getCategoryIcon(r.cat)} {r.cat}</td>
                            <td className="py-2.5 pr-4 text-[var(--text-muted)] num">{r.total}</td>
                            <td className="py-2.5 pr-4 text-[#9fb0bd] num">{r.sold}</td>
                            <td className="py-2.5 pr-4 text-[var(--text-muted)] num">{r.inStock}</td>
                            <td className="py-2.5 pr-4">
                              <div className="flex items-center gap-2">
                                <div className="w-16 h-1.5 bg-[var(--fill)] rounded-full overflow-hidden">
                                  <div className="h-full bg-[#8397aa] rounded-full" style={{ width: `${r.st}%` }} />
                                </div>
                                <span className={`num font-semibold ${r.st >= 60 ? 'text-emerald-400' : r.st >= 30 ? 'text-yellow-400' : 'text-red-400'}`}>{r.st}%</span>
                              </div>
                            </td>
                            <td className="py-2.5 pr-4 text-[var(--text-muted)] num">{r.capital.toFixed(0)}€</td>
                            <td className={`py-2.5 pr-4 num font-semibold ${r.profit >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{r.profit >= 0 ? '+' : ''}{r.profit.toFixed(0)}€</td>
                            <td className="py-2.5 text-[var(--text-soft)] num">{r.avgDays ?? '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              );
            })()}

            {/* ---- Dead-Stock Alert ---- */}
            {staleProducts.length > 0 && (
              <section className="bg-[var(--surface)] border border-yellow-500/20 rounded-2xl p-5">
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-2">
                    <AlertTriangle className="text-yellow-500" size={15} />
                    <h3 className="font-semibold">{t('an.deadStock')}</h3>
                    <span className="bg-yellow-500/10 text-yellow-400 text-[10px] font-bold px-2 py-0.5 rounded-full">{staleProducts.length} {t('an.products')}</span>
                  </div>
                  <span className="text-[10px] text-[var(--text-faint)]">{t('an.staleFor')}{staleThreshold} {t('an.daysLocked')} · {staleProducts.reduce((s: number, p: any) => s + (p.purchasePrice || 0), 0).toFixed(0)}€ {t('an.locked')}</span>
                </div>
                <div className="space-y-2">
                  {staleProducts.slice(0, 5).map((p: any) => {
                    const days = p.createdAt ? Math.floor((Date.now() - new Date(p.createdAt).getTime()) / 86400000) : 0;
                    return (
                      <div key={p.id} className="flex items-center gap-3 p-3 bg-[var(--surface-2)] rounded-xl">
                        <div className="w-8 h-8 rounded-lg bg-yellow-500/10 flex items-center justify-center flex-shrink-0">
                          <span className="text-base">{getCategoryIcon(p.category)}</span>
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-bold truncate">{fullName(p.brand, p.name)}</p>
                          <p className="text-[10px] text-[var(--text-soft)]">{p.size} · {p.condition}</p>
                        </div>
                        <div className="text-right shrink-0">
                          <p className="text-sm font-semibold text-[var(--text)]">{(p.purchasePrice || 0).toFixed(0)}€</p>
                          <p className="text-[10px] text-yellow-600">{days} {t('an.days')}</p>
                        </div>
                      </div>
                    );
                  })}
                  {staleProducts.length > 5 && (
                    <p className="text-[11px] text-[var(--text-faint)] text-center pt-1">+{staleProducts.length - 5} {t('an.moreStale')}</p>
                  )}
                </div>
              </section>
            )}
          </div>
        )}

        {/* ========== MARKETPLACE PUBBLICO ========== */}
        {currentView === 'market' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <h2 className="text-3xl font-semibold">{t('market.title')}</h2>
              <span className="text-xs text-[var(--text-faint)]">{marketItems.length} {t('market.itemsCount')}</span>
            </div>
            {/* Ricerca + categorie */}
            <div className="flex gap-2">
              <div className="flex-1 relative">
                <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-faint)]" />
                <input value={marketQuery} onChange={e => setMarketQuery(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') fetchMarket(); }}
                  placeholder={t('market.searchPlaceholder')}
                  className="w-full bg-[var(--surface)] border border-[var(--border-2)] rounded-xl pl-9 pr-3 py-2.5 text-sm outline-none focus:border-[#8397aa]" />
              </div>
              <button onClick={fetchMarket} className="px-4 py-2.5 rounded-xl bg-[#8397aa] text-white text-sm font-bold">{t('market.searchBtn')}</button>
            </div>
            {marketCats.length > 0 && (
              <div className="flex gap-2 flex-wrap">
                <button onClick={() => { setMarketCat(''); }} className={`px-3 py-1.5 rounded-lg text-xs font-bold border ${!marketCat ? 'bg-[#8397aa]/10 border-[#8397aa]' : 'bg-[var(--surface-2)] border-[var(--border-2)] text-[var(--text-soft)]'}`}>{t('market.all')}</button>
                {marketCats.map((c: string) => (
                  <button key={c} onClick={() => setMarketCat(c)} className={`px-3 py-1.5 rounded-lg text-xs font-bold border ${marketCat === c ? 'bg-[#8397aa]/10 border-[#8397aa]' : 'bg-[var(--surface-2)] border-[var(--border-2)] text-[var(--text-soft)]'}`}>{c}</button>
                ))}
              </div>
            )}
            {marketLoading ? (
              <div className="flex justify-center py-16"><Loader2 className="animate-spin text-[#8397aa]" size={28} /></div>
            ) : marketItems.length === 0 ? (
              <div className="text-center py-16 text-[var(--text-soft)]">{t('market.empty')}</div>
            ) : (
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                {marketItems.map((it: any) => (
                  <button key={it.id} onClick={() => openMarketDetail(it.id)}
                    className="text-left bg-[var(--surface)] border border-[var(--border)] rounded-2xl overflow-hidden hover:-translate-y-0.5 hover:shadow-lg transition-all">
                    <div className="aspect-square bg-white flex items-center justify-center overflow-hidden">
                      {it.photo ? <img src={it.photo} alt="" className="w-full h-full object-cover" /> : <span className="text-4xl">{getCategoryIcon(it.category)}</span>}
                    </div>
                    <div className="p-3">
                      <p className="font-bold text-sm truncate">{fullName(it.brand, it.name)}</p>
                      <p className="text-[11px] text-[var(--text-soft)]">{it.size} · {it.condition}</p>
                      <p className="text-lg font-bold mt-1">{it.price != null ? `${it.price}€` : '—'}</p>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ========== PORTAFOGLIO (Incassi marketplace) ========== */}
        {currentView === 'wallet' && (
          <div className="space-y-4 max-w-2xl">
            <div className="flex items-center gap-2">
              <Wallet className="text-[#8397aa]" size={26} />
              <h2 className="text-3xl font-semibold">{t('nav.wallet')}</h2>
              {connectStatus?.chargesEnabled
                ? <span className="text-[10px] font-bold text-green-400 bg-green-500/15 px-2 py-0.5 rounded-full">{t('wallet.accountActive')}</span>
                : connectStatus?.connected
                  ? <span className="text-[10px] font-bold text-yellow-400 bg-yellow-500/15 px-2 py-0.5 rounded-full">{t('wallet.toComplete')}</span>
                  : null}
            </div>

            {connectStatus?.configured === false ? (
              <div className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-6 text-sm text-[var(--text-soft)]">{t('wallet.notActive')}</div>
            ) : (
              <>
                {/* Saldo — due righe separate, così anche cifre grandi entrano */}
                <div className="flex flex-col gap-3">
                  <div className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-4 flex items-center justify-between gap-3">
                    <p className="text-[11px] text-[var(--text-soft)] uppercase tracking-widest shrink-0">{t('wallet.toCollect')}</p>
                    <p className="text-2xl sm:text-3xl font-bold num truncate text-right">{(wallet?.available ?? 0).toFixed(2)}€</p>
                  </div>
                  <div className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-4 flex items-center justify-between gap-3">
                    <p className="text-[11px] text-[var(--text-soft)] uppercase tracking-widest shrink-0">{t('wallet.awaitingDelivery')}</p>
                    <p className="text-2xl sm:text-3xl font-bold num truncate text-right text-[var(--text-soft)]">{(wallet?.pending ?? 0).toFixed(2)}€</p>
                  </div>
                </div>

                <button type="button" onClick={withdrawFunds} disabled={withdrawing || (wallet?.available ?? 0) <= 0}
                  className="w-full py-3 bg-[#8397aa] hover:bg-[#6f8394] rounded-2xl text-sm font-bold transition-colors disabled:opacity-40 flex items-center justify-center gap-2">
                  {withdrawing ? <Loader2 size={16} className="animate-spin" /> : <Wallet size={16} />}
                  {(wallet?.available ?? 0) > 0 ? `${t('wallet.collect')} ${(wallet?.available ?? 0).toFixed(2)}€` : t('wallet.nothingToCollect')}
                </button>
                <p className="text-[11px] text-[var(--text-faint)]">
                  {connectStatus?.chargesEnabled
                    ? t('wallet.verifiedHint')
                    : t('wallet.firstWithdrawHint')}
                </p>

                {/* Pronti da riscuotere */}
                {(wallet?.readyItems?.length ?? 0) > 0 && (
                  <div className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-4">
                    <p className="text-xs font-bold text-[var(--text-soft)] uppercase tracking-widest mb-2">{t('wallet.readyToCollect')}</p>
                    <div className="space-y-1.5">
                      {wallet!.readyItems.map((it: any) => (
                        <div key={it.id} className="flex justify-between text-sm">
                          <span className="truncate text-[var(--text)]">{it.name}</span>
                          <span className="font-bold num text-green-400">+{(it.amount || 0).toFixed(2)}€</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* In attesa di consegna */}
                {(wallet?.pendingItems?.length ?? 0) > 0 && (
                  <div className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-4">
                    <p className="text-xs font-bold text-[var(--text-soft)] uppercase tracking-widest mb-2">{t('wallet.awaitingBuyerConfirm')}</p>
                    <div className="space-y-1.5">
                      {wallet!.pendingItems.map((it: any) => (
                        <div key={it.id} className="flex justify-between text-sm">
                          <span className="truncate text-[var(--text-soft)]">{it.name}</span>
                          <span className="font-bold num text-[var(--text-soft)]">{(it.amount || 0).toFixed(2)}€</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {(wallet?.readyItems?.length ?? 0) === 0 && (wallet?.pendingItems?.length ?? 0) === 0 && (
                  <div className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-8 text-center text-sm text-[var(--text-soft)]">
                    {t('wallet.noIncome')}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* ========== CHAT ========== */}
        {currentView === 'chat' && (
          <div className="space-y-4">
            <h2 className="text-3xl font-semibold">{t('nav.messages')}</h2>
            {!activeConvo ? (
              conversations.length === 0 ? (
                <div className="text-center py-16 text-[var(--text-soft)]">{t('chat.empty')}</div>
              ) : (
                <div className="space-y-2">
                  {conversations.map((c: any) => (
                    <button key={c.id} onClick={() => openConversation(c)}
                      className="w-full flex items-center gap-3 bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-3 text-left hover:border-[var(--border-2)]">
                      <div className="w-12 h-12 rounded-xl bg-[var(--surface-2)] flex items-center justify-center overflow-hidden shrink-0">
                        {c.productPhoto ? <img src={c.productPhoto} alt="" className="w-full h-full object-cover" /> : <Store size={18} className="text-[var(--text-faint)]" />}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-bold text-sm truncate">{c.productName} · <span className="text-[var(--text-soft)]">{c.price != null ? `${c.price}€` : ''}</span></p>
                        <p className="text-[11px] text-[var(--text-soft)] truncate">{c.role === 'seller' ? '🟢 ' + t('chat.buyer') : t('market.seller')}: {c.otherName} — {c.lastMessage || t('chat.noMessage')}</p>
                      </div>
                    </button>
                  ))}
                </div>
              )
            ) : (
              <div className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl flex flex-col h-[calc(100dvh-13rem)] lg:h-[70vh] overflow-hidden">
                <div className="flex items-center gap-2 p-3 border-b border-[var(--border)]">
                  <button onClick={() => { setActiveConvo(null); setChatMessages([]); }} className="p-1.5 hover:bg-[var(--fill)] rounded-lg"><ChevronDown size={18} className="rotate-90" /></button>
                  <div className="flex-1 min-w-0">
                    <span className="font-bold text-sm truncate block">{activeConvo.otherName || activeConvo.productName || t('chat.conversation')}</span>
                    {activeConvo.productName && <span className="text-[11px] text-[var(--text-soft)] truncate block">{activeConvo.productName}{activeConvo.price != null ? ` · ${activeConvo.price}€` : ''}</span>}
                  </div>
                  {/* Solo per articoli PAGATI: il venditore spedisce. La vendita avviene quando
                      il compratore paga in-app, quindi niente piu "Vendi e spedisci" manuale. */}
                  {activeConvo.role === 'seller' && activeConvo.productStatus === 'PAGATO' && (
                    <button onClick={() => setShipForm(f => ({ ...f, open: true, price: activeConvo.price != null ? String(activeConvo.price) : '' }))}
                      className="shrink-0 px-3 py-1.5 rounded-lg text-xs font-bold bg-green-600 text-white flex items-center gap-1.5">
                      <Package size={13} /> {t('mag.ship')}</button>
                  )}
                  {activeConvo.role === 'buyer' && activeConvo.productStatus === 'PAGATO' && !activeConvo.disputeStatus && (
                    <>
                      <button onClick={confirmDelivery}
                        className="shrink-0 px-3 py-1.5 rounded-lg text-xs font-bold bg-[#8397aa] text-white flex items-center gap-1.5"><CheckCircle size={13} /> {t('chat.delivered')}</button>
                      <button onClick={() => setDisputeForm(f => ({ ...f, open: true }))}
                        className="shrink-0 px-3 py-1.5 rounded-lg text-xs font-bold bg-red-500/15 text-red-400 flex items-center gap-1.5"><AlertTriangle size={13} /> {t('chat.problem')}</button>
                    </>
                  )}
                  {activeConvo.role === 'buyer' && (!activeConvo.productStatus || activeConvo.productStatus === 'IN STOCK') && (
                    <>
                      <button onClick={() => payProduct(activeConvo.productId)}
                        className="shrink-0 px-3 py-1.5 rounded-lg text-xs font-bold bg-green-600 text-white flex items-center gap-1.5"><DollarSign size={13} /> {t('market.buy')}</button>
                      <button onClick={makeOffer}
                        className="shrink-0 px-3 py-1.5 rounded-lg text-xs font-bold bg-[var(--fill)] text-[var(--text)] border border-[var(--border-2)] flex items-center gap-1.5"><DollarSign size={13} /> {t('chat.offer')}</button>
                    </>
                  )}
                </div>
                {/* Barra spedizione: tracciamento + etichetta direttamente in chat */}
                {activeConvo.trackingCode && (
                  <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--border)] bg-[var(--surface-2)] shrink-0">
                    <Truck size={14} className="text-blue-400 shrink-0" />
                    <span className="text-[11px] text-[var(--text-soft)] truncate flex-1 num">{activeConvo.trackingCode}</span>
                    <button onClick={() => trackShipment(activeConvo.trackingCode)}
                      className="shrink-0 px-2.5 py-1 rounded-lg text-[11px] font-bold bg-blue-500/15 text-blue-400">{t('chat.track')}</button>
                    <button onClick={() => openDemoLabel(activeConvo.productName, activeConvo.role === 'seller' ? (user?.name || t('market.seller')) : t('market.seller'), activeConvo.role === 'buyer' ? (user?.name || t('chat.buyer')) : (activeConvo.otherName || t('chat.buyer')), activeConvo.trackingCode, activeConvo.trackingCarrier || 'Corriere')}
                      className="shrink-0 px-2.5 py-1 rounded-lg text-[11px] font-bold bg-[#8397aa]/15 text-[#8397aa]">{t('chat.label')}</button>
                  </div>
                )}
                {/* Banner contestazione */}
                {activeConvo.disputeStatus && (
                  <div className="px-3 py-2.5 border-b border-red-500/20 bg-red-500/10 shrink-0">
                    <div className="flex items-start gap-2">
                      <AlertTriangle size={15} className="text-red-400 shrink-0 mt-0.5" />
                      <div className="flex-1 min-w-0">
                        {activeConvo.disputeStatus === 'OPEN' && (
                          <>
                            <p className="text-xs font-bold text-red-400">{t('dispute.opened')}: {reasonLabelFE(activeConvo.disputeReason)}</p>
                            {disputeInfo?.note && <p className="text-[11px] text-[var(--text-soft)] mt-0.5">{disputeInfo.note}</p>}
                            {disputeInfo?.photos?.length > 0 && (
                              <div className="flex gap-1.5 mt-1.5 flex-wrap">
                                {disputeInfo.photos.map((p: string, i: number) => (
                                  <img key={i} src={p} alt="" className="w-12 h-12 rounded-lg object-cover border border-[var(--border-2)]" />
                                ))}
                              </div>
                            )}
                            {activeConvo.role === 'seller' ? (
                              <div className="flex flex-wrap gap-2 mt-2">
                                <button disabled={disputeSaving} onClick={() => respondDispute('refund')} className="px-2.5 py-1 rounded-lg text-[11px] font-bold bg-red-600 text-white disabled:opacity-50">{t('dispute.refundAll')}</button>
                                <button disabled={disputeSaving} onClick={() => respondDispute('partial')} className="px-2.5 py-1 rounded-lg text-[11px] font-bold bg-amber-500/20 text-amber-400 disabled:opacity-50">{t('dispute.partialRefund')}</button>
                                <button disabled={disputeSaving} onClick={() => respondDispute('contest')} className="px-2.5 py-1 rounded-lg text-[11px] font-bold bg-[var(--fill)] text-[var(--text-muted)] border border-[var(--border-2)] disabled:opacity-50">{t('dispute.contest')}</button>
                              </div>
                            ) : (
                              <p className="text-[11px] text-[var(--text-soft)] mt-1">{t('dispute.awaitingSeller')}</p>
                            )}
                          </>
                        )}
                        {activeConvo.disputeStatus === 'ESCALATED' && (
                          <p className="text-xs font-bold text-amber-400">{t('dispute.escalated')}</p>
                        )}
                      </div>
                    </div>
                  </div>
                )}
                <div className="flex-1 overflow-y-auto overscroll-contain p-3 space-y-2">
                  {chatMessages.map((m: any) => (
                    m.offerAmount != null ? (
                      <div key={m.id} className={`flex ${m.mine ? 'justify-end' : 'justify-start'}`}>
                        <div className="max-w-[80%] px-3 py-2 rounded-2xl text-sm bg-[var(--surface-2)] border border-[#8397aa]/30">
                          <p className="font-bold">💶 {t('chat.offerLabel')}: {m.offerAmount.toFixed(2)}€</p>
                          {m.offerStatus === 'accepted' && <p className="text-[11px] text-green-400 font-semibold mt-0.5">{t('chat.accepted')}</p>}
                          {m.offerStatus === 'declined' && <p className="text-[11px] text-red-400 font-semibold mt-0.5">{t('chat.declined')}</p>}
                          {m.offerStatus === 'pending' && activeConvo.role === 'seller' && (
                            <div className="flex gap-2 mt-2">
                              <button onClick={() => respondOffer(m.id, 'accept')} className="px-3 py-1 rounded-lg text-xs font-bold bg-green-600 text-white">{t('chat.accept')}</button>
                              <button onClick={() => respondOffer(m.id, 'decline')} className="px-3 py-1 rounded-lg text-xs font-bold bg-[var(--fill)] text-[var(--text-muted)]">{t('chat.decline')}</button>
                            </div>
                          )}
                          {m.offerStatus === 'pending' && activeConvo.role === 'buyer' && <p className="text-[11px] text-[var(--text-soft)] mt-0.5">{t('chat.awaitingResponse')}</p>}
                        </div>
                      </div>
                    ) : (
                    <div key={m.id} className={`flex ${m.mine ? 'justify-end' : 'justify-start'}`}>
                      <div className={`max-w-[75%] px-3 py-2 rounded-2xl text-sm ${m.mine ? 'bg-[#8397aa] text-white' : 'bg-[var(--surface-2)] text-[var(--text)]'}`}>{m.text}</div>
                    </div>
                    )
                  ))}
                  {chatMessages.length === 0 && <p className="text-center text-[var(--text-faint)] text-sm py-8">{t('chat.firstMessage')}</p>}
                </div>
                <div className="p-3 border-t border-[var(--border)] flex gap-2">
                  <input value={chatInput} onChange={e => setChatInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') sendMessage(); }}
                    placeholder={t('chat.messagePlaceholder')}
                    className="flex-1 bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl px-3 py-2 text-sm outline-none focus:border-[#8397aa]" />
                  <button onClick={sendMessage} disabled={chatSending || !chatInput.trim()}
                    className="px-4 py-2 rounded-xl bg-[#8397aa] text-white text-sm font-bold disabled:opacity-50">{t('chat.send')}</button>
                </div>
              </div>
            )}
            {/* Modale: completa vendita + spedizione dalla chat (venditore) */}
            {shipForm.open && activeConvo && createPortal((
              <div className="fixed inset-0 z-[200] bg-black/70 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={() => !shipping && setShipForm(f => ({ ...f, open: false }))} {...swipeBack(() => { if (!shipping) setShipForm(f => ({ ...f, open: false })); })}>
                <div className="bg-[var(--surface)] border-t sm:border border-[var(--border-2)] rounded-t-3xl sm:rounded-3xl w-full max-w-md p-6" onClick={e => e.stopPropagation()}>
                  <div className="flex justify-center mb-4 sm:hidden"><div className="w-10 h-1 bg-gray-700 rounded-full" /></div>
                  <h2 className="text-xl font-semibold mb-1">{activeConvo.productStatus === 'PAGATO' ? t('ship.titlePaid') : t('ship.titleSell')}</h2>
                  <p className="text-xs text-[var(--text-soft)] mb-5">
                    {activeConvo.productStatus === 'PAGATO'
                      ? `${activeConvo.productName} — ${t('ship.descPaid')}`
                      : `${activeConvo.productName} — ${t('ship.descSell')}`}
                  </p>
                  <div className="space-y-4">
                    {activeConvo.productStatus === 'PAGATO' && (
                      <button onClick={shipTestLabel} disabled={shipping}
                        className="w-full py-3 rounded-xl bg-[#8397aa]/15 text-[#8397aa] font-bold text-sm flex items-center justify-center gap-2 disabled:opacity-50">
                        {shipping ? <Loader2 className="animate-spin" size={16} /> : <Package size={16} />} {t('ship.genTestLabel')}
                      </button>
                    )}
                    {activeConvo.productStatus !== 'PAGATO' && (
                    <div>
                      <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">{t('ship.agreedPrice')}</label>
                      <input type="number" step="0.01" value={shipForm.price} onChange={e => setShipForm(f => ({ ...f, price: e.target.value }))}
                        className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm outline-none focus:border-[#8397aa]" />
                    </div>
                    )}
                    <div>
                      <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">{t('sell.trackingCode')} {activeConvo.productStatus === 'PAGATO' ? '' : `(${t('form.optional')})`}</label>
                      <input value={shipForm.code} onChange={e => setShipForm(f => ({ ...f, code: e.target.value }))} placeholder={t('ship.codePlaceholder')}
                        className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm outline-none focus:border-[#8397aa]" />
                      <p className="text-[10px] text-[var(--text-faint)] mt-1">{t('ship.noLinks')}</p>
                    </div>
                    <div className="flex gap-2">
                      <button onClick={() => setShipForm(f => ({ ...f, open: false }))} disabled={shipping}
                        className="flex-1 py-3 rounded-xl bg-[var(--fill)] text-[var(--text-muted)] font-bold disabled:opacity-50">{t('common.cancel')}</button>
                      <button onClick={confirmShip} disabled={shipping}
                        className="flex-1 py-3 rounded-xl bg-green-600 text-white font-bold disabled:opacity-50 flex items-center justify-center gap-1.5">
                        {shipping ? <Loader2 className="animate-spin" size={18} /> : <><Package size={16} /> {activeConvo.productStatus === 'PAGATO' ? t('ship.confirmShip') : t('ship.confirmSell')}</>}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            ), document.body)}

            {/* ========== MODALE: FAI UN'OFFERTA (compratore) ========== */}
            {chatOffer.open && activeConvo && createPortal((
              <div className="fixed inset-0 z-[210] bg-black/70 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={() => setChatOffer(o => ({ ...o, open: false }))} {...swipeBack(() => setChatOffer(o => ({ ...o, open: false })))}>
                <div className="bg-[var(--surface)] border-t sm:border border-[var(--border-2)] rounded-t-3xl sm:rounded-3xl w-full max-w-sm p-6" onClick={e => e.stopPropagation()}>
                  <div className="flex justify-center mb-4 sm:hidden"><div className="w-10 h-1 bg-gray-700 rounded-full" /></div>
                  <h2 className="text-xl font-semibold mb-1 flex items-center gap-2"><DollarSign size={18} className="text-[#8397aa]" /> {t('offer.title')}</h2>
                  <p className="text-xs text-[var(--text-soft)] mb-5">{activeConvo.productName}{activeConvo.price != null ? ` · ${t('offer.price')} ${activeConvo.price}€` : ''}</p>
                  <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">{t('offer.yourOffer')}</label>
                  <input type="number" inputMode="decimal" step="0.01" autoFocus value={chatOffer.amount}
                    onChange={e => setChatOffer(o => ({ ...o, amount: e.target.value }))}
                    onKeyDown={e => { if (e.key === 'Enter') submitChatOffer(); }}
                    placeholder="es. 120"
                    className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-lg font-bold num outline-none focus:border-[#8397aa]" />
                  <div className="flex gap-2 mt-5">
                    <button onClick={() => setChatOffer(o => ({ ...o, open: false }))}
                      className="flex-1 py-3 rounded-xl bg-[var(--fill)] text-[var(--text-muted)] font-bold">{t('common.cancel')}</button>
                    <button onClick={submitChatOffer}
                      className="flex-1 py-3 rounded-xl bg-[#8397aa] text-white font-bold flex items-center justify-center gap-1.5"><DollarSign size={16} /> {t('offer.send')}</button>
                  </div>
                </div>
              </div>
            ), document.body)}

            {/* ========== MODALE: APRI CONTESTAZIONE (compratore) ========== */}
            {disputeForm.open && activeConvo && createPortal((
              <div className="fixed inset-0 z-[210] bg-black/70 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={() => !disputeSaving && setDisputeForm(f => ({ ...f, open: false }))} {...swipeBack(() => { if (!disputeSaving) setDisputeForm(f => ({ ...f, open: false })); })}>
                <div className="bg-[var(--surface)] border-t sm:border border-[var(--border-2)] rounded-t-3xl sm:rounded-3xl w-full max-w-md p-6 max-h-[92dvh] overflow-y-auto" onClick={e => e.stopPropagation()}>
                  <div className="flex justify-center mb-4 sm:hidden"><div className="w-10 h-1 bg-gray-700 rounded-full" /></div>
                  <h2 className="text-xl font-semibold mb-1 flex items-center gap-2"><AlertTriangle size={18} className="text-red-400" /> {t('dispute.title')}</h2>
                  <p className="text-xs text-[var(--text-soft)] mb-5">{activeConvo.productName} — {t('dispute.descLong')}</p>
                  <div className="space-y-4">
                    <div>
                      <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">{t('dispute.reason')}</label>
                      <select value={disputeForm.reason} onChange={e => setDisputeForm(f => ({ ...f, reason: e.target.value }))}
                        className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm outline-none focus:border-[#8397aa]">
                        {DISPUTE_REASONS_FE.map(r => <option key={r.v} value={r.v}>{r.l}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">{t('dispute.describe')}</label>
                      <textarea value={disputeForm.note} onChange={e => setDisputeForm(f => ({ ...f, note: e.target.value.slice(0, 1000) }))} rows={3} placeholder={t('dispute.describePh')}
                        className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm outline-none focus:border-[#8397aa] resize-none" />
                    </div>
                    <div>
                      <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">{t('dispute.proofPhotos')}</label>
                      <div className="flex gap-2 flex-wrap">
                        {disputeForm.photos.map((p, i) => (
                          <div key={i} className="relative">
                            <img src={p} alt="" className="w-16 h-16 rounded-lg object-cover border border-[var(--border-2)]" />
                            <button onClick={() => setDisputeForm(f => ({ ...f, photos: f.photos.filter((_, j) => j !== i) }))}
                              className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-red-600 text-white text-xs flex items-center justify-center">×</button>
                          </div>
                        ))}
                        {disputeForm.photos.length < 5 && (
                          <label className="w-16 h-16 rounded-lg border border-dashed border-[var(--border-2)] flex items-center justify-center cursor-pointer text-[var(--text-faint)]">
                            <Camera size={18} />
                            <input type="file" accept="image/*" className="hidden" onChange={async e => {
                              const file = e.target.files?.[0]; if (!file) return;
                              const c = await compressImage(file, 1024, 0.6);
                              setDisputeForm(f => ({ ...f, photos: [...f.photos, c].slice(0, 5) }));
                              e.currentTarget.value = '';
                            }} />
                          </label>
                        )}
                      </div>
                      <p className="text-[10px] text-[var(--text-faint)] mt-1">{t('dispute.photosDeleted')}</p>
                    </div>
                    <div className="flex gap-2 pt-1">
                      <button onClick={() => setDisputeForm(f => ({ ...f, open: false }))} disabled={disputeSaving}
                        className="flex-1 py-3 rounded-xl bg-[var(--fill)] text-[var(--text-muted)] font-bold disabled:opacity-50">{t('common.cancel')}</button>
                      <button onClick={submitDispute} disabled={disputeSaving}
                        className="flex-1 py-3 rounded-xl bg-red-600 text-white font-bold disabled:opacity-50 flex items-center justify-center gap-1.5">
                        {disputeSaving ? <Loader2 className="animate-spin" size={18} /> : <><AlertTriangle size={16} /> {t('dispute.submit')}</>}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            ), document.body)}
          </div>
        )}

        {/* ========== MODALE: DETTAGLIO ARTICOLO MARKETPLACE (portal → copre header/nav) ========== */}
        {marketDetail && createPortal((
          <div className="fixed inset-0 z-[200] bg-black/60 backdrop-blur-sm sm:flex sm:items-center sm:justify-center sm:p-4" onClick={() => setMarketDetail(null)} {...swipeBack(() => setMarketDetail(null))}>
            <div className="bg-[var(--card)] w-full h-full sm:h-auto sm:rounded-3xl sm:max-w-lg sm:max-h-[90vh] flex flex-col overflow-hidden" onClick={e => e.stopPropagation()}>
              {/* Header con chiudi (sempre visibile, sotto la status bar) */}
              <div className="flex items-center justify-between p-3 border-b border-[var(--border)] shrink-0"
                style={{ paddingTop: 'calc(0.75rem + env(safe-area-inset-top))' }}>
                <span className="font-bold text-sm truncate">{fullName(marketDetail.brand, marketDetail.name)}</span>
                <button onClick={() => setMarketDetail(null)} aria-label="Chiudi"
                  className="p-3 -mr-1 hover:bg-[var(--fill)] rounded-xl shrink-0 active:scale-95 transition-transform"><X size={22} /></button>
              </div>
              {/* Contenuto scrollabile */}
              <div className="flex-1 overflow-y-auto overscroll-contain">
                {(() => {
                  const photos: string[] = Array.isArray(marketDetail.photos) ? marketDetail.photos : [];
                  const idx = Math.min(marketPhotoIdx, Math.max(0, photos.length - 1));
                  return (
                    <>
                      <div className="aspect-square bg-white flex items-center justify-center overflow-hidden">
                        {photos[idx] ? <img src={photos[idx]} alt="" className="w-full h-full object-contain" /> : <img src="/logo.png" alt="" className="w-1/3 h-1/3 object-contain opacity-20" />}
                      </div>
                      {photos.length > 1 && (
                        <div className="flex gap-2 p-3 overflow-x-auto">
                          {photos.map((ph, i) => (
                            <button key={i} onClick={() => setMarketPhotoIdx(i)}
                              className={`w-14 h-14 rounded-lg overflow-hidden shrink-0 border-2 transition-colors ${i === idx ? 'border-[#8397aa]' : 'border-[var(--border-2)]'}`}>
                              <img src={ph} alt="" className="w-full h-full object-cover" />
                            </button>
                          ))}
                        </div>
                      )}
                    </>
                  );
                })()}
                <div className="p-5">
                  <p className="text-xl font-bold">{fullName(marketDetail.brand, marketDetail.name)}</p>
                  <p className="text-sm text-[var(--text-soft)] mt-1">{marketDetail.size} · {marketDetail.condition} · {marketDetail.category}</p>
                  {marketDetail.sku && <p className="text-[11px] text-[var(--text-faint)] mt-1">SKU: {marketDetail.sku}</p>}
                  <p className="text-3xl font-bold mt-3">{marketDetail.price != null ? `${marketDetail.price}€` : '—'}</p>
                  {marketDetail.breakdown && (
                    <p className="text-sm font-bold text-[#8397aa] mt-0.5">
                      {t('market.total')} {marketDetail.breakdown.total.toFixed(2)}€
                      <span className="font-normal text-[var(--text-soft)]"> · {t('market.totalIncl')}</span>
                    </p>
                  )}
                  <p className="text-xs text-[var(--text-soft)] mt-1">{t('market.seller')}: {marketDetail.sellerName}</p>
                </div>
              </div>
              {/* Barra azioni FISSA in basso (sempre raggiungibile) */}
              <div className="border-t border-[var(--border)] p-3 shrink-0" style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom))' }}>
                {isAuthenticated && marketDetail.sellerId && user?.id === marketDetail.sellerId ? (
                  <div className="text-center py-2 text-sm text-[var(--text-soft)] font-semibold">{t('market.yourItem')}</div>
                ) : isAuthenticated ? (
                  <>
                  {marketDetail.payEnabled && marketDetail.breakdown && (
                    <div className="mb-3 text-xs bg-[var(--surface-2)] rounded-xl p-3 space-y-1">
                      <div className="flex justify-between"><span className="text-[var(--text-soft)]">{t('market.item')}</span><span className="font-semibold">{marketDetail.breakdown.itemPrice.toFixed(2)}€</span></div>
                      {marketDetail.breakdown.shipping > 0 && <div className="flex justify-between"><span className="text-[var(--text-soft)]">{t('market.shipping')}</span><span className="font-semibold">{marketDetail.breakdown.shipping.toFixed(2)}€</span></div>}
                      <div className="flex justify-between"><span className="text-[var(--text-soft)]">{t('market.serviceFees')}</span><span className="font-semibold">{(marketDetail.breakdown.serviceFee + marketDetail.breakdown.fees).toFixed(2)}€</span></div>
                      <div className="flex justify-between pt-1 border-t border-[var(--border)] text-sm"><span className="font-bold">{t('market.total')}</span><span className="font-bold">{marketDetail.breakdown.total.toFixed(2)}€</span></div>
                    </div>
                  )}
                  <div className="flex gap-2">
                    {marketDetail.payEnabled ? (
                      <button onClick={() => payProduct(marketDetail.id)}
                        className="flex-1 py-3 rounded-xl bg-[#8397aa] hover:bg-[#6f8394] text-white font-bold transition-colors">{t('market.buyNow')}</button>
                    ) : (
                      <button onClick={() => contactSeller(marketDetail.id, `${t('market.buyMsgPre')}${fullName(marketDetail.brand, marketDetail.name)}${t('market.buyMsgPost')}`)}
                        className="flex-1 py-3 rounded-xl bg-[#8397aa] hover:bg-[#6f8394] text-white font-bold transition-colors">{t('market.buy')}</button>
                    )}
                    <button onClick={() => contactSeller(marketDetail.id)}
                      className="flex-1 py-3 rounded-xl bg-[var(--fill)] border border-[var(--border-2)] font-bold transition-colors">{t('market.contactSeller')}</button>
                  </div>
                  <p className="text-[10px] text-[var(--text-faint)] text-center mt-2">{marketDetail.payEnabled ? t('market.securePay') : t('market.chatSafe')}</p>
                  </>
                ) : (
                  <button onClick={() => { setMarketDetail(null); setPublicMarket(false); }}
                    className="w-full py-3 rounded-xl bg-[#8397aa] hover:bg-[#6f8394] text-white font-bold transition-colors">{t('market.loginToBuy')}</button>
                )}
              </div>
            </div>
          </div>
        ), document.body)}

        {/* ========== MODALE: ETICHETTA DI PROVA (in-app, niente nuova finestra) ========== */}
        {labelData && createPortal((
          <div className="fixed inset-0 z-[200] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4" onClick={() => setLabelData(null)} {...swipeBack(() => setLabelData(null))}>
            <div className="bg-white text-black rounded-2xl w-full max-w-sm p-6 relative" onClick={e => e.stopPropagation()}>
              <button onClick={() => setLabelData(null)} aria-label="Chiudi"
                className="absolute top-3 right-3 p-2 rounded-lg hover:bg-black/5 active:scale-95"><X size={20} /></button>
              <span className="inline-block bg-[#8397aa] text-white text-[11px] font-bold px-2 py-0.5 rounded-full">ETICHETTA DI PROVA</span>
              <h3 className="text-lg font-bold mt-3">{labelData.productName}</h3>
              <div className="text-sm text-gray-700 mt-2 space-y-1">
                <p><b>Mittente:</b> {labelData.sender}</p>
                <p><b>Destinatario:</b> {labelData.recipient}</p>
                <p><b>Corriere:</b> {labelData.carrier}</p>
              </div>
              <div className="font-mono text-xl font-bold tracking-widest mt-4 pt-3 border-t border-dashed border-gray-400">{labelData.code}</div>
              <div className="h-12 mt-2 rounded" style={{ background: 'repeating-linear-gradient(90deg,#111 0 3px,#fff 3px 6px)' }} />
              <p className="text-[11px] text-gray-500 mt-3">Etichetta dimostrativa — non valida per la spedizione reale.</p>
              <button onClick={() => setLabelData(null)}
                className="mt-4 w-full py-3 rounded-xl bg-[#8397aa] text-white font-bold">Chiudi</button>
            </div>
          </div>
        ), document.body)}

        {/* ========== SELETTORE PERIODO (da card Personal / grafico) ========== */}
        {periodPickerOpen && createPortal((
          <div className="fixed inset-0 z-[205] bg-black/60 backdrop-blur-sm flex flex-col justify-end sm:items-center sm:justify-center sm:p-4" onClick={() => setPeriodPickerOpen(false)}>
            <div className="bg-[var(--surface)] w-full sm:max-w-sm sm:rounded-3xl rounded-t-3xl border-t sm:border border-[var(--border-2)] overflow-hidden" onClick={e => e.stopPropagation()}
              style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}>
              <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border)]" style={{ paddingTop: 'calc(env(safe-area-inset-top, 0px) + 16px)' }}>
                <h3 className="font-extrabold">{t('per.title')}</h3>
                <button onClick={() => setPeriodPickerOpen(false)} className="p-1.5 rounded-full text-[var(--text-faint)] hover:text-[var(--text)] hover:bg-white/5"><X size={22} /></button>
              </div>
              <div className="p-4 space-y-2">
                {([['7d', t('per.7d')], ['30d', t('per.30d')], ['year', t('per.year')], ['all', t('per.all')]] as const).map(([k, lbl]) => (
                  <button key={k} onClick={() => { setPersonalPeriod({ kind: k as any }); setPeriodPickerOpen(false); }}
                    className={`w-full flex items-center justify-between px-4 py-3 rounded-xl text-sm font-bold transition-colors ${personalPeriod.kind === k ? 'bg-[#8397aa] text-white' : 'bg-[var(--surface-2)] text-[var(--text-soft)] hover:text-[var(--text)]'}`}>
                    {lbl} {personalPeriod.kind === k && <Check size={16} />}
                  </button>
                ))}
                {/* Intervallo personalizzato */}
                <div className="rounded-xl bg-[var(--surface-2)] border border-[var(--border-2)] p-3 space-y-2">
                  <p className="text-[11px] font-bold text-[var(--text-soft)] uppercase tracking-widest">{t('per.custom')}</p>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="min-w-0">
                      <label className="text-[10px] text-[var(--text-faint)]">{t('per.from')}</label>
                      <input type="date" value={ppFrom} onChange={e => setPpFrom(e.target.value)} className="w-full min-w-0 bg-[var(--surface)] border border-[var(--border-2)] rounded-lg px-2 py-2 text-sm outline-none focus:border-[#8397aa] appearance-none" />
                    </div>
                    <div className="min-w-0">
                      <label className="text-[10px] text-[var(--text-faint)]">{t('per.to')}</label>
                      <input type="date" value={ppTo} onChange={e => setPpTo(e.target.value)} className="w-full min-w-0 bg-[var(--surface)] border border-[var(--border-2)] rounded-lg px-2 py-2 text-sm outline-none focus:border-[#8397aa] appearance-none" />
                    </div>
                  </div>
                  <button onClick={() => { if (ppFrom || ppTo) { setPersonalPeriod({ kind: 'custom', from: ppFrom || undefined, to: ppTo || undefined }); setPeriodPickerOpen(false); } }}
                    disabled={!ppFrom && !ppTo}
                    className="w-full py-2 rounded-lg bg-[#8397aa] hover:bg-[#6f8394] text-white text-sm font-bold disabled:opacity-40">{t('per.apply')}</button>
                </div>
              </div>
            </div>
          </div>
        ), document.body)}

        {/* ========== PANNELLO NOTE / TASK ========== */}
        {taskPanelOpen && createPortal((
          <div className="fixed inset-0 z-[205] bg-black/60 backdrop-blur-sm flex flex-col justify-end sm:items-center sm:justify-center sm:p-4" onClick={() => { setTaskPanelOpen(false); setExpandedTask(null); }}>
            <div className="bg-[var(--surface)] w-full sm:max-w-md sm:rounded-3xl rounded-t-3xl border-t sm:border border-[var(--border-2)] max-h-[85vh] flex flex-col overflow-hidden" onClick={e => e.stopPropagation()}
              style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}>
              <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border)] shrink-0" style={{ paddingTop: 'calc(env(safe-area-inset-top, 0px) + 16px)' }}>
                <h3 className="font-extrabold flex items-center gap-2"><StickyNote size={18} className="text-[#8397aa]" /> {t('task.title')}</h3>
                <button onClick={() => { setTaskPanelOpen(false); setExpandedTask(null); }} className="p-1.5 rounded-full text-[var(--text-faint)] hover:text-[var(--text)] hover:bg-white/5"><X size={22} /></button>
              </div>
              {/* Aggiungi (testo + promemoria facoltativo con notifica) */}
              <div className="px-5 py-3 border-b border-[var(--border)] shrink-0 space-y-2">
                <div className="flex gap-2">
                  <input value={taskInput} onChange={e => setTaskInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') addTask(); }} maxLength={2000}
                    placeholder={t('task.placeholder')} className="flex-1 min-w-0 bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl px-3 py-2.5 text-sm outline-none focus:border-[#8397aa]" />
                  <button onClick={addTask} disabled={taskSaving || !taskInput.trim()}
                    className="px-4 rounded-xl bg-[#8397aa] hover:bg-[#6f8394] text-white text-sm font-bold disabled:opacity-40 shrink-0">
                    {taskSaving ? <Loader2 size={16} className="animate-spin" /> : t('task.add')}
                  </button>
                </div>
                <div className="flex items-center gap-2 text-[var(--text-soft)]">
                  <span className="text-sm">🔔</span>
                  <input type="datetime-local" value={taskRemind} onChange={e => setTaskRemind(e.target.value)}
                    className="flex-1 bg-[var(--surface-2)] border border-[var(--border-2)] rounded-lg px-2.5 py-1.5 text-xs outline-none focus:border-[#8397aa] text-[var(--text)]" />
                  {taskRemind
                    ? <button onClick={() => setTaskRemind('')} className="text-[var(--text-faint)] hover:text-red-400 text-xs font-bold px-1">✕</button>
                    : <span className="text-[10px] text-[var(--text-faint)]">{t('task.remindHint')}</span>}
                </div>
              </div>
              {/* Lista */}
              <div className="flex-1 overflow-y-auto px-5 py-3 space-y-2">
                {tasks.length === 0 && <p className="text-sm text-[var(--text-faint)] text-center py-6">{t('task.empty')}</p>}
                {tasks.map(tk => {
                  const editing = editingTask === tk.id;
                  const remindStr = tk.remindAt ? new Date(tk.remindAt).toLocaleString(lang === 'en' ? 'en-GB' : 'it-IT', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : null;
                  return (
                    <div key={tk.id} className={`rounded-xl border px-3 py-2.5 ${tk.done ? 'border-[var(--border)] opacity-55' : 'border-[var(--border-2)] bg-[var(--surface-2)]'}`}>
                      {editing ? (
                        <div className="space-y-2">
                          <textarea value={editText} onChange={e => setEditText(e.target.value)} rows={2} maxLength={2000} autoFocus
                            className="w-full bg-[var(--surface)] border border-[var(--border-2)] rounded-lg px-2.5 py-2 text-sm outline-none focus:border-[#8397aa] resize-none" />
                          <div className="flex items-center gap-2">
                            <span className="text-sm">🔔</span>
                            <input type="datetime-local" value={editRemind} onChange={e => setEditRemind(e.target.value)}
                              className="flex-1 bg-[var(--surface)] border border-[var(--border-2)] rounded-lg px-2.5 py-1.5 text-xs outline-none focus:border-[#8397aa] text-[var(--text)]" />
                            {editRemind && <button onClick={() => setEditRemind('')} className="text-[var(--text-faint)] hover:text-red-400 text-xs font-bold px-1">✕</button>}
                          </div>
                          <div className="flex justify-end gap-2">
                            <button onClick={() => setEditingTask(null)} className="px-3 py-1.5 text-xs font-bold text-[var(--text-soft)] hover:text-[var(--text)]">{t('common.cancel')}</button>
                            <button onClick={() => saveTaskEdit(tk.id)} disabled={!editText.trim()} className="px-4 py-1.5 rounded-lg bg-[#8397aa] hover:bg-[#6f8394] text-white text-xs font-bold disabled:opacity-40">{t('task.save')}</button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <div className="flex items-center gap-2.5">
                            <button onClick={() => toggleTask(tk)} className={`w-5 h-5 rounded-md border flex items-center justify-center shrink-0 ${tk.done ? 'bg-[#8397aa] border-[#8397aa]' : 'border-[var(--border-3)]'}`}>
                              {tk.done && <Check size={13} className="text-white" />}
                            </button>
                            {/* Tap sulla nota = MODIFICA (testo + promemoria) */}
                            <button onClick={() => startEditTask(tk)} className={`flex-1 min-w-0 text-left text-sm font-semibold truncate ${tk.done ? 'line-through text-[var(--text-faint)]' : 'text-[var(--text)]'}`}>
                              {tk.summary || tk.text}
                            </button>
                            <button onClick={() => deleteTask(tk.id)} className="text-[var(--text-faint)] hover:text-red-400 shrink-0"><Trash2 size={14} /></button>
                          </div>
                          {remindStr && (
                            <p className="text-[11px] text-[#9fb0bd] mt-1.5 pl-7 flex items-center gap-1">🔔 {remindStr}{tk.notified ? ` · ${t('task.notified')}` : ''}</p>
                          )}
                          {tk.text && tk.text !== (tk.summary || '') && (
                            <p className="text-[12px] text-[var(--text-soft)] mt-1 pl-7 whitespace-pre-wrap leading-relaxed line-clamp-3">{tk.text}</p>
                          )}
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        ), document.body)}

        {/* ========== POPUP: ATTIVA NOTIFICHE (quando metti un promemoria senza notifiche) ========== */}
        {notifyPrompt && createPortal((
          <div className="fixed inset-0 z-[220] bg-black/60 backdrop-blur-sm flex items-center justify-center p-5" onClick={() => setNotifyPrompt(false)}>
            <div className="bg-[var(--surface)] border border-[var(--border-2)] rounded-3xl p-6 w-full max-w-sm text-center" onClick={e => e.stopPropagation()}>
              <div className="w-14 h-14 rounded-2xl bg-[#8397aa]/15 text-[#8397aa] flex items-center justify-center mb-3 mx-auto text-3xl">🔔</div>
              <h3 className="text-lg font-black">{t('task.notifTitle')}</h3>
              <p className="text-sm text-[var(--text-soft)] mt-1.5 mb-4">{t('task.notifBody')}</p>
              <div className="flex gap-2">
                <button onClick={() => setNotifyPrompt(false)} className="flex-1 py-2.5 rounded-xl border border-[var(--border-2)] text-sm font-bold text-[var(--text-soft)] hover:text-[var(--text)]">{t('task.notifLater')}</button>
                <button onClick={async () => { setNotifyPrompt(false); await enablePush(); }} disabled={pushBusy}
                  className="flex-1 py-2.5 rounded-xl bg-[#8397aa] hover:bg-[#6f8394] text-white text-sm font-bold disabled:opacity-50">{t('task.notifEnable')}</button>
              </div>
            </div>
          </div>
        ), document.body)}

        {/* ========== MODALE: LINK VETRINA CONDIVISA ========== */}
        {shareResult && createPortal((
          <div className="fixed inset-0 z-[210] bg-black/60 backdrop-blur-sm flex items-center justify-center p-5" onClick={() => setShareResult(null)}>
            <div className="bg-[var(--surface)] border border-[var(--border-2)] rounded-3xl p-6 w-full max-w-md" onClick={e => e.stopPropagation()}>
              <div className="w-12 h-12 rounded-2xl bg-[#8397aa]/15 text-[#8397aa] flex items-center justify-center mb-3"><Share2 size={22} /></div>
              <h3 className="text-lg font-black">Vetrina creata · {shareResult.count} prodotti</h3>
              <p className="text-sm text-[var(--text-soft)] mt-1 mb-3">Link copiato negli appunti. Mostra <b>solo</b> questi prodotti (niente prezzi d'acquisto, clienti o resto del magazzino).</p>
              <div className="flex items-center gap-2 bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl px-3 py-2.5">
                <span className="text-[12px] text-[var(--text-soft)] truncate flex-1">{shareResult.url}</span>
                <button onClick={() => { navigator.clipboard.writeText(shareResult.url).catch(() => {}); showToast('Link copiato'); }}
                  className="text-[#8397aa] hover:text-[#9fb0bd] shrink-0"><Copy size={16} /></button>
              </div>
              <div className="flex gap-2 mt-4">
                <a href={shareResult.url} target="_blank" rel="noopener noreferrer"
                  className="flex-1 py-2.5 rounded-xl border border-[var(--border-2)] text-sm font-bold text-center text-[var(--text-soft)] hover:text-[var(--text)]">Apri</a>
                <button onClick={() => setShareResult(null)} className="flex-1 py-2.5 rounded-xl bg-[#8397aa] hover:bg-[#6f8394] text-white text-sm font-bold">Ok</button>
              </div>
            </div>
          </div>
        ), document.body)}

        {/* ========== POPUP CONFERMA ELIMINA (da swipe ← sinistra) ========== */}
        {swipeDelete && createPortal((
          <div className="fixed inset-0 z-[210] bg-black/60 backdrop-blur-sm flex items-center justify-center p-5" onClick={() => setSwipeDelete(null)}>
            <div className="bg-[var(--surface)] border border-[var(--border-2)] rounded-3xl p-5 w-full max-w-sm" onClick={e => e.stopPropagation()}>
              <div className="w-11 h-11 rounded-2xl bg-red-500/15 text-red-400 flex items-center justify-center mb-3"><Trash2 size={20} /></div>
              <h3 className="text-lg font-black">{t('sw.confirmTitle')}</h3>
              <p className="text-sm text-[var(--text-soft)] mt-1">{swipeDelete.brand} {swipeDelete.name} · {swipeDelete.size}</p>
              <p className="text-[12px] text-[var(--text-faint)] mt-2">{t('sw.confirmBody')}</p>
              <div className="flex gap-2 mt-4">
                <button onClick={() => setSwipeDelete(null)} className="flex-1 py-2.5 rounded-xl border border-[var(--border-2)] text-sm font-bold text-[var(--text-soft)] hover:text-[var(--text)]">{t('common.cancel')}</button>
                <button onClick={() => deleteProductGroup(swipeDelete)} className="flex-1 py-2.5 rounded-xl bg-red-600 hover:bg-red-500 text-white text-sm font-bold">{t('sw.confirmDelete')}</button>
              </div>
            </div>
          </div>
        ), document.body)}

        {/* ========== POPUP: TUTTI I COMPRATORI / FORNITORI (con ricerca) ========== */}
        {contactsPage && createPortal((() => {
          const isBuyers = contactsPage === 'buyers';
          const all: any[] = Object.values(
            (isBuyers
              ? products.filter((p: any) => p.status === 'VENDUTO' && (p.customer || '').trim())
              : products.filter((p: any) => (p.supplier || '').trim())
            ).reduce((acc: any, p: any) => {
              const nm = ((isBuyers ? p.customer : p.supplier) || '').trim();
              if (!acc[nm]) acc[nm] = { name: nm, count: 0, amount: 0, items: [] };
              acc[nm].count++;
              acc[nm].amount += isBuyers ? (p.salePrice || 0) : (p.purchasePrice || 0);
              acc[nm].items.push(p);
              return acc;
            }, {})
          ).sort((a: any, b: any) => b.amount - a.amount);
          const q = contactSearch.trim().toLowerCase();
          const stats = q ? all.filter((s: any) => s.name.toLowerCase().includes(q)) : all;
          const accent = isBuyers ? 'text-emerald-400' : 'text-[#8397aa]';
          const dfmt = (v: any) => v ? new Date(v).toLocaleDateString(dateLocale, { day: 'numeric', month: 'short', year: '2-digit' }) : '—';
          const close = () => { setContactsPage(null); setContactSearch(''); };
          return (
            <div className="fixed inset-0 z-[200] bg-black/60 backdrop-blur-sm flex flex-col sm:items-center sm:justify-center sm:p-4"
              onClick={e => { if (e.target === e.currentTarget) close(); }} {...swipeBack(close)}>
              <div className="bg-[var(--surface)] w-full h-full sm:h-auto sm:max-h-[85vh] sm:max-w-lg sm:rounded-3xl border-t sm:border border-[var(--border-2)] flex flex-col overflow-hidden" onClick={e => e.stopPropagation()}>
                {/* Header con X (chiude su PC e mobile) */}
                <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--border)] shrink-0" style={{ paddingTop: 'calc(0.75rem + env(safe-area-inset-top))' }}>
                  <div className="min-w-0 flex-1">
                    <h2 className="text-lg font-black truncate flex items-center gap-1.5">
                      {isBuyers ? <Users size={16} className="text-emerald-400" /> : <Package size={16} className="text-[#8397aa]" />}
                      {isBuyers ? t('ct.buyers') : t('ct.sellers')}
                    </h2>
                    <p className="text-[11px] text-[var(--text-soft)]">{all.length} · {all.reduce((a, s) => a + s.amount, 0).toFixed(0)}€</p>
                  </div>
                  <button onClick={close} aria-label={t('common.close')}
                    className="p-2 -mr-1 rounded-full text-[var(--text-faint)] hover:text-[var(--text)] hover:bg-white/5 shrink-0 active:scale-95 transition-transform"><X size={22} /></button>
                </div>
                {/* Ricerca */}
                <div className="px-4 py-2.5 border-b border-[var(--border)] shrink-0">
                  <div className="flex items-center gap-2 bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl px-3 py-2">
                    <Search size={16} className="text-[var(--text-faint)] shrink-0" />
                    <input value={contactSearch} onChange={e => setContactSearch(e.target.value)} autoFocus
                      placeholder={`${t('mag.search')}…`} className="flex-1 min-w-0 bg-transparent outline-none text-sm text-[var(--text)] placeholder:text-[var(--text-faint)]" />
                    {contactSearch && <button onClick={() => setContactSearch('')} className="text-[var(--text-faint)] hover:text-[var(--text)] shrink-0"><X size={15} /></button>}
                  </div>
                </div>
                <div className="flex-1 overflow-y-auto overscroll-contain p-3 space-y-2">
                {stats.length === 0 && <p className="text-center text-sm text-[var(--text-faint)] py-10">{q ? '—' : (isBuyers ? t('ct.noBuyers') : t('ct.noSellers'))}</p>}
                {stats.map((s, i) => {
                  const open = contactPageExpanded === s.name;
                  return (
                    <div key={s.name} className="rounded-2xl bg-[var(--surface)] border border-[var(--border)]">
                      <button onClick={() => setContactPageExpanded(open ? null : s.name)} className="w-full flex items-center gap-3 px-4 py-3 text-left">
                        <span className="w-6 text-sm font-black text-[var(--text-faint)] shrink-0">{i + 1}</span>
                        <span className="text-sm font-bold text-[var(--text)] truncate flex-1">{s.name}</span>
                        <span className={`text-sm font-bold num shrink-0 ${accent}`}>{s.amount.toFixed(0)}€</span>
                        <span className="text-[11px] text-[var(--text-faint)] num shrink-0 w-10 text-right">×{s.count}</span>
                        <ChevronDown size={16} className={`text-[var(--text-faint)] shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
                      </button>
                      {open && (
                        <div className="px-4 pb-3 space-y-1 border-t border-[var(--border)] pt-2">
                          {s.items.map((p: any) => (
                            <div key={p.id} className="flex items-center justify-between gap-2 text-[12px]">
                              <span className="text-[var(--text-soft)] truncate">{fullName(p.brand, p.name)} <span className="text-[var(--text-faint)]">· {p.size}</span></span>
                              <span className="text-[var(--text-faint)] shrink-0 num">{dfmt(isBuyers ? p.soldAt : p.createdAt)} · {(isBuyers ? (p.salePrice || 0) : (p.purchasePrice || 0)).toFixed(0)}€</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
                </div>
              </div>
            </div>
          );
        })(), document.body)}

        {/* ========== MODALE: DETTAGLIO MODELLO (suddivisione per taglia) ========== */}
        {modelDetail && createPortal((
          <div className="fixed inset-0 z-[200] bg-black/60 backdrop-blur-sm sm:flex sm:items-center sm:justify-center sm:p-4" onClick={() => setModelDetail(null)} {...swipeBack(() => setModelDetail(null))}>
            <div className="bg-[var(--surface)] w-full h-full sm:h-auto sm:rounded-3xl sm:max-w-lg sm:max-h-[90vh] flex flex-col overflow-hidden" onClick={e => e.stopPropagation()}>
              <div className="flex items-center gap-2 p-3 border-b border-[var(--border)] shrink-0" style={{ paddingTop: 'calc(0.75rem + env(safe-area-inset-top))' }}>
                <button onClick={() => setModelDetail(null)} aria-label={t('common.back')}
                  className="flex items-center gap-1 px-2 py-2 -ml-1 hover:bg-[var(--fill)] rounded-xl shrink-0 active:scale-95 transition-transform text-[var(--text-soft)] hover:text-[var(--text)]">
                  <ChevronDown size={20} className="rotate-90" /> <span className="text-sm font-bold">{t('common.back')}</span>
                </button>
                <div className="min-w-0 flex-1 text-center">
                  <p className="font-bold truncate">{modelDetail.brand} {modelDetail.name}</p>
                  <p className="text-[11px] text-[var(--text-soft)]">{modelSub(modelDetail)}</p>
                </div>
                <button onClick={() => setModelDetail(null)} aria-label={t('common.close')}
                  className="p-3 -mr-1 hover:bg-[var(--fill)] rounded-xl shrink-0 active:scale-95 transition-transform"><X size={22} /></button>
              </div>
              <div className="px-4 py-2 border-b border-[var(--border)] text-[10px] text-[var(--text-soft)]/80 shrink-0 text-center">{t('mag.modelPickHint')}</div>
              <div className="flex-1 overflow-y-auto overscroll-contain p-3 space-y-2">
                {modelDetail.sizes.map((s: any, i: number) => {
                  const ids: string[] = s.group.ids || [];
                  const sel = ids.length > 0 && ids.every((id: string) => selectedPieceIds.has(id));
                  return (
                  <div key={i} className={`flex items-center gap-2.5 rounded-2xl border px-3 py-3 transition-colors ${sel ? 'bg-[var(--accent)]/12 border-[var(--accent)]' : 'bg-[var(--surface-2)] border-[var(--border)]'}`}>
                    <button onClick={() => setSelectedPieceIds(prev => { setBulkMode(true); const next = new Set(prev); if (sel) ids.forEach(id => next.delete(id)); else ids.forEach(id => next.add(id)); return next; })}
                      aria-label={t('mag.select')}
                      className={`w-6 h-6 shrink-0 rounded-lg border-2 flex items-center justify-center transition-colors ${sel ? 'bg-[var(--accent)] border-[var(--accent)] text-white' : 'border-[var(--border-2)] text-transparent'}`}>
                      <Check size={14} strokeWidth={3} />
                    </button>
                    {/* Tap sul prodotto = apri la MODIFICA (come nel resto dell'app), non un'iconcina */}
                    <button onClick={() => { setModelDetail(null); openEditModal(s.group); }}
                      className="flex items-center gap-2.5 flex-1 min-w-0 text-left active:scale-[.99] transition-transform">
                      <div className="w-11 shrink-0 text-center">
                        <p className="text-[9px] text-[var(--text-faint)] uppercase tracking-widest">{t('form.size')}</p>
                        <p className="font-black text-lg leading-none">{s.size}</p>
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-bold">×{s.quantity} <span className="text-[var(--text-faint)] font-normal">· {(s.purchasePrice || 0).toFixed(0)}€ {t('mag.each')}</span></p>
                        {(s.condition || s.supplier || s.date) && (
                          <p className="text-[11px] text-[var(--text-soft)] truncate mt-0.5">
                            {s.condition ? `${s.condition} · ` : ''}
                            {s.supplier ? <span className="font-semibold text-[var(--text-muted)]">{t('mag.from')} {s.supplier}</span> : null}
                            {s.supplier && s.date ? ' · ' : ''}
                            {s.date ? new Date(s.date).toLocaleDateString(lang === 'en' ? 'en-GB' : 'it-IT') : ''}
                          </p>
                        )}
                      </div>
                    </button>
                    <button onClick={() => { setModelDetail(null); openSellModal(s.group.ids, `${fullName(modelDetail.brand, modelDetail.name)}`, s.group); }}
                      className="px-3 py-2 rounded-xl bg-green-600 hover:bg-green-500 text-white text-xs font-bold flex items-center gap-1.5"><DollarSign size={13} /> {t('mag.sell')}</button>
                  </div>
                  );
                })}
              </div>
            </div>
          </div>
        ), document.body)}

        {/* ========== MODALE: DETTAGLIO LOTTO (lista pezzi) ========== */}
        {lotDetail && createPortal((
          <div className="fixed inset-0 z-[200] bg-black/60 backdrop-blur-sm sm:flex sm:items-center sm:justify-center sm:p-4" onClick={() => setLotDetail(null)} {...swipeBack(() => setLotDetail(null))}>
            <div className="bg-[var(--card)] w-full h-full sm:h-auto sm:rounded-3xl sm:max-w-lg sm:max-h-[90vh] flex flex-col overflow-hidden" onClick={e => e.stopPropagation()}>
              <div className="flex items-center gap-2 p-3 border-b border-[var(--border)] shrink-0"
                style={{ paddingTop: 'calc(0.75rem + env(safe-area-inset-top))' }}>
                <button onClick={() => setLotDetail(null)} aria-label="Indietro"
                  className="flex items-center gap-1 px-2 py-2 -ml-1 hover:bg-[var(--fill)] rounded-xl shrink-0 active:scale-95 transition-transform text-[var(--text-soft)] hover:text-[var(--text)]">
                  <ChevronDown size={20} className="rotate-90" /> <span className="text-sm font-bold">{t('common.back')}</span>
                </button>
                <div className="min-w-0 flex-1 text-center">
                  <p className="font-bold truncate flex items-center justify-center gap-1.5"><Layers size={16} className="text-[#8397aa]" /> {lotDetail.lotName}</p>
                  <p className="text-[11px] text-[var(--text-soft)]">{lotDetail.category}</p>
                </div>
                <button onClick={() => setLotDetail(null)} aria-label="Chiudi"
                  className="p-3 -mr-1 hover:bg-[var(--fill)] rounded-xl shrink-0 active:scale-95 transition-transform"><X size={22} /></button>
              </div>
              {(() => {
                const pieces = products.filter((p: any) => p.lotName === lotDetail.lotName && p.status === 'IN STOCK');
                const tot = pieces.reduce((a: number, p: any) => a + (p.purchasePrice || 0), 0);
                const selCount = getBulkSelectedIds().length;
                return (
                  <>
                    <div className="px-4 py-2 border-b border-[var(--border)] text-[11px] text-[var(--text-soft)] shrink-0">
                      {pieces.length} pezzi · costo totale {tot.toFixed(0)}€ · {(tot / (pieces.length || 1)).toFixed(2)}€ cad.
                      <span className="block text-[10px] text-[var(--text-soft)]/70 mt-0.5">Tieni premuto un pezzo per selezionarlo e venderlo insieme ad altri</span>
                    </div>
                    <div className="flex-1 overflow-y-auto overscroll-contain p-3 space-y-2">
                      {pieces.map((p: any) => {
                        const picked = selectedPieceIds.has(p.id);
                        const selecting = bulkMode;
                        return (
                        <div key={p.id}
                          onMouseDown={() => startPieceLongPress(p.id)} onMouseUp={cancelLongPress} onMouseLeave={cancelLongPress}
                          onTouchStart={() => startPieceLongPress(p.id)} onTouchEnd={cancelLongPress}
                          onClick={() => { if (longPressFired.current) { longPressFired.current = false; return; } if (selecting) togglePieceSelection(p.id); }}
                          className={`flex items-center justify-between gap-2 rounded-xl p-3 select-none transition-all ${picked ? 'bg-[#8397aa]/15 ring-1 ring-[#8397aa]/60' : 'bg-[var(--surface-2)]'} ${selecting ? 'cursor-pointer' : ''}`}>
                          {selecting && (
                            <div className={`shrink-0 w-5 h-5 rounded-md border flex items-center justify-center ${picked ? 'bg-[#8397aa] border-[#8397aa]' : 'border-[var(--border-2)]'}`}>
                              {picked && <Check size={14} className="text-white" />}
                            </div>
                          )}
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-semibold truncate">{fullName(p.brand, p.name)}</p>
                            <p className="text-[11px] text-[var(--text-soft)]">{p.size} · {p.condition} · {p.purchasePrice?.toFixed(0)}€</p>
                          </div>
                          {!selecting && (
                          <div className="flex gap-1.5 shrink-0">
                            <button onClick={() => { setLotDetail(null); openEditModal({ ...p, ids: [p.id], quantity: 1, isLot: false }); }}
                              className="px-3 py-1.5 rounded-lg text-xs font-bold bg-[var(--fill)] text-[var(--text-muted)]">Modifica</button>
                            <button onClick={() => { setLotDetail(null); openSellModal([p.id], `${fullName(p.brand, p.name)}`, p); }}
                              className="px-3 py-1.5 rounded-lg text-xs font-bold bg-green-500/15 text-green-400">Vendi</button>
                          </div>
                          )}
                        </div>
                        );
                      })}
                    </div>
                    {selCount > 0 && (
                      <div className="border-t border-[var(--border)] p-3 shrink-0 flex gap-2"
                        style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom))' }}>
                        <button onClick={() => setLotDetail(null)}
                          className="flex-1 px-4 py-3 rounded-xl text-sm font-bold bg-[var(--fill)] text-[var(--text-muted)]">
                          Aggiungi altri prodotti
                        </button>
                        <button onClick={() => { setLotDetail(null); setBulkSellOpen(true); }}
                          className="flex-1 px-4 py-3 rounded-xl text-sm font-bold bg-green-600 text-white flex items-center justify-center gap-1.5">
                          <DollarSign size={16} /> Vendi {selCount} insieme
                        </button>
                      </div>
                    )}
                  </>
                );
              })()}
            </div>
          </div>
        ), document.body)}

        {/* ========== TRACKING PAGE ========== */}
        {currentView === 'tracking' && (() => {
          const allTracked = products.filter(p => p.trackingCode);
          const active = allTracked.filter(p => ['PENDING','IN_TRANSIT','OUT_FOR_DELIVERY'].includes(p.trackingStatus || 'PENDING'));
          const delivered = allTracked.filter(p => p.trackingStatus === 'DELIVERED');
          const exceptions = allTracked.filter(p => p.trackingStatus === 'EXCEPTION' || p.trackingStatus === 'RETURNED');

          const statusLabel = (s?: string) => {
            if (s === 'IN_TRANSIT') return { text: t('track.stInTransit'), cls: 'bg-blue-500/20 text-blue-400', dot: 'bg-blue-400' };
            if (s === 'OUT_FOR_DELIVERY') return { text: t('track.stOutForDelivery'), cls: 'bg-[#8397aa]/20 text-[#9fb0bd]', dot: 'bg-[#9fb0bd]' };
            if (s === 'DELIVERED') return { text: t('track.stDelivered'), cls: 'bg-green-500/20 text-green-400', dot: 'bg-green-400' };
            if (s === 'EXCEPTION') return { text: t('track.stException'), cls: 'bg-red-500/20 text-red-400', dot: 'bg-red-400' };
            if (s === 'RETURNED') return { text: t('track.stReturned'), cls: 'bg-[#8397aa]/20 text-[#9fb0bd]', dot: 'bg-[#9fb0bd]' };
            return { text: t('track.stPending'), cls: 'bg-[var(--fill)] text-[var(--text-soft)]', dot: 'bg-gray-600' };
          };

          const TrackCard = ({ p }: { p: Product }) => {
            let photos: string[] = [];
            try { photos = p.photos ? JSON.parse(p.photos) : []; } catch {}
            const st = statusLabel(p.trackingStatus);
            const dir = (p as any).trackingDirection || (p.status === 'VENDUTO' ? 'OUTBOUND' : 'INBOUND');
            const updatedAgo = p.trackingUpdatedAt
              ? (() => {
                  const mins = Math.floor((Date.now() - new Date(p.trackingUpdatedAt).getTime()) / 60000);
                  if (mins < 60) return `${mins}m ${t('track.ago')}`;
                  const hrs = Math.floor(mins / 60);
                  if (hrs < 24) return `${hrs}h ${t('track.ago')}`;
                  return `${Math.floor(hrs / 24)}${t('track.agoDay')} ${t('track.ago')}`;
                })()
              : null;

            return (
              <div className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl overflow-hidden hover:border-[var(--border-2)] transition-all">
                <div className="flex items-center gap-3 p-4">
                  {photos.length > 0 ? (
                    <div className="w-12 h-12 rounded-xl overflow-hidden shrink-0 border border-[var(--border-2)]">
                      <img src={photos[0]} alt="" className="w-full h-full object-cover" />
                    </div>
                  ) : (
                    <div className="w-12 h-12 rounded-xl bg-[var(--fill)] flex items-center justify-center shrink-0 text-xl">
                      {getCategoryIcon(p.category)}
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-bold text-sm">{fullName(p.brand, p.name)}</p>
                      <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold shrink-0 ${dir === 'OUTBOUND' ? 'bg-emerald-500/15 text-emerald-400' : 'bg-blue-500/15 text-blue-400'}`}>
                        {dir === 'OUTBOUND' ? t('track.dirSale') : t('track.dirIncoming')}
                      </span>
                      <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold flex items-center gap-1 shrink-0 ${st.cls}`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${st.dot}`} />
                        {st.text}
                      </span>
                    </div>
                    <p className="text-xs text-[var(--text-soft)] mt-0.5 font-mono truncate">{p.trackingCode}</p>
                    <div className="flex items-center gap-2 mt-1 flex-wrap">
                      <span className="text-[10px] text-[var(--text-faint)] bg-[var(--fill)] px-2 py-0.5 rounded-full">{p.trackingCarrier}</span>
                      {updatedAgo && <span className="text-[10px] text-[var(--text-faint)]">{t('track.updated')} {updatedAgo}</span>}
                    </div>
                  </div>
                  <button
                    onClick={() => { setCurrentView('magazzino'); setMagazzinoView('instock'); setTimeout(() => openTrackingModal({ ...p, ids: [p.id], quantity: 1 }), 100); }}
                    className="shrink-0 p-2 hover:bg-[var(--fill)] rounded-xl transition-colors text-[var(--text-soft)] hover:text-[var(--text)]">
                    <Truck size={16} />
                  </button>
                </div>
                {p.status === 'VENDUTO' && p.salePrice === 0 && (
                  <div className="border-t border-yellow-800/40 bg-yellow-900/10 px-4 py-2.5 flex items-center justify-between">
                    <p className="text-xs text-yellow-400 font-bold">{t('track.deliveredSaleToComplete')}</p>
                    <button
                      onClick={() => openSellModal([p.id], `${fullName(p.brand, p.name)}`, p)}
                      className="text-[10px] bg-yellow-500/20 hover:bg-yellow-500/30 text-yellow-400 px-3 py-1.5 rounded-xl font-bold transition-colors">
                      {t('track.complete')}
                    </button>
                  </div>
                )}
              </div>
            );
          };

          return (
            <div className="space-y-8">
              {/* Header */}
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-3xl font-semibold">{t('nav.tracking')}</h2>
                  <p className="text-[var(--text-soft)] text-sm mt-1">{t('track.subtitle')}</p>
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={openIncoming}
                    className="flex items-center gap-2 bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white px-4 py-2.5 rounded-xl text-sm font-bold transition-colors">
                    <Plus size={16} /> <span className="hidden sm:inline">{t('track.incoming')}</span><span className="sm:hidden">{t('track.incomingShort')}</span>
                  </button>
                  {active.length > 0 && (
                    <button onClick={handleRefreshAllTrackings} disabled={isRefreshingAll}
                      className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 px-4 py-2.5 rounded-xl text-sm font-bold transition-colors">
                      {isRefreshingAll ? <Loader2 className="animate-spin" size={16} /> : <Truck size={16} />}
                      <span className="hidden sm:inline">{isRefreshingAll ? t('track.refreshing') : t('track.refreshAll')}</span>
                    </button>
                  )}
                </div>
              </div>

              {/* Stats */}
              <div className="grid grid-cols-3 gap-3">
                {[
                  { label: t('track.active'), value: active.length, color: 'text-blue-400', bg: 'bg-[var(--surface)] border-blue-500/20', glow: 'bg-blue-500/8' },
                  { label: t('track.delivered'), value: delivered.length, color: 'text-emerald-400', bg: 'bg-[var(--surface)] border-green-500/20', glow: 'bg-green-500/8' },
                  { label: t('track.exceptions'), value: exceptions.length, color: 'text-red-400', bg: 'bg-[var(--surface)] border-red-500/20', glow: 'bg-red-500/8' },
                ].map(s => (
                  <div key={s.label} className={`${s.bg} border rounded-2xl p-4 text-center relative overflow-hidden`}>
                    <div className={`absolute inset-0 ${s.glow} pointer-events-none`} />
                    <p className={`text-2xl lg:text-3xl font-bold ${s.color}`}>{s.value}</p>
                    <p className="text-[9px] text-[var(--text-faint)] font-semibold tracking-[0.1em] uppercase mt-1.5">{s.label}</p>
                  </div>
                ))}
              </div>

              {/* Nessun tracking */}
              {allTracked.length === 0 && (
                <div className="text-center py-16 bg-[var(--surface)] rounded-2xl border border-[var(--border)]">
                  <Truck className="mx-auto text-gray-800 mb-3" size={44} />
                  <p className="text-[var(--text-muted)] font-semibold">{t('track.none')}</p>
                  <p className="text-[var(--text-faint)] text-sm mt-1">{t('track.noneHint')}</p>
                </div>
              )}

              {/* Sezione: Attive */}
              {active.length > 0 && (
                <div className="space-y-3">
                  <h3 className="text-[10px] lg:text-xs font-semibold text-[var(--text-muted)] tracking-[0.12em] uppercase flex items-center gap-2">
                    <span className="w-2 h-2 bg-blue-400 rounded-full animate-pulse" />
                    {t('track.activeShipments')} ({active.length})
                  </h3>
                  {active.map(p => <TrackCard key={p.id} p={p} />)}
                </div>
              )}

              {/* Sezione: Eccezioni / Resi */}
              {exceptions.length > 0 && (
                <div className="space-y-3">
                  <h3 className="text-[10px] lg:text-xs font-semibold text-[var(--text-muted)] tracking-[0.12em] uppercase flex items-center gap-2">
                    <span className="w-2 h-2 bg-red-400 rounded-full" />
                    {t('track.exceptionsReturns')} ({exceptions.length})
                  </h3>
                  {exceptions.map(p => <TrackCard key={p.id} p={p} />)}
                </div>
              )}

              {/* Sezione: Consegnate */}
              {delivered.length > 0 && (
                <div className="space-y-3">
                  <h3 className="text-[10px] lg:text-xs font-semibold text-[var(--text-muted)] tracking-[0.12em] uppercase flex items-center gap-2">
                    <span className="w-2 h-2 bg-green-400 rounded-full" />
                    {t('track.deliveredSection')} ({delivered.length})
                  </h3>
                  {delivered.map(p => <TrackCard key={p.id} p={p} />)}
                </div>
              )}
            </div>
          );
        })()}

        {/* ========== CATALOGO (BETA · solo admin) ========== */}
        {currentView === 'catalog' && (
          <CatalogBrowser
            apiCall={apiCall}
            showToast={showToast}
            categories={userCategories}
            warehouses={warehouses.map(w => ({ id: w.id, name: w.name, parentId: w.parentId }))}
            baseWarehouseId={baseWarehouse?.id}
            onAdded={fetchProducts}
            onAddDetailed={addFromCatalogDetailed}
          />
        )}

        {/* ========== SETTINGS ========== */}
        {currentView === 'settings' && (
          <div className="space-y-5">
            <h2 className="text-3xl font-semibold">{t('set.title')}</h2>

            {/* SEZIONE: Piani & Pro */}
            <section className="bg-gradient-to-br from-[#8397aa]/10 to-[var(--surface)] border border-[#8397aa]/30 rounded-2xl p-6">
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-start gap-3">
                  <Sparkles className="text-[#8397aa] mt-0.5" size={22} />
                  <div>
                    <h3 className="text-lg font-bold tracking-tighter">{t('set.plansTitle')}</h3>
                    <p className="text-xs text-[var(--text-soft)] mt-1">
                      {t('set.currentPlan')}: <b className="text-[var(--text)] uppercase">{myPlan}</b> · {t('set.plansDesc')}
                    </p>
                  </div>
                </div>
                <button onClick={() => openPlanModal()}
                  className="px-4 py-2 rounded-xl text-xs font-bold bg-[#8397aa] hover:bg-[#9fb0bd] text-white transition-colors whitespace-nowrap">
                  {t('set.seePlans')}
                </button>
              </div>
            </section>

            {/* SEZIONE: Notifiche push */}
            <section className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-6">
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-start gap-3">
                  <Bell className={pushEnabled ? 'text-[#8397aa] mt-0.5' : 'text-[var(--text-soft)] mt-0.5'} size={22} />
                  <div>
                    <h3 className="text-lg font-bold tracking-tighter">{t('set.notifications')}</h3>
                    <p className="text-xs text-[var(--text-soft)] mt-1">
                      {pushEnabled
                        ? t('set.pushOn')
                        : t('set.pushOff')}
                    </p>
                  </div>
                </div>
                <button onClick={() => pushEnabled ? disablePush() : enablePush()} disabled={pushBusy || !pushSupported}
                  className={`px-4 py-2 rounded-xl text-xs font-bold transition-colors whitespace-nowrap disabled:opacity-40 ${
                    pushEnabled ? 'bg-red-600/20 hover:bg-red-600/30 text-red-400' : 'bg-[#8397aa] hover:bg-[#9fb0bd] text-white'
                  }`}>
                  {pushBusy ? <Loader2 size={14} className="animate-spin" /> : pushEnabled ? t('set.disable') : t('set.enable')}
                </button>
              </div>
              <button onClick={openNotifPrefs}
                className="mt-4 w-full py-2.5 rounded-xl border border-[var(--border-2)] bg-[var(--surface-2)] text-xs font-bold text-[var(--text-soft)] hover:text-[var(--text)] hover:border-[var(--border-3)] transition-colors flex items-center justify-between px-4">
                <span className="flex items-center gap-2"><Bell size={13} /> {t('set.manageNotifs')}</span>
                <ChevronDown size={16} className="-rotate-90" />
              </button>
              {pushEnabled && user?.warehouses?.some(w => w.role === 'OWNER') && (
                <button onClick={sendTestPush} disabled={pushBusy}
                  className="mt-2 w-full py-2 rounded-xl border border-[var(--border-2)] bg-[var(--surface-2)] text-xs font-bold text-[var(--text-soft)] hover:text-[var(--text)] hover:border-[var(--border-3)] transition-colors disabled:opacity-40 flex items-center justify-center gap-2">
                  <Bell size={13} /> {t('set.testNotif')}
                </button>
              )}
              {!pushSupported && (
                <p className="text-[10px] text-[var(--text-faint)] mt-3">{t('set.iosHint')}</p>
              )}
            </section>

            {/* SEZIONE: Assistente vocale "Ehy HQ" (solo admin, beta) */}
            {(
              <section className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-6">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-start gap-3">
                    <Sparkles className={voiceWake ? 'text-[#8397aa] mt-0.5' : 'text-[var(--text-soft)] mt-0.5'} size={22} />
                    <div>
                      <h3 className="text-lg font-bold tracking-tighter">Assistente vocale “Ehy HQ”</h3>
                      <p className="text-xs text-[var(--text-soft)] mt-1 max-w-md">
                        {voiceWake
                          ? 'Attivo. Dopo un tocco qualsiasi nell’app, di’ “Ehy HQ” (o “acca cu”) e detta il comando: a ogni pausa lo eseguo e resto in ascolto.'
                          : 'Attivalo per dare il permesso microfono. Poi basta dire “Ehy HQ” per parlare con l’assistente (riconoscimento on-device, niente cloud).'}
                      </p>
                    </div>
                  </div>
                  <button onClick={toggleVoiceWake}
                    className={`shrink-0 w-12 h-7 rounded-full transition-colors relative ${voiceWake ? 'bg-[#8397aa]' : 'bg-[var(--fill-2)]'}`}>
                    <span className={`absolute top-1 w-5 h-5 rounded-full bg-white transition-all ${voiceWake ? 'left-6' : 'left-1'}`} />
                  </button>
                </div>
                <p className="text-[10px] text-[var(--text-faint)] mt-3">
                  Nota: i browser ascoltano solo con l’app aperta in primo piano (non in background come Siri).
                </p>
              </section>
            )}

            {/* SEZIONE: Lingua */}
            <section className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-6">
              <div className="flex items-center gap-2 mb-1">
                <Glasses className="text-[#8397aa]" size={18} />
                <h3 className="text-lg font-bold tracking-tighter">{t('settings.language')}</h3>
              </div>
              <p className="text-xs text-[var(--text-soft)] mb-4">{t('settings.languageDesc')}</p>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {LANGUAGES.filter(l => l.ready).map(l => (
                  <button key={l.code} onClick={() => changeLang(l.code)}
                    className={`flex items-center gap-2 px-3 py-2.5 rounded-xl text-sm font-bold border transition-colors ${lang === l.code ? 'bg-[#8397aa] text-white border-[#8397aa]' : 'bg-[var(--surface-2)] text-[var(--text-soft)] border-[var(--border-2)] hover:text-[var(--text)]'}`}>
                    <span className="text-lg">{l.flag}</span> {l.label}
                  </button>
                ))}
              </div>
              <p className="text-[11px] text-[var(--text-faint)] mt-3">{t('set.langNote')}</p>
            </section>

            {/* SEZIONE: Magazzino pubblico (auto-pubblicazione) — NASCOSTA finché il marketplace non è pubblico */}
            {MARKETPLACE_ENABLED && (
            <section className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-6">
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-start gap-3">
                  <Store className={autoPublishOn ? 'text-[#8397aa] mt-0.5' : 'text-[var(--text-soft)] mt-0.5'} size={22} />
                  <div>
                    <h3 className="text-lg font-bold tracking-tighter">{t('set.publicWh')}</h3>
                    <p className="text-xs text-[var(--text-soft)] mt-1 max-w-md">
                      {autoPublishOn
                        ? t('set.publicWhOn')
                        : t('set.publicWhOff')}
                    </p>
                  </div>
                </div>
                <button onClick={toggleAutoPublish}
                  className={`shrink-0 w-12 h-7 rounded-full transition-colors relative ${autoPublishOn ? 'bg-[#8397aa]' : 'bg-[var(--fill-2)]'}`}>
                  <span className={`absolute top-1 w-5 h-5 rounded-full bg-white transition-all ${autoPublishOn ? 'left-6' : 'left-1'}`} />
                </button>
              </div>
              {!hasFeature('marketplace') && (
                <p className="text-[11px] text-amber-400 mt-3">{t('set.publicWhWarn')}</p>
              )}
            </section>
            )}

            {/* SEZIONE: Prodotti Fermi */}
            <section className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-6">
              <div className="flex items-center gap-2 mb-4">
                <AlertTriangle className="text-yellow-500" size={18} />
                <h3 className="text-lg font-bold tracking-tighter">{t('set.staleTitle')}</h3>
              </div>
              <p className="text-xs text-[var(--text-soft)] mb-4">
                {t('set.staleDesc')}
              </p>
              <div className="flex items-center gap-3 mb-4">
                <label className="text-sm text-[var(--text-muted)] flex-1">{t('set.notifyAfter')}</label>
                <input 
                  type="number" min="7" max="365" value={staleThreshold}
                  onChange={(e: any) => {
                    const v = parseInt(e.target.value) || 60;
                    setStaleThreshold(v);
                    localStorage.setItem('staleThreshold', v.toString());
                  }}
                  className="w-24 bg-[var(--surface-2)] border border-[var(--border-2)] rounded-lg px-3 py-2 text-sm text-right focus:border-[#8397aa] outline-none"
                />
                <span className="text-sm text-[var(--text-muted)]">{t('set.days')}</span>
              </div>
              {staleProducts.length > 0 ? (
                <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-3">
                  <p className="text-sm font-bold text-yellow-400 mb-2">
                    ⏰ {t('set.youHave')} {staleProducts.length} {staleProducts.length === 1 ? t('set.staleOne') : t('set.staleMany')}
                  </p>
                  <div className="space-y-2 max-h-64 overflow-y-auto">
                    {staleProducts.slice(0, 10).map((sp: any) => (
                      <div key={sp.id} className="text-xs bg-[var(--surface-2)] p-2 rounded-lg">
                        <p className="text-[var(--text)] font-bold">{fullName(sp.brand, sp.name)}</p>
                        <p className="text-[var(--text-soft)]">
                          {sp.daysInStock}{t('set.daysInStock')} • {t('set.discount')}: <span className="text-yellow-400 font-bold">-{sp.suggestedDiscount}%</span> → <span className="text-green-400">€{sp.suggestedPrice}</span>
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <p className="text-xs text-[var(--text-faint)] italic">{t('set.noStale')}</p>
              )}
              <button
                onClick={checkStaleProducts}
                className="mt-3 w-full bg-yellow-600/20 hover:bg-yellow-600/30 text-yellow-400 py-2 rounded-xl text-xs font-bold transition-colors">
                {t('set.recheckNow')}
              </button>
            </section>
            
            {/* SEZIONE: 2FA */}
            <section className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-6">
              <div className="flex items-start justify-between gap-4 mb-4">
                <div className="flex items-start gap-3">
                  <Shield className={user.twoFactorEnabled ? 'text-green-400' : 'text-[var(--text-soft)]'} size={24} />
                  <div>
                    <h3 className="text-lg font-bold tracking-tighter">{t('set.twoFaTitle')}</h3>
                    <p className="text-xs text-[var(--text-soft)] mt-1">
                      {user.twoFactorEnabled
                        ? t('set.twoFaOn')
                        : t('set.twoFaOff')}
                    </p>
                  </div>
                </div>
                {user.twoFactorEnabled ? (
                  <button onClick={handle2FADisable}
                    className="px-4 py-2 bg-red-600/20 hover:bg-red-600/30 text-red-400 rounded-xl text-xs font-bold transition-colors whitespace-nowrap">
                    {t('set.disableBtn')}
                  </button>
                ) : (
                  <button onClick={handle2FASetupStart} disabled={twoFaLoading}
                    className="px-4 py-2 bg-[#8397aa] hover:bg-[#9fb0bd] rounded-xl text-xs font-bold transition-colors whitespace-nowrap">
                    {t('set.enable2fa')}
                  </button>
                )}
              </div>
            </section>
            
            {/* SEZIONE: Face ID (Passkey / WebAuthn) — NASCOSTA per ora (FACE_ID_ENABLED) */}
            {FACE_ID_ENABLED && (
            <section className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-6">
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-start gap-3">
                  <ScanFace className={faceIdOn ? 'text-green-400 mt-0.5' : 'text-[var(--text-soft)] mt-0.5'} size={24} />
                  <div>
                    <h3 className="text-lg font-bold tracking-tighter">Face ID</h3>
                    <p className="text-xs text-[var(--text-soft)] mt-1 max-w-md">
                      {faceIdOn ? 'Attivo: entri col volto o impronta, senza password.' : 'Entra con Face ID / impronta invece della password — veloce e sicuro. Su questo dispositivo.'}
                    </p>
                  </div>
                </div>
                {faceIdOn ? (
                  <button onClick={disableFaceId}
                    className="px-4 py-2 bg-red-600/20 hover:bg-red-600/30 text-red-400 rounded-xl text-xs font-bold transition-colors whitespace-nowrap">
                    Disattiva
                  </button>
                ) : (
                  <button onClick={enableFaceId}
                    className="px-4 py-2 bg-[#8397aa] hover:bg-[#9fb0bd] rounded-xl text-xs font-bold transition-colors whitespace-nowrap">
                    Attiva
                  </button>
                )}
              </div>
            </section>
            )}

            {/* SEZIONE: CAMBIA PASSWORD */}
            <section className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-6">
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-start gap-3">
                  <Lock className="text-[var(--text-soft)] mt-0.5" size={22} />
                  <div>
                    <h3 className="text-lg font-bold tracking-tighter">{t('set.password')}</h3>
                    <p className="text-xs text-[var(--text-soft)] mt-1">{t('set.passwordDesc')}</p>
                  </div>
                </div>
                <button onClick={() => setChangePwdOpen(true)}
                  className="px-4 py-2 bg-[#8397aa] hover:bg-[#9fb0bd] rounded-xl text-xs font-bold transition-colors whitespace-nowrap">
                  {t('set.change')}
                </button>
              </div>
            </section>

            {/* SEZIONE: Incassi marketplace → rimanda alla pagina Portafoglio dedicata */}
            {MARKETPLACE_ENABLED && (
            <button type="button" onClick={() => navigateTo('wallet')}
              className="w-full text-left bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-6 hover:border-[var(--border-2)] transition-colors flex items-center gap-3">
              <Wallet className="text-[#8397aa]" size={20} />
              <div className="flex-1 min-w-0">
                <h3 className="text-lg font-bold tracking-tighter">{t('set.walletTitle')}</h3>
                <p className="text-xs text-[var(--text-soft)]">{t('set.walletBalance')} {(wallet?.available ?? 0).toFixed(2)}€ · {t('set.walletPending')} {(wallet?.pending ?? 0).toFixed(2)}€</p>
              </div>
              <ChevronDown size={18} className="-rotate-90 text-[var(--text-soft)]" />
            </button>
            )}

            {/* SEZIONE: Reparti & Codici Invito — lista a tendina (non spinge giù le impostazioni) */}
            <section className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-6">
              <button type="button" onClick={() => setRepartiOpen(o => !o)}
                className="w-full flex items-center gap-2 mb-1 group">
                <Layers className="text-[var(--text)]" size={18} />
                <h3 className="text-lg font-bold tracking-tighter">{t('set.myWarehouses')}</h3>
                <span className="text-xs font-bold text-[var(--text-soft)] bg-[var(--fill)] px-2 py-0.5 rounded-full">{user.warehouses.filter((w: any) => !w.parentId).length}</span>
                <ChevronDown size={18} className={`ml-auto text-[var(--text-soft)] transition-transform ${repartiOpen ? 'rotate-180' : ''}`} />
              </button>
              {!repartiOpen && (
                <p className="text-xs text-[var(--text-faint)] mb-1">{t('set.tapToSee')}</p>
              )}

              {repartiOpen && (<>
              <div className="space-y-3 mb-6 mt-4">
                {user.warehouses.filter((w: any) => !w.parentId).map((w: any) => (
                  <div key={w.id} className="bg-[var(--surface-2)] p-4 rounded-xl border border-[var(--border-2)]">
                    <div className="flex items-center justify-between flex-wrap gap-3">
                      <div className="flex items-center gap-3">
                        <span className="text-2xl"><Layers size={22} className="text-[#8397aa]" /></span>
                        <div>
                          <p className="font-bold">{w.name}</p>
                          <p className="text-[10px] text-[var(--text-soft)] uppercase">
                            {w.role === 'OWNER' ? t('set.founder') : t('set.partner')} • {t('set.share')} {w.percentage}%
                          </p>
                        </div>
                      </div>
                      {w.inviteCode && (
                        <button
                          onClick={() => { navigator.clipboard.writeText(w.inviteCode); showToast(t('set.codeCopied')); }}
                          className="flex items-center gap-2 bg-blue-600/20 hover:bg-blue-600/30 text-blue-400 px-3 py-2 rounded-lg text-xs font-mono">
                          <KeyRound size={12} /> {w.inviteCode} <Copy size={12} />
                        </button>
                      )}
                    </div>
                    {/* Marketplace: pubblica/rendi privato tutto il magazzino (solo OWNER) */}
                    {w.role === 'OWNER' && (() => {
                      const whProds = products.filter((p: any) => p.warehouseId === w.id && p.status === 'IN STOCK');
                      const pub = whProds.filter((p: any) => p.isPublic).length;
                      return (
                        <div className="mt-3 pt-3 border-t border-[var(--border)] flex items-center justify-between gap-2 flex-wrap">
                          <div className="flex items-center gap-2 min-w-0">
                            <Store size={14} className="text-[#8397aa] shrink-0" />
                            <span className="text-xs text-[var(--text-soft)]">{t('set.showcase')}: <b className="text-[var(--text)]">{pub}/{whProds.length}</b> {t('set.public')}</span>
                          </div>
                          <div className="flex gap-2 shrink-0">
                            <button onClick={() => toggleWarehousePublic(w.id, true)} className="px-3 py-1.5 rounded-lg text-xs font-bold bg-[#8397aa] text-white">{t('set.publishAll')}</button>
                            <button onClick={() => toggleWarehousePublic(w.id, false)} className="px-3 py-1.5 rounded-lg text-xs font-bold bg-[var(--fill)] border border-[var(--border-2)] text-[var(--text-soft)]">{t('set.makePrivate')}</button>
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                ))}
              </div>
              
              {isFounder && (
                <div className="pt-5 border-t border-[var(--border-2)] space-y-4">
                  {/* Crea un nuovo MAGAZZINO (partnership): poi inviti i soci col codice */}
                  <div className="flex items-center gap-2"><span className="text-xs font-bold text-[var(--text-soft)] uppercase tracking-widest">{t('set.newWhPartners')}</span>{!hasFeature('partners') && <PlanLock plan="Starter" />}</div>
                  <form onSubmit={handleAddWarehouse} className="flex flex-col sm:flex-row gap-3">
                    <input type="text" value={newWarehouseName}
                      onChange={(e: any) => setNewWarehouseName(e.target.value)}
                      placeholder={t('set.newWhPlaceholder')}
                      className="flex-1 bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl px-4 py-2 text-sm focus:border-[#8397aa] outline-none" />
                    <button type="submit" disabled={isAddingWarehouse}
                      className="bg-[#8397aa] hover:bg-[#9fb0bd] px-5 py-2 rounded-xl text-sm font-bold transition-colors whitespace-nowrap text-white">
                      {isAddingWarehouse ? <Loader2 className="animate-spin" size={16} /> : t('set.addWarehouse')}
                    </button>
                  </form>
                  {/* Crea una nuova CATEGORIA (trasversale): l'IA genera i campi giusti */}
                  <form onSubmit={handleAddCategory} className="flex flex-col sm:flex-row gap-3">
                    <input type="text" value={newCatName}
                      onChange={(e: any) => setNewCatName(e.target.value)}
                      placeholder={t('set.newCatPlaceholder')}
                      className="flex-1 bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl px-4 py-2 text-sm focus:border-[#8397aa] outline-none" />
                    <button type="submit" disabled={isAddingCat}
                      className="bg-[var(--fill)] hover:bg-[var(--fill-2)] border border-[var(--border-2)] px-5 py-2 rounded-xl text-sm font-bold transition-colors whitespace-nowrap">
                      {isAddingCat ? <Loader2 className="animate-spin" size={16} /> : t('set.addCategory')}
                    </button>
                  </form>
                  {categories.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {categories.map(c => (
                        <span key={c.name} className="text-[11px] bg-[var(--surface-2)] border border-[var(--border-2)] text-[var(--text-soft)] px-2 py-1 rounded-lg">
                          {c.icon ? `${c.icon} ` : ''}{c.name}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}
              </>)}
            </section>

            {/* SEZIONE: Integrazioni (StockX) — SOLO admin. Per gli utenti resta in background. */}
            {isAdminUser && (
              <section className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-6">
                <div className="flex items-center gap-2 mb-1">
                  <TrendingUp className="text-green-400" size={18} />
                  <h3 className="text-lg font-bold tracking-tighter">{t('set.integrations')}</h3>
                </div>
                <p className="text-xs text-[var(--text-soft)] mb-4">{t('set.integrationsDesc')}</p>
                {!stockxStatus?.configured ? (
                  <p className="text-xs text-[var(--text-faint)]">
                    {t('set.stockxNotConfigured')} <span className="font-mono">STOCKX_CLIENT_ID</span>, <span className="font-mono">STOCKX_CLIENT_SECRET</span>, <span className="font-mono">STOCKX_API_KEY</span>, {t('set.stockxThenReload')}
                  </p>
                ) : (stockxStatus?.connected && stockxStatus?.tokenOk) ? (
                  <div className="flex items-center gap-3 flex-wrap">
                    <div className="flex items-center gap-2 text-sm font-semibold text-green-400"><CheckCircle size={16} /> {t('set.connected')}</div>
                    <button type="button" onClick={connectStockX} disabled={stockxConnecting}
                      className="text-xs font-bold text-[var(--text-soft)] hover:text-[var(--text)] underline">{t('set.reconnect')}</button>
                  </div>
                ) : (
                  <div>
                    {stockxStatus?.connected && !stockxStatus?.tokenOk && (
                      <p className="text-xs text-amber-400 mb-2">{t('set.stockxExpired')}</p>
                    )}
                    <button type="button" onClick={connectStockX} disabled={stockxConnecting}
                      className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-green-600 hover:bg-green-500 text-white text-sm font-bold transition-colors disabled:opacity-50">
                      {stockxConnecting ? <Loader2 size={15} className="animate-spin" /> : <KeyRound size={15} />} {stockxStatus?.connected ? t('set.reconnectStockx') : t('set.connectStockx')}
                    </button>
                  </div>
                )}
              </section>
            )}

            {/* SEZIONE: Team & Quote */}
            {teamData.map((team: any) => (
              <section key={team.warehouseId} className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-6">
                <div className="flex items-center gap-2 mb-5">
                  <Users className="text-blue-500" size={18} />
                  <h3 className="text-lg font-bold tracking-tighter">{t('set.partnersOf')} {team.warehouseName}</h3>
                </div>
                
                {/* Intestazione colonne: Utili (divisione profitto) e Costi (chi paga l'acquisto) */}
                <div className="flex items-center gap-3 px-3 mb-1">
                  <div className="flex-1" />
                  <span className="w-20 text-[10px] font-bold text-[var(--text-soft)] uppercase text-center">{t('set.profitPct')}</span>
                  <span className="w-20 text-[10px] font-bold text-[var(--text-soft)] uppercase text-center">{t('set.costPct')}</span>
                </div>
                <div className="space-y-3 mb-4">
                  {team.members.map((m: any) => (
                    <div key={m.membershipId} className="flex items-center gap-3 bg-[var(--surface-2)] p-3 rounded-xl">
                      <div className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-500 to-blue-700 flex items-center justify-center font-bold text-sm shrink-0">
                        {m.name[0]?.toUpperCase()}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-bold text-sm truncate">{m.name}</p>
                        <p className="text-[10px] text-[var(--text-soft)] uppercase">{m.role === 'OWNER' ? t('set.founder') : t('set.partner')}</p>
                      </div>
                      <input type="number" min="0" max="100" value={m.percentage} title="Quota utili"
                        onChange={(e: any) => updateMemberPercentage(team.warehouseId, m.membershipId, e.target.value, 'percentage')}
                        className="w-20 bg-[var(--surface)] border border-[var(--border)] rounded-lg px-3 py-1.5 text-sm text-right focus:border-[#8397aa] outline-none" />
                      <input type="number" min="0" max="100" value={m.costPercentage ?? 0} title="Quota costi"
                        onChange={(e: any) => updateMemberPercentage(team.warehouseId, m.membershipId, e.target.value, 'costPercentage')}
                        className="w-20 bg-[var(--surface)] border border-[var(--border)] rounded-lg px-3 py-1.5 text-sm text-right focus:border-amber-500 outline-none" />
                    </div>
                  ))}
                </div>

                <p className={`text-xs font-bold mb-1 ${
                  Math.round(team.members.reduce((s: number, m: any) => s + (Number(m.percentage) || 0), 0)) === 100
                    ? 'text-green-500' : 'text-yellow-500'
                }`}>
                  {t('set.profits')}: {team.members.reduce((s: number, m: any) => s + (Number(m.percentage) || 0), 0).toFixed(0)}%
                  {Math.round(team.members.reduce((s: number, m: any) => s + (Number(m.percentage) || 0), 0)) !== 100 && ' ' + t('set.mustBe100Inline')}
                </p>
                {(() => {
                  const ct = team.members.reduce((s: number, m: any) => s + (Number(m.costPercentage) || 0), 0);
                  if (ct === 0) return <p className="text-[11px] text-[var(--text-faint)] mb-3">{t('set.costsNotSet')}</p>;
                  return (
                    <p className={`text-xs font-bold mb-3 ${Math.round(ct) === 100 ? 'text-green-500' : 'text-yellow-500'}`}>
                      {t('set.costs')}: {ct.toFixed(0)}%{Math.round(ct) !== 100 && ' ' + t('set.mustBe100Inline')}
                    </p>
                  );
                })()}

                <button onClick={() => savePercentages(team.warehouseId, team.members)}
                  disabled={isSavingTeam}
                  className="w-full bg-blue-600 hover:bg-blue-500 py-2 rounded-xl text-sm font-bold transition-colors flex items-center justify-center gap-2">
                  {isSavingTeam ? <Loader2 className="animate-spin" size={16} /> : t('set.saveShares')}
                </button>

                {/* Elimina magazzino — solo OWNER, piccolo e discreto */}
                {team.myRole === 'OWNER' && user.warehouses.length > 1 && (
                  <div className="mt-4 pt-4 border-t border-[var(--border)] flex justify-end">
                    <button
                      onClick={async () => {
                        if (!confirm(t('set.deleteWhConfirm').replace('{name}', team.warehouseName))) return;
                        const { ok, data } = await apiCall(`/warehouses/${team.warehouseId}`, { method: 'DELETE' });
                        if (ok) { setUser(data.user); await fetchTeam(); showToast(t('set.whDeleted')); }
                        else showToast(data.error || 'Errore', 'err');
                      }}
                      className="text-[11px] text-red-500/40 hover:text-red-400/70 transition-colors flex items-center gap-1"
                    >
                      <Trash2 size={11} /> {t('set.deleteWh')}
                    </button>
                  </div>
                )}
              </section>
            ))}

            {/* ===== ENTRA IN UN MAGAZZINO ===== */}
            <section className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-5">
              <div className="flex items-center gap-2 mb-1">
                <UserPlus size={15} className="text-[var(--text-muted)]" />
                <h3 className="font-semibold text-sm">{t('set.joinWh')}</h3>
              </div>
              <p className="text-[11px] text-[var(--text-faint)] mb-4">{t('set.joinWhDesc')}</p>
              <form onSubmit={handleJoinWarehouse} className="flex flex-col gap-2">
                <input
                  value={joinCodeInput}
                  onChange={e => setJoinCodeInput(e.target.value.toUpperCase())}
                  placeholder={t('set.joinWhPlaceholder')}
                  maxLength={20}
                  className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl px-4 py-3 text-sm font-mono tracking-widest focus:border-[var(--border-3)] outline-none uppercase"
                />
                <button type="submit" disabled={isJoining || !joinCodeInput.trim()}
                  className="w-full py-3 bg-white text-black rounded-xl text-sm font-semibold hover:bg-gray-200 transition-colors disabled:opacity-40">
                  {isJoining ? <Loader2 size={16} className="animate-spin mx-auto" /> : t('set.joinWhBtn')}
                </button>
              </form>
            </section>

            {/* ===== DATI: import/export ===== */}
            <section className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-5">
              <div className="flex items-center gap-2 mb-1">
                <Download size={15} className="text-[var(--text-muted)]" />
                <h3 className="font-semibold text-sm">{t('set.data')}</h3>
              </div>
              <p className="text-[11px] text-[var(--text-faint)] mb-4">{t('set.dataDesc')}</p>
              <div className="flex flex-wrap gap-2">
                <label className="px-4 py-2.5 text-xs font-bold rounded-xl border border-[var(--border-2)] bg-[var(--surface-2)] text-gray-300 hover:text-[var(--text)] hover:border-[var(--border-3)] cursor-pointer transition-colors flex items-center gap-2">
                  <Download size={14} /> {t('set.importExcel')}
                  <input type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleExcelFile} />
                </label>
              </div>
            </section>

            {/* SEZIONE: Aiuto & Assistenza — il messaggio arriva all'admin via email */}
            <section className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-6">
              <div className="flex items-center gap-2 mb-1">
                <Mail size={18} className="text-[#8397aa]" />
                <h3 className="text-lg font-bold tracking-tighter">{t('set.helpTitle')}</h3>
              </div>
              <p className="text-xs text-[var(--text-soft)] mb-4">
                {t('set.helpDesc')}
              </p>
              <div className="flex flex-wrap gap-2 mb-3">
                {([
                  { v: 'idea', label: t('set.fbIdea'), Icon: Lightbulb },
                  { v: 'bug', label: t('set.fbBug'), Icon: Bug },
                  { v: 'domanda', label: t('set.fbQuestion'), Icon: HelpCircle },
                  { v: 'altro', label: t('set.fbOther'), Icon: MoreHorizontal },
                ] as const).map(o => (
                  <button key={o.v} type="button" onClick={() => setFeedbackType(o.v)}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold border transition-colors ${
                      feedbackType === o.v
                        ? 'bg-[#8397aa]/10 border-[#8397aa] text-[var(--text)]'
                        : 'bg-[var(--surface-2)] border-[var(--border-2)] text-[var(--text-soft)] hover:border-gray-600'
                    }`}>
                    <o.Icon size={14} /> {o.label}
                  </button>
                ))}
              </div>
              <textarea value={feedbackMsg} onChange={(e: any) => setFeedbackMsg(e.target.value)}
                maxLength={4000} rows={4}
                placeholder={t('set.fbPlaceholder')}
                className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm focus:border-[#8397aa] outline-none resize-none" />
              <div className="flex items-center justify-between gap-3 mt-3">
                <span className="text-[10px] text-[var(--text-faint)]">{feedbackMsg.length}/4000</span>
                <button onClick={sendFeedback} disabled={feedbackSending || feedbackMsg.trim().length < 3}
                  className="px-5 py-2 bg-[#8397aa] hover:bg-[#9fb0bd] rounded-xl text-sm font-bold transition-colors disabled:opacity-40 flex items-center gap-2">
                  {feedbackSending ? <Loader2 className="animate-spin" size={16} /> : <Mail size={15} />}
                  {t('set.send')}
                </button>
              </div>
            </section>

            {/* SEZIONE: Aspetto / Tema — in fondo, poco rilevante */}
            <section className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-6">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                <div className="flex items-start gap-3">
                  {theme === 'light' ? <Sun className="text-[#8397aa] mt-0.5" size={22} /> : theme === 'glass' ? <Sparkles className="text-[#8397aa] mt-0.5" size={22} /> : theme === 'lux' ? <Gem className="text-[#1fa89f] mt-0.5" size={22} /> : theme === 'chrome' ? <Gem className="text-[#c2c9d2] mt-0.5" size={22} /> : <Moon className="text-[#b9c0c9] mt-0.5" size={22} />}
                  <div>
                    <h3 className="text-lg font-bold tracking-tighter">{t('set.appearance')}</h3>
                    <p className="text-xs text-[var(--text-soft)] mt-1">{t('set.appearanceDesc')}</p>
                  </div>
                </div>
                <div className="flex flex-wrap gap-1 justify-center bg-[var(--surface-2)] p-1 rounded-xl border border-[var(--border-2)] self-center sm:self-auto">
                  <button onClick={() => setTheme('dark')}
                    className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-lg transition-colors ${
                      theme === 'dark' ? 'bg-[#8397aa] text-white' : 'text-[var(--text-soft)]'
                    }`}>
                    <Moon size={13} /> {t('set.themeDark')}
                  </button>
                  <button onClick={() => setTheme('light')}
                    className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-lg transition-colors ${
                      theme === 'light' ? 'bg-[#8397aa] text-white' : 'text-[var(--text-soft)]'
                    }`}>
                    <Sun size={13} /> {t('set.themeLight')}
                  </button>
                  {/* Tema premium cromato — DEFAULT per tutti */}
                  <button onClick={() => setTheme('chrome')}
                    className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-lg transition-colors ${
                      theme === 'chrome' ? 'bg-[#c2c9d2] text-[#0c0e11]' : 'text-[var(--text-soft)]'
                    }`}>
                    <Gem size={13} /> Chrome
                  </button>
                </div>
              </div>
            </section>

            {/* ===== ELIMINAZIONE ACCOUNT ===== */}
            <section className="bg-[var(--surface)] border border-red-500/30 rounded-2xl p-5">
              <div className="flex items-center gap-2 mb-1">
                <AlertTriangle size={15} className="text-red-500" />
                <h3 className="font-semibold text-sm text-red-500">{t('set.deleteAccount')}</h3>
              </div>
              <p className="text-[11px] text-[var(--text-muted)] mb-4">
                {t('set.deleteAccountDesc')}
              </p>
              <button onClick={() => setDeleteAccountStep(1)}
                className="px-4 py-2 rounded-xl border border-red-500/40 text-red-500 text-xs font-semibold hover:bg-red-500 hover:text-white transition-colors">
                {t('set.deleteAccountBtn')}
              </button>
            </section>

          </div>
        )}

        {/* ========== PAGINA ADMIN (dedicata, solo ADMIN_EMAIL) ========== */}
        {currentView === 'admin' && isAdminEmail(user.email) && (
          <div className="space-y-5">
            <div className="flex items-center gap-2">
              <Shield size={24} className="text-[#8397aa]" />
              <h2 className="text-3xl font-semibold">Admin</h2>
            </div>

            <section className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl overflow-hidden">
              {/* Toolbar */}
              <div className="px-5 py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 border-b border-[var(--border)]">
                <p className="text-[10px] text-[var(--text-faint)]">Auto-aggiornamento ogni 5 min</p>
                <div className="flex flex-wrap gap-2">
                  <button onClick={sendTestEmail}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-[var(--fill)] hover:bg-[var(--fill)] rounded-xl text-xs font-semibold transition-colors">
                    <Mail size={12} /> Test Email
                  </button>
                  <button onClick={() => { fetchAdminUsers(); fetchAdminFeedback(); }} disabled={adminLoading}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-[var(--fill)] hover:bg-[var(--fill-2)] rounded-xl text-xs font-semibold transition-colors disabled:opacity-40">
                    {adminLoading ? <Loader2 size={12} className="animate-spin" /> : <Users size={12} />}
                    Aggiorna
                  </button>
                </div>
              </div>

              {/* Toggle vista: Utenti / Richieste */}
              <div className="px-5 py-3 flex gap-2 border-b border-[var(--border)]">
                <button onClick={() => setAdminView('users')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors ${adminView === 'users' ? 'bg-[#8397aa] text-white' : 'bg-[var(--fill)] text-[var(--text-soft)]'}`}>
                  Utenti
                </button>
                <button onClick={() => { setAdminView('feedback'); fetchAdminFeedback(); }}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors flex items-center gap-1.5 ${adminView === 'feedback' ? 'bg-[#8397aa] text-white' : 'bg-[var(--fill)] text-[var(--text-soft)]'}`}>
                  Richieste
                  {adminFbNuove > 0 && (
                    <span className={`text-[9px] px-1.5 py-0.5 rounded-full ${adminView === 'feedback' ? 'bg-white/25' : 'bg-[#8397aa] text-white'}`}>{adminFbNuove}</span>
                  )}
                </button>
                <button onClick={() => { setAdminView('disputes'); fetchAdminDisputes(); }}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors flex items-center gap-1.5 ${adminView === 'disputes' ? 'bg-[#8397aa] text-white' : 'bg-[var(--fill)] text-[var(--text-soft)]'}`}>
                  Contestazioni
                  {adminDisputes.filter(d => d.status === 'ESCALATED').length > 0 && (
                    <span className={`text-[9px] px-1.5 py-0.5 rounded-full ${adminView === 'disputes' ? 'bg-white/25' : 'bg-red-500 text-white'}`}>{adminDisputes.filter(d => d.status === 'ESCALATED').length}</span>
                  )}
                </button>
                <button onClick={() => { setAdminView('stats'); fetchAdminStats(); }}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors ${adminView === 'stats' ? 'bg-[#8397aa] text-white' : 'bg-[var(--fill)] text-[var(--text-soft)]'}`}>
                  Statistiche
                </button>
              </div>

              {adminView === 'users' && adminLoaded && (
                <>
                  {/* KPI */}
                  <div className="grid grid-cols-2 border-b border-[var(--border)]">
                    {[
                      { label: 'Utenti', value: adminUsers.length },
                      { label: 'Prodotti totali', value: adminUsers.reduce((a, u) => a + u.stats.totalProducts, 0) },
                    ].map(s => (
                      <div key={s.label} className="p-3 text-center border-r border-[var(--border)] last:border-0">
                        <p className="text-base font-bold num">{s.value}</p>
                        <p className="text-[9px] text-[var(--text-faint)] mt-0.5">{s.label}</p>
                      </div>
                    ))}
                  </div>

                  {/* Lista utenti */}
                  <div className="divide-y divide-[var(--border)] max-h-[28rem] overflow-y-auto">
                    {adminUsers.map(u => (
                      <div key={u.id} className="px-4 py-3 flex items-start gap-3">
                        <div className="w-7 h-7 rounded-full bg-[var(--fill)] flex items-center justify-center text-xs font-semibold shrink-0 mt-0.5">
                          {u.name?.[0]?.toUpperCase()}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="font-semibold text-sm">{u.name}</span>
                            {u.twoFactorEnabled && <span className="text-[8px] bg-green-500/15 text-green-400 px-1.5 py-0.5 rounded-full">2FA</span>}
                          </div>
                          <p className="text-[10px] text-[var(--text-soft)]">{u.email}</p>
                          <p className="text-[10px] text-gray-700 mt-0.5">
                            {u.stats.inStock} in stock · {u.stats.sold} venduti · {u.stats.totalProducts} totali
                          </p>
                          <div className="flex items-center gap-1.5 mt-1.5">
                            <span className="text-[9px] text-[var(--text-faint)] uppercase">Piano</span>
                            <select value={u.plan || 'free'} onChange={e => setUserPlan(u.id, e.target.value)}
                              className="text-[10px] bg-[var(--fill)] border border-[var(--border-2)] rounded-lg px-2 py-1 outline-none focus:border-[#8397aa]">
                              <option value="free">Free</option>
                              <option value="starter">Starter 9.99</option>
                              <option value="pro">Pro 19.99</option>
                              <option value="business">Business 39.99</option>
                            </select>
                          </div>
                        </div>
                        {!isAdminEmail(u.email) && (
                          <button onClick={() => deleteAdminUser(u.id, u.name)}
                            className="p-1 hover:bg-red-500/10 rounded-lg transition-colors shrink-0">
                            <Trash2 size={13} className="text-red-500/40 hover:text-red-400" />
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                </>
              )}

              {/* Vista RICHIESTE */}
              {adminView === 'feedback' && (() => {
                const isOpen = (f: any) => f.status === 'nuova'; // "nuova" = arrivata, non ancora risposta
                const nuove = adminFeedback.filter(isOpen);
                const risolte = adminFeedback.filter(f => !isOpen(f));
                const list = fbFilter === 'nuove' ? nuove : risolte;
                return (
                <>
                  {/* Distinzione: assistenza DA RISPONDERE vs GIÀ RISOLTA */}
                  <div className="flex items-center gap-2 px-4 py-2.5 border-b border-[var(--border)] sticky top-0 bg-[var(--surface)] z-10">
                    <button onClick={() => setFbFilter('nuove')}
                      className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors flex items-center gap-1.5 ${fbFilter === 'nuove' ? 'bg-[#8397aa] text-white' : 'bg-[var(--fill)] text-[var(--text-soft)]'}`}>
                      Da rispondere
                      {nuove.length > 0 && <span className={`text-[9px] px-1.5 py-0.5 rounded-full ${fbFilter === 'nuove' ? 'bg-white/25' : 'bg-[#8397aa] text-white'}`}>{nuove.length}</span>}
                    </button>
                    <button onClick={() => setFbFilter('risolte')}
                      className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors flex items-center gap-1.5 ${fbFilter === 'risolte' ? 'bg-[#8397aa] text-white' : 'bg-[var(--fill)] text-[var(--text-soft)]'}`}>
                      Risolte
                      {risolte.length > 0 && <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-green-500/15 text-green-400">{risolte.length}</span>}
                    </button>
                  </div>
                <div className="divide-y divide-[var(--border)] max-h-[30rem] overflow-y-auto">
                  {list.length === 0 ? (
                    <p className="p-6 text-center text-xs text-[var(--text-faint)]">{fbFilter === 'nuove' ? 'Nessuna richiesta da rispondere. 🎉' : 'Nessuna richiesta risolta.'}</p>
                  ) : list.map(f => (
                    <div key={f.id} className="px-4 py-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="text-[9px] uppercase font-bold px-1.5 py-0.5 rounded-full bg-[var(--fill)] text-[var(--text-soft)]">{f.type}</span>
                            {f.status === 'nuova'
                              ? <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-[#8397aa] text-white font-bold">nuova</span>
                              : <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-green-500/15 text-green-400 font-bold">risposta</span>}
                            <span className="text-[11px] font-semibold truncate">{f.userName || f.userEmail}</span>
                          </div>
                          <p className="text-[10px] text-[var(--text-faint)]">{f.userEmail} · {new Date(f.createdAt).toLocaleDateString('it-IT', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</p>
                        </div>
                        <button onClick={() => deleteAdminFeedback(f.id)}
                          className="p-1 hover:bg-red-500/10 rounded-lg transition-colors shrink-0">
                          <Trash2 size={13} className="text-red-500/40 hover:text-red-400" />
                        </button>
                      </div>
                      <p className="text-sm text-[var(--text)] mt-2 whitespace-pre-wrap break-words">{f.message}</p>

                      {f.reply && (
                        <div className="mt-2 bg-[var(--surface-2)] border-l-2 border-green-500/40 rounded-r-lg px-3 py-2">
                          <p className="text-[9px] uppercase font-bold text-green-400 mb-1">La tua risposta</p>
                          <p className="text-xs text-[var(--text-muted)] whitespace-pre-wrap break-words">{f.reply}</p>
                        </div>
                      )}

                      {replyingId === f.id ? (
                        <div className="mt-2">
                          <textarea value={replyText} onChange={(e: any) => setReplyText(e.target.value)}
                            rows={3} maxLength={6000} autoFocus
                            placeholder={`Rispondi a ${f.userEmail}…`}
                            className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-2.5 text-sm focus:border-[#8397aa] outline-none resize-none" />
                          <div className="flex items-center justify-end gap-2 mt-2">
                            <button onClick={() => { setReplyingId(null); setReplyText(''); }}
                              className="px-3 py-1.5 text-xs font-bold text-[var(--text-soft)] hover:text-[var(--text)] transition-colors">Annulla</button>
                            <button onClick={() => sendAdminReply(f.id)} disabled={replySending || replyText.trim().length < 2}
                              className="px-4 py-1.5 bg-[#8397aa] hover:bg-[#9fb0bd] rounded-lg text-xs font-bold transition-colors disabled:opacity-40 flex items-center gap-1.5">
                              {replySending ? <Loader2 size={13} className="animate-spin" /> : <Mail size={13} />}
                              Invia via email
                            </button>
                          </div>
                        </div>
                      ) : (
                        <button onClick={() => { setReplyingId(f.id); setReplyText(f.reply || ''); }}
                          className="mt-2 text-xs font-bold text-[#8397aa] hover:text-[#9fb0bd] transition-colors">
                          {f.reply ? 'Modifica risposta' : '↩ Rispondi'}
                        </button>
                      )}
                    </div>
                  ))}
                </div>
                </>
                );
              })()}

              {/* Vista STATISTICHE (pre-lancio): visite landing + waitlist */}
              {adminView === 'stats' && (
                <div className="p-4 space-y-5 max-h-[38rem] overflow-y-auto">
                  {!adminStats ? (
                    <p className="p-6 text-center text-xs text-[var(--text-faint)]"><Loader2 size={16} className="animate-spin inline" /> Carico…</p>
                  ) : (() => {
                    const pageLabels: Record<string, string> = { home: 'Home', magazzino: 'Magazzino', spedizione: 'Spedizione', waitlist: 'Waitlist' };
                    const pages = Object.entries(adminStats.byPage || {}).sort((a: any, b: any) => b[1] - a[1]);
                    const maxPage = Math.max(1, ...pages.map((p: any) => p[1]));
                    const sources = Object.entries(adminStats.bySource || {}).sort((a: any, b: any) => b[1] - a[1]);
                    const maxSrc = Math.max(1, ...sources.map((s: any) => s[1]));
                    const recent = adminStats.waitlist?.recent || [];
                    return (
                    <>
                      {/* KPI */}
                      <div className="grid grid-cols-2 gap-3">
                        <div className="bg-[var(--surface-2)] border border-[var(--border)] rounded-2xl p-4">
                          <p className="text-[10px] uppercase tracking-widest text-[var(--text-faint)] font-bold">Iscritti waitlist</p>
                          <p className="text-3xl font-black mt-1 text-[#8397aa]">{adminStats.waitlist?.total ?? 0}</p>
                        </div>
                        <div className="bg-[var(--surface-2)] border border-[var(--border)] rounded-2xl p-4">
                          <p className="text-[10px] uppercase tracking-widest text-[var(--text-faint)] font-bold">Visite (30 gg)</p>
                          <p className="text-3xl font-black mt-1">{adminStats.totalHits ?? 0}</p>
                        </div>
                      </div>

                      {/* Visite per landing */}
                      <div>
                        <p className="text-[11px] uppercase tracking-widest text-[var(--text-soft)] font-bold mb-2.5">Visite per pagina</p>
                        {pages.length === 0 ? <p className="text-xs text-[var(--text-faint)]">Ancora nessuna visita.</p> : (
                          <div className="space-y-2">
                            {pages.map(([k, v]: any) => (
                              <div key={k} className="flex items-center gap-3">
                                <span className="text-xs font-bold w-24 shrink-0 truncate">{pageLabels[k] || k}</span>
                                <div className="flex-1 h-2.5 rounded-full bg-[var(--fill)] overflow-hidden">
                                  <div className="h-full rounded-full bg-[#8397aa]" style={{ width: `${(v / maxPage) * 100}%` }} />
                                </div>
                                <span className="text-xs font-black w-10 text-right num">{v}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* Provenienza */}
                      <div>
                        <p className="text-[11px] uppercase tracking-widest text-[var(--text-soft)] font-bold mb-2.5">Da dove arrivano</p>
                        {sources.length === 0 ? <p className="text-xs text-[var(--text-faint)]">—</p> : (
                          <div className="space-y-2">
                            {sources.map(([k, v]: any) => (
                              <div key={k} className="flex items-center gap-3">
                                <span className="text-xs font-semibold w-24 shrink-0 truncate text-[var(--text-soft)]">{k}</span>
                                <div className="flex-1 h-2.5 rounded-full bg-[var(--fill)] overflow-hidden">
                                  <div className="h-full rounded-full bg-teal-500/70" style={{ width: `${(v / maxSrc) * 100}%` }} />
                                </div>
                                <span className="text-xs font-black w-10 text-right num">{v}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* Email raccolte */}
                      <div>
                        <p className="text-[11px] uppercase tracking-widest text-[var(--text-soft)] font-bold mb-2.5">Email raccolte (ultime {recent.length})</p>
                        {recent.length === 0 ? <p className="text-xs text-[var(--text-faint)]">Ancora nessuna iscrizione.</p> : (
                          <div className="border border-[var(--border)] rounded-xl divide-y divide-[var(--border)] max-h-56 overflow-y-auto">
                            {recent.map((w: any, i: number) => (
                              <div key={i} className="flex items-center justify-between gap-2 px-3 py-2">
                                <span className="text-xs font-semibold truncate">{w.email}</span>
                                <span className="text-[10px] text-[var(--text-faint)] shrink-0">{w.source || '—'} · {new Date(w.createdAt).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' })}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </>
                    );
                  })()}
                </div>
              )}

              {/* Vista CONTESTAZIONI */}
              {adminView === 'disputes' && (
                <div className="divide-y divide-[var(--border)] max-h-[40rem] overflow-y-auto">
                  {adminDisputes.length === 0 ? (
                    <p className="p-6 text-center text-xs text-[var(--text-faint)]">Nessuna contestazione aperta.</p>
                  ) : adminDisputes.map(d => (
                    <div key={d.productId} className="px-4 py-3">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        {d.status === 'ESCALATED'
                          ? <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-red-500 text-white font-bold">DA DECIDERE</span>
                          : <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-400 font-bold">in attesa venditore</span>}
                        <span className="text-[9px] uppercase font-bold px-1.5 py-0.5 rounded-full bg-[var(--fill)] text-[var(--text-soft)]">{d.reasonLabel}</span>
                        <span className="text-[11px] font-semibold truncate">{d.product}</span>
                        <span className="text-[11px] text-[var(--text-soft)] num">{(d.amount || 0).toFixed(2)}€</span>
                      </div>
                      <p className="text-[10px] text-[var(--text-faint)] mt-1">
                        Venditore: {d.seller?.name || '—'} · Compratore: {d.buyer?.name || '—'} · {d.openedAt ? new Date(d.openedAt).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' }) : ''}
                      </p>
                      {d.note && <p className="text-sm text-[var(--text)] mt-2 whitespace-pre-wrap break-words">{d.note}</p>}
                      {d.photos?.length > 0 && (
                        <div className="flex gap-1.5 mt-2 flex-wrap">
                          {d.photos.map((p: string, i: number) => (
                            <img key={i} src={p} alt="" className="w-16 h-16 rounded-lg object-cover border border-[var(--border-2)]" />
                          ))}
                        </div>
                      )}
                      {d.status === 'ESCALATED' && (
                        <div className="flex gap-2 mt-3">
                          <button onClick={() => resolveAdminDispute(d.productId, 'refund_buyer')}
                            className="px-3 py-1.5 rounded-lg text-xs font-bold bg-red-600 text-white">Rimborsa compratore</button>
                          <button onClick={() => resolveAdminDispute(d.productId, 'release_seller')}
                            className="px-3 py-1.5 rounded-lg text-xs font-bold bg-green-600 text-white">Paga venditore</button>
                        </div>
                      )}
                      {d.status === 'OPEN' && (
                        <p className="text-[10px] text-[var(--text-faint)] mt-2">In attesa che il venditore risponda (rimborso o contesta). Puoi intervenire solo se viene escalata.</p>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {adminView === 'users' && !adminLoaded && adminLoading && (
                <div className="p-6 flex justify-center">
                  <Loader2 size={20} className="animate-spin text-[var(--text-faint)]" />
                </div>
              )}
            </section>
          </div>
        )}
      </main>

      {/* ========== SCHERMATA: MANUTENZIONE (globale, copre tutto) ========== */}
      {maintenance && createPortal((
        <div className="fixed inset-0 z-[400] bg-[var(--bg)] flex items-center justify-center p-6 text-center">
          <div className="max-w-sm">
            <div className="text-3xl font-black mb-4 font-display">HQ<span className="text-gold">Vault</span></div>
            <div className="text-5xl mb-4">🛠️</div>
            <h1 className="text-2xl font-bold mb-2">Aggiornamento in corso</h1>
            <p className="text-[var(--text-soft)] text-sm">Stiamo migliorando l'app. Torna tra qualche minuto — i tuoi dati sono al sicuro.</p>
            <div className="mt-6 flex justify-center"><Loader2 className="animate-spin text-[#8397aa]" size={24} /></div>
          </div>
        </div>
      ), document.body)}

      {/* ========== SCHERMATA: PREFERENZE NOTIFICHE (globale) ========== */}
      {notifPrefsOpen && createPortal((
        <div className="fixed inset-0 z-[220] bg-[var(--bg)] overflow-y-auto" {...swipeBack(() => setNotifPrefsOpen(false))}>
          <div className="sticky top-0 z-10 bg-[var(--bg)]/95 backdrop-blur border-b border-[var(--border)] px-4 py-3 flex items-center gap-3"
            style={{ paddingTop: 'calc(0.75rem + env(safe-area-inset-top))' }}>
            <button onClick={() => setNotifPrefsOpen(false)} className="p-1.5 hover:bg-[var(--fill)] rounded-lg active:scale-90 transition-transform"><ChevronDown size={20} className="rotate-90" /></button>
            <h2 className="text-lg font-bold">{t('set.notifications')}</h2>
          </div>
          <div className="max-w-md mx-auto p-4 space-y-2.5">
            <p className="text-xs text-[var(--text-soft)] px-1 mb-2">{t('notif.choose')}</p>
            {NOTIF_LABELS.map(c => {
              const on = notifPrefs[c.key] !== false;
              return (
                <div key={c.key} className="flex items-center justify-between gap-3 bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-4">
                  <div className="min-w-0">
                    <p className="font-bold text-sm">{c.label}</p>
                    <p className="text-[11px] text-[var(--text-soft)] mt-0.5">{c.desc}</p>
                  </div>
                  <button onClick={() => toggleNotifPref(c.key)}
                    className={`shrink-0 w-12 h-7 rounded-full transition-colors relative ${on ? 'bg-[#8397aa]' : 'bg-[var(--fill-2)]'}`}>
                    <span className={`absolute top-1 w-5 h-5 rounded-full bg-white transition-all ${on ? 'left-6' : 'left-1'}`} />
                  </button>
                </div>
              );
            })}
            {!pushEnabled && (
              <p className="text-[11px] text-amber-400 px-1 pt-2">{t('notif.pushOffWarn')}</p>
            )}
          </div>
        </div>
      ), document.body)}

      {/* ========== DIALOG CONFERMA (in-app, sostituisce window.confirm) ========== */}
      {confirmState && createPortal((
        <div className="fixed inset-0 z-[240] bg-black/70 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={() => closeConfirm(false)} {...swipeBack(() => closeConfirm(false))}>
          <div className="bg-[var(--surface)] border-t sm:border border-[var(--border-2)] rounded-t-3xl sm:rounded-3xl w-full max-w-sm p-6" onClick={e => e.stopPropagation()}>
            <div className="flex justify-center mb-4 sm:hidden"><div className="w-10 h-1 bg-gray-700 rounded-full" /></div>
            <h2 className="text-lg font-bold mb-2">{confirmState.title}</h2>
            <p className="text-sm text-[var(--text-soft)] mb-6">{confirmState.message}</p>
            <div className="flex gap-2">
              <button onClick={() => closeConfirm(false)} className="flex-1 py-3 rounded-xl bg-[var(--fill)] text-[var(--text-muted)] font-bold">{t('common.cancel')}</button>
              <button onClick={() => closeConfirm(true)} className={`flex-1 py-3 rounded-xl text-white font-bold ${confirmState.danger ? 'bg-red-600' : 'bg-[#8397aa]'}`}>{confirmState.confirmLabel}</button>
            </div>
          </div>
        </div>
      ), document.body)}

      {/* ========== DIALOG PROMPT (in-app, sostituisce window.prompt) ========== */}
      {promptState && createPortal((
        <div className="fixed inset-0 z-[240] bg-black/70 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={() => closePrompt(null)} {...swipeBack(() => closePrompt(null))}>
          <div className="bg-[var(--surface)] border-t sm:border border-[var(--border-2)] rounded-t-3xl sm:rounded-3xl w-full max-w-sm p-6" onClick={e => e.stopPropagation()}>
            <div className="flex justify-center mb-4 sm:hidden"><div className="w-10 h-1 bg-gray-700 rounded-full" /></div>
            <h2 className="text-lg font-bold mb-1">{promptState.title}</h2>
            {promptState.message && <p className="text-sm text-[var(--text-soft)] mb-4">{promptState.message}</p>}
            <input autoFocus value={promptState.value} placeholder={promptState.placeholder}
              onChange={e => setPromptState(s => s ? { ...s, value: e.target.value } : s)}
              onKeyDown={e => { if (e.key === 'Enter') closePrompt(promptState.value); }}
              className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-base outline-none focus:border-[#8397aa]" />
            <div className="flex gap-2 mt-5">
              <button onClick={() => closePrompt(null)} className="flex-1 py-3 rounded-xl bg-[var(--fill)] text-[var(--text-muted)] font-bold">{t('common.cancel')}</button>
              <button onClick={() => closePrompt(promptState.value)} className="flex-1 py-3 rounded-xl bg-[#8397aa] text-white font-bold">{t('common.confirm')}</button>
            </div>
          </div>
        </div>
      ), document.body)}

      {/* ========== COMMAND PALETTE (⌘K / Ctrl+K) ========== */}
      {cmdOpen && (() => {
        const q = cmdQuery.trim().toLowerCase();
        const baseActions: any[] = [
          { key: 'nav-dashboard', icon: LayoutDashboard, label: `${t('cmd.goTo')} ${t('nav.dashboard')}`, sub: '', run: () => navigateTo('dashboard') },
          { key: 'nav-magazzino', icon: Package, label: `${t('cmd.goTo')} ${t('nav.magazzino')}`, sub: '', run: () => navigateTo('magazzino') },
          { key: 'nav-analytics', icon: BarChart3, label: `${t('cmd.goTo')} ${t('nav.analytics')}`, sub: '', run: () => navigateTo('analytics') },
          { key: 'nav-tracking', icon: Truck, label: `${t('cmd.goTo')} ${t('nav.tracking')}`, sub: '', run: () => navigateTo('tracking') },
          { key: 'nav-settings', icon: Settings, label: `${t('cmd.goTo')} ${t('nav.settings')}`, sub: '', run: () => navigateTo('settings') },
          { key: 'act-add', icon: Plus, label: t('mag.addProduct'), sub: t('cmd.addProductSub'), run: () => openAddForm() },
          ...(VALUATION_ENABLED ? [{ key: 'act-sourcing', icon: DollarSign, label: t('dash.valueLookup'), sub: t('cmd.valueLookupSub'), run: () => openSourcing() }] : []),
        ];
        // Azioni sui selezionati (quando sei in modalità selezione)
        if (bulkMode && getBulkSelectedIds().length > 0) {
          const n = getBulkSelectedIds().length;
          baseActions.push(
            { key: 'act-bulk-sell', icon: DollarSign, label: `${t('cmd.sellSelected')} (${n})`, sub: '', run: () => setBulkSellOpen(true) },
            { key: 'act-bulk-del', icon: Trash2, label: `${t('cmd.delSelected')} (${n})`, sub: '', run: () => setBulkDeleteConfirmOpen(true) },
          );
        }
        baseActions.push(
          { key: 'act-theme-dark', icon: Moon, label: t('cmd.themeDark'), sub: '', run: () => setTheme('dark') },
          { key: 'act-theme-light', icon: Sun, label: t('cmd.themeLight'), sub: '', run: () => setTheme('light') },
          { key: 'act-theme-glass', icon: Sparkles, label: t('cmd.themeGlass'), sub: '', run: () => setTheme('glass') },
          { key: 'act-logout', icon: LogOut, label: t('cmd.logout'), sub: '', run: () => handleLogout() },
        );
        const navActions = baseActions.filter(a => !q || a.label.toLowerCase().includes(q));
        const prodItems = (q.length > 0
          ? products.filter((p: any) => `${fullName(p.brand, p.name)} ${p.size || ''} ${p.category || ''}`.toLowerCase().includes(q)).slice(0, 8)
          : []
        ).map((p: any) => ({
          key: `prod-${p.id}`, icon: Package,
          label: `${fullName(p.brand, p.name)}`,
          sub: `${p.size ? p.size + ' · ' : ''}${p.category || ''} · ${p.status === 'VENDUTO' ? t('cmd.sold') : t('cmd.inStockWord')}`,
          run: () => {
            setCurrentView('magazzino');
            setMagazzinoView(p.status === 'VENDUTO' ? 'sold' : 'instock');
            setFilterCat('all');
            setSearchTerm(`${fullName(p.brand, p.name)}`);
            window.scrollTo({ top: 0, behavior: 'smooth' });
          },
        }));
        const items = [...navActions, ...prodItems];
        const sel = Math.min(cmdIndex, Math.max(0, items.length - 1));
        const close = () => { setCmdOpen(false); setCmdQuery(''); setCmdIndex(0); };
        const choose = (i: number) => { const it = items[i]; if (it) { it.run(); close(); } };
        return (
          <div className="fixed inset-0 z-[60] flex items-start justify-center p-4 pt-[12vh] bg-black/60 backdrop-blur-sm" onClick={close} {...swipeBack(close)}>
            <div className="w-full max-w-xl bg-[var(--surface)] border border-[var(--border-2)] rounded-2xl shadow-2xl overflow-hidden" onClick={e => e.stopPropagation()}>
              <div className="flex items-center gap-3 px-4 border-b border-[var(--border)]">
                <Search size={18} className="text-[var(--text-faint)] shrink-0" />
                <input autoFocus value={cmdQuery}
                  onChange={(e: any) => { setCmdQuery(e.target.value); setCmdIndex(0); }}
                  onKeyDown={(e: any) => {
                    if (e.key === 'ArrowDown') { e.preventDefault(); setCmdIndex(i => Math.min(i + 1, items.length - 1)); }
                    else if (e.key === 'ArrowUp') { e.preventDefault(); setCmdIndex(i => Math.max(i - 1, 0)); }
                    else if (e.key === 'Enter') { e.preventDefault(); choose(sel); }
                    else if (e.key === 'Escape') { e.preventDefault(); close(); }
                  }}
                  placeholder={t('cmd.searchPlaceholder')}
                  className="flex-1 bg-transparent py-4 text-sm outline-none placeholder:text-[var(--text-faint)]" />
                <kbd className="hidden sm:block text-[10px] text-[var(--text-faint)] border border-[var(--border-2)] rounded px-1.5 py-0.5">ESC</kbd>
              </div>
              <div className="max-h-[50vh] overflow-y-auto py-2">
                {items.length === 0 ? (
                  <p className="px-4 py-8 text-center text-sm text-[var(--text-soft)]">{t('mag.noResults')}</p>
                ) : items.map((it, i) => {
                  const Icon = it.icon;
                  return (
                    <button key={it.key} onMouseEnter={() => setCmdIndex(i)} onClick={() => choose(i)}
                      className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors ${i === sel ? 'bg-[var(--fill-2)]' : 'hover:bg-[var(--fill)]'}`}>
                      <Icon size={16} className="text-[var(--text-muted)] shrink-0" />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold truncate">{it.label}</p>
                        {it.sub && <p className="text-[11px] text-[var(--text-faint)] truncate">{it.sub}</p>}
                      </div>
                    </button>
                  );
                })}
              </div>
              <div className="hidden sm:flex items-center gap-4 px-4 py-2 border-t border-[var(--border)] text-[10px] text-[var(--text-faint)]">
                <span className="flex items-center gap-1"><kbd className="border border-[var(--border-2)] rounded px-1">↑</kbd><kbd className="border border-[var(--border-2)] rounded px-1">↓</kbd> {t('cmd.navigate')}</span>
                <span className="flex items-center gap-1"><kbd className="border border-[var(--border-2)] rounded px-1">↵</kbd> {t('cmd.openWord')}</span>
                <span className="ml-auto">⌘K / Ctrl K</span>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Input fotocamera persistente: cliccato da openAddForm() per aprire subito la camera */}
      <input ref={addCameraInputRef} type="file" accept="image/*" capture="environment" className="hidden"
        onChange={(e: any) => handlePhotoAdd(e, false)} />
      {/* Input fotocamera per il sourcing */}
      <input ref={sourcingCamInputRef} type="file" accept="image/*" capture="environment" className="hidden"
        onChange={sourcingPhoto} />

      {/* ========== MODALE: QUANTO LO PAGO? (sourcing) ========== */}
      {sourcingOpen && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-end sm:items-center justify-center z-50 p-0 sm:p-4" {...swipeBack(() => setSourcingOpen(false))}>
          <div className="bg-[var(--surface)] border-t sm:border border-[var(--border-2)] rounded-t-3xl sm:rounded-3xl w-full max-w-md max-h-[92vh] overflow-y-auto">
            <div className="flex justify-center pt-3 pb-1 sm:hidden"><div className="w-10 h-1 bg-gray-700 rounded-full" /></div>
            <div className="sticky top-0 bg-[var(--surface)] border-b border-[var(--border)] p-5 flex items-center justify-between z-10">
              <div className="flex items-center gap-2">
                <DollarSign size={20} className="text-[#8397aa]" />
                <h2 className="text-xl font-semibold">Ricerca valore</h2>
              </div>
              <button onClick={() => setSourcingOpen(false)} className="p-2 hover:bg-[var(--fill)] rounded-lg transition-colors"><X size={20} /></button>
            </div>

            <div className="p-5 space-y-4">
              <p className="text-xs text-[var(--text-soft)]">Scatta una foto dell'oggetto: l'IA lo riconosce e ti dice il <b>valore di mercato</b> e il <b>prezzo massimo d'acquisto</b> per il margine che vuoi. Niente da scrivere.</p>

              {/* Solo foto */}
              <button type="button" onClick={() => sourcingCamInputRef.current?.click()} disabled={sourcingScanning || sourcingCalcLoading}
                className="w-full py-4 rounded-2xl border border-[#8397aa]/40 bg-[#8397aa]/10 hover:bg-[#8397aa]/20 text-sm font-bold flex items-center justify-center gap-2 transition-colors disabled:opacity-40">
                {(sourcingScanning || sourcingCalcLoading)
                  ? <><Loader2 size={18} className="animate-spin text-[#9fb0bd]" /> {sourcingScanning ? 'Riconoscimento…' : 'Valutazione…'}</>
                  : <><Camera size={18} className="text-[#9fb0bd]" /> Scatta foto</>}
              </button>

              {/* Cosa ha riconosciuto l'IA */}
              {(sourcingBrand || sourcingModel) && (
                <div className="text-center">
                  <p className="text-[10px] uppercase tracking-widest text-[var(--text-faint)]">Riconosciuto</p>
                  <p className="text-sm font-bold text-[var(--text)]">{[sourcingBrand, sourcingModel].filter(Boolean).join(' ')}{sourcingSize ? ` · ${sourcingSize}` : ''}</p>
                </div>
              )}

              {/* Risultato */}
              {sourcingVal && (sourcingVal.configured === false ? (
                <p className="text-xs text-[var(--text-soft)] bg-[var(--surface-2)] rounded-xl p-3 text-center">Fonte prezzi non ancora attiva (eBay in attivazione). Riprova più tardi.</p>
              ) : sourcingVal.value == null ? (
                <p className="text-xs text-[var(--text-soft)] bg-[var(--surface-2)] rounded-xl p-3 text-center">Nessun dato di mercato per questo prodotto. Riprova con una foto più chiara o da un'altra angolazione.</p>
              ) : (
                <div className="space-y-3">
                  <div className="flex items-center justify-between text-sm bg-[var(--surface-2)] rounded-xl p-3">
                    <span className="text-[var(--text-soft)]">Valore di mercato</span>
                    <span className="font-bold text-[var(--text)] num">{Math.round(sourcingVal.value)}€</span>
                  </div>
                  <div className="flex items-center justify-between text-[10px] text-[var(--text-faint)] px-1">
                    <span>{sourcingVal.source} · {sourcingVal.sample} comp.</span>
                    <span className={`font-bold ${sourcingVal.confidence === 'alta' ? 'text-emerald-400' : sourcingVal.confidence === 'media' ? 'text-yellow-500' : 'text-red-400'}`}>confidenza {sourcingVal.confidence}</span>
                  </div>

                  {/* Margine desiderato */}
                  <div>
                    <p className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest mb-2">Margine desiderato</p>
                    <div className="flex gap-2">
                      {[30, 50, 100, 200].map(m => (
                        <button key={m} onClick={() => setSourcingMargin(m)}
                          className={`flex-1 py-2 rounded-lg text-xs font-bold border transition-colors ${sourcingMargin === m ? 'bg-[#8397aa]/10 border-[#8397aa] text-[var(--text)]' : 'bg-[var(--surface-2)] border-[var(--border-2)] text-[var(--text-soft)]'}`}>
                          +{m}%
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Prezzo massimo d'acquisto */}
                  {(() => {
                    const maxBuy = sourcingVal.value / (1 + sourcingMargin / 100);
                    const profit = sourcingVal.value - maxBuy;
                    return (
                      <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-2xl p-4 text-center">
                        <p className="text-[10px] uppercase tracking-widest text-[var(--text-soft)] font-bold mb-1">Paga al massimo</p>
                        <p className="text-3xl font-bold text-emerald-400 num">{Math.round(maxBuy)}€</p>
                        <p className="text-[11px] text-[var(--text-soft)] mt-1">A questo prezzo guadagni ~{Math.round(profit)}€ (margine +{sourcingMargin}%)</p>
                      </div>
                    );
                  })()}
                  <p className="text-[9px] text-[var(--text-faint)] text-center">Stima orientativa lorda (prima delle fee di vendita). Verifica sempre lo stato dell'oggetto.</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* FAB "+" mobile RIMOSSO: l'aggiunta si fa dal "+" verde dentro la barra chat (più pulito). */}

      {/* ========== ADD TYPE PICKER ========== */}

      {/* ========== MOBILE BOTTOM NAV — minimal iOS style ========== */}
      <nav
        ref={bottomNavRef}
        className="lg:hidden fixed bottom-0 left-0 right-0 z-30"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        {/* Sfondo quasi invisibile — frosted glass leggero */}
        <div className="absolute inset-0 bg-[var(--bg-overlay)] backdrop-blur-2xl" />
        {/* Separatore appena percettibile */}
        <div className="absolute top-0 left-0 right-0 h-px bg-[var(--fill)]" />

        {(() => {
          const bottomTabs = [
            { id: 'dashboard',  icon: LayoutDashboard },
            { id: 'magazzino',  icon: Package },
            ...(MARKETPLACE_ENABLED ? [
              { id: 'market',     icon: Store },
              { id: 'chat',       icon: Mail },
            ] : []),
            { id: 'catalog',    icon: Layers },
            { id: 'tracking',   icon: Truck },
            { id: 'analytics',  icon: BarChart3 },
          ];
          return (
        <div className="relative grid px-1" style={{ gridTemplateColumns: `repeat(${bottomTabs.length}, minmax(0, 1fr))` }}>
          {bottomTabs.map(tab => {
            const Icon = tab.icon;
            const active = currentView === tab.id;
            const badge = tab.id === 'tracking'
              ? products.filter(p => p.trackingCode && ['PENDING','IN_TRANSIT','OUT_FOR_DELIVERY'].includes(p.trackingStatus || 'PENDING')).length
              : 0;
            return (
              <button key={tab.id} onClick={() => navigateTo(tab.id as any)}
                className={`flex flex-col items-center justify-center py-2.5 relative active:scale-90 transition-all duration-150 ${
                  active ? 'text-[var(--text)]' : 'text-[var(--text)]/25'
                }`}>
                <div className="relative">
                  <Icon size={22} strokeWidth={active ? 2 : 1.5} />
                  {badge > 0 && (
                    <span className="absolute -top-1 -right-1.5 w-3.5 h-3.5 bg-[#8397aa] text-[var(--text)] rounded-full text-[8px] font-bold flex items-center justify-center">
                      {badge}
                    </span>
                  )}
                </div>
                {/* Dot attivo sottile */}
                {active && <span className="w-1 h-1 rounded-full bg-white mt-1 opacity-60" />}
              </button>
            );
          })}
        </div>
          );
        })()}
      </nav>

      {/* ========== CHATBOX "HQ" (aperta a tutti · solo telefono) ========== */}
      <AssistantChat apiCall={apiCall} showToast={showToast} onAction={fetchProducts} lang={lang} hideBar={bulkMode} onPlus={() => openAddForm()} />

      {smartLotOpen && (
        <SmartLotModal
          apiCall={apiCall}
          showToast={showToast}
          onDone={fetchProducts}
          onClose={() => setSmartLotOpen(false)}
          categories={userCategories}
          warehouses={warehouses.map(w => ({ id: w.id, name: w.name, parentId: w.parentId }))}
          baseWarehouseId={baseWarehouse?.id}
        />
      )}

      {/* ========== MODALE: AGGIUNGI PRODOTTO ========== */}
      {isFormOpen && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-end sm:items-center justify-center z-50 p-0 sm:p-4" {...swipeBack(() => setIsFormOpen(false))}>
          <div className="bg-[var(--surface)] border-t sm:border border-[var(--border-2)] rounded-t-3xl sm:rounded-3xl w-full max-w-2xl max-h-[92vh] overflow-y-auto">
            {/* Drag handle (solo mobile) */}
            <div className="flex justify-center pt-3 pb-1 sm:hidden">
              <div className="w-10 h-1 bg-gray-700 rounded-full" />
            </div>
            <div className="sticky top-0 bg-[var(--surface)] border-b border-[var(--border)] p-5 flex items-center justify-between z-10">
              <div>
                <h2 className="text-xl font-semibold">{t('form.addTitle')}</h2>
                <button type="button"
                  onClick={() => { setIsFormOpen(false); setSmartLotOpen(true); }}
                  className="mt-2 inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-[#8397aa]/15 text-[#8397aa] hover:bg-[#8397aa]/25 text-xs font-bold transition-colors">
                  <Layers size={14} /> {t('form.buyingLot')}
                </button>
              </div>
              <button onClick={() => setIsFormOpen(false)}
                className="p-2 hover:bg-[var(--fill)] rounded-lg transition-colors">
                <X size={20} />
              </button>
            </div>
            
            <form onSubmit={handleSave} className="p-5 space-y-5">
              
              {/* Magazzino + Categoria. Foto-first: la categoria la capisce l'IA dalla
                  foto (niente griglia da cliccare). Resta il "scrivi a mano" per crearla/sceglierla. */}
              <div>
                {/* Selettore MAGAZZINO (partnership). Mostrato se l'utente ha più di un magazzino. */}
                {warehouses.filter((w: any) => !w.parentId).length > 1 && (
                  <div className="mb-3">
                    <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">{t('form.warehouse')}</label>
                    <div className="flex flex-wrap gap-2">
                      {warehouses.filter((w: any) => !w.parentId).map((w: any) => {
                        const isSel = (selectedWarehouseId || baseWarehouse?.id) === w.id;
                        return (
                          <button key={w.id} type="button" onClick={() => setSelectedWarehouseId(w.id)}
                            className={`px-3 py-2 rounded-xl text-xs font-bold border transition-all ${isSel ? 'bg-[#8397aa]/10 border-[#8397aa] text-[var(--text)]' : 'bg-[var(--surface-2)] border-[var(--border-2)] text-[var(--text-soft)]'}`}>
                            {w.name}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Stato categoria (rilevata dall'IA) + scrivi a mano */}
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <span className="text-[11px] text-[var(--text-soft)] flex items-center gap-1.5 min-w-0">
                    <Sparkles size={12} className="text-[#9fb0bd] shrink-0" />
                    {category && category !== AUTO_CATEGORY ? (
                      <>{t('form.category')}: <b className="text-[var(--text)]">{category}</b></>
                    ) : detectedReparto ? (
                      <>{t('form.detected')}: <b className="text-[var(--text)]">{detectedReparto}</b>…</>
                    ) : (
                      <>{t('form.aiUnderstands')}</>
                    )}
                  </span>
                  <button type="button" onClick={() => { setShowRepartoGrid(v => !v); setFormCatInput(''); }}
                    className="text-[11px] font-bold text-[var(--text-soft)] hover:text-[var(--text)] transition-colors shrink-0">
                    {showRepartoGrid ? t('common.cancel') : t('form.writeCategory')}
                  </button>
                </div>

                {/* Input manuale: crea la categoria se non esiste, altrimenti la seleziona.
                    NB: NIENTE <form> annidato (causerebbe il submit del form esterno → refresh). */}
                {showRepartoGrid && (
                  <div className="mt-2 flex gap-2">
                    <input list="form-cat-suggestions" value={formCatInput} onChange={e => setFormCatInput(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); useManualCategory(); } }}
                      placeholder={t('form.catPlaceholder')} autoFocus
                      className="flex-1 bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl px-3 py-2 text-sm outline-none focus:border-[#8397aa]" />
                    <datalist id="form-cat-suggestions">
                      {userCategories.map((c: string) => <option key={c} value={c} />)}
                    </datalist>
                    <button type="button" onClick={useManualCategory} disabled={isAddingCat || !formCatInput.trim()}
                      className="px-4 py-2 rounded-xl bg-[#8397aa] text-white text-sm font-bold disabled:opacity-50">
                      {isAddingCat ? <Loader2 size={14} className="animate-spin" /> : t('form.use')}
                    </button>
                  </div>
                )}
              </div>

              {/* FOTO + IA SCAN — multi-foto (max 5) */}
              <div className="bg-gradient-to-br from-[#8397aa]/10 to-[#8397aa]/10 border border-[#8397aa]/30 rounded-2xl p-4">
                <div className="flex items-center justify-between mb-2">
                  <label className="flex items-center gap-2">
                    <Sparkles className="text-[#9fb0bd]" size={16} />
                    <span className="text-xs font-bold text-[var(--text)]">{t('form.photoAI')}</span>
                  </label>
                  <span className="text-[10px] text-[var(--text-soft)]">{productPhotos.length}/5 {t('form.photos')}</span>
                </div>
                <p className="text-[10px] text-[var(--text-muted)] mb-3">
                  {category === AUTO_CATEGORY
                    ? t('form.photoHintAuto')
                    : t('form.photoHintManual')}
                </p>

                {/* Scansiona barcode: legge il codice e prova a riconoscere il prodotto */}
                <button type="button" onClick={openBarcodeScanner} disabled={barcodeBusy}
                  className="w-full mb-3 flex items-center justify-center gap-2 py-2.5 rounded-xl bg-[var(--surface-2)] border border-[var(--border-2)] hover:border-[#8397aa] text-sm font-bold text-[var(--text)] transition-colors disabled:opacity-50">
                  {barcodeBusy ? <Loader2 size={15} className="animate-spin" /> : <ScanLine size={15} className="text-[#8397aa]" />}
                  {t('form.scanBarcode')}
                </button>

                {/* Griglia foto */}
                <div className="grid grid-cols-5 gap-2 mb-3">
                  {productPhotos.map((photo, i) => (
                    <div key={i} className={`relative aspect-square rounded-xl overflow-hidden bg-[var(--surface-2)] border ${i === 0 ? 'border-[var(--teal)] ring-1 ring-[var(--teal)]' : 'border-[#8397aa]/30'}`}>
                      <img src={/^https?:\/\//.test(photo) ? proxyImg(photo) : photo} alt={`foto ${i + 1}`} className="w-full h-full object-cover" />
                      <button type="button" onClick={() => removePhoto(i)}
                        className="absolute top-1 right-1 w-5 h-5 bg-black/70 rounded-full flex items-center justify-center hover:bg-red-600 transition-colors">
                        <X size={10} />
                      </button>
                      {/* Foto principale = la prima. Tocca la stella per rendere principale un'altra. */}
                      {i === 0 ? (
                        <span className="absolute top-1 left-1 w-5 h-5 rounded-full bg-[var(--teal)] text-white flex items-center justify-center text-[10px]" title="Foto principale">★</span>
                      ) : (
                        <button type="button" onClick={() => setPrimaryPhoto(i)} title="Rendi principale"
                          className="absolute top-1 left-1 w-5 h-5 bg-black/70 rounded-full flex items-center justify-center text-white text-[10px] hover:bg-[var(--teal)] transition-colors">☆</button>
                      )}
                      <button type="button" onClick={() => runAIScan(photo, category)}
                        disabled={isScanning}
                        className="absolute bottom-0 left-0 right-0 bg-[#6f8394]/80 hover:bg-[#8397aa]/90 py-0.5 text-[9px] font-bold text-center transition-colors disabled:opacity-40">
                        {t('form.scan')}
                      </button>
                    </div>
                  ))}
                  {productPhotos.length < 5 && (
                    // Tile principale: apre DIRETTAMENTE la fotocamera (capture) su mobile.
                    // Resta attivo anche durante lo scan: puoi aggiungere altre foto mentre
                    // l'IA ragiona (si accodano alla galleria, non interrompono il riconoscimento).
                    <label className="aspect-square rounded-xl border-2 border-dashed border-[#8397aa]/30 hover:border-[#8397aa] flex flex-col items-center justify-center cursor-pointer transition-colors">
                      <input type="file" accept="image/*" capture="environment" className="hidden"
                        onChange={(e: any) => handlePhotoAdd(e, false)} />
                      <Camera size={18} className="text-[#9fb0bd] mb-1" />
                      <span className="text-[9px] text-[var(--text-soft)]">{t('form.take')}</span>
                    </label>
                  )}
                </div>

                {/* Alternativa: scegli dalla libreria (senza capture → galleria/file).
                    Disponibile anche durante lo scan per aggiungere altre foto. */}
                {productPhotos.length < 5 && (
                  <label className="flex items-center justify-center gap-2 w-full mb-3 py-2 rounded-xl border border-[#8397aa]/30 hover:border-[#8397aa] text-[11px] font-bold text-[var(--text-soft)] hover:text-[var(--text)] cursor-pointer transition-colors">
                    <input type="file" accept="image/*" multiple className="hidden"
                      onChange={(e: any) => handlePhotoAdd(e, false)} />
                    <ImageIcon size={13} className="text-[#9fb0bd]" />
                    {t('form.chooseLibrary')}
                  </label>
                )}

                {isScanning && (
                  <p className="text-xs text-[#9fb0bd] flex items-center gap-2 mb-2">
                    <Loader2 className="animate-spin" size={12} /> {t('form.aiAnalyzing')}
                  </p>
                )}

                {scanResult && (
                  <div className="space-y-2 text-xs">
                    <div className={`p-2 rounded-lg ${
                      scanResult.confidence === 'HIGH' ? 'bg-green-500/10 text-green-400' :
                      scanResult.confidence === 'MEDIUM' ? 'bg-yellow-500/10 text-yellow-400' :
                      'bg-red-500/10 text-red-400'
                    }`}>
                      <span className="font-bold">{t('form.recognition')}: {scanResult.confidence}</span>
                      {scanResult.autoDetected && scanResult.detectedCategory && (
                        <p className="opacity-90">{t('form.detectedCategory')}: <b>{scanResult.detectedCategory}</b></p>
                      )}
                      {scanResult.brand && <p>{scanResult.brand} {scanResult.model}</p>}
                      {scanResult.warnings?.map((w: any, i: number) => <p key={i}>⚠️ {w}</p>)}
                    </div>
                    {/* Verifica eBay del riconoscimento (valore di mercato reale) */}
                    {scanMarket && (
                      scanMarket.value != null ? (
                        <div className={`p-2 rounded-lg flex items-center gap-1.5 ${scanMarket.reliable ? 'bg-emerald-500/10 text-emerald-300' : 'bg-amber-500/10 text-amber-300'}`}>
                          {scanMarket.reliable ? <CheckCircle size={13} className="shrink-0" /> : <AlertTriangle size={13} className="shrink-0" />}
                          <span>
                            <b>~{Math.round(scanMarket.value)}{(scanMarket.currency && scanMarket.currency !== 'EUR') ? ' ' + scanMarket.currency : '€'}</b>
                            {scanMarket.itemName ? <span className="opacity-80"> · {scanMarket.itemName}{scanMarket.extra ? ` (${scanMarket.extra})` : ''}</span> : null}
                            <span className="opacity-60"> · {scanMarket.source}</span>
                          </span>
                        </div>
                      ) : (
                        <div className="p-2 rounded-lg bg-[var(--surface-2)] text-[var(--text-soft)] flex items-center gap-1.5">
                          <Search size={13} className="shrink-0" />
                          <span>{t('form.noValueFound')}</span>
                        </div>
                      )
                    )}
                    {/* Conferma visiva StockX: la foto del modello che StockX ha trovato */}
                    {scanStockxMatch && scanStockxMatch.image && (
                      <div className="p-2 rounded-lg bg-[var(--surface-2)] border border-[var(--border-2)]">
                        <div className="flex items-center gap-2.5">
                          <img src={scanStockxMatch.image} alt="" className="w-14 h-14 rounded-lg object-contain bg-white shrink-0" />
                          <div className="min-w-0">
                            <p className="text-[10px] uppercase tracking-widest text-[var(--text-faint)]">{t('form.stockxSays')}</p>
                            <p className="font-bold text-[var(--text)] truncate">{scanStockxMatch.title}</p>
                            <p className="text-[11px] text-[var(--text-soft)]">{scanStockxMatch.sku ? `${scanStockxMatch.sku} · ` : ''}{scanStockxMatch.price != null ? `${scanStockxMatch.price}€` : ''}</p>
                          </div>
                        </div>
                        <p className="text-[10px] text-[var(--text-faint)] mt-1.5">{t('form.compareShoe')}</p>
                      </div>
                    )}
                    {/* Tabella dinamica: attributi estratti dall'IA */}
                    {(() => {
                      const d = scanResult.details || {};
                      const LABELS: Record<string, string> = lang === 'it' ? {
                        type: 'Tipo', material: 'Materiale', color: 'Colore', size: 'Taglia/Misura',
                        condition: 'Condizione', collaboration: 'Collab', styleCode: 'Codice',
                        metal: 'Metallo', hallmark: 'Punzone', stones: 'Pietre', serial: 'Seriale',
                        serialNumber: 'Seriale', lensType: 'Lenti', frameMaterial: 'Montatura',
                        lensColor: 'Colore lenti', modelCode: 'Cod. modello', pattern: 'Pattern',
                        dateCode: 'Data code', hardwareColor: 'Hardware', sizeName: 'Misura',
                        buckleType: 'Fibbia', beltSize: 'Taglia', concentration: 'Concentr.',
                        volumeMl: 'Volume', batchCode: 'Batch', storage: 'Memoria',
                        modelNumber: 'Modello', generation: 'Gen.', game: 'Gioco', rarity: 'Rarità',
                        graded: 'Grading', cardNumber: 'Numero', artist: 'Artista', title: 'Titolo',
                        format: 'Formato', catalogNumber: 'Catalogo', pressing: 'Stampa',
                        itemNumber: 'Numero', series: 'Serie', exclusive: 'Esclusiva', style: 'Stile',
                        hatSize: 'Taglia',
                        country: 'Paese', denomination: 'Valore', year: 'Anno', mintMark: 'Zecca',
                        productType: 'Prodotto', shade: 'Tonalità', volume: 'Volume',
                        instrumentType: 'Strumento', finish: 'Finitura',
                        publisher: 'Editore', issueNumber: 'Numero', edition: 'Edizione',
                        isbn: 'ISBN', stampCondition: 'Stato', catalogRef: 'Catalogo',
                        priceTier: 'Fascia', walletType: 'Tipo',
                      } : {
                        type: 'Type', material: 'Material', color: 'Color', size: 'Size',
                        condition: 'Condition', collaboration: 'Collab', styleCode: 'Code',
                        metal: 'Metal', hallmark: 'Hallmark', stones: 'Stones', serial: 'Serial',
                        serialNumber: 'Serial', lensType: 'Lenses', frameMaterial: 'Frame',
                        lensColor: 'Lens color', modelCode: 'Model code', pattern: 'Pattern',
                        dateCode: 'Date code', hardwareColor: 'Hardware', sizeName: 'Size',
                        buckleType: 'Buckle', beltSize: 'Size', concentration: 'Concentr.',
                        volumeMl: 'Volume', batchCode: 'Batch', storage: 'Storage',
                        modelNumber: 'Model', generation: 'Gen.', game: 'Game', rarity: 'Rarity',
                        graded: 'Grading', cardNumber: 'Number', artist: 'Artist', title: 'Title',
                        format: 'Format', catalogNumber: 'Catalog', pressing: 'Pressing',
                        itemNumber: 'Number', series: 'Series', exclusive: 'Exclusive', style: 'Style',
                        hatSize: 'Size',
                        country: 'Country', denomination: 'Denomination', year: 'Year', mintMark: 'Mint mark',
                        productType: 'Product', shade: 'Shade', volume: 'Volume',
                        instrumentType: 'Instrument', finish: 'Finish',
                        publisher: 'Publisher', issueNumber: 'Number', edition: 'Edition',
                        isbn: 'ISBN', stampCondition: 'Condition', catalogRef: 'Catalog',
                        priceTier: 'Tier', walletType: 'Type',
                      };
                      const SKIP = new Set(['notes', 'logoDescription', 'authenticityMarkers', 'rawText', 'priceRange', 'luxuryMarkers']);
                      const rows = Object.entries(d).filter(([k, v]) =>
                        !SKIP.has(k) && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') &&
                        String(v).trim() && String(v).toLowerCase() !== 'null' && String(v).toLowerCase() !== 'false'
                      ).slice(0, 8);
                      return rows.length > 0 ? (
                        <div className="grid grid-cols-2 gap-x-3 gap-y-1 p-2 rounded-lg bg-[var(--surface-2)] border border-[var(--border)]">
                          {rows.map(([k, v]) => (
                            <div key={k} className="flex justify-between gap-2 min-w-0">
                              <span className="text-[var(--text-faint)] shrink-0">{LABELS[k] || k}</span>
                              <span className="text-[var(--text-muted)] font-medium text-right truncate">{v === true ? (lang === 'it' ? 'Sì' : 'Yes') : String(v)}</span>
                            </div>
                          ))}
                        </div>
                      ) : null;
                    })()}
                  </div>
                )}
              </div>
              
              {/* FOTO-FIRST: i campi/tabelle compaiono solo quando la categoria è
                  determinata (rilevata dalla foto o scelta a mano). In Automatico
                  senza ancora una categoria si vede solo la foto. */}
              {(category && category !== AUTO_CATEGORY) && (<>
              {/* Form campi specifici per categoria */}
              {category === 'Pokemon' ? (
                <>
                  <div>
                    <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">{t('nf.cardName')}</label>
                    <input type="text" required value={pokeName}
                      onChange={(e: any) => setPokeName(e.target.value)}
                      placeholder="Es. Charizard"
                      className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm focus:border-[#8397aa] outline-none" />
                  </div>
                  {/* Numero carta — rilevato dall'IA, correggibile: serve per il prezzo esatto */}
                  <div>
                    <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">
                      {t('nf.cardNumber')} <span className="text-[var(--text-faint)] normal-case font-medium">{t('nf.forExactPrice')}</span>
                    </label>
                    <div className="flex gap-2">
                      <input type="text" value={cardNumber} onChange={(e: any) => setCardNumber(e.target.value)}
                        placeholder="es. 4/102, SWSH076"
                        className="flex-1 bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm font-mono focus:border-[#8397aa] outline-none" />
                      <button type="button" onClick={revalueCard} disabled={revaluingCard}
                        className="px-4 rounded-xl bg-[#8397aa]/15 text-[#8397aa] text-xs font-bold hover:bg-[#8397aa]/25 disabled:opacity-50 transition-colors flex items-center gap-1.5 whitespace-nowrap">
                        {revaluingCard ? <Loader2 className="animate-spin" size={14} /> : <Search size={14} />} {t('nf.priceBtn')}
                      </button>
                    </div>
                    <p className="text-[10px] text-[var(--text-faint)] mt-1">{t('nf.cardNumHint')}</p>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">{t('nf.graded')}</label>
                      <select value={pokeGraded} onChange={(e: any) => { setPokeGraded(e.target.value); setTimeout(revalueCard, 0); }}
                        className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm focus:border-[#8397aa] outline-none">
                        <option value="No">{t('nf.gradedNo')}</option>
                        <option value="Si">{t('nf.gradedYes')}</option>
                      </select>
                    </div>
                    {pokeGraded === 'Si' && (
                      <div>
                        <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">{t('nf.grade')}</label>
                        <input type="text" value={pokeGrade}
                          onChange={(e: any) => setPokeGrade(e.target.value)}
                          onBlur={revalueCard}
                          placeholder="10, 9.5..."
                          className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm focus:border-[#8397aa] outline-none" />
                      </div>
                    )}
                  </div>
                </>
              ) : category === 'Orologi' ? (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">{t('form.brand')}</label>
                      <input type="text" required value={watchBrand}
                        onChange={(e: any) => setWatchBrand(e.target.value)}
                        placeholder="Rolex"
                        className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm focus:border-[#8397aa] outline-none" />
                    </div>
                    <div>
                      <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">{t('form.model')}</label>
                      <input type="text" required value={watchModel}
                        onChange={(e: any) => setWatchModel(e.target.value)}
                        placeholder="Submariner"
                        className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm focus:border-[#8397aa] outline-none" />
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">{t('nf.case')}</label>
                      <input type="text" value={watchCase}
                        onChange={(e: any) => setWatchCase(e.target.value)}
                        placeholder="41mm"
                        className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm focus:border-[#8397aa] outline-none" />
                    </div>
                    <div>
                      <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">{t('nf.strap')}</label>
                      <input type="text" value={watchStrap}
                        onChange={(e: any) => setWatchStrap(e.target.value)}
                        placeholder="Oyster"
                        className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm focus:border-[#8397aa] outline-none" />
                    </div>
                    <div>
                      <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">{t('nf.material')}</label>
                      <input type="text" value={watchMaterial}
                        onChange={(e: any) => setWatchMaterial(e.target.value)}
                        placeholder="Acciaio"
                        className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm focus:border-[#8397aa] outline-none" />
                    </div>
                  </div>
                  <div>
                    <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">{t('mag.condition')}</label>
                    <select value={condition} onChange={(e: any) => setCondition(e.target.value)}
                      className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm focus:border-[#8397aa] outline-none">
                      <option value="">{t('form.conditionNone')}</option>
                      <option value="Full Set">{t('nf.cdFullSet')}</option>
                      <option value="Solo Box">{t('nf.cdBoxOnly')}</option>
                      <option value="Solo Carta">{t('nf.cdPapersOnly')}</option>
                      <option value="Naked">{t('nf.cdNaked')}</option>
                    </select>
                  </div>
                </>
              ) : (() => {
                const catConfig = !isBuiltinCategory(category) ? getCategoryConfig(category) : null;
                if (catConfig?.fields?.length > 0) {
                  // Form DINAMICO generato dall'IA
                  return (
                    <>
                      <div className="grid grid-cols-2 gap-3">
                        {catConfig.fields.map((f: any) => {
                          const val = f.name === 'brand' ? brand : f.name === 'model' ? name : customFieldValues[f.name] || '';
                          const setVal = (v: string) => {
                            if (f.name === 'brand') setBrand(v);
                            else if (f.name === 'model') setName(v);
                            else setCustomFieldValues(prev => ({ ...prev, [f.name]: v }));
                          };
                          return (
                            <div key={f.name} className={f.name === 'model' || f.type === 'text' && f.placeholder?.length > 20 ? 'col-span-2' : ''}>
                              <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">
                                {f.label}{!f.required && <span className="text-gray-700 normal-case font-normal ml-1">{t('nf.optShort')}</span>}
                              </label>
                              {f.type === 'select' ? (
                                <select value={val} onChange={(e: any) => setVal(e.target.value)}
                                  required={f.required}
                                  className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm focus:border-[#8397aa] outline-none">
                                  <option value="">{t('nf.select')}</option>
                                  {(f.options || []).map((opt: string) => <option key={opt} value={opt}>{opt}</option>)}
                                </select>
                              ) : (
                                <input type={f.type === 'number' ? 'number' : 'text'}
                                  value={val} onChange={(e: any) => setVal(e.target.value)}
                                  required={f.required}
                                  placeholder={f.placeholder || ''}
                                  className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm focus:border-[#8397aa] outline-none" />
                              )}
                            </div>
                          );
                        })}
                        {/* Condizione dal config AI */}
                        <div>
                          <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">{t('mag.condition')}</label>
                          <select value={condition} onChange={(e: any) => setCondition(e.target.value)}
                            className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm focus:border-[#8397aa] outline-none">
                            <option value="">{t('form.conditionNone')}</option>
                            {(catConfig.conditionOptions || ['Nuovo','Ottimo','Buono','Usato']).map((opt: string) => (
                              <option key={opt} value={opt}>{opt}</option>
                            ))}
                          </select>
                        </div>
                      </div>
                    </>
                  );
                }
                // Form GENERICO fallback (nessun config AI ancora)
                return (
                <>
                  {/* Scarpe: il brand è inutile (il modello StockX lo contiene già) → solo Model. */}
                  <div className={`grid gap-3 ${category === 'Scarpe' ? 'grid-cols-1' : 'grid-cols-2'}`}>
                    {category !== 'Scarpe' && (
                      <div>
                        <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">{t('form.brand')}</label>
                        <input type="text" required value={brand}
                          onChange={(e: any) => setBrand(e.target.value)}
                          placeholder={category === 'Vestiti' ? 'Supreme' : 'Louis Vuitton'}
                          className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm focus:border-[#8397aa] outline-none" />
                      </div>
                    )}
                    <div>
                      <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">{t('form.model')}</label>
                      <input type="text" required value={name}
                        onChange={(e: any) => setName(e.target.value)}
                        placeholder={category === 'Scarpe' ? 'Air Jordan 1 Chicago' : category === 'Vestiti' ? 'Box Logo Hoodie' : 'Neverfull MM'}
                        className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm focus:border-[#8397aa] outline-none" />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      {/* Taglia — sempre input libero con suggerimenti datalist */}
                      <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">
                        {category === 'Scarpe' ? t('form.sizeEU') : category === 'Vestiti' ? t('form.size') : t('form.sizeDim')}
                      </label>
                      <input
                        list={`size-suggestions-${category}`}
                        value={size}
                        onChange={(e: any) => setSize(e.target.value)}
                        placeholder={category === 'Scarpe' ? 'es. 42, 42.5, US 9' : category === 'Vestiti' ? 'es. M, L, XL' : 'es. MM, 30cm, Small'}
                        className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm focus:border-[#8397aa] outline-none"
                      />
                      <datalist id={`size-suggestions-${category}`}>
                        {category === 'Scarpe'
                          ? ['36','37','38','38.5','39','40','40.5','41','42','42.5','43','44','44.5','45','46','US 7','US 8','US 9','US 10','US 11','US 12']
                            .map(s => <option key={s} value={s} />)
                          : category === 'Vestiti'
                          ? ['XS','S','M','L','XL','XXL','One Size']
                            .map(s => <option key={s} value={s} />)
                          : ['XS','S','M','L','XL','Mini','Small','Medium','Large','20cm','25cm','30cm','35cm','Unisize']
                            .map(s => <option key={s} value={s} />)
                        }
                      </datalist>
                    </div>
                    <div>
                      <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">{t('mag.condition')}</label>
                      <select value={condition} onChange={(e: any) => setCondition(e.target.value)}
                        className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm focus:border-[#8397aa] outline-none">
                        <option value="">{t('form.conditionNone')}</option>
                        <option value="DS">{t('form.condDS')}</option>
                        <option value="VNDS">{t('form.condVNDS')}</option>
                        <option value="Used">{t('form.condUsed')}</option>
                        <option value="Worn">{t('form.condWorn')}</option>
                      </select>
                    </div>
                  </div>
                  {/* Campi dinamici dalla CategoryTemplate — a comparsa per non sovraccaricare */}
                  {activeTemplate && activeTemplate.fields?.length > 0 && (
                    <div className="border-t border-[var(--border-2)] pt-4">
                      <button type="button" onClick={() => setShowCatDetails(v => !v)}
                        className="w-full flex items-center justify-between text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest">
                        <span>{t('form.catDetails')} <span className="text-[var(--text-faint)] normal-case">({t('form.optional')})</span></span>
                        <ChevronDown size={16} className={`transition-transform ${showCatDetails ? 'rotate-180' : ''}`} />
                      </button>
                      {showCatDetails && (
                        <div className="mt-3">
                          <DynamicForm
                            /* Tolgo dai "dettagli" i campi TAGLIA/SIZE/DIMENSIONE: c'è già il campo Taglia
                               standard sopra → niente doppioni (es. abbigliamento chiedeva la taglia 2 volte). */
                            fields={activeTemplate.fields.filter((f: any) => {
                              const k = `${f.key || ''} ${f.label || ''} ${f.name || ''}`.toLowerCase();
                              return !(/\bsize\b|tagli|dimension|misura/.test(k)) || /belt|hat|case|band|strap|watch/.test(k);
                            })}
                            values={dynamicAttrs}
                            onChange={(key, value) => setDynamicAttrs(prev => ({ ...prev, [key]: value }))}
                            disabled={isSaving}
                          />
                        </div>
                      )}
                    </div>
                  )}
                </>
              );})()}

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">{t('form.purchasePrice')}{(parseInt(quantity) || 1) > 1 ? ' (totale)' : ''}</label>
                  <input type="number" step="0.01" required value={price}
                    onChange={(e: any) => setPrice(e.target.value)}
                    className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm focus:border-[#8397aa] outline-none" />
                  {(parseInt(quantity) || 1) > 1 && parseFloat(price) > 0 && (
                    <p className="text-[10px] text-[var(--text-faint)] mt-1 num">= {(parseFloat(price) / (parseInt(quantity) || 1)).toFixed(2)}€ a pezzo</p>
                  )}
                </div>
                <div>
                  <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">{t('form.quantity')}</label>
                  <input type="number" min="1" required value={quantity}
                    onChange={(e: any) => setQuantity(e.target.value)}
                    className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm focus:border-[#8397aa] outline-none" />
                </div>
              </div>

              {/* Fornitore: da CHI ho acquistato (facoltativo) → tabella "Fornitori" nelle analytics. */}
              <div>
                <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">{t('sup.label')} <span className="text-[var(--text-faint)] normal-case font-normal">{t('sup.hint')}</span></label>
                <input type="text" value={productSupplier} onChange={(e: any) => setProductSupplier(e.target.value)} maxLength={120} placeholder={t('sup.placeholder')}
                  className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm focus:border-[#8397aa] outline-none" />
              </div>

              {/* Conto vendita — prodotto di un terzo */}
              <div className="border-t border-[var(--border-2)] pt-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Store size={14} className="text-[#8397aa]" />
                    <span className="text-sm font-bold">{t('form.consignment')}</span>
                  </div>
                  <button type="button" onClick={() => setIsConsignment(v => !v)}
                    className={`relative w-11 h-6 rounded-full transition-colors shrink-0 ${isConsignment ? 'bg-[#8397aa]' : 'bg-[var(--fill-3)]'}`}>
                    <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${isConsignment ? 'translate-x-5' : ''}`} />
                  </button>
                </div>
                <p className="text-[11px] text-[var(--text-faint)] mt-1">{t('form.consignmentHint')}</p>
                {isConsignment && (
                  <div className="grid grid-cols-2 gap-3 mt-3">
                    <div>
                      <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">{t('form.name')} <span className="text-red-400">*</span></label>
                      <input type="text" value={consignmentName} onChange={(e: any) => setConsignmentName(e.target.value)} placeholder="es. Marco R."
                        className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm focus:border-[#8397aa] outline-none" />
                    </div>
                    <div>
                      <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">{t('form.percent')} <span className="text-[var(--text-faint)] normal-case font-medium">({t('form.optionalShort')})</span></label>
                      <input type="number" min="0" max="100" step="1" value={consignmentPercent} onChange={(e: any) => setConsignmentPercent(e.target.value)} placeholder="es. 20"
                        className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm focus:border-[#8397aa] outline-none" />
                    </div>
                  </div>
                )}
              </div>

              {/* Quote del team */}
              {(() => {
                const whId = selectedWarehouseId || baseWarehouse?.id;
                const currentTeam = teamData.find((t: any) => t.warehouseId === whId);
                if (!currentTeam || currentTeam.members.length <= 1) return null;
                return (
                  <div className="border-t border-[var(--border-2)] pt-4">
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-2">
                        <Users size={14} className="text-blue-400" />
                        <span className="text-sm font-bold">{t('form.teamShares')}</span>
                      </div>
                      {!isSharedPurchase ? (
                        <button type="button"
                          onClick={() => setIsSharedPurchase(true)}
                          className="text-xs text-[var(--text)] hover:text-[#9fb0bd] font-bold transition-colors">
                          {t('form.changePercent')}
                        </button>
                      ) : (
                        <button type="button"
                          onClick={() => { setIsSharedPurchase(false); setProductShares([]); }}
                          className="text-xs text-[var(--text-soft)] hover:text-[var(--text)] font-bold transition-colors">
                          {t('form.restoreDefault')}
                        </button>
                      )}
                    </div>

                    {!isSharedPurchase ? (
                      <div className="space-y-2">
                        {currentTeam.members.map((m: any) => (
                          <div key={m.userId} className="flex items-center gap-3 bg-[var(--surface-2)] p-3 rounded-xl">
                            <span className="font-bold text-sm flex-1">{m.name}</span>
                            <span className="text-[var(--text-muted)] text-sm font-bold w-12 text-right">{m.percentage}%</span>
                          </div>
                        ))}
                        <p className="text-[10px] text-[var(--text-faint)] mt-1">{t('form.teamDefaultHint')}</p>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {productShares.map((s: any, i: number) => (
                          <div key={s.userId} className="flex items-center gap-3 bg-[var(--surface-2)] p-3 rounded-xl">
                            <span className="font-bold text-sm flex-1">{s.name}</span>
                            <input type="number" min="0" max="100" value={s.percentage}
                              onChange={(e: any) => {
                                const newShares = [...productShares];
                                newShares[i].percentage = e.target.value;
                                setProductShares(newShares);
                              }}
                              className="w-20 bg-[var(--surface)] border border-[var(--border)] rounded-lg px-3 py-1.5 text-sm text-right" />
                            <span className="text-[var(--text-soft)] text-xs">%</span>
                          </div>
                        ))}
                        <p className={`text-[10px] mt-1 font-bold ${
                          Math.round(productShares.reduce((s, x) => s + (Number(x.percentage) || 0), 0)) === 100
                            ? 'text-green-500' : 'text-yellow-500'
                        }`}>
                          {t('form.total')}: {productShares.reduce((s, x) => s + (Number(x.percentage) || 0), 0).toFixed(0)}% {t('form.mustBe100')}
                        </p>
                      </div>
                    )}
                  </div>
                );
              })()}
              
              <button type="submit" disabled={isSaving}
                className="w-full bg-[#8397aa] hover:bg-[#9fb0bd] py-3 rounded-xl font-bold transition-colors disabled:opacity-50 flex items-center justify-center">
                {isSaving ? <Loader2 className="animate-spin" size={20} /> : t('form.saveProduct')}
              </button>
              </>)}
            </form>
          </div>
        </div>
      )}
      
      {/* ========== LIGHTBOX FOTO (tap su una foto del magazzino) ========== */}
      {zoomPhoto && (
        <div className="fixed inset-0 z-[120] bg-black/95 flex items-center justify-center p-4" onClick={() => setZoomPhoto(null)}>
          <button onClick={() => setZoomPhoto(null)} aria-label="Chiudi"
            className="absolute right-4 p-2 bg-white/10 rounded-full text-white hover:bg-white/20 z-10" style={{ top: 'calc(env(safe-area-inset-top) + 12px)' }}>
            <X size={22} />
          </button>
          <img src={/^https?:\/\//.test(zoomPhoto) ? (proxyImg(zoomPhoto) || zoomPhoto) : zoomPhoto} alt="" className="max-w-full max-h-full object-contain rounded-2xl" onClick={e => e.stopPropagation()} />
        </div>
      )}

      {/* ========== MODALE: VENDI ========== */}
      {/* ===== SELETTORE QUANTITÀ per selezione parziale di un gruppo di pezzi identici ===== */}
      {bulkQtyGroup && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-end sm:items-center justify-center z-[220] p-0 sm:p-4" onClick={() => setBulkQtyGroup(null)}>
          <div className="bg-[var(--surface)] border-t sm:border border-[var(--border-2)] rounded-t-3xl sm:rounded-3xl w-full max-w-sm p-6" onClick={e => e.stopPropagation()}>
            <div className="flex justify-center pt-1 pb-3 sm:hidden"><div className="w-10 h-1 bg-gray-700 rounded-full" /></div>
            <h3 className="text-lg font-black text-center">{fullName(bulkQtyGroup.brand, bulkQtyGroup.name)}</h3>
            <p className="text-xs text-[var(--text-soft)] text-center mt-1">{lang === 'en' ? 'How many to select?' : 'Quanti selezionarne?'} · {lang === 'en' ? 'available' : 'disponibili'}: {bulkQtyGroup.ids.length}</p>
            <div className="flex items-center justify-center gap-4 my-6">
              <button type="button" onClick={() => setBulkQtyValue(q => String(Math.max(0, (parseInt(q) || 0) - 1)))}
                className="w-14 h-14 rounded-2xl bg-[var(--surface-2)] border border-[var(--border-2)] text-2xl font-black hover:bg-[var(--fill)] active:scale-95 transition disabled:opacity-40"
                disabled={(parseInt(bulkQtyValue) || 0) <= 0}>−</button>
              <input type="number" min="0" max={bulkQtyGroup.ids.length} inputMode="numeric"
                value={bulkQtyValue}
                onChange={(e: any) => { const n = parseInt(e.target.value); setBulkQtyValue(e.target.value === '' ? '' : String(Math.min(bulkQtyGroup.ids.length, Math.max(0, n || 0)))); }}
                className="w-24 text-center bg-[var(--surface-2)] border border-[var(--border-2)] rounded-2xl p-3 text-2xl font-black focus:border-[#8397aa] outline-none" />
              <button type="button" onClick={() => setBulkQtyValue(q => String(Math.min(bulkQtyGroup.ids.length, (parseInt(q) || 0) + 1)))}
                className="w-14 h-14 rounded-2xl bg-[var(--surface-2)] border border-[var(--border-2)] text-2xl font-black hover:bg-[var(--fill)] active:scale-95 transition disabled:opacity-40"
                disabled={(parseInt(bulkQtyValue) || 0) >= bulkQtyGroup.ids.length}>+</button>
            </div>
            <button type="button" onClick={() => setBulkQtyValue(String(bulkQtyGroup.ids.length))}
              className="w-full mb-2 text-xs font-bold text-[#8397aa] hover:underline">{lang === 'en' ? 'Select all' : 'Seleziona tutti'} ({bulkQtyGroup.ids.length})</button>
            <div className="flex gap-2">
              <button type="button" onClick={() => setBulkQtyGroup(null)} className="flex-1 py-3 rounded-xl border border-[var(--border-2)] text-sm font-bold text-[var(--text-soft)] hover:text-[var(--text)]">{t('common.cancel')}</button>
              <button type="button" onClick={applyBulkQty} className="flex-1 py-3 rounded-xl bg-[#8397aa] hover:bg-[#6f8394] text-white text-sm font-black">OK</button>
            </div>
          </div>
        </div>
      )}

      {sellModalOpen && productToSell && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-end sm:items-center justify-center z-50 p-0 sm:p-4" {...swipeBack(() => setSellModalOpen(false))}>
          <div className="bg-[var(--surface)] border-t sm:border border-[var(--border-2)] rounded-t-3xl sm:rounded-3xl w-full max-w-md max-h-[92vh] overflow-y-auto">
            <div className="flex justify-center pt-3 pb-1 sm:hidden"><div className="w-10 h-1 bg-gray-700 rounded-full" /></div>
            <div className="sticky top-0 bg-[var(--surface)] border-b border-[var(--border)] p-5 flex items-center justify-between">
              <h2 className="text-xl font-semibold">{t('sell.title')}</h2>
              <button onClick={() => setSellModalOpen(false)}
                className="p-2 hover:bg-[var(--fill)] rounded-lg transition-colors">
                <X size={20} />
              </button>
            </div>
            
            <form onSubmit={confirmSell} className="p-5 space-y-4">
              <p className="text-sm text-[var(--text-muted)]">{productToSell.name}</p>
              
              
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">{t('form.quantity')}</label>
                  {/* Stepper − / + così è chiaro che si può vendere PIÙ di uno di un gruppo (es. 14 di 29). */}
                  <div className="flex items-stretch gap-2">
                    <button type="button" aria-label="-"
                      onClick={() => setSellQuantity(q => String(Math.max(1, (parseInt(q) || 1) - 1)))}
                      className="w-10 shrink-0 rounded-xl bg-[var(--surface-2)] border border-[var(--border-2)] text-lg font-black text-[var(--text)] hover:bg-[var(--fill)] active:scale-95 transition disabled:opacity-40"
                      disabled={(parseInt(sellQuantity) || 1) <= 1}>−</button>
                    <input type="number" min="1" max={productToSell.maxQty} inputMode="numeric"
                      value={sellQuantity}
                      onChange={(e: any) => { const n = parseInt(e.target.value); setSellQuantity(!n ? '' : String(Math.min(productToSell!.maxQty, Math.max(1, n)))); }}
                      className="w-full text-center bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm font-bold focus:border-[#8397aa] outline-none" />
                    <button type="button" aria-label="+"
                      onClick={() => setSellQuantity(q => String(Math.min(productToSell!.maxQty, (parseInt(q) || 1) + 1)))}
                      className="w-10 shrink-0 rounded-xl bg-[var(--surface-2)] border border-[var(--border-2)] text-lg font-black text-[var(--text)] hover:bg-[var(--fill)] active:scale-95 transition disabled:opacity-40"
                      disabled={(parseInt(sellQuantity) || 1) >= productToSell.maxQty}>+</button>
                  </div>
                  <div className="flex items-center justify-between mt-1">
                    <p className="text-[10px] text-[var(--text-soft)]">{t('sell.maxAvailable')}: {productToSell.maxQty}</p>
                    {productToSell.maxQty > 1 && (
                      <button type="button" onClick={() => setSellQuantity(String(productToSell!.maxQty))}
                        className="text-[10px] font-bold text-[#8397aa] hover:underline">{lang === 'en' ? 'All' : 'Tutti'}</button>
                    )}
                  </div>
                </div>
                <div>
                  <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">{t('sell.totalPrice')}</label>
                  <input type="number" step="0.01" required value={sellPrice}
                    onChange={(e: any) => setSellPrice(e.target.value)}
                    className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm focus:border-[#8397aa] outline-none" />
                </div>
              </div>
              
              <div>
                <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">{t('sell.platform')}</label>
                <select value={sellPlatform} onChange={(e: any) => setSellPlatform(e.target.value)}
                  className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm focus:border-[#8397aa] outline-none">
                  <option value="Vinted">Vinted</option>
                  <option value="Subito">Subito</option>
                  <option value="StockX">StockX (12% fee)</option>
                  <option value="eBay">eBay</option>
                  <option value="Privato">{t('sell.platformPrivate')}</option>
                </select>
              </div>
              
              <div>
                <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">{t('sell.paymentMethod')}</label>
                <select value={sellPaymentMethod} onChange={(e: any) => setSellPaymentMethod(e.target.value)}
                  className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm focus:border-[#8397aa] outline-none">
                  <option value="Nessuna Fee (Contanti/Bonifico)">{t('sell.noFee')}</option>
                  <option value="PayPal Beni e Servizi">{t('sell.paypal')}</option>
                </select>
              </div>

              {/* Identificativo cliente (facoltativo): nome, @social, codice… — idea utente */}
              <div>
                <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2 flex items-center gap-1.5"><Users size={11} /> Cliente <span className="font-normal text-[var(--text-faint)] normal-case tracking-normal">(facoltativo)</span></label>
                <input type="text" value={sellCustomer} onChange={e => setSellCustomer(e.target.value)} placeholder="Nome, @social o codice cliente…" maxLength={120}
                  className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm focus:border-[#8397aa] outline-none" />
              </div>

              {/* Costi extra alla vendita (scatola, etichetta spedizione, dogana…): tendina con
                  voci modificabili; la loro somma viene SOTTRATTA dal ricavo. */}
              <div className="bg-[var(--surface-2)] rounded-xl overflow-hidden">
                <button type="button" onClick={() => setSellExtraOpen(o => !o)}
                  className="w-full flex items-center justify-between p-3 text-left">
                  <span className="text-xs font-bold text-[var(--text-soft)] flex items-center gap-1.5">
                    <Package size={13} /> Costi extra <span className="font-normal text-[var(--text-faint)] hidden sm:inline">(scatola, spedizione, dogana…)</span>
                  </span>
                  {(() => { const ex = sellExtraCosts.reduce((a, c) => a + (parseFloat(c.amount) || 0), 0); return (
                    <span className="flex items-center gap-1.5">
                      <span className={`text-xs font-bold ${ex > 0 ? 'text-red-400' : 'text-[#8397aa]'}`}>{ex > 0 ? `-${ex.toFixed(2)}€` : 'Aggiungi'}</span>
                      <ChevronDown size={14} className={`text-[var(--text-faint)] transition-transform ${sellExtraOpen ? 'rotate-180' : ''}`} />
                    </span>
                  ); })()}
                </button>
                {sellExtraOpen && (
                  <div className="px-3 pb-3 space-y-2">
                    {sellExtraCosts.map((c, i) => (
                      <div key={i} className="flex gap-2">
                        <input type="text" value={c.desc} placeholder="Descrizione (es. Scatola)"
                          onChange={(e: any) => setSellExtraCosts(arr => arr.map((x, j) => j === i ? { ...x, desc: e.target.value } : x))}
                          className="flex-1 min-w-0 bg-[var(--surface)] border border-[var(--border-2)] rounded-lg p-2 text-xs outline-none focus:border-[#8397aa]" />
                        <input type="number" step="0.01" value={c.amount} placeholder="€"
                          onChange={(e: any) => setSellExtraCosts(arr => arr.map((x, j) => j === i ? { ...x, amount: e.target.value } : x))}
                          className="w-20 shrink-0 bg-[var(--surface)] border border-[var(--border-2)] rounded-lg p-2 text-xs outline-none focus:border-[#8397aa]" />
                        <button type="button" onClick={() => setSellExtraCosts(arr => arr.filter((_, j) => j !== i))}
                          className="w-9 shrink-0 flex items-center justify-center rounded-lg bg-red-500/10 text-red-400 hover:bg-red-500/20"><X size={14} /></button>
                      </div>
                    ))}
                    <button type="button" onClick={() => setSellExtraCosts(arr => [...arr, { desc: '', amount: '' }])}
                      className="w-full py-2 rounded-lg border border-dashed border-[var(--border-2)] text-xs font-bold text-[#8397aa] hover:bg-[#8397aa]/10 flex items-center justify-center gap-1.5">
                      <Plus size={13} /> Aggiungi costo
                    </button>
                  </div>
                )}
              </div>

              <div className="bg-[var(--surface-2)] p-3 rounded-xl space-y-1.5">
                <div className="flex justify-between text-xs">
                  <span className="text-[var(--text-soft)]">{t('sell.feesCalc')}</span>
                  <span className="font-bold text-red-400">-{sellFees}€</span>
                </div>
                {(() => { const ex = sellExtraCosts.reduce((a, c) => a + (parseFloat(c.amount) || 0), 0); return ex > 0 ? (
                  <div className="flex justify-between text-xs">
                    <span className="text-[var(--text-soft)]">Costi extra</span>
                    <span className="font-bold text-red-400">-{ex.toFixed(2)}€</span>
                  </div>
                ) : null; })()}
                {productToSell?.purchasePrice && sellPrice && (() => {
                  const qty = parseInt(sellQuantity) || 1;
                  const totalCost = productToSell.purchasePrice! * qty;
                  const saleTotal = parseFloat(sellPrice) || 0;
                  const feesNum = parseFloat(sellFees) || 0;
                  const extraNum = sellExtraCosts.reduce((a, c) => a + (parseFloat(c.amount) || 0), 0);
                  const profit = saleTotal - totalCost - feesNum - extraNum;
                  const margin = totalCost > 0 ? (profit / totalCost * 100) : 0;
                  return (
                    <>
                      <div className="flex justify-between text-xs border-t border-[var(--border-2)] pt-1.5">
                        <span className="text-[var(--text-soft)]">{t('sell.expectedProfit')}</span>
                        <span className={`font-bold ${profit >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                          {profit >= 0 ? '+' : ''}{profit.toFixed(2)}€
                        </span>
                      </div>
                      <div className="flex justify-between text-xs">
                        <span className="text-[var(--text-soft)]">{t('sell.margin')}</span>
                        <span className={`font-bold ${margin >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                          {margin >= 0 ? '+' : ''}{margin.toFixed(1)}%
                        </span>
                      </div>
                    </>
                  );
                })()}
              </div>

              {/* Tracking spedizione (opzionale) — la spedizione al compratore */}
              <div className="border-t border-[var(--border-2)] pt-4">
                <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest flex items-center gap-1.5 mb-2">
                  <Truck size={12} /> {t('sell.shipTracking')} <span className="text-[var(--text-faint)] normal-case font-normal">({t('form.optional')})</span>
                </label>
                <div className="grid grid-cols-2 gap-3">
                  <input type="text" value={sellTrackingCode} onChange={(e: any) => setSellTrackingCode(e.target.value)}
                    placeholder={t('sell.trackingCode')}
                    className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm focus:border-[#8397aa] outline-none" />
                  <select value={sellTrackingCarrier} onChange={(e: any) => setSellTrackingCarrier(e.target.value)}
                    className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm focus:border-[#8397aa] outline-none">
                    {['Auto','BRT','GLS','Poste Italiane','SDA','DHL','UPS','FedEx','TNT','Amazon Logistics','Nexive'].map(c => (
                      <option key={c} value={c}>{c === 'Auto' ? t('sell.autoDetect') : c}</option>
                    ))}
                  </select>
                </div>
                <p className="text-[10px] text-[var(--text-faint)] mt-1.5">{t('sell.trackingHint')}</p>
              </div>

              <button type="submit"
                className="w-full bg-green-600 hover:bg-green-500 py-3 rounded-xl font-bold transition-colors">
                {t('sell.confirm')}
              </button>
            </form>
          </div>
        </div>
      )}
      
      {/* ========== MODALE: MODIFICA PRODOTTO ========== */}
      {editModalOpen && productToEdit && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-end sm:items-center justify-center z-50 p-0 sm:p-4" {...swipeBack(() => setEditModalOpen(false))}>
          <div className="bg-[var(--surface)] border-t sm:border border-[var(--border-2)] rounded-t-3xl sm:rounded-3xl w-full max-w-md max-h-[92vh] overflow-y-auto">
            <div className="flex justify-center pt-3 pb-1 sm:hidden"><div className="w-10 h-1 bg-gray-700 rounded-full" /></div>
            <div className="sticky top-0 bg-[var(--surface)] border-b border-[var(--border)] p-5 flex items-center justify-between gap-3">
              <h2 className="text-xl font-semibold shrink-0">{t('form.editTitle')}</h2>
              <div className="flex items-center gap-2 min-w-0">
                {/* Etichetta lotto: si vede SOLO qui (in alto a destra) — idea utente */}
                {productToEdit?.lotName && (
                  <span className="text-[10px] font-bold px-2.5 py-1 rounded-full bg-[#8397aa]/15 text-[#8397aa] flex items-center gap-1.5 truncate" title={productToEdit.lotName}>
                    <Layers size={11} className="shrink-0" /> <span className="truncate">Lotto: {productToEdit.lotName}</span>
                  </span>
                )}
                <button onClick={() => setEditModalOpen(false)}
                  className="p-2 hover:bg-[var(--fill)] rounded-lg transition-colors shrink-0">
                  <X size={20} />
                </button>
              </div>
            </div>
            
            <form onSubmit={handleSaveEdit} className="p-5 space-y-4">
              {/* Scarpe: niente brand, solo modello (coerente col form di aggiunta). */}
              <div className={`grid gap-3 ${productToEdit?.category === 'Scarpe' ? 'grid-cols-1' : 'grid-cols-2'}`}>
                {productToEdit?.category !== 'Scarpe' && (
                  <div>
                    <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">{t('form.brand')}</label>
                    <input type="text" required value={editBrand}
                      onChange={(e: any) => setEditBrand(e.target.value)}
                      className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm focus:border-[#8397aa] outline-none" />
                  </div>
                )}
                <div>
                  <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">{t('form.name')}</label>
                  <input type="text" required value={editName}
                    onChange={(e: any) => setEditName(e.target.value)}
                    className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm focus:border-[#8397aa] outline-none" />
                </div>
              </div>
              {/* Sposta in un altro magazzino: cambiandolo, il prodotto eredita le percentuali soci del nuovo magazzino. */}
              {warehouses.filter((w: any) => !w.parentId).length > 1 && (
                <div>
                  <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">{t('form.warehouse')}</label>
                  <select value={editWarehouseId || baseWarehouse?.id || ''} onChange={(e: any) => setEditWarehouseId(e.target.value)}
                    className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm focus:border-[#8397aa] outline-none">
                    {warehouses.filter((w: any) => !w.parentId).map((w: any) => <option key={w.id} value={w.id}>{w.name}</option>)}
                  </select>
                  {productToEdit?.lotName && (
                    <p className="text-[11px] text-[#8397aa] font-semibold mt-1.5 flex items-center gap-1">
                      <Layers size={11} className="shrink-0" /> {t('sup.moveWholeLot').replace('{name}', productToEdit.lotName)}
                    </p>
                  )}
                </div>
              )}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">{t('form.size')}</label>
                  <input type="text" value={editSize}
                    onChange={(e: any) => setEditSize(e.target.value)}
                    className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm focus:border-[#8397aa] outline-none" />
                </div>
                <div>
                  <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">{t('mag.condition')}</label>
                  <input type="text" value={editCondition}
                    onChange={(e: any) => setEditCondition(e.target.value)}
                    className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm focus:border-[#8397aa] outline-none" />
                </div>
              </div>

              {/* Valutazione di mercato (fonte reale, anti-falsi) */}
              <div className="bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <TrendingUp size={15} className="text-[#8397aa] shrink-0" />
                    <span className="text-sm font-bold">{t('val.title')}</span>
                    {!hasFeature('stockx_pricing') && <PlanLock plan="Pro" />}
                  </div>
                  <button type="button" onClick={() => fetchValuation(productToEdit)} disabled={valLoading}
                    className="shrink-0 text-xs font-bold px-3 py-1.5 rounded-lg bg-[#8397aa] text-white hover:bg-[#6f8394] disabled:opacity-50 transition-colors flex items-center gap-1.5">
                    {valLoading ? <Loader2 size={13} className="animate-spin" /> : <Search size={13} />} {t('val.evaluate')}
                  </button>
                </div>
                {valuation && (
                  <div className="mt-3">
                    {valuation.configured === false ? (
                      <p className="text-[var(--text-soft)] text-xs">{t('val.notActive')}</p>
                    ) : valuation.value == null ? (
                      (valuation.source && /non connesso|non configurato|ricerca fallita|errore|billing|shipping|market-data|nessun prezzo|generico/i.test(valuation.source)) ? (
                        <p className="text-amber-400 text-xs">⚠️ {t('val.stockxUnavail')} — {valuation.source}. {isAdminUser ? t('val.linkAdmin') : t('val.sourceActivating')}</p>
                      ) : (
                        <p className="text-[var(--text-soft)] text-xs">{t('val.noQuote')}</p>
                      )
                    ) : (
                      <div className="flex items-end justify-between gap-2">
                        <div>
                          <p className="text-2xl font-bold num">{valuation.value}€</p>
                          <p className="text-[11px] text-[var(--text-faint)] mt-0.5">{valuation.source} · {valuation.sample} {t('val.comp')}{valuation.authenticatedOnly ? ' ' + t('val.authenticated') : ''}</p>
                        </div>
                        <span className={`text-[10px] font-bold px-2 py-1 rounded-full ${valuation.confidence === 'alta' ? 'bg-emerald-500/20 text-emerald-400' : valuation.confidence === 'media' ? 'bg-yellow-500/20 text-yellow-400' : 'bg-[var(--fill)] text-[var(--text-soft)]'}`}>{t('val.confidence')} {valuation.confidence}</span>
                      </div>
                    )}
                  </div>
                )}
              </div>
              <div>
                <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">{t('form.purchasePrice')}</label>
                <input type="number" step="0.01" required value={editPrice}
                  onChange={(e: any) => setEditPrice(e.target.value)}
                  className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm focus:border-[#8397aa] outline-none" />
              </div>

              {/* Fornitore: da CHI ho acquistato il pezzo (facoltativo) → alimenta la tabella "Fornitori". */}
              <div>
                <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">{t('sup.label')} <span className="text-[var(--text-faint)] normal-case font-normal">{t('sup.hint')}</span></label>
                <input type="text" value={editSupplier} onChange={e => setEditSupplier(e.target.value)} maxLength={120} placeholder={t('sup.placeholder')}
                  className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm focus:border-[#8397aa] outline-none" />
              </div>

              {/* Date (facoltative): acquisto sempre, vendita solo se venduto. min-w-0 = le input
                  date non "sforano" la colonna su iOS (prima si sovrapponevano). */}
              <div className="grid grid-cols-2 gap-3">
                <div className="min-w-0">
                  <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">{t('edit.purchaseDate')}</label>
                  <input type="date" value={editPurchaseDate} onChange={e => setEditPurchaseDate(e.target.value)}
                    className="w-full min-w-0 bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm focus:border-[#8397aa] outline-none appearance-none" />
                </div>
                {productToEdit.status === 'VENDUTO' && (
                  <div className="min-w-0">
                    <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">{t('edit.saleDate')}</label>
                    <input type="date" value={editSoldDate} onChange={e => setEditSoldDate(e.target.value)}
                      className="w-full min-w-0 bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm focus:border-[#8397aa] outline-none appearance-none" />
                  </div>
                )}
              </div>

              {/* Sell panic — prezzo di svendita rapida (solo articoli IN STOCK) */}
              {productToEdit.status !== 'VENDUTO' && (
                <div>
                  <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2 flex items-center gap-1.5"><TrendingDown size={12} className="text-amber-400" /> Prezzo svendita <span className="font-normal text-[var(--text-faint)] normal-case tracking-normal">(sell panic, facoltativo)</span></label>
                  <input type="number" step="0.01" value={editQuickSale} onChange={e => setEditQuickSale(e.target.value)} placeholder="A quanto lo daresti per venderlo SUBITO?"
                    className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm focus:border-[#8397aa] outline-none" />
                </div>
              )}

              {/* Modifica VENDITA — solo per prodotti già venduti (idea utente) */}
              {productToEdit.status === 'VENDUTO' && (
                <div className="bg-green-500/[0.06] border border-green-500/20 rounded-xl p-3.5 space-y-3">
                  <p className="text-[10px] font-bold text-green-400 uppercase tracking-widest flex items-center gap-1.5"><DollarSign size={11} /> Vendita</p>
                  <div className="grid grid-cols-2 gap-2.5">
                    <div>
                      <label className="text-[9px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-1.5">Prezzo vendita</label>
                      <input type="number" step="0.01" value={editSalePrice} onChange={e => setEditSalePrice(e.target.value)}
                        className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-lg p-2.5 text-sm focus:border-[#8397aa] outline-none" />
                    </div>
                    <div>
                      <label className="text-[9px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-1.5">Fee</label>
                      <input type="number" step="0.01" value={editSaleFees} onChange={e => setEditSaleFees(e.target.value)}
                        className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-lg p-2.5 text-sm focus:border-[#8397aa] outline-none" />
                    </div>
                    <div>
                      <label className="text-[9px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-1.5">Piattaforma</label>
                      <select value={editSalePlatform} onChange={e => setEditSalePlatform(e.target.value)}
                        className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-lg p-2.5 text-sm focus:border-[#8397aa] outline-none">
                        <option>Vinted</option><option>Subito</option><option>StockX</option><option>eBay</option><option>Privato</option>
                      </select>
                    </div>
                    <div>
                      <label className="text-[9px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-1.5">Cliente</label>
                      <input type="text" value={editSaleCustomer} onChange={e => setEditSaleCustomer(e.target.value)} maxLength={120} placeholder="facoltativo"
                        className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-lg p-2.5 text-sm focus:border-[#8397aa] outline-none" />
                    </div>
                  </div>
                </div>
              )}

              {/* Quantità pezzi: per lotti e gruppi multi-pezzo. Riduci = elimina i pezzi
                  in eccesso (i più recenti); aumenta = aggiunge nuovi pezzi. */}
              {(productToEdit.lotName || (productToEdit.quantity || 1) > 1) && (
                <div>
                  <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2 flex items-center gap-1.5">
                    <Layers size={11} className="text-[#8397aa]" />
                    {productToEdit.lotName ? `${t('edit.lotPieces')} "${productToEdit.lotName}"` : t('edit.qtyPieces')}
                  </label>
                  <input type="number" min="1" step="1" value={editQuantity}
                    onChange={(e: any) => setEditQuantity(e.target.value)}
                    className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm focus:border-[#8397aa] outline-none" />
                  <p className="text-[11px] text-[var(--text-faint)] mt-1.5">
                    {t('edit.current')}: {productToEdit.lotName ? editLotIds.length : (productToEdit.ids?.length || 1)} {t('edit.qtyHint')}
                  </p>
                </div>
              )}

              {/* Foto prodotto nel modale modifica */}
              <div className="border-t border-[var(--border-2)] pt-4">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <Camera size={14} className="text-[#9fb0bd]" />
                    <span className="text-sm font-bold">{t('edit.photos')}</span>
                  </div>
                  <span className="text-[10px] text-[var(--text-soft)]">{editPhotos.length}/5</span>
                </div>
                <div className="grid grid-cols-5 gap-2">
                  {editPhotos.map((photo, i) => (
                    <div key={i} className="relative aspect-square rounded-xl overflow-hidden bg-[var(--surface-2)] border border-[var(--border-2)]">
                      <img src={photo} alt={`foto ${i + 1}`} className="w-full h-full object-cover" />
                      <button type="button" onClick={() => removePhoto(i, true)}
                        className="absolute top-1 right-1 w-5 h-5 bg-black/70 rounded-full flex items-center justify-center hover:bg-red-600 transition-colors">
                        <X size={10} />
                      </button>
                    </div>
                  ))}
                  {editPhotos.length < 5 && (
                    <label className="aspect-square rounded-xl border-2 border-dashed border-gray-700 hover:border-[#8397aa] flex flex-col items-center justify-center cursor-pointer transition-colors">
                      <input type="file" accept="image/*" multiple className="hidden"
                        onChange={(e: any) => handlePhotoAdd(e, true)} />
                      <Camera size={16} className="text-[var(--text-soft)] mb-0.5" />
                      <span className="text-[9px] text-[var(--text-soft)]">{t('common.add')}</span>
                    </label>
                  )}
                </div>
              </div>

              {/* Pubblica nel marketplace — NASCOSTO finché il marketplace non è pubblico */}
              {MARKETPLACE_ENABLED && (
              <div className="border-t border-[var(--border-2)] pt-4">
                <div className="flex items-center justify-between gap-2 mb-2">
                  <div className="flex items-center gap-2">
                    <Store size={15} className="text-[#8397aa]" />
                    <span className="text-sm font-bold">{t('edit.marketplacePublic')}</span>
                    {!hasFeature('marketplace') && <PlanLock plan="Starter" />}
                  </div>
                  {editIsPublic && <span className="text-[10px] font-bold text-green-400 bg-green-500/15 px-2 py-0.5 rounded-full">{t('edit.public')}</span>}
                </div>
                <p className="text-[11px] text-[var(--text-faint)] mb-3">{t('edit.publishHint')}</p>
                <div className="grid grid-cols-2 gap-2 mb-2">
                  <input type="number" step="0.01" min="0" value={editPublicPrice}
                    onChange={(e: any) => setEditPublicPrice(e.target.value)}
                    placeholder={t('edit.publicPrice')}
                    className="bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl px-3 py-2 text-sm outline-none focus:border-[#8397aa]" />
                  <input type="number" step="0.01" min="0" value={editShippingCost}
                    onChange={(e: any) => setEditShippingCost(e.target.value)}
                    placeholder={t('edit.shippingCost')}
                    className="bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl px-3 py-2 text-sm outline-none focus:border-[#8397aa]" />
                </div>
                <div className="flex gap-2">
                  {editIsPublic ? (
                    <button type="button" onClick={() => savePublish(productToEdit, false)} disabled={isPublishing}
                      className="px-4 py-2 rounded-xl bg-[var(--fill)] border border-[var(--border-2)] text-sm font-bold disabled:opacity-50">{t('edit.withdraw')}</button>
                  ) : (
                    <button type="button" onClick={() => savePublish(productToEdit, true)} disabled={isPublishing}
                      className="px-4 py-2 rounded-xl bg-[#8397aa] text-white text-sm font-bold disabled:opacity-50">
                      {isPublishing ? <Loader2 size={15} className="animate-spin" /> : t('mag.publish')}
                    </button>
                  )}
                </div>
              </div>
              )}

              {/* Quote del team nel modale di modifica */}
              {(() => {
                const currentTeam = teamData.find((t: any) => t.warehouseId === productToEdit?.warehouseId);
                if (!currentTeam || currentTeam.members.length <= 1) return null;
                return (
                  <div className="border-t border-[var(--border-2)] pt-4">
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-2">
                        <Users size={14} className="text-blue-400" />
                        <span className="text-sm font-bold">{t('form.teamShares')}</span>
                      </div>
                      {!isEditShared ? (
                        <button type="button"
                          onClick={() => {
                            setIsEditShared(true);
                            setEditShares(currentTeam.members.map((m: any) => ({
                              userId: m.userId, name: m.name, percentage: m.percentage,
                            })));
                          }}
                          className="text-xs text-[var(--text)] hover:text-[#9fb0bd] font-bold transition-colors">
                          {t('form.changePercent')}
                        </button>
                      ) : (
                        <button type="button"
                          onClick={() => { setIsEditShared(false); setEditShares([]); }}
                          className="text-xs text-[var(--text-soft)] hover:text-[var(--text)] font-bold transition-colors">
                          {t('form.restoreDefault')}
                        </button>
                      )}
                    </div>
                    {!isEditShared ? (
                      <div className="space-y-2">
                        {currentTeam.members.map((m: any) => (
                          <div key={m.userId} className="flex items-center gap-3 bg-[var(--surface-2)] p-3 rounded-xl">
                            <span className="font-bold text-sm flex-1">{m.name}</span>
                            <span className="text-[var(--text-muted)] text-sm font-bold w-12 text-right">{m.percentage}%</span>
                          </div>
                        ))}
                        <p className="text-[10px] text-[var(--text-faint)] mt-1">{t('form.teamDefaultHint')}</p>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {editShares.map((s: any, i: number) => (
                          <div key={s.userId} className="flex items-center gap-3 bg-[var(--surface-2)] p-3 rounded-xl">
                            <span className="font-bold text-sm flex-1">{s.name}</span>
                            <input type="number" min="0" max="100" value={s.percentage}
                              onChange={(e: any) => {
                                const ns = [...editShares];
                                ns[i].percentage = e.target.value;
                                setEditShares(ns);
                              }}
                              className="w-20 bg-[var(--surface)] border border-[var(--border)] rounded-lg px-3 py-1.5 text-sm text-right" />
                            <span className="text-[var(--text-soft)] text-xs">%</span>
                          </div>
                        ))}
                        <p className={`text-[10px] mt-1 font-bold ${
                          Math.round(editShares.reduce((s, x) => s + (Number(x.percentage) || 0), 0)) === 100
                            ? 'text-green-500' : 'text-yellow-500'
                        }`}>
                          {t('form.total')}: {editShares.reduce((s, x) => s + (Number(x.percentage) || 0), 0).toFixed(0)}% {t('form.mustBe100')}
                        </p>
                      </div>
                    )}
                  </div>
                );
              })()}

              <div className="flex gap-3">
                <button type="submit" disabled={isSaving}
                  className="flex-1 bg-[#8397aa] hover:bg-[#9fb0bd] py-3 rounded-xl font-bold transition-colors disabled:opacity-50 flex items-center justify-center">
                  {isSaving ? <Loader2 className="animate-spin" size={20} /> : t('edit.save')}
                </button>
                <button type="button"
                  onClick={() => { setProductToDelete(productToEdit); setDeleteConfirmOpen(true); }}
                  className="p-3 bg-red-600/20 hover:bg-red-600/30 text-red-400 rounded-xl transition-colors">
                  <Trash2 size={20} />
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ========== MODALE: 2FA SETUP ========== */}
      {twoFaSetupOpen && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50 p-4" {...swipeBack(() => { setTwoFaSetupOpen(false); setTwoFaBackupCodes(null); setTwoFaCode(''); })}>
          <div className="bg-[var(--surface)] border border-[var(--border)] rounded-3xl w-full max-w-md max-h-[90vh] overflow-y-auto">
            <div className="border-b border-[var(--border-2)] p-5 flex items-center justify-between">
              <h2 className="text-xl font-semibold flex items-center gap-2">
                <Shield className="text-[var(--text)]" size={20} /> {t('twofa.enable')}
              </h2>
              <button onClick={() => { setTwoFaSetupOpen(false); setTwoFaBackupCodes(null); setTwoFaCode(''); }}
                className="p-2 hover:bg-[var(--fill)] rounded-lg transition-colors">
                <X size={20} />
              </button>
            </div>
            
            <div className="p-5 space-y-4">
              {!twoFaBackupCodes ? (
                <>
                  <div className="space-y-2 text-sm text-[var(--text-muted)]">
                    <p>{t('twofa.step1')} <span className="text-[var(--text)] font-bold">Google Authenticator</span> {t('twofa.or')} <span className="text-[var(--text)] font-bold">Authy</span></p>
                    <p>{t('twofa.step2')}</p>
                    <p>{t('twofa.step3')}</p>
                  </div>
                  
                  {twoFaQR && (
                    <div className="bg-white p-4 rounded-2xl flex items-center justify-center">
                      <img src={twoFaQR} alt="QR 2FA" className="w-48 h-48" />
                    </div>
                  )}
                  
                  <div>
                    <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">{t('twofa.codeFromApp')}</label>
                    <input type="text" inputMode="numeric" value={twoFaCode}
                      onChange={(e: any) => setTwoFaCode(e.target.value)}
                      placeholder="000000" maxLength={6}
                      className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-center font-mono text-2xl tracking-widest focus:border-[#8397aa] outline-none" />
                  </div>
                  
                  <button onClick={handle2FAVerify} disabled={twoFaLoading || twoFaCode.length !== 6}
                    className="w-full bg-[#8397aa] hover:bg-[#9fb0bd] py-3 rounded-xl font-bold transition-colors disabled:opacity-50 flex items-center justify-center">
                    {twoFaLoading ? <Loader2 className="animate-spin" size={20} /> : t('twofa.enable')}
                  </button>
                </>
              ) : (
                <>
                  <div className="bg-green-500/10 border border-green-500/30 rounded-xl p-4">
                    <p className="font-bold text-green-400 mb-1 flex items-center gap-2">
                      <CheckCircle size={16} /> {t('twofa.activated')}
                    </p>
                    <p className="text-xs text-gray-300">{t('twofa.saveCodes')}</p>
                  </div>

                  <div className="bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-4">
                    <p className="text-xs font-bold text-[var(--text-soft)] mb-3 uppercase tracking-widest">{t('twofa.backupCodes')}</p>
                    <div className="grid grid-cols-2 gap-2 font-mono text-sm">
                      {twoFaBackupCodes.map((c: string, i: number) => (
                        <div key={i} className="bg-[var(--surface)] p-2 rounded text-center">{c}</div>
                      ))}
                    </div>
                    <button onClick={() => {
                      navigator.clipboard.writeText(twoFaBackupCodes.join('\n'));
                      showToast(t('twofa.codesCopied'));
                    }}
                      className="mt-3 w-full bg-[var(--fill)] hover:bg-[var(--fill)] py-2 rounded-lg text-xs font-bold transition-colors flex items-center justify-center gap-2">
                      <Copy size={12} /> {t('twofa.copyAll')}
                    </button>
                  </div>

                  <p className="text-xs text-yellow-400 bg-yellow-500/10 p-3 rounded-xl">
                    {t('twofa.onceWarning')}
                  </p>

                  <button onClick={() => { setTwoFaSetupOpen(false); setTwoFaBackupCodes(null); setTwoFaCode(''); }}
                    className="w-full bg-[#8397aa] hover:bg-[#9fb0bd] py-3 rounded-xl font-bold transition-colors">
                    {t('twofa.savedCodes')}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ========== MODALE: DISABILITA 2FA ========== */}
      {twoFaDisableOpen && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-end sm:items-center justify-center z-50 p-0 sm:p-4" {...swipeBack(() => setTwoFaDisableOpen(false))}>
          <div className="bg-[var(--surface)] border-t sm:border border-[var(--border-2)] rounded-t-3xl sm:rounded-3xl w-full max-w-md p-6">
            <div className="flex justify-center mb-4 sm:hidden"><div className="w-10 h-1 bg-gray-700 rounded-full" /></div>
            <div className="flex items-center gap-2 mb-5">
              <Shield className="text-red-400" size={20} />
              <h3 className="text-lg font-semibold">{t('twofa.disableTitle')}</h3>
            </div>
            <div className="space-y-4">
              <div>
                <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">{t('twofa.accountPwd')}</label>
                <input type="password" value={twoFaDisablePwd}
                  onChange={e => setTwoFaDisablePwd(e.target.value)}
                  placeholder="••••••••"
                  className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-[var(--text)] outline-none focus:border-red-500" />
              </div>
              <div>
                <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">{t('twofa.codeFrom2fa')}</label>
                <input type="text" inputMode="numeric" value={twoFaDisableOtp}
                  onChange={e => setTwoFaDisableOtp(e.target.value)}
                  maxLength={6} placeholder="000000"
                  className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-[var(--text)] font-mono text-center text-2xl tracking-widest outline-none focus:border-red-500" />
              </div>
              <button onClick={confirm2FADisable}
                disabled={!twoFaDisablePwd || twoFaDisableOtp.length < 6}
                className="w-full bg-red-600 hover:bg-red-500 disabled:opacity-40 py-3 rounded-xl font-bold text-sm transition-colors">
                {t('twofa.confirmDisable')}
              </button>
              <button onClick={() => setTwoFaDisableOpen(false)}
                className="w-full bg-[var(--fill)] hover:bg-[var(--fill)] py-3 rounded-xl font-bold text-sm transition-colors">
                {t('common.cancel')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ========== BARRA BULK ACTIONS ========== */}
      {bulkMode && (
        <div className="fixed left-0 right-0 z-40 px-4 transition-all bottom-[calc(5rem+env(safe-area-inset-bottom)+8px)] lg:bottom-6">
          {(() => { const selCount = getBulkSelectedIds().length; return (
          <div className={`bg-[var(--surface)] border rounded-2xl p-3 flex items-center gap-2 shadow-2xl transition-all max-w-md mx-auto ${
            selCount > 0 ? 'border-[#8397aa]/50' : 'border-gray-700'
          }`}>
            <button onClick={() => { setBulkMode(false); setSelectedGroupKeys(new Set()); setSelectedPieceIds(new Set()); }}
              className="shrink-0 w-8 h-8 flex items-center justify-center rounded-lg hover:bg-white/10 text-gray-300 hover:text-white transition-colors">
              <X size={16} />
            </button>
            <button onClick={selectAllGroups}
              className="text-xs text-gray-300 hover:text-white font-bold transition-colors shrink-0 px-2">
              Tutti
            </button>
            <div className="flex-1 text-center">
              <span className="text-sm font-bold text-white">
                {selCount > 0
                  ? `${selCount} pezzi selezionati`
                  : 'Tieni premuto una card per selezionare'}
              </span>
            </div>
            {/* Condividi (solo admin per ora): vetrina pubblica dei prodotti selezionati */}
            {isAdminEmail(user?.email) && (
              <button
                onClick={shareSelected}
                disabled={selCount === 0 || shareCreating}
                title="Condividi selezionati"
                className="px-3 py-2 bg-[#8397aa]/25 hover:bg-[#8397aa]/35 text-[#b9a8f0] rounded-xl text-xs font-bold disabled:opacity-30 transition-colors">
                {shareCreating ? <Loader2 size={14} className="animate-spin" /> : <Share2 size={14} />}
              </button>
            )}
            <button
              onClick={() => setBulkDeleteConfirmOpen(true)}
              disabled={selCount === 0}
              className="px-3 py-2 bg-red-600/20 hover:bg-red-600/30 text-red-400 rounded-xl text-xs font-bold disabled:opacity-30 transition-colors">
              <Trash2 size={14} />
            </button>
            <button
              onClick={() => setBulkSellOpen(true)}
              disabled={selCount === 0}
              className="px-4 py-2 bg-green-600 hover:bg-green-500 text-white rounded-xl text-xs font-bold disabled:opacity-30 transition-colors flex items-center gap-1.5">
              <DollarSign size={14} /> Vendi
            </button>
          </div>
          ); })()}
        </div>
      )}

      {/* ========== MODALE: BULK VENDI ========== */}
      {bulkSellOpen && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-end sm:items-center justify-center z-50 p-0 sm:p-4" {...swipeBack(() => setBulkSellOpen(false))}>
          <div className="bg-[var(--surface)] border-t sm:border border-[var(--border-2)] rounded-t-3xl sm:rounded-3xl w-full max-w-md p-6">
            <div className="flex justify-center mb-4 sm:hidden"><div className="w-10 h-1 bg-gray-700 rounded-full" /></div>
            <h2 className="text-xl font-semibold mb-1">Vendi in Blocco</h2>
            <p className="text-xs text-[var(--text-soft)] mb-5">
              {getBulkSelectedIds().length} prodotti — inserisci il <b className="text-[var(--text)]">prezzo TOTALE</b> di vendita: l'app lo divide tra i pezzi.
            </p>
            <form onSubmit={handleBulkSell} className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">Prezzo TOTALE €</label>
                  <input type="number" step="0.01" required value={bulkSellPrice}
                    onChange={e => setBulkSellPrice(e.target.value)}
                    className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm focus:border-[#8397aa] outline-none" />
                </div>
                <div>
                  <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">Fees TOTALI €</label>
                  <input type="number" step="0.01" value={bulkSellFees}
                    onChange={e => setBulkSellFees(e.target.value)}
                    className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm focus:border-[#8397aa] outline-none" />
                </div>
              </div>
              {(() => {
                const n = getBulkSelectedIds().length || 1;
                const tot = parseFloat(bulkSellPrice) || 0;
                return tot > 0 ? (
                  <p className="text-xs text-[var(--text-soft)] -mt-1">
                    = <b className="text-[var(--teal)] num">{(tot / n).toFixed(2)}€</b> a pezzo ({n} pezzi)
                  </p>
                ) : null;
              })()}
              <div>
                <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">Piattaforma</label>
                <select value={bulkSellPlatform} onChange={e => setBulkSellPlatform(e.target.value)}
                  className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm focus:border-[#8397aa] outline-none">
                  <option>Vinted</option><option>Subito</option><option>StockX</option>
                  <option>eBay</option><option>Privato</option>
                </select>
              </div>
              <div className="flex gap-3 pt-1">
                <button type="button" onClick={() => setBulkSellOpen(false)}
                  className="flex-1 bg-[var(--fill)] hover:bg-[var(--fill)] py-3 rounded-xl font-bold text-sm transition-colors">
                  Annulla
                </button>
                <button type="submit" disabled={isBulkProcessing}
                  className="flex-1 bg-green-600 hover:bg-green-500 disabled:opacity-50 py-3 rounded-xl font-bold text-sm transition-colors flex items-center justify-center">
                  {isBulkProcessing ? <Loader2 className="animate-spin" size={18} /> : `Conferma ${getBulkSelectedIds().length} vendite`}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ========== MODALE: BULK ELIMINA ========== */}
      {bulkDeleteConfirmOpen && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-end sm:items-center justify-center z-50 p-0 sm:p-4" {...swipeBack(() => setBulkDeleteConfirmOpen(false))}>
          <div className="bg-[var(--surface)] border-t sm:border border-[var(--border-2)] rounded-t-3xl sm:rounded-3xl w-full max-w-sm p-6">
            <div className="flex justify-center mb-4 sm:hidden"><div className="w-10 h-1 bg-gray-700 rounded-full" /></div>
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-red-500/20 flex items-center justify-center shrink-0">
                <Trash2 className="text-red-400" size={20} />
              </div>
              <div>
                <h3 className="font-semibold text-base">Elimina {getBulkSelectedIds().length} prodotti</h3>
                <p className="text-xs text-[var(--text-soft)]">Azione irreversibile</p>
              </div>
            </div>
            <div className="flex gap-3">
              <button onClick={() => setBulkDeleteConfirmOpen(false)}
                className="flex-1 bg-[var(--fill)] hover:bg-[var(--fill)] py-3 rounded-xl font-bold text-sm transition-colors">
                Annulla
              </button>
              <button onClick={handleBulkDelete} disabled={isBulkProcessing}
                className="flex-1 bg-red-600 hover:bg-red-500 disabled:opacity-50 py-3 rounded-xl font-bold text-sm transition-colors flex items-center justify-center">
                {isBulkProcessing ? <Loader2 className="animate-spin" size={18} /> : 'Elimina'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ========== MODALE: IMPORT EXCEL ========== */}
      {importOpen && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-end sm:items-center justify-center z-50 p-0 sm:p-4" {...swipeBack(() => setImportOpen(false))}>
          <div className="bg-[var(--surface)] border-t sm:border border-[var(--border-2)] rounded-t-3xl sm:rounded-3xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex justify-center pt-3 pb-1 sm:hidden"><div className="w-10 h-1 bg-gray-700 rounded-full" /></div>
            <div className="sticky top-0 bg-[var(--surface)] border-b border-[var(--border)] p-5 flex items-center justify-between z-10">
              <h2 className="text-xl font-semibold flex items-center gap-2">
                <Download size={20} className="text-[var(--text)]" /> Importa da Excel
              </h2>
              <button onClick={() => { setImportOpen(false); setImportRows([]); setImportErrors([]); }}
                className="p-2 hover:bg-[var(--fill)] rounded-lg transition-colors"><X size={20} /></button>
            </div>
            <div className="p-5 space-y-4">
              {/* Abbinamento colonne: funziona con QUALSIASI Excel. Auto-rilevato, correggibile. */}
              {importHeaders.length > 0 ? (
                <div className="bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3">
                  <p className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest mb-2.5">Abbina le tue colonne</p>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
                    {[
                      { key: 'brand', label: 'Marca *' },
                      { key: 'name', label: 'Nome / Modello *' },
                      { key: 'price', label: 'Prezzo *' },
                      { key: 'size', label: 'Taglia' },
                      { key: 'condition', label: 'Condizione' },
                      { key: 'category', label: 'Reparto' },
                    ].map(f => (
                      <div key={f.key}>
                        <label className="text-[10px] text-[var(--text-soft)] block mb-1">{f.label}</label>
                        <select value={importMap[f.key] || ''} onChange={e => setImportField(f.key, e.target.value)}
                          className="w-full bg-[var(--surface)] border border-[var(--border-2)] rounded-lg px-2 py-1.5 text-xs outline-none focus:border-[#8397aa]">
                          <option value="">— nessuna —</option>
                          {importHeaders.map(h => {
                            const sample = (importRaw.find((r: any) => r[h] !== '' && r[h] != null) || {})[h];
                            const lbl = /^__EMPTY/.test(h) ? 'Colonna' : h;
                            return <option key={h} value={h}>{lbl}{sample != null ? ` — es. ${String(sample).slice(0, 16)}` : ''}</option>;
                          })}
                        </select>
                      </div>
                    ))}
                  </div>
                  <p className="text-[10px] text-[var(--text-faint)] mt-2.5">Le ho abbinate da solo dal tuo file: correggi se serve. <span className="text-[var(--text-soft)]">*</span> = obbligatorie.</p>
                </div>
              ) : (
                <div className="bg-blue-500/10 border border-blue-500/30 rounded-xl p-3 text-xs text-blue-400">
                  <p className="font-bold mb-1">Carica il TUO Excel: poi abbini le colonne ai campi dell'app.</p>
                  <button onClick={downloadImportTemplate} className="mt-1 text-[10px] underline hover:text-blue-300 transition-colors">Oppure scarica un template di esempio →</button>
                </div>
              )}

              <div className="flex items-center gap-3">
                <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest flex-1">
                  Reparto di default <span className="text-[var(--text-faint)]">(per righe senza colonna Categoria)</span>
                </label>
                <select value={importCategory} onChange={e => setImportCategory(e.target.value)}
                  className="bg-[var(--surface-2)] border border-[var(--border-2)] rounded-lg px-3 py-2 text-sm focus:border-[#8397aa] outline-none">
                  {userCategories.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>

              {/* Magazzino di destinazione (le sue percentuali vanno su tutti i prodotti importati). */}
              {warehouses.filter((w: any) => !w.parentId).length > 1 && (
                <div className="flex items-center gap-3">
                  <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest flex-1">{t('form.warehouse')}</label>
                  <select value={importWarehouseId || baseWarehouse?.id || ''} onChange={e => setImportWarehouseId(e.target.value)}
                    className="bg-[var(--surface-2)] border border-[var(--border-2)] rounded-lg px-3 py-2 text-sm focus:border-[#8397aa] outline-none">
                    {warehouses.filter((w: any) => !w.parentId).map((w: any) => <option key={w.id} value={w.id}>{w.name}</option>)}
                  </select>
                </div>
              )}

              {importRows.length > 0 && (
                <>
                  <p className="text-sm font-bold">
                    <span className="text-[var(--text)]">{importRows.length}</span> righe trovate
                    {importRows.filter(r => !r.brand || !r.name || !r.price).length > 0 && (
                      <span className="text-red-400 ml-2 text-xs">
                        ({importRows.filter(r => !r.brand || !r.name || !r.price).length} con errori — verranno saltate)
                      </span>
                    )}
                  </p>
                  <div className="overflow-x-auto rounded-xl border border-[var(--border-2)]">
                    <table className="w-full text-xs">
                      <thead className="bg-[var(--surface-2)] border-b border-[var(--border-2)]">
                        <tr>
                          {['Brand','Nome','Taglia','Cond.','Prezzo','Categoria'].map(h => (
                            <th key={h} className="px-3 py-2 text-left text-[var(--text-soft)] font-bold">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {importRows.slice(0, 12).map((r, i) => {
                          const hasErr = !r.brand || !r.name || !r.price;
                          return (
                            <tr key={i} className={`border-b border-gray-900 ${hasErr ? 'bg-red-500/5' : ''}`}>
                              <td className="px-3 py-2">{r.brand || <span className="text-red-400">⚠ mancante</span>}</td>
                              <td className="px-3 py-2 max-w-[120px] truncate">{r.name || <span className="text-red-400">⚠ mancante</span>}</td>
                              <td className="px-3 py-2 text-[var(--text-muted)]">{r.size || '—'}</td>
                              <td className="px-3 py-2 text-[var(--text-muted)]">{r.condition || 'DS'}</td>
                              <td className="px-3 py-2">{r.price > 0 ? `€${r.price}` : <span className="text-red-400">⚠ {String(r.price)}</span>}</td>
                              <td className="px-3 py-2 text-[var(--text-muted)]">{r.category || <span className="text-blue-400">{importCategory}</span>}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                    {importRows.length > 12 && (
                      <p className="p-3 text-xs text-[var(--text-soft)] text-center">...e altri {importRows.length - 12} prodotti</p>
                    )}
                  </div>
                </>
              )}

              {importErrors.length > 0 && (
                <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-3 space-y-1 max-h-32 overflow-y-auto">
                  {importErrors.map((err, i) => <p key={i} className="text-xs text-red-400">{err}</p>)}
                </div>
              )}

              <div className="flex gap-3 pt-1">
                <button onClick={() => { setImportOpen(false); setImportRows([]); setImportErrors([]); }}
                  className="flex-1 bg-[var(--fill)] hover:bg-[var(--fill)] py-3 rounded-xl font-bold text-sm transition-colors">
                  Annulla
                </button>
                <button onClick={confirmImport} disabled={isImporting || importRows.length === 0}
                  className="flex-1 bg-[#8397aa] hover:bg-[#9fb0bd] disabled:opacity-50 py-3 rounded-xl font-bold text-sm transition-colors flex items-center justify-center gap-2">
                  {isImporting
                    ? <><Loader2 className="animate-spin" size={16} /> Importazione...</>
                    : `Importa ${importRows.filter(r => r.brand && r.name && r.price > 0).length} prodotti`}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ========== MODALE: CREA LOTTO ========== */}
      {lotOpen && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-end sm:items-center justify-center z-50 p-0 sm:p-4" {...swipeBack(() => setLotOpen(false))}>
          <div className="bg-[var(--surface)] border-t sm:border border-[var(--border-2)] rounded-t-3xl sm:rounded-3xl w-full max-w-md">
            <div className="flex justify-center pt-3 pb-1 sm:hidden"><div className="w-10 h-1 bg-gray-700 rounded-full" /></div>
            <div className="p-5 border-b border-[var(--border)] flex items-center justify-between">
              <div>
                <h2 className="font-semibold text-base flex items-center gap-2">
                  <Layers size={16} className="text-[var(--text-muted)]" /> Crea Lotto
                </h2>
                <button type="button"
                  onClick={() => { setLotOpen(false); openAddForm(); }}
                  className="text-[11px] text-[var(--text-faint)] hover:text-[var(--text-muted)] transition-colors mt-0.5 flex items-center gap-1">
                  <Plus size={10} /> Torna a Prodotto Singolo
                </button>
              </div>
              <button onClick={() => setLotOpen(false)} className="p-2 hover:bg-[var(--fill)] rounded-xl transition-colors">
                <X size={18} className="text-[var(--text-muted)]" />
              </button>
            </div>
            <form onSubmit={handleCreateLot} className="p-5 space-y-4">

              {/* Magazzino (partnership): scegli dove va il lotto. Mostrato se hai più di un magazzino.
                  Le percentuali di quel magazzino vengono applicate a ogni pezzo del lotto. */}
              {warehouses.filter((w: any) => !w.parentId).length > 1 && (
                <div>
                  <label className="text-[10px] font-semibold text-[var(--text-soft)] uppercase tracking-[0.1em] block mb-2">{t('form.warehouse')}</label>
                  <div className="flex flex-wrap gap-2">
                    {warehouses.filter((w: any) => !w.parentId).map((w: any) => {
                      const isSel = (lotWarehouseId || baseWarehouse?.id) === w.id;
                      return (
                        <button key={w.id} type="button" onClick={() => setLotWarehouseId(w.id)}
                          className={`px-3 py-2 rounded-xl text-xs font-bold border transition-all ${isSel ? 'bg-[#8397aa]/10 border-[#8397aa] text-[var(--text)]' : 'bg-[var(--surface-2)] border-[var(--border-2)] text-[var(--text-soft)]'}`}>
                          {w.name}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Reparto */}
              <div>
                <label className="text-[10px] font-semibold text-[var(--text-soft)] uppercase tracking-[0.1em] block mb-2">Reparto</label>
                <div className="grid grid-cols-2 gap-2">
                  {userCategories.map(cat => (
                    <button key={cat} type="button" onClick={() => setLotCategory(cat)}
                      className={`p-2.5 rounded-xl border text-sm font-semibold transition-colors flex items-center gap-2 ${
                        lotCategory === cat ? 'bg-[var(--fill)] border-[var(--border-3)] text-[var(--text)]' : 'bg-[var(--surface-2)] border-[var(--border)] text-[var(--text-soft)]'
                      }`}>
                      <span>{getCategoryIcon(cat)}</span> {cat}
                    </button>
                  ))}
                </div>
              </div>

              {/* Nome lotto — con elenco dei lotti esistenti per aggiungerci pezzi */}
              {(() => {
                const existingLots = Array.from(new Set(products.filter((p: any) => p.lotName).map((p: any) => p.lotName as string)));
                const isAppending = existingLots.includes(lotName.trim());
                return (
                  <div>
                    <label className="text-[10px] font-semibold text-[var(--text-soft)] uppercase tracking-[0.1em] block mb-2">Nome Lotto</label>
                    <input required list="lotti-esistenti" value={lotName} onChange={e => setLotName(e.target.value)}
                      placeholder="Es: Bundle Pokemon Giugno, Lotto Scarpe Estate..."
                      className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm text-[var(--text)] placeholder-gray-600 focus:border-[var(--border-3)] outline-none" />
                    <datalist id="lotti-esistenti">
                      {existingLots.map(l => <option key={l} value={l} />)}
                    </datalist>
                    {isAppending ? (
                      <p className="text-[11px] text-[#8397aa] font-semibold mt-1.5 flex items-center gap-1"><Layers size={11} /> Lotto esistente: i pezzi verranno aggiunti (numerazione continua)</p>
                    ) : existingLots.length > 0 ? (
                      <p className="text-[11px] text-[var(--text-faint)] mt-1.5">Suggerimento: scegli un lotto esistente per aggiungerci altri pezzi</p>
                    ) : null}
                  </div>
                );
              })()}

              {/* Prezzo totale + numero pezzi */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] font-semibold text-[var(--text-soft)] uppercase tracking-[0.1em] block mb-2">Prezzo Totale €</label>
                  <input required type="number" min="0.01" step="0.01" value={lotTotal} onChange={e => setLotTotal(e.target.value)}
                    placeholder="300"
                    className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm text-[var(--text)] placeholder-gray-600 focus:border-[var(--border-3)] outline-none" />
                </div>
                <div>
                  <label className="text-[10px] font-semibold text-[var(--text-soft)] uppercase tracking-[0.1em] block mb-2">N° Articoli</label>
                  <input required type="number" min="2" max="200" step="1" value={lotQty} onChange={e => setLotQty(e.target.value)}
                    placeholder="10"
                    className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm text-[var(--text)] placeholder-gray-600 focus:border-[var(--border-3)] outline-none" />
                </div>
              </div>

              {/* Preview costo per articolo */}
              {lotTotal && lotQty && parseFloat(lotTotal) > 0 && parseInt(lotQty) >= 2 && (
                <div className="bg-[var(--fill)] border border-[var(--border)] rounded-xl p-3 flex items-center justify-between">
                  <span className="text-[12px] text-[var(--text-soft)]">Costo per articolo</span>
                  <span className="font-semibold text-[var(--text)] text-sm">
                    {(parseFloat(lotTotal) / parseInt(lotQty)).toFixed(2)}€
                  </span>
                </div>
              )}

              {/* Brand (opzionale) */}
              <div>
                <label className="text-[10px] font-semibold text-[var(--text-soft)] uppercase tracking-[0.1em] block mb-2">Brand <span className="text-gray-700 normal-case font-normal">(opzionale)</span></label>
                <input value={lotBrand} onChange={e => setLotBrand(e.target.value)}
                  placeholder="Es: Pokémon, Nike, Rolex..."
                  className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm text-[var(--text)] placeholder-gray-600 focus:border-[var(--border-3)] outline-none" />
              </div>

              {/* Note */}
              <div>
                <label className="text-[10px] font-semibold text-[var(--text-soft)] uppercase tracking-[0.1em] block mb-2">Note <span className="text-gray-700 normal-case font-normal">(opzionale)</span></label>
                <input value={lotNotes} onChange={e => setLotNotes(e.target.value)}
                  placeholder="Es: acquistato da privato, condizioni miste..."
                  className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm text-[var(--text)] placeholder-gray-600 focus:border-[var(--border-3)] outline-none" />
              </div>

              {/* Foto del lotto (es. pagina del raccoglitore di carte): applicata a tutti i pezzi */}
              <div>
                <label className="text-[10px] font-semibold text-[var(--text-soft)] uppercase tracking-[0.1em] block mb-2">Foto del lotto <span className="text-gray-700 normal-case font-normal">(opzionale — es. la foto delle carte)</span></label>
                {lotPhotos[0] ? (
                  <div className="relative w-24 h-24 rounded-xl overflow-hidden border border-[var(--border-2)] bg-white">
                    <img src={lotPhotos[0]} alt="" className="w-full h-full object-cover" />
                    <button type="button" onClick={() => setLotPhotos([])} className="absolute top-1 right-1 w-6 h-6 rounded-full bg-black/70 text-white flex items-center justify-center"><X size={13} /></button>
                  </div>
                ) : (
                  <label className="flex items-center justify-center gap-2 py-3 rounded-xl border border-dashed border-[var(--border-2)] text-[var(--text-soft)] text-sm cursor-pointer hover:border-[#8397aa] hover:text-[var(--text)] transition-colors">
                    <Camera size={16} /> Aggiungi foto
                    <input type="file" accept="image/*" className="hidden" onChange={onLotPhotoFile} />
                  </label>
                )}
              </div>

              <div className="flex gap-2 pt-1">
                <button type="button" onClick={() => setLotOpen(false)}
                  className="flex-1 py-3 rounded-xl border border-[var(--border-2)] text-sm text-[var(--text-muted)] hover:text-[var(--text)] transition-colors">
                  Annulla
                </button>
                <button type="submit" disabled={isCreatingLot || !lotCategory || !lotName || !lotTotal || !lotQty}
                  className="flex-1 py-3 rounded-xl bg-white text-black text-sm font-semibold hover:bg-gray-200 transition-colors disabled:opacity-40">
                  {isCreatingLot ? 'Creazione...' : `Crea ${lotQty || 0} Articoli`}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ========== MODALE: ELIMINA ACCOUNT (multi-step) ========== */}
      {deleteAccountStep > 0 && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-end sm:items-center justify-center z-[80] p-0 sm:p-4" {...swipeBack(() => setDeleteAccountStep(s => s > 1 ? s - 1 : 0))}>
          <div className="bg-[var(--surface)] border-t sm:border border-[var(--border-2)] rounded-t-3xl sm:rounded-3xl w-full max-w-md">
            <div className="flex justify-center pt-3 pb-1 sm:hidden"><div className="w-10 h-1 bg-gray-700 rounded-full" /></div>

            {/* STEP 1: Warning */}
            {deleteAccountStep === 1 && (
              <div className="p-6">
                <div className="flex items-center gap-3 mb-4">
                  <div className="w-10 h-10 rounded-full bg-red-500/15 flex items-center justify-center shrink-0">
                    <AlertTriangle size={20} className="text-red-400" />
                  </div>
                  <div>
                    <h3 className="font-semibold">{t('del.title')}</h3>
                    <p className="text-[11px] text-[var(--text-soft)]">{t('del.permanent')}</p>
                  </div>
                </div>
                <div className="bg-red-500/[0.06] border border-red-500/[0.15] rounded-xl p-4 mb-5 space-y-1.5">
                  {[t('del.item1'), t('del.item2'), t('del.item3'), t('del.item4'), t('del.item5')].map(item => (
                    <div key={item} className="flex items-start gap-2 text-[12px] text-red-300/70">
                      <span className="text-red-500 mt-0.5 shrink-0">×</span> {item}
                    </div>
                  ))}
                </div>
                <p className="text-[11px] text-[var(--text-faint)] mb-5">{t('del.partnersNote')}</p>
                <div className="flex gap-2">
                  <button onClick={() => setDeleteAccountStep(0)}
                    className="flex-1 py-3 rounded-xl border border-[var(--border-2)] text-sm text-[var(--text-muted)] hover:text-[var(--text)] transition-colors">
                    {t('common.cancel')}
                  </button>
                  <button onClick={() => setDeleteAccountStep(2)}
                    className="flex-1 py-3 rounded-xl bg-red-500/15 border border-red-500/30 text-red-400 text-sm font-semibold hover:bg-red-500/25 transition-colors">
                    {t('del.continue')}
                  </button>
                </div>
              </div>
            )}

            {/* STEP 2: Conferma email */}
            {deleteAccountStep === 2 && (
              <div className="p-6">
                <h3 className="font-semibold mb-1">{t('del.confirmEmail')}</h3>
                <p className="text-[12px] text-[var(--text-soft)] mb-4">{t('del.confirmEmailDesc')}</p>
                <p className="text-xs text-[var(--text-faint)] bg-[var(--fill)] border border-[var(--border)] rounded-xl p-3 mb-4 font-mono">{user?.email}</p>
                <input
                  value={deleteEmailConfirm}
                  onChange={e => setDeleteEmailConfirm(e.target.value)}
                  placeholder={t('del.emailPlaceholder')}
                  className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm focus:border-red-500/40 outline-none mb-4"
                  autoFocus
                />
                <div className="flex gap-2">
                  <button onClick={() => setDeleteAccountStep(1)}
                    className="flex-1 py-3 rounded-xl border border-[var(--border-2)] text-sm text-[var(--text-muted)] transition-colors">
                    {t('del.back')}
                  </button>
                  <button
                    onClick={() => {
                      if (deleteEmailConfirm.toLowerCase() !== user?.email?.toLowerCase()) {
                        showToast(t('del.emailMismatch'), 'err'); return;
                      }
                      setDeleteAccountStep(3);
                    }}
                    disabled={!deleteEmailConfirm}
                    className="flex-1 py-3 rounded-xl bg-red-500/15 border border-red-500/30 text-red-400 text-sm font-semibold disabled:opacity-40 transition-colors">
                    {t('del.continue')}
                  </button>
                </div>
              </div>
            )}

            {/* STEP 3: Inserisci password */}
            {deleteAccountStep === 3 && (
              <div className="p-6">
                <h3 className="font-semibold mb-1">{t('del.enterPwd')}</h3>
                <p className="text-[12px] text-[var(--text-soft)] mb-4">{t('del.enterPwdDesc')}</p>
                <input
                  type="password"
                  value={deletePasswordConfirm}
                  onChange={e => setDeletePasswordConfirm(e.target.value)}
                  placeholder={t('pwd.current')}
                  className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm focus:border-red-500/40 outline-none mb-4"
                  autoFocus
                />
                <div className="flex gap-2">
                  <button onClick={() => setDeleteAccountStep(2)}
                    className="flex-1 py-3 rounded-xl border border-[var(--border-2)] text-sm text-[var(--text-muted)] transition-colors">
                    {t('del.back')}
                  </button>
                  <button
                    onClick={() => { if (deletePasswordConfirm.length >= 6) setDeleteAccountStep(4); }}
                    disabled={deletePasswordConfirm.length < 6}
                    className="flex-1 py-3 rounded-xl bg-red-500/15 border border-red-500/30 text-red-400 text-sm font-semibold disabled:opacity-40 transition-colors">
                    {t('del.continue')}
                  </button>
                </div>
              </div>
            )}

            {/* STEP 4: Conferma finale */}
            {deleteAccountStep === 4 && (
              <div className="p-6">
                <div className="flex items-center justify-center mb-4">
                  <div className="w-14 h-14 rounded-full bg-red-500/10 flex items-center justify-center">
                    <Trash2 size={24} className="text-red-400" />
                  </div>
                </div>
                <h3 className="font-semibold text-center mb-1">{t('del.lastConfirm')}</h3>
                <p className="text-[12px] text-[var(--text-soft)] text-center mb-5">{t('del.noRecover')}</p>
                <label className="flex items-start gap-3 cursor-pointer mb-5 p-3 bg-red-500/[0.05] border border-red-500/[0.12] rounded-xl">
                  <input type="checkbox" checked={deleteCheckbox} onChange={e => setDeleteCheckbox(e.target.checked)}
                    className="mt-0.5 shrink-0 w-4 h-4 accent-red-500" />
                  <span className="text-[12px] text-[var(--text-muted)] leading-relaxed">
                    {t('del.checkbox')}
                  </span>
                </label>
                <div className="flex gap-2">
                  <button onClick={() => { setDeleteAccountStep(0); setDeleteEmailConfirm(''); setDeletePasswordConfirm(''); setDeleteCheckbox(false); }}
                    className="flex-1 py-3 rounded-xl border border-[var(--border-2)] text-sm text-[var(--text-muted)] transition-colors">
                    {t('common.cancel')}
                  </button>
                  <button onClick={handleDeleteAccount}
                    disabled={!deleteCheckbox || isDeletingAccount}
                    className="flex-1 py-3 rounded-xl bg-red-600 text-[var(--text)] text-sm font-semibold disabled:opacity-40 hover:bg-red-700 transition-colors">
                    {isDeletingAccount ? <Loader2 size={16} className="animate-spin mx-auto" /> : t('del.deleteBtn')}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ========== COOKIE BANNER ========== */}
      {!cookieConsent && (
        <div className="fixed bottom-0 left-0 right-0 z-[100] lg:bottom-6 lg:left-6 lg:right-auto lg:max-w-sm">
          <div className="bg-[var(--surface)] border border-[var(--border-2)] lg:rounded-2xl p-5 shadow-2xl border-t lg:border">
            <div className="flex items-start gap-3 mb-4">
              <div className="text-lg shrink-0">🍪</div>
              <div>
                <p className="text-sm font-semibold text-[var(--text)] mb-1">{t('cookie.title')}</p>
                <p className="text-[12px] text-[var(--text-soft)] leading-relaxed">
                  {t('cookie.bodyPre')} <span className="text-gray-300">{t('cookie.strictlyNecessary')}</span> {t('cookie.bodyPost')}{' '}
                  <button onClick={() => setPrivacyOpen(true)} className="text-[var(--text)] underline underline-offset-2 hover:no-underline">
                    {t('cookie.privacy')}
                  </button>
                </p>
              </div>
            </div>
            <div className="flex gap-2">
              <button onClick={() => setPrivacyOpen(true)}
                className="flex-1 py-2 rounded-xl border border-[var(--border-2)] text-xs text-[var(--text-muted)] hover:text-[var(--text)] transition-colors">
                {t('cookie.readAll')}
              </button>
              <button onClick={() => { localStorage.setItem('hq_cookie_consent', '1'); setCookieConsent(true); }}
                className="flex-1 py-2 rounded-xl bg-white text-black text-xs font-semibold hover:bg-gray-200 transition-colors">
                {t('cookie.accept')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ========== MODALE: PIANI & STRUMENTI PRO ========== */}
      {planModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={() => setPlanModalOpen(false)} {...swipeBack(() => setPlanModalOpen(false))}>
          <div className="bg-[var(--surface)] border border-[var(--border)] w-full sm:max-w-3xl sm:rounded-2xl rounded-t-2xl max-h-[92vh] flex flex-col overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="p-5 border-b border-[var(--border)] flex items-center justify-between shrink-0">
              <div className="flex items-center gap-2">
                <Sparkles className="text-[#8397aa]" size={20} />
                <h2 className="font-semibold text-base">{t('set.plansTitle')}</h2>
                <span className="text-[10px] uppercase font-bold bg-[var(--fill)] px-2 py-0.5 rounded-full">{myPlan}</span>
              </div>
              <button onClick={() => setPlanModalOpen(false)} className="p-2 hover:bg-[var(--fill)] rounded-xl transition-colors"><X size={18} /></button>
            </div>

            {/* Tabs — per ora solo "Piani". Gli strumenti Pro (Stock fermo/Trattative/
                Multi-canale) restano nel codice e si riattivano rimettendo le voci qui. */}
            <div className="flex gap-1.5 p-3 border-b border-[var(--border)] overflow-x-auto shrink-0" style={{ display: 'none' }}>
              {([['plans',t('plan.tabPlans')]] as [typeof proTab,string][]).map(([id,label]) => (
                <button key={id} onClick={() => setProTab(id)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold whitespace-nowrap transition-colors ${proTab === id ? 'bg-[#8397aa] text-white' : 'bg-[var(--fill)] text-[var(--text-soft)]'}`}>
                  {label}
                </button>
              ))}
            </div>

            <div className="p-4 overflow-y-auto">
              {/* TAB: PIANI */}
              {proTab === 'plans' && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {planCatalog.map(p => (
                    <div key={p.id} className={`rounded-2xl border p-4 ${p.id === myPlan ? 'border-[#8397aa] bg-[#8397aa]/5' : 'border-[var(--border-2)] bg-[var(--surface-2)]'}`}>
                      <div className="flex items-baseline justify-between">
                        <h3 className="font-bold text-lg">{p.name}</h3>
                        <span className="font-bold num">{p.priceMonthly === 0 ? t('plan.free') : `${p.priceMonthly}€`}<span className="text-[10px] text-[var(--text-faint)] font-normal">{p.priceMonthly === 0 ? '' : t('plan.perMonth')}</span></span>
                      </div>
                      <p className="text-[11px] text-[var(--text-soft)] mt-0.5">{p.tagline}</p>
                      <ul className="mt-3 space-y-1.5">
                        {p.highlights.map((h: string, i: number) => (
                          <li key={i} className="flex items-start gap-2 text-[11px] text-[var(--text-soft)]">
                            <CheckCircle size={13} className="text-[#8397aa] mt-0.5 shrink-0" /> <span>{h}</span>
                          </li>
                        ))}
                      </ul>
                      {p.id === myPlan ? (
                        <>
                          <p className="mt-3 text-center text-[10px] font-bold text-[#8397aa] uppercase">{t('set.currentPlan')}</p>
                          {p.priceMonthly > 0 && (
                            <button onClick={manageBilling} className="mt-2 w-full py-2 rounded-xl bg-[var(--fill)] border border-[var(--border-2)] text-xs font-bold text-[var(--text-soft)]">{t('plan.manageSub')}</button>
                          )}
                        </>
                      ) : p.priceMonthly > 0 && (
                        <button onClick={() => subscribeToPlan(p.id)} className="mt-3 w-full py-2.5 rounded-xl bg-[#8397aa] hover:bg-[#6f8394] text-white text-sm font-bold transition-colors">{t('plan.subscribe')}</button>
                      )}
                    </div>
                  ))}
                  {isAdminEmail(user?.email) && (
                    <p className="sm:col-span-2 text-[10px] text-[var(--text-faint)] text-center mt-1">{t('plan.adminNote')}</p>
                  )}
                </div>
              )}

              {/* TAB: RIPREZZAMENTO STOCK FERMO */}
              {proTab === 'repricing' && (
                !hasFeature('repricing') ? (
                  proLocked('repricing')
                ) : (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <p className="text-xs text-[var(--text-soft)]">{t('plan.repricingDesc')}</p>
                      <button onClick={loadRepricing} disabled={repricingLoading}
                        className="px-3 py-1.5 rounded-xl text-xs font-bold bg-[#8397aa] hover:bg-[#9fb0bd] text-white disabled:opacity-40">
                        {repricingLoading ? <Loader2 size={14} className="animate-spin" /> : t('plan.analyze')}
                      </button>
                    </div>
                    {repricingList && repricingList.length === 0 && <p className="text-xs text-center text-[var(--text-faint)] py-6">{t('plan.noStale')}</p>}
                    {repricingList && repricingList.map((r: any) => (
                      <div key={r.id} className="flex items-center justify-between bg-[var(--surface-2)] rounded-xl p-3">
                        <div className="min-w-0">
                          <p className="text-sm font-bold truncate">{fullName(r.brand, r.name)}</p>
                          <p className="text-[10px] text-[var(--text-faint)]">{r.daysInStock} {t('plan.daysWord')} · {t('plan.sizeWord')} {r.size}</p>
                        </div>
                        <div className="text-right shrink-0 ml-3">
                          <p className="text-sm font-bold text-[#8397aa] num">{r.suggestedPrice}€</p>
                          <p className="text-[10px] text-yellow-500">-{r.suggestedDiscount}%</p>
                        </div>
                      </div>
                    ))}
                  </div>
                )
              )}

              {/* TAB: ASSISTENTE TRATTATIVE */}
              {proTab === 'offer' && (
                !hasFeature('offer_assistant') ? (
                  proLocked('offer_assistant')
                ) : (
                  <div className="space-y-3">
                    <select value={offerProductId} onChange={e => setOfferProductId(e.target.value)}
                      className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-2.5 text-sm outline-none focus:border-[#8397aa]">
                      <option value="">{t('plan.chooseProduct')}</option>
                      {products.filter((p: any) => p.status === 'IN STOCK').map((p: any) => (
                        <option key={p.id} value={p.id}>{fullName(p.brand, p.name)} ({p.size})</option>
                      ))}
                    </select>
                    <div className="flex gap-2">
                      <input type="number" inputMode="decimal" value={offerAmount} onChange={e => setOfferAmount(e.target.value)} placeholder={t('plan.offerReceived')}
                        className="flex-1 bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-2.5 text-sm outline-none focus:border-[#8397aa]" />
                      <input type="number" inputMode="decimal" value={offerMargin} onChange={e => setOfferMargin(e.target.value)} placeholder={t('plan.minMargin')}
                        className="w-28 bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-2.5 text-sm outline-none focus:border-[#8397aa]" />
                    </div>
                    <button onClick={runOffer} disabled={offerLoading}
                      className="w-full py-2.5 rounded-xl text-sm font-bold bg-[#8397aa] hover:bg-[#9fb0bd] text-white disabled:opacity-40 flex items-center justify-center gap-2">
                      {offerLoading ? <Loader2 size={16} className="animate-spin" /> : t('plan.whatReply')}
                    </button>
                    {offerResult && (
                      <div className="space-y-2 bg-[var(--surface-2)] rounded-xl p-3">
                        <div className="flex items-center gap-2">
                          <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full ${offerResult.decision === 'accept' ? 'bg-green-500/15 text-green-400' : offerResult.decision === 'counter' ? 'bg-yellow-500/15 text-yellow-500' : 'bg-red-500/15 text-red-400'}`}>
                            {offerResult.decision === 'accept' ? t('plan.accept') : offerResult.decision === 'counter' ? `${t('plan.counter')} ${offerResult.counterPrice}€` : `${t('plan.rejectPropose')} ${offerResult.counterPrice}€)`}
                          </span>
                          <span className="text-[10px] text-[var(--text-faint)]">{t('plan.min')} {offerResult.minPrice}€ · {t('plan.margin')} {offerResult.offerMargin}€</span>
                        </div>
                        <p className="text-sm text-[var(--text)] bg-[var(--fill)] rounded-lg p-2.5">{offerResult.message}</p>
                        <div className="flex items-center justify-between">
                          <p className="text-[10px] text-[var(--text-faint)] italic">{offerResult.reasoning}</p>
                          <button onClick={() => { navigator.clipboard?.writeText(offerResult.message); showToast(t('plan.msgCopied')); }}
                            className="flex items-center gap-1 text-[10px] font-bold text-[#8397aa]"><Copy size={12} /> {t('plan.copy')}</button>
                        </div>
                      </div>
                    )}
                  </div>
                )
              )}

              {/* TAB: MULTI-CANALE */}
              {proTab === 'channels' && (
                !hasFeature('crossposting') ? (
                  proLocked('crossposting')
                ) : (
                  <div className="space-y-3">
                    <p className="text-xs text-[var(--text-soft)]">{t('plan.channelsDesc')}</p>
                    <select value={chProductId} onChange={e => setChProductId(e.target.value)}
                      className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-2.5 text-sm outline-none focus:border-[#8397aa]">
                      <option value="">{t('plan.chooseProduct')}</option>
                      {products.filter((p: any) => p.status === 'IN STOCK').map((p: any) => (
                        <option key={p.id} value={p.id}>{fullName(p.brand, p.name)} ({p.size})</option>
                      ))}
                    </select>
                    <div className="flex flex-wrap gap-2">
                      {['Vinted','eBay','Depop','Subito','Wallapop','StockX'].map(pl => {
                        const on = chSelected.includes(pl);
                        return (
                          <button key={pl} onClick={() => setChSelected(prev => on ? prev.filter(x => x !== pl) : [...prev, pl])}
                            className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-colors ${on ? 'bg-[#8397aa] text-white' : 'bg-[var(--fill)] text-[var(--text-soft)]'}`}>
                            {pl}
                          </button>
                        );
                      })}
                    </div>
                    <button onClick={saveChannels} disabled={chSaving}
                      className="w-full py-2.5 rounded-xl text-sm font-bold bg-[#8397aa] hover:bg-[#9fb0bd] text-white disabled:opacity-40 flex items-center justify-center gap-2">
                      {chSaving ? <Loader2 size={16} className="animate-spin" /> : <><Store size={15} /> {t('plan.saveChannels')}</>}
                    </button>
                  </div>
                )
              )}
            </div>
          </div>
        </div>
      )}

      {/* ========== MODALE: PRIVACY POLICY ========== */}
      {/* ===== MODALE GUIDA RAPIDA ===== */}
      {/* ========== MODALE: SUPPORTO CLIENTI IA (con escalation a operatore) ========== */}
      {supportOpen && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-end sm:items-center justify-center z-[110] p-0 sm:p-4" onClick={() => setSupportOpen(false)} {...swipeBack(() => setSupportOpen(false))}>
          <div className="bg-[var(--surface)] border-t sm:border border-[var(--border-2)] rounded-t-3xl sm:rounded-3xl w-full max-w-lg h-[85vh] sm:h-[600px] flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between p-5 border-b border-[var(--border)] shrink-0">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-xl bg-[#8397aa]/15 flex items-center justify-center"><HelpCircle size={18} className="text-[#8397aa]" /></div>
                <div>
                  <h2 className="font-semibold text-base leading-tight">{t('hdr.support')}</h2>
                  <p className="text-[11px] text-[var(--text-soft)]">Ti risponde l'assistente. Se serve, passa a un operatore.</p>
                </div>
              </div>
              <button onClick={() => setSupportOpen(false)} className="p-2 hover:bg-[var(--fill)] rounded-xl transition-colors"><X size={18} className="text-[var(--text-muted)]" /></button>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {supportMsgs.length === 0 && (
                <div className="text-center text-[13px] text-[var(--text-soft)] mt-8 px-6">
                  👋 Ciao! Chiedimi qualsiasi cosa su HQVault: come aggiungere prodotti, vendere, i piani, il tracking… Se non riesco a risolvere, ti metto in contatto con un operatore.
                </div>
              )}
              {supportMsgs.map((m, i) => (
                <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[82%] px-3.5 py-2.5 rounded-2xl text-[13.5px] leading-relaxed whitespace-pre-wrap ${m.role === 'user' ? 'bg-[#8397aa] text-white rounded-br-md' : 'bg-[var(--fill)] text-[var(--text)] rounded-bl-md'}`}>{m.content}</div>
                </div>
              ))}
              {supportLoading && <div className="flex justify-start"><div className="bg-[var(--fill)] px-3.5 py-2.5 rounded-2xl rounded-bl-md text-[13px] text-[var(--text-soft)]">sto scrivendo…</div></div>}
              {supportEscalated && (
                <div className="mt-2 p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-[12.5px] text-[var(--text)]">
                  ✅ <b>Richiesta passata a un operatore.</b> Ti risponderemo via email{user?.email ? ` a ${user.email}` : ''} al più presto.
                </div>
              )}
            </div>
            <div className="shrink-0 p-3 border-t border-[var(--border)] flex items-center gap-2" style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom))' }}>
              <input value={supportInput} onChange={e => setSupportInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendSupport(); } }}
                placeholder="Scrivi la tua domanda…"
                className="flex-1 bg-[var(--fill)] rounded-xl px-3.5 py-2.5 text-[14px] outline-none focus:ring-2 focus:ring-[#8397aa]/40" />
              <button onClick={sendSupport} disabled={supportLoading || !supportInput.trim()}
                className="w-10 h-10 rounded-xl bg-[#8397aa] text-white flex items-center justify-center disabled:opacity-40 transition-opacity shrink-0">
                <Send size={17} />
              </button>
            </div>
          </div>
        </div>
      )}

      {guideOpen && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-end sm:items-center justify-center z-[110] p-0 sm:p-4" onClick={() => setGuideOpen(false)} {...swipeBack(() => setGuideOpen(false))}>
          <div className="bg-[var(--surface)] border-t sm:border border-[var(--border-2)] rounded-t-3xl sm:rounded-3xl w-full max-w-xl max-h-[90vh] flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between p-5 border-b border-[var(--border)] shrink-0">
              <div>
                <h2 className="font-semibold text-base flex items-center gap-2"><BookOpen size={18} className="text-[#8397aa]" /> Guida rapida</h2>
                <p className="text-[11px] text-[var(--text-soft)] mt-0.5">Come sfruttare HQ in pochi passi</p>
              </div>
              <button onClick={() => setGuideOpen(false)} className="p-2 hover:bg-[var(--fill)] rounded-xl transition-colors">
                <X size={18} className="text-[var(--text-muted)]" />
              </button>
            </div>
            <div className="overflow-y-auto p-5 space-y-4">
              {[
                { icon: Plus, t: 'Aggiungi un prodotto', d: 'Premi "+" e scatta una foto: l\'IA riconosce brand e modello e compila i campi. Controlla taglia/condizione e salva.' },
                { icon: DollarSign, t: 'Vendi e traccia il profitto', d: 'Sul prodotto premi "Vendi": inserisci prezzo, piattaforma e fee. HQ calcola profitto e margine in automatico.' },
                { icon: Truck, t: 'Spedizioni', d: 'Aggiungi il tracking sia per i pacchi in arrivo (entrano in stock alla consegna) sia per le vendite. Stato aggiornabile a mano + link al corriere.' },
                { icon: Users, t: 'Team e magazzini', d: 'Crea magazzini/reparti e invita i soci col codice: i profitti si dividono con le percentuali impostate.' },
                { icon: Bell, t: 'Notifiche', d: 'Attiva le notifiche push dalle Impostazioni per vendite, consegne e prodotti fermi da troppo tempo.' },
                { icon: Smartphone, t: 'Installa l\'app sul telefono', d: 'HQ funziona come un\'app vera, a schermo intero. Su iPhone (Safari): tocca il tasto Condividi in basso → "Aggiungi a schermata Home". Su Android (Chrome): menu ⋮ in alto a destra → "Installa app" (o "Aggiungi a schermata Home"). Poi la apri dall\'icona come una qualsiasi app.' },
              ].map(s => {
                const I = s.icon;
                return (
                  <div key={s.t} className="flex items-start gap-3">
                    <div className="w-9 h-9 rounded-xl bg-[#8397aa]/15 flex items-center justify-center shrink-0"><I size={16} className="text-[#8397aa]" /></div>
                    <div>
                      <p className="font-semibold text-sm text-[var(--text)]">{s.t}</p>
                      <p className="text-[13px] text-[var(--text-muted)] leading-relaxed mt-0.5">{s.d}</p>
                    </div>
                  </div>
                );
              })}
              <div className="pt-1 text-center">
                <button onClick={() => { setGuideOpen(false); navigateTo('settings'); }} className="text-xs text-[#8397aa] font-semibold hover:underline">
                  Serve aiuto? Impostazioni → Aiuto &amp; Assistenza
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {privacyOpen && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-end sm:items-center justify-center z-[110] p-0 sm:p-4" {...swipeBack(() => setPrivacyOpen(false))}>
          <div className="bg-[var(--surface)] border-t sm:border border-[var(--border-2)] rounded-t-3xl sm:rounded-3xl w-full max-w-2xl max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between p-5 border-b border-[var(--border)] shrink-0">
              <div>
                <h2 className="font-semibold text-base">Privacy Policy & Cookie</h2>
                <p className="text-[11px] text-[var(--text-soft)] mt-0.5">Ultimo aggiornamento: {new Date().toLocaleDateString('it-IT', { year: 'numeric', month: 'long' })}</p>
              </div>
              <button onClick={() => setPrivacyOpen(false)} className="p-2 hover:bg-[var(--fill)] rounded-xl transition-colors">
                <X size={18} className="text-[var(--text-muted)]" />
              </button>
            </div>
            <div className="overflow-y-auto p-5 space-y-5 text-[13px] text-[var(--text-muted)] leading-relaxed">

              {/* Conferma consenso: chi è registrato ha già accettato (in fase di creazione account). */}
              {isAuthenticated && (
                <div className="bg-green-500/10 border border-green-500/30 rounded-xl p-3.5 flex items-start gap-2.5">
                  <Check size={17} className="text-green-400 mt-0.5 shrink-0" />
                  <div className="text-[12.5px] text-[var(--text)]">
                    <b>Consensi accettati.</b>{' '}
                    <span className="text-[var(--text-soft)]">Hai accettato la <b className="text-[var(--text)]">Privacy</b> e la <b className="text-[var(--text)]">Cookie Policy</b> alla creazione del tuo account{user?.email ? ` (${user.email})` : ''}. Qui sotto puoi rileggerle quando vuoi. I <b className="text-[var(--text)]">Termini e Condizioni</b> verranno aggiunti a breve.</span>
                  </div>
                </div>
              )}

              <section>
                <h3 className="text-[var(--text)] font-semibold text-sm mb-2">1. Titolare del Trattamento</h3>
                <p>Il titolare del trattamento dei dati personali è l'operatore dell'account HQ. Per qualsiasi richiesta relativa ai dati personali, contatta il responsabile della piattaforma.</p>
              </section>

              <section>
                <h3 className="text-[var(--text)] font-semibold text-sm mb-2">2. Dati Raccolti</h3>
                <p className="mb-2">HQ raccoglie i seguenti dati personali:</p>
                <ul className="space-y-1 list-none">
                  {[
                    'Indirizzo email e nome (account)',
                    'Dati prodotti inseriti (brand, prezzi, foto)',
                    'Dati di vendita e acquisto',
                    'Indirizzo IP e User Agent (sicurezza)',
                    'Log di accesso e azioni (audit)',
                  ].map(item => (
                    <li key={item} className="flex items-start gap-2">
                      <span className="text-[var(--text-faint)] mt-0.5">—</span>
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </section>

              <section>
                <h3 className="text-[var(--text)] font-semibold text-sm mb-2">3. Finalità del Trattamento</h3>
                <p>I dati sono trattati esclusivamente per:</p>
                <ul className="space-y-1 mt-2 list-none">
                  {[
                    'Fornitura del servizio di gestione magazzino',
                    'Autenticazione e sicurezza dell\'account',
                    'Funzionalità team e condivisione dati tra soci',
                    'Prevenzione di accessi non autorizzati',
                  ].map(item => (
                    <li key={item} className="flex items-start gap-2">
                      <span className="text-[var(--text-faint)] mt-0.5">—</span>
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </section>

              <section>
                <h3 className="text-[var(--text)] font-semibold text-sm mb-2">4. Cookie Utilizzati</h3>
                <p className="mb-3">HQ utilizza <span className="text-[var(--text)]">esclusivamente cookie tecnici strettamente necessari</span>, non richiesti dal consenso ai sensi dell'art. 122 D.Lgs. 196/2003 e delle Linee Guida Garante.</p>
                <div className="bg-[var(--fill)] border border-[var(--border)] rounded-xl overflow-hidden">
                  <div className="grid grid-cols-3 text-[11px] font-semibold text-[var(--text-soft)] p-3 border-b border-[var(--border)] uppercase tracking-wider">
                    <span>Nome</span><span>Durata</span><span>Scopo</span>
                  </div>
                  {[
                    ['access_token', '15 minuti', 'Autenticazione sessione'],
                    ['refresh_token', '7 giorni', 'Rinnovo sessione automatico'],
                  ].map(([name, duration, purpose]) => (
                    <div key={name} className="grid grid-cols-3 text-[12px] p-3 border-b border-[var(--border)] last:border-0">
                      <span className="text-[var(--text)] font-mono">{name}</span>
                      <span>{duration}</span>
                      <span>{purpose}</span>
                    </div>
                  ))}
                </div>
                <p className="mt-3 text-[12px]">Nessun cookie di profilazione, marketing, analisi o terze parti è utilizzato.</p>
              </section>

              <section>
                <h3 className="text-[var(--text)] font-semibold text-sm mb-2">5. Base Giuridica</h3>
                <p>Il trattamento si basa sull'esecuzione del contratto di servizio (art. 6.1.b GDPR) e sul legittimo interesse alla sicurezza della piattaforma (art. 6.1.f GDPR).</p>
              </section>

              <section>
                <h3 className="text-[var(--text)] font-semibold text-sm mb-2">6. Conservazione dei Dati</h3>
                <p>I dati dell'account sono conservati per tutta la durata del rapporto contrattuale. I log di sicurezza sono conservati per 90 giorni. Dopo la cancellazione dell'account, i dati vengono eliminati entro 30 giorni.</p>
              </section>

              <section>
                <h3 className="text-[var(--text)] font-semibold text-sm mb-2">7. Diritti dell'Interessato</h3>
                <p>Ai sensi del GDPR (artt. 15-22) hai il diritto di: accedere ai tuoi dati, rettificarli, richiederne la cancellazione, opporti al trattamento, richiedere la portabilità. Per esercitare i tuoi diritti, contatta il titolare del trattamento.</p>
              </section>

              <section>
                <h3 className="text-[var(--text)] font-semibold text-sm mb-2">8. Sicurezza</h3>
                <p>I dati sono protetti con crittografia AES-256, password hashate con bcrypt, autenticazione a due fattori (2FA), comunicazioni cifrate HTTPS, e token JWT con rotazione automatica.</p>
              </section>

              <section>
                <h3 className="text-[var(--text)] font-semibold text-sm mb-2">9. Comunicazioni Email</h3>
                <p>Previo consenso facoltativo espresso in fase di registrazione, HQ potrà inviare all'indirizzo email fornito comunicazioni relative ad aggiornamenti del servizio, nuove funzionalità e novità della piattaforma. Il consenso è revocabile in qualsiasi momento accedendo alle <span className="text-[var(--text)]">Impostazioni → Profilo</span> dell'app, senza pregiudizio per la liceità dei trattamenti effettuati prima della revoca. Il mancato consenso non pregiudica l'accesso al servizio.</p>
              </section>

              <section>
                <h3 className="text-[var(--text)] font-semibold text-sm mb-2">10. Trattamento delle immagini tramite intelligenza artificiale (fornitori terzi)</h3>
                <p>Le foto che carichi per il riconoscimento prodotto e la valutazione vengono inviate a fornitori terzi di intelligenza artificiale (attualmente <span className="text-[var(--text)]">Google Gemini</span> e <span className="text-[var(--text)]">Groq</span>), con sede anche al di fuori dell'Unione Europea, al solo scopo di analizzare l'immagine e restituire le informazioni sul prodotto. Le immagini non vengono pubblicate né condivise con altri utenti. A seconda del piano di servizio del fornitore, le immagini potrebbero essere utilizzate dal fornitore stesso per il miglioramento dei propri modelli. Ti invitiamo a non caricare immagini contenenti dati personali o riservati non necessari alla valutazione. Base giuridica: esecuzione del contratto di servizio (art. 6.1.b GDPR).</p>
              </section>

              <section>
                <h3 className="text-[var(--text)] font-semibold text-sm mb-2">11. Modifiche alla Privacy Policy</h3>
                <p>Questa policy può essere aggiornata. Le modifiche sostanziali saranno comunicate tramite notifica in-app.</p>
              </section>

            </div>
            <div className="p-5 border-t border-[var(--border)] shrink-0">
              <button onClick={() => { localStorage.setItem('hq_cookie_consent', '1'); setCookieConsent(true); setPrivacyOpen(false); }}
                className="w-full py-3 rounded-xl bg-white text-black text-sm font-semibold hover:bg-gray-200 transition-colors">
                Ho letto e accetto
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ========== MODALE: NOTE PRODOTTO ========== */}
      {notesModalProduct && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-end sm:items-center justify-center z-[60] p-0 sm:p-4" {...swipeBack(() => setNotesModalProduct(null))}>
          <div className="bg-[var(--surface)] border-t sm:border border-[var(--border-2)] rounded-t-3xl sm:rounded-3xl w-full max-w-md">
            <div className="flex justify-center pt-3 pb-1 sm:hidden"><div className="w-10 h-1 bg-gray-700 rounded-full" /></div>
            <div className="p-5">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <StickyNote size={16} className="text-[var(--text-muted)]" />
                  <div>
                    <h3 className="font-semibold text-sm">{notesModalProduct.brand} {notesModalProduct.name}</h3>
                    <p className="text-[11px] text-[var(--text-faint)]">{notesModalProduct.size} · Note operative</p>
                  </div>
                </div>
                <button onClick={() => setNotesModalProduct(null)} className="p-1.5 hover:bg-[var(--fill)] rounded-lg transition-colors">
                  <X size={16} className="text-[var(--text-muted)]" />
                </button>
              </div>
              <textarea
                value={notesInput}
                onChange={e => setNotesInput(e.target.value)}
                placeholder="Es: cinturino usurato, scatola mancante, graffio sul fondello, acquistato da privato..."
                className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3.5 text-sm text-[var(--text)] placeholder-gray-600 focus:border-[var(--border-3)] outline-none resize-none"
                rows={4}
                autoFocus
              />
              <p className="text-[10px] text-[var(--text-faint)] mt-1.5 mb-4">{notesInput.length}/500 caratteri</p>
              <div className="flex gap-2">
                <button onClick={() => setNotesModalProduct(null)}
                  className="flex-1 py-2.5 rounded-xl border border-[var(--border-2)] text-sm text-[var(--text-muted)] hover:text-[var(--text)] transition-colors">
                  Annulla
                </button>
                <button onClick={saveNotes} disabled={isSavingNotes}
                  className="flex-1 py-2.5 rounded-xl bg-white text-black text-sm font-semibold hover:bg-gray-200 transition-colors disabled:opacity-50">
                  {isSavingNotes ? 'Salvo...' : 'Salva Note'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ========== MODALE: ELIMINA PRODOTTO ========== */}
      {deleteConfirmOpen && productToDelete && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-end sm:items-center justify-center z-[60] p-0 sm:p-4" {...swipeBack(() => setDeleteConfirmOpen(false))}>
          <div className="bg-[var(--surface)] border-t sm:border border-[var(--border-2)] rounded-t-3xl sm:rounded-3xl w-full max-w-sm p-6">
            <div className="flex justify-center mb-4 sm:hidden"><div className="w-10 h-1 bg-gray-700 rounded-full" /></div>
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-red-500/20 flex items-center justify-center">
                <Trash2 className="text-red-400" size={20} />
              </div>
              <div>
                <h3 className="font-semibold text-base">{t('delp.title')}</h3>
                <p className="text-xs text-[var(--text-soft)]">{t('delp.irreversible')}</p>
              </div>
            </div>
            <p className="text-sm text-[var(--text-muted)] mb-6">
              {t('delp.removing')} <span className="text-[var(--text)] font-bold">{productToDelete.brand} {productToDelete.name}</span>
              {productToDelete.quantity > 1 && ` (${productToDelete.quantity} ${t('delp.pieces')})`}.
            </p>
            <div className="flex gap-3">
              <button onClick={() => setDeleteConfirmOpen(false)}
                className="flex-1 bg-[var(--fill)] hover:bg-[var(--fill)] py-3 rounded-xl font-bold text-sm transition-colors">
                {t('common.cancel')}
              </button>
              <button onClick={handleDeleteProduct}
                className="flex-1 bg-red-600 hover:bg-red-500 py-3 rounded-xl font-bold text-sm transition-colors">
                {t('common.delete')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ========== MODALE: CAMBIA PASSWORD ========== */}
      {changePwdOpen && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-end sm:items-center justify-center z-[60] p-0 sm:p-4" {...swipeBack(() => setChangePwdOpen(false))}>
          <div className="bg-[var(--surface)] border-t sm:border border-[var(--border-2)] rounded-t-3xl sm:rounded-3xl w-full max-w-sm p-6">
            <div className="flex justify-center mb-4 sm:hidden"><div className="w-10 h-1 bg-gray-700 rounded-full" /></div>
            <div className="flex items-center gap-3 mb-5">
              <Lock className="text-[var(--text)]" size={22} />
              <h3 className="font-semibold text-base">{t('pwd.title')}</h3>
            </div>
            <form onSubmit={handleChangePassword} className="space-y-4">
              <div>
                <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">{t('pwd.current')}</label>
                <input type="password" required value={changePwdCurrent}
                  onChange={e => setChangePwdCurrent(e.target.value)}
                  placeholder="••••••••"
                  className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-[var(--text)] outline-none focus:border-[#8397aa]" />
              </div>
              <div>
                <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">{t('pwd.new')}</label>
                <input type="password" required value={changePwdNew}
                  onChange={e => setChangePwdNew(e.target.value)}
                  placeholder="••••••••"
                  className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-[var(--text)] outline-none focus:border-[#8397aa]" />
                <p className="text-[10px] text-[var(--text-soft)] mt-1">{t('pwd.rule')}</p>
              </div>
              <div>
                <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">{t('pwd.confirm')}</label>
                <input type="password" required value={changePwdConfirm}
                  onChange={e => setChangePwdConfirm(e.target.value)}
                  placeholder="••••••••"
                  className={`w-full bg-[var(--surface-2)] border rounded-xl p-3 text-[var(--text)] outline-none focus:border-[#8397aa] ${
                    changePwdConfirm && changePwdNew !== changePwdConfirm ? 'border-red-500' : 'border-[var(--border-2)]'
                  }`} />
              </div>
              <div className="flex gap-3 pt-2">
                <button type="button" onClick={() => { setChangePwdOpen(false); setChangePwdCurrent(''); setChangePwdNew(''); setChangePwdConfirm(''); }}
                  className="flex-1 bg-[var(--fill)] hover:bg-[var(--fill)] py-3 rounded-xl font-bold text-sm transition-colors">
                  {t('common.cancel')}
                </button>
                <button type="submit" disabled={changePwdLoading || (!!changePwdConfirm && changePwdNew !== changePwdConfirm)}
                  className="flex-1 bg-[#8397aa] hover:bg-[#9fb0bd] disabled:opacity-50 py-3 rounded-xl font-bold text-sm transition-colors flex items-center justify-center">
                  {changePwdLoading ? <Loader2 className="animate-spin" size={16} /> : t('common.save')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ========== MODALE: TRACKING SPEDIZIONE ========== */}
      {/* ========== MODALE: ACQUISTO IN ARRIVO ========== */}
      {incomingOpen && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-end sm:items-center justify-center z-[60] p-0 sm:p-4" onClick={() => setIncomingOpen(false)} {...swipeBack(() => setIncomingOpen(false))}>
          <div className="bg-[var(--surface)] border-t sm:border border-[var(--border-2)] rounded-t-3xl sm:rounded-3xl w-full max-w-md p-6 max-h-[92vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="flex justify-center mb-4 sm:hidden"><div className="w-10 h-1 bg-gray-700 rounded-full" /></div>
            <div className="flex items-center justify-between mb-5">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-[var(--accent)]/15 flex items-center justify-center"><Truck className="text-[var(--accent)]" size={20} /></div>
                <div>
                  <h3 className="font-semibold text-base">{t('track.incoming')}</h3>
                  <p className="text-xs text-[var(--text-soft)]">{t('track.incomingSub')}</p>
                </div>
              </div>
              <button onClick={() => setIncomingOpen(false)}><X size={20} className="text-[var(--text-soft)] hover:text-[var(--text)]" /></button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">{t('form.name')}</label>
                <input value={incName} onChange={(e: any) => setIncName(e.target.value)} placeholder="Es. Air Jordan 1 Chicago" autoFocus
                  className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm focus:border-[var(--accent)] outline-none" />
                <p className="text-[10px] text-[var(--text-faint)] mt-1">{t('track.incNameHint')}</p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">{t('sell.trackingCode')}</label>
                  <input value={incTrackCode} onChange={(e: any) => setIncTrackCode(e.target.value)} placeholder="ABC123..."
                    className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm focus:border-[var(--accent)] outline-none" />
                </div>
                <div>
                  <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">{t('track.carrier')}</label>
                  <select value={incTrackCarrier} onChange={(e: any) => setIncTrackCarrier(e.target.value)}
                    className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm focus:border-[var(--accent)] outline-none">
                    {(carrierList.length ? carrierList.map(c => c.key) : ['Auto','BRT','GLS','Poste Italiane','SDA','DHL','UPS','FedEx','TNT','Amazon Logistics','Nexive']).map(k => (
                      <option key={k} value={k}>{k === 'Auto' ? t('sell.autoDetect') : k}</option>
                    ))}
                  </select>
                </div>
              </div>
              {/* Magazzino di destinazione (con le sue percentuali soci). Solo se >1 magazzino. */}
              {warehouses.filter((w: any) => !w.parentId).length > 1 && (
                <div>
                  <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">{t('form.warehouse')}</label>
                  <select value={incWarehouseId || baseWarehouse?.id || ''} onChange={(e: any) => setIncWarehouseId(e.target.value)}
                    className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm focus:border-[var(--accent)] outline-none">
                    {warehouses.filter((w: any) => !w.parentId).map((w: any) => <option key={w.id} value={w.id}>{w.name}</option>)}
                  </select>
                </div>
              )}
              <button onClick={createIncoming} disabled={incSaving}
                className="w-full bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white py-3 rounded-xl font-bold transition-colors disabled:opacity-50 flex items-center justify-center gap-2">
                {incSaving ? <Loader2 className="animate-spin" size={18} /> : <><Plus size={16} /> {t('track.addAndTrack')}</>}
              </button>
            </div>
          </div>
        </div>
      )}

      {trackingModalOpen && trackingProduct && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-end sm:items-center justify-center z-[60] p-0 sm:p-4" {...swipeBack(() => setTrackingModalOpen(false))}>
          <div className="bg-[var(--surface)] border-t sm:border border-[var(--border-2)] rounded-t-3xl sm:rounded-3xl w-full max-w-md p-6 max-h-[90vh] overflow-y-auto">
            <div className="flex justify-center mb-4 sm:hidden"><div className="w-10 h-1 bg-gray-700 rounded-full" /></div>
            <div className="flex items-center justify-between mb-5">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-blue-500/20 flex items-center justify-center">
                  <Truck className="text-blue-400" size={20} />
                </div>
                <div>
                  <h3 className="font-semibold text-base">{trackingProduct.status === 'VENDUTO' ? t('track.saleShipment') : t('track.incomingShipment')}</h3>
                  <p className="text-xs text-[var(--text-soft)]">{trackingProduct.brand} {trackingProduct.name}</p>
                </div>
              </div>
              <button onClick={() => setTrackingModalOpen(false)}>
                <X size={20} className="text-[var(--text-soft)] hover:text-[var(--text)]" />
              </button>
            </div>

            {/* Stato spedizione — stepper tappabile: mostra l'avanzamento e si aggiorna con un tap */}
            {trackingProduct.trackingCode && (() => {
              // Escrow: sugli articoli pagati in-app la consegna la conferma SOLO il
              // compratore (chat). Il venditore non vede lo step "Consegnato".
              const isEscrow = trackingProduct.status === 'PAGATO';
              const steps = [
                { key: 'PENDING', label: t('track.stPending'), icon: '⏳' },
                { key: 'IN_TRANSIT', label: t('track.stInTransit'), icon: '🚚' },
                { key: 'OUT_FOR_DELIVERY', label: t('track.stOutForDelivery'), icon: '📦' },
                ...(isEscrow ? [] : [{ key: 'DELIVERED', label: t('track.stDelivered'), icon: '✅' }]),
              ];
              const cur = trackingProduct.trackingStatus || 'PENDING';
              const isException = cur === 'EXCEPTION';
              const curIdx = steps.findIndex(s => s.key === cur);
              return (
                <div className="mb-5">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest">{t('track.shipmentStatus')}</p>
                    <button onClick={handleRefreshTracking} disabled={isRefreshingTracking}
                      className="flex items-center gap-1 text-[11px] text-blue-400 hover:text-blue-300 font-bold disabled:opacity-50">
                      {isRefreshingTracking ? <Loader2 className="animate-spin" size={11} /> : <Truck size={11} />} {t('track.refresh')}
                    </button>
                  </div>
                  {/* Progressione a step: pieni fino allo stato corrente. Tap = imposta lo stato. */}
                  <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }}>
                    {steps.map((s, i) => {
                      const done = !isException && i <= curIdx;
                      return (
                        <button key={s.key} onClick={() => setManualStatus(s.key)}
                          className={`py-2.5 rounded-xl text-center transition-colors ${done ? 'bg-[#8397aa] text-white' : 'bg-[var(--fill)] text-[var(--text-soft)] hover:text-[var(--text)]'}`}>
                          <div className="text-base leading-none">{s.icon}</div>
                          <div className="text-[9px] font-bold mt-1 leading-tight">{s.label}</div>
                        </button>
                      );
                    })}
                  </div>
                  <div className="flex gap-2 mt-2.5">
                    <button onClick={() => setManualStatus('EXCEPTION')}
                      className={`flex-1 py-2 rounded-xl text-xs font-bold transition-colors ${isException ? 'bg-red-500 text-white' : 'bg-red-500/10 text-red-400 hover:bg-red-500/20'}`}>
                      {t('track.problemBtn')}
                    </button>
                    <a href={trackingPublicUrl(trackingProduct.trackingCode)} target="_blank" rel="noopener noreferrer"
                      className="flex-1 py-2 rounded-xl text-xs font-bold bg-[var(--surface-2)] border border-[var(--border-2)] text-[var(--text-soft)] hover:text-[var(--text)] flex items-center justify-center gap-1 transition-colors">
                      {t('track.viewCarrier')}
                    </a>
                  </div>
                  <p className="text-[10px] text-[var(--text-faint)] mt-2 text-center">{t('track.tapStep')} · {trackingProduct.trackingCarrier} • {trackingProduct.trackingCode}</p>
                  {isEscrow && <p className="text-[10px] text-[var(--text-faint)] mt-1 text-center">{t('track.buyerConfirms')}</p>}
                </div>
              );
            })()}

            {/* Storico eventi */}
            {trackingDetail?.history?.length > 0 && (
              <div className="mb-5">
                <p className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest mb-3">{t('track.history')}</p>
                <div className="space-y-0 max-h-44 overflow-y-auto pr-1">
                  {(trackingDetail.history as any[]).map((ev: any, i: number) => (
                    <div key={i} className="flex gap-3 text-xs">
                      <div className="flex flex-col items-center pt-1">
                        <div className={`w-2 h-2 rounded-full shrink-0 ${i === 0 ? 'bg-blue-400' : 'bg-gray-700'}`} />
                        {i < trackingDetail.history.length - 1 && <div className="w-px flex-1 bg-[var(--fill)] my-1 min-h-[12px]" />}
                      </div>
                      <div className="pb-3">
                        <p className="text-[var(--text)] font-medium">{ev.description || '—'}</p>
                        {ev.location && <p className="text-[var(--text-soft)]">{ev.location}</p>}
                        {ev.date && <p className="text-[var(--text-faint)] text-[10px]">{ev.date}</p>}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Form aggiungi/modifica tracking */}
            <div className="space-y-3 mb-5">
              <div>
                <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">{t('track.trackingCodeLabel')}</label>
                <input type="text" value={trackingInput}
                  onChange={e => setTrackingInput(e.target.value.toUpperCase())}
                  placeholder="ES: BRT123456789IT"
                  className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-[var(--text)] outline-none focus:border-blue-500 font-mono text-sm uppercase"
                />
              </div>
              <div>
                <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">{t('track.carrier')}</label>
                <select value={trackingCarrierSel} onChange={e => setTrackingCarrierSel(e.target.value)}
                  className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-[var(--text)] outline-none focus:border-blue-500">
                  {(carrierList.length > 0 ? carrierList : [
                    { key: 'Auto', label: 'Auto-detect' }, { key: 'BRT', label: 'BRT/Bartolini' },
                    { key: 'GLS', label: 'GLS' }, { key: 'Poste Italiane', label: 'Poste Italiane' },
                    { key: 'SDA', label: 'SDA' }, { key: 'DHL', label: 'DHL' },
                    { key: 'UPS', label: 'UPS' }, { key: 'FedEx', label: 'FedEx' },
                    { key: 'TNT', label: 'TNT' }, { key: 'Amazon Logistics', label: 'Amazon Logistics' },
                    { key: 'Nexive', label: 'Nexive' },
                  ]).map(c => (
                    <option key={c.key} value={c.key}>{c.label}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="flex gap-2">
              {trackingProduct.trackingCode && (
                <button onClick={handleRemoveTracking}
                  className="w-12 h-12 flex items-center justify-center bg-red-900/30 hover:bg-red-900/50 text-red-400 rounded-xl transition-colors shrink-0">
                  <Trash2 size={16} />
                </button>
              )}
              <button onClick={() => setTrackingModalOpen(false)}
                className="flex-1 bg-[var(--fill)] hover:bg-[var(--fill)] py-3 rounded-xl font-bold text-sm transition-colors">
                {t('common.cancel')}
              </button>
              <button onClick={handleSaveTracking} disabled={!trackingInput.trim() || isSavingTracking}
                className="flex-1 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 py-3 rounded-xl font-bold text-sm transition-colors flex items-center justify-center gap-2">
                {isSavingTracking ? <Loader2 className="animate-spin" size={16} /> : <><Truck size={15} /> {t('common.save')}</>}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ========== TEAM PANEL ========== */}
      {teamPanelOpen && (() => {
        const totalSoci = new Set(teamData.flatMap((t: any) => t.members.map((m: any) => m.userId))).size;
        const totalStock = products.filter(p => p.status === 'IN STOCK').length;
        const totalSoldCount = products.filter(p => p.status === 'VENDUTO').length;
        const totalProfit = products.filter(p => p.status === 'VENDUTO')
          .reduce((s, p) => s + ((p.salePrice || 0) - p.purchasePrice - (p.fees || 0)), 0);

        const regenerateInvite = async (warehouseId: string) => {
          setIsRegenerating(warehouseId);
          const { ok, data } = await apiCall(`/warehouses/${warehouseId}/regenerate-invite`, { method: 'POST' });
          setIsRegenerating(null);
          if (ok) { await apiCall('/auth/me').then(r => r.ok && setUser(r.data.user)); showToast(t('tp.inviteRegen')); }
          else showToast(data.error || t('tp.regenError'), 'err');
        };

        const kickMember = async (membershipId: string) => {
          const { ok, data } = await apiCall(`/team/members/${membershipId}`, { method: 'DELETE' });
          if (ok) { await fetchTeam(); setKickConfirm(null); showToast(t('tp.memberRemoved')); }
          else showToast(data.error || t('tp.error'), 'err');
        };

        const saveEditedQuotes = async (team: any) => {
          const updates = team.members.map((m: any) => ({
            userId: m.userId, membershipId: m.membershipId,
            percentage: Number(editQuoteValues[m.membershipId] ?? m.percentage),
          }));
          const total = updates.reduce((s: number, u: any) => s + u.percentage, 0);
          if (Math.round(total) !== 100) { showToast(t('tp.sumMustBe100'), 'err'); return; }
          setIsSavingTeam(true);
          const { ok, data } = await apiCall('/team/percentage', {
            method: 'PUT', body: JSON.stringify({ warehouseId: team.warehouseId, updates }),
          });
          setIsSavingTeam(false);
          if (ok) { fetchTeam(); setEditQuoteWarehouse(null); showToast(t('tp.sharesUpdated')); }
          else showToast(data.error || t('tp.error'), 'err');
        };

        return (
          <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-[70] flex items-end lg:justify-end"
            onClick={() => setTeamPanelOpen(false)} {...swipeBack(() => setTeamPanelOpen(false))}>
            <div
              className="bg-[var(--surface)] border-t lg:border-t-0 lg:border-l border-[var(--border-2)] w-full lg:w-[460px] max-h-[92vh] lg:h-full overflow-y-auto rounded-t-3xl lg:rounded-none animate-slide-up lg:animate-slide-right"
              onClick={e => e.stopPropagation()}>

              {/* Header sticky */}
              <div className="sticky top-0 bg-[var(--surface-blur)] backdrop-blur-xl border-b border-[var(--border)] p-5 flex items-center justify-between z-10">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-2xl bg-[#8397aa]/15 border border-[#8397aa]/20 flex items-center justify-center">
                    <Users className="text-[#9fb0bd]" size={18} />
                  </div>
                  <div>
                    <h2 className="font-semibold text-base leading-none">{t('tp.title')}</h2>
                    <p className="text-[10px] text-[var(--text-faint)] mt-0.5">{totalSoci} {totalSoci === 1 ? t('tp.member') : t('tp.members')} · {teamData.length} {teamData.length === 1 ? t('tp.dept') : t('tp.depts')}</p>
                  </div>
                </div>
                <button onClick={() => setTeamPanelOpen(false)} className="p-2 hover:bg-[var(--fill)] rounded-xl transition-colors">
                  <X size={19} className="text-[var(--text-muted)]" />
                </button>
              </div>

              {/* Stats rapide globali */}
              <div className="grid grid-cols-4 gap-2 p-4 border-b border-[var(--border)]">
                {[
                  { label: t('an.partners'), value: totalSoci, color: 'text-[#9fb0bd]' },
                  { label: t('tp.inStock'), value: totalStock, color: 'text-[var(--text)]' },
                  { label: t('an.thSold'), value: totalSoldCount, color: 'text-blue-400' },
                  { label: t('dash.profit'), value: (totalProfit >= 0 ? '+' : '') + totalProfit.toFixed(0) + '€', color: totalProfit >= 0 ? 'text-emerald-400' : 'text-red-400' },
                ].map(s => (
                  <div key={s.label} className="bg-[var(--surface-2)] rounded-xl p-2.5 text-center">
                    <p className={`text-sm font-bold num ${s.color}`}>{s.value}</p>
                    <p className="text-[9px] text-[var(--text-faint)] mt-0.5 uppercase tracking-wider">{s.label}</p>
                  </div>
                ))}
              </div>

              <div className="p-4 space-y-5">

                {/* Per ogni magazzino (partnership) */}
                {teamData.map((team: any) => {
                  const teamProds = products.filter(p => (p as any).warehouseId === team.warehouseId);
                  const teamSold = teamProds.filter(p => p.status === 'VENDUTO' && (p.salePrice || 0) > 0);
                  const teamRevenue = teamSold.reduce((a, p) => a + (p.salePrice || 0), 0);
                  const teamCosts = teamSold.reduce((a, p) => a + p.purchasePrice, 0);
                  const teamFees = teamSold.reduce((a, p) => a + (p.fees || 0), 0);
                  const teamProfit = teamRevenue - teamCosts - teamFees;
                  const teamStock = teamProds.filter(p => p.status === 'IN STOCK');
                  const isEditing = editQuoteWarehouse === team.warehouseId;
                  const isOwnerHere = team.myRole === 'OWNER';
                  const sellThrough = teamProds.length > 0 ? Math.round((teamSold.length / teamProds.length) * 100) : 0;

                  // Calcolo profitto per membro (rispettando le customShares sui singoli prodotti)
                  const memberProfits = team.members.map((m: any) => {
                    const profit = teamSold.reduce((a: number, p: Product) => {
                      const itemProfit = (p.salePrice || 0) - p.purchasePrice - (p.fees || 0);
                      const shares = getShares(p);
                      if (shares?.length > 0) {
                        const myShare = shares.find((s: any) => s.userId === m.userId);
                        return a + (itemProfit * ((myShare?.percentage || 0) / 100));
                      }
                      return a + (itemProfit * (m.percentage / 100));
                    }, 0);
                    return { ...m, profit };
                  }).sort((a: any, b: any) => b.profit - a.profit);

                  // Pareggio conti: ogni socio riceve la sua quota di UTILE + il rimborso
                  // dei COSTI che ha sostenuto (quota costi separata, se impostata; altrimenti
                  // i costi seguono la quota utili). La somma = ricavi netti (ricavi - fee).
                  const hasCostSplit = team.members.some((m: any) => Number(m.costPercentage) > 0);
                  const settleAmounts = memberProfits.map((m: any) => {
                    const costPct = hasCostSplit ? (Number(m.costPercentage) || 0) : (Number(m.percentage) || 0);
                    const rimborsoCosti = teamCosts * (costPct / 100);
                    return { ...m, rimborsoCosti, spettante: m.profit + rimborsoCosti, hasCostSplit };
                  });

                  return (
                    <section key={team.warehouseId} className="bg-[var(--bg)] rounded-2xl border border-[var(--border)] overflow-hidden">

                      {/* Reparto header */}
                      <div className="p-4 border-b border-[var(--border)]">
                        <div className="flex items-center justify-between mb-3">
                          <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-xl bg-[var(--surface-2)] border border-[var(--border)] flex items-center justify-center text-xl shrink-0">
                              <Layers size={18} className="text-[#8397aa]" />
                            </div>
                            <div>
                              <p className="font-bold">{team.warehouseName}</p>
                              <p className="text-[10px] text-[var(--text-faint)]">{team.members.length} {t('tp.partnersWord')} · {teamStock.length} {t('tp.stockWord')} · {teamSold.length} {t('tp.salesWord')}</p>
                            </div>
                          </div>
                          <div className="text-right">
                            <p className={`font-semibold num ${teamProfit > 0 ? 'text-emerald-400' : teamProfit < 0 ? 'text-red-400' : 'text-[var(--text-faint)]'}`}>
                              {teamProfit > 0 ? '+' : ''}{teamProfit.toFixed(0)}€
                            </p>
                            <p className="text-[10px] text-[var(--text-faint)] mt-0.5">{teamRevenue.toFixed(0)}€ {t('an.revenueLower')} · {sellThrough}% sell-through</p>
                          </div>
                        </div>

                        {/* Mini progress sell-through */}
                        <div className="h-1 bg-[var(--fill)] rounded-full overflow-hidden">
                          <div className="h-full bg-gradient-to-r from-[#8397aa] to-[#9fb0bd] rounded-full transition-all" style={{ width: `${sellThrough}%` }} />
                        </div>
                      </div>

                      {/* Membri */}
                      <div className="divide-y divide-[var(--border)]">
                        {memberProfits.map((m: any, idx: number) => {
                          const medals = ['🥇', '🥈', '🥉'];
                          const isMe = m.userId === user!.id;
                          const canKick = isOwnerHere && !isMe && m.role !== 'OWNER';
                          return (
                            <div key={m.membershipId}>
                              <div className={`flex items-center gap-3 p-3.5 transition-colors ${isMe ? 'bg-[#8397aa]/[0.04]' : 'hover:bg-[var(--fill)]'}`}>
                                {/* Rank medal o avatar */}
                                <div className="relative shrink-0">
                                  <div className="w-9 h-9 rounded-full bg-gradient-to-br from-[#8397aa] to-blue-600 flex items-center justify-center font-black text-xs shadow-sm">
                                    {m.name[0]?.toUpperCase()}
                                  </div>
                                  {idx < 3 && teamSold.length > 0 && (
                                    <span className="absolute -top-1 -right-1 text-[10px] leading-none">{medals[idx]}</span>
                                  )}
                                </div>

                                {/* Info membro */}
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-1.5 flex-wrap">
                                    <span className="font-bold text-sm">{m.name}</span>
                                    {isMe && <span className="text-[8px] bg-[#8397aa]/20 text-[var(--text)] px-1.5 py-0.5 rounded-full font-semibold">{t('an.you')}</span>}
                                    <span className={`text-[8px] px-1.5 py-0.5 rounded-full font-semibold ${m.role === 'OWNER' ? 'bg-[#8397aa]/15 text-[var(--text)]/80' : 'bg-[var(--fill)] text-[var(--text-soft)]'}`}>
                                      {m.role === 'OWNER' ? t('tp.owner') : t('set.partner')}
                                    </span>
                                  </div>
                                  {/* Contribuzione */}
                                  <div className="flex items-center gap-2 mt-0.5">
                                    <span className="text-[10px] text-[var(--text-faint)]">{m.productsAdded ?? 0} {t('tp.added')} · {m.productsSold ?? 0} {t('tp.sold')}</span>
                                  </div>
                                </div>

                                {/* Destra: % e profitto */}
                                <div className="flex items-center gap-2 shrink-0">
                                  {isEditing ? (
                                    <input
                                      type="number" min="0" max="100" step="1"
                                      value={editQuoteValues[m.membershipId] ?? m.percentage}
                                      onChange={e => setEditQuoteValues(prev => ({ ...prev, [m.membershipId]: e.target.value }))}
                                      className="w-14 bg-[var(--surface-2)] border border-[var(--border-2)] rounded-lg px-2 py-1 text-xs text-center text-[var(--text)] outline-none focus:border-[#8397aa]"
                                    />
                                  ) : (
                                    <span className="text-[10px] text-[var(--text-soft)] font-semibold bg-[var(--fill)] px-2 py-1 rounded-lg">{m.percentage}%</span>
                                  )}
                                  <span className={`font-semibold text-sm w-16 text-right num ${m.profit >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                                    {m.profit >= 0 ? '+' : ''}{m.profit.toFixed(0)}€
                                  </span>
                                  {canKick && !isEditing && (
                                    <button
                                      onClick={() => setKickConfirm(m.membershipId)}
                                      className="w-6 h-6 flex items-center justify-center hover:bg-red-500/10 rounded-lg transition-colors text-gray-700 hover:text-red-400 ml-0.5"
                                      title={t('tp.remove')}>
                                      <X size={12} />
                                    </button>
                                  )}
                                </div>
                              </div>

                              {/* Conferma kick */}
                              {kickConfirm === m.membershipId && (
                                <div className="mx-3.5 mb-3 p-3 bg-red-500/10 border border-red-500/20 rounded-xl flex items-center justify-between gap-3">
                                  <p className="text-xs text-red-300">{t('tp.removeConfirm')} <strong>{m.name}</strong>?</p>
                                  <div className="flex gap-2">
                                    <button onClick={() => setKickConfirm(null)} className="text-[11px] text-[var(--text-soft)] hover:text-[var(--text)] px-2 py-1 rounded-lg hover:bg-[var(--fill)]">{t('common.cancel')}</button>
                                    <button onClick={() => kickMember(m.membershipId)} className="text-[11px] text-red-300 hover:text-red-200 bg-red-500/20 hover:bg-red-500/30 px-3 py-1 rounded-lg font-bold">{t('tp.remove')}</button>
                                  </div>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>

                      {/* Footer reparto */}
                      <div className="p-4 border-t border-[var(--border)] space-y-3">

                        {/* Pareggio conti (utile + rimborso costi) */}
                        {(teamProfit !== 0 || teamCosts !== 0) && (
                          <div className="bg-[var(--surface-2)] rounded-xl p-3">
                            <div className="flex items-center gap-1.5 mb-2.5">
                              <DollarSign size={11} className="text-emerald-500" />
                              <p className="text-[10px] font-bold text-[var(--text-muted)] uppercase tracking-wider">{t('tp.settle')}</p>
                              <span className="ml-auto text-[10px] text-[var(--text-faint)] num">{t('tp.revenueW')} {teamRevenue.toFixed(0)}€ · {t('tp.costsW')} {teamCosts.toFixed(0)}€ · {t('tp.profitW')} {teamProfit.toFixed(0)}€</span>
                            </div>
                            <div className="space-y-1.5">
                              {settleAmounts.map((m: any) => (
                                <div key={m.membershipId} className="flex items-center justify-between">
                                  <div className="flex items-center gap-1.5 min-w-0">
                                    <div className="w-4 h-4 rounded-full bg-gradient-to-br from-[#8397aa] to-blue-600 flex items-center justify-center font-black text-[7px] shrink-0">
                                      {m.name[0]?.toUpperCase()}
                                    </div>
                                    <span className="text-xs text-[var(--text-muted)] truncate">{m.name}</span>
                                    {m.hasCostSplit
                                      ? <span className="text-[10px] text-gray-700 shrink-0">{t('tp.profitW')} {m.percentage}% · {t('tp.costsW')} {m.costPercentage ?? 0}%</span>
                                      : <span className="text-[10px] text-gray-700 shrink-0">{m.percentage}%</span>}
                                  </div>
                                  <span className={`text-sm font-bold num shrink-0 ${m.spettante >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                                    {m.spettante >= 0 ? '+' : ''}{m.spettante.toFixed(2)}€
                                  </span>
                                </div>
                              ))}
                            </div>
                            <p className="text-[9px] text-[var(--text-faint)] mt-2">{t('tp.settleHint')}</p>
                          </div>
                        )}

                        {/* Modifica Quote (OWNER only) */}
                        {isOwnerHere && (
                          isEditing ? (
                            <div className="space-y-2">
                              <div className="flex items-center justify-between text-[10px]">
                                <span className="text-[var(--text-faint)]">
                                  {t('form.total')}: {team.members.reduce((s: number, m: any) => s + (Number(editQuoteValues[m.membershipId] ?? m.percentage) || 0), 0)}%
                                  {Math.round(team.members.reduce((s: number, m: any) => s + (Number(editQuoteValues[m.membershipId] ?? m.percentage) || 0), 0)) !== 100 && (
                                    <span className="text-red-400 ml-1">{t('tp.mustBe100')}</span>
                                  )}
                                </span>
                              </div>
                              <div className="flex gap-2">
                                <button onClick={() => { setEditQuoteWarehouse(null); setEditQuoteValues({}); }}
                                  className="flex-1 py-2 text-xs font-bold text-[var(--text-soft)] hover:text-[var(--text)] bg-[var(--fill)] hover:bg-[var(--fill)] rounded-xl transition-colors">
                                  {t('common.cancel')}
                                </button>
                                <button onClick={() => saveEditedQuotes(team)} disabled={isSavingTeam}
                                  className="flex-1 py-2 text-xs font-bold text-[var(--text)] bg-[#8397aa]/80 hover:bg-[#8397aa] rounded-xl transition-colors disabled:opacity-40">
                                  {isSavingTeam ? t('tp.saving') : t('set.saveShares')}
                                </button>
                              </div>
                            </div>
                          ) : (
                            <button onClick={() => {
                              setEditQuoteWarehouse(team.warehouseId);
                              const init: Record<string, string> = {};
                              team.members.forEach((m: any) => { init[m.membershipId] = String(m.percentage); });
                              setEditQuoteValues(init);
                            }}
                              className="w-full py-2 text-[11px] font-bold text-[var(--text-soft)] hover:text-[var(--text)] bg-[var(--fill)] hover:bg-[var(--fill)] rounded-xl border border-[var(--border)] hover:border-[var(--border-2)] transition-colors flex items-center justify-center gap-1.5">
                              <Edit size={11} /> {t('tp.editShares')}
                            </button>
                          )
                        )}

                        {/* Sezione invito */}
                        {isOwnerHere && team.inviteCode && (
                          <div className="bg-[var(--surface-2)] rounded-xl p-3 border border-[var(--border)]">
                            <p className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-wider mb-2 flex items-center gap-1.5">
                              <UserPlus size={10} /> {t('tp.invitePartner')}
                            </p>
                            <div className="flex gap-2">
                              <div className="flex-1 bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl px-3 py-2 flex items-center gap-2 overflow-hidden">
                                <KeyRound size={11} className="text-[var(--text-faint)] shrink-0" />
                                <span className="font-mono text-xs text-gray-300 truncate">{team.inviteCode}</span>
                              </div>
                              <button
                                onClick={() => { navigator.clipboard.writeText(team.inviteCode); showToast(t('set.codeCopied')); }}
                                className="px-3 bg-[var(--fill)] hover:bg-[var(--fill-2)] border border-[var(--border-2)] rounded-xl text-[var(--text-muted)] hover:text-[var(--text)] transition-colors active:scale-95">
                                <Copy size={14} />
                              </button>
                              <button
                                onClick={() => regenerateInvite(team.warehouseId)}
                                disabled={isRegenerating === team.warehouseId}
                                className="px-3 bg-[var(--fill)] hover:bg-[var(--fill-2)] border border-[var(--border-2)] rounded-xl text-[var(--text-muted)] hover:text-[var(--text)] transition-colors disabled:opacity-40 active:scale-95"
                                title={t('tp.inviteRegen')}>
                                {isRegenerating === team.warehouseId
                                  ? <Loader2 size={14} className="animate-spin" />
                                  : <ArrowUpDown size={14} />}
                              </button>
                            </div>
                            <p className="text-[10px] text-gray-700 mt-1.5">{t('tp.shareCode')}</p>
                          </div>
                        )}
                      </div>
                    </section>
                  );
                })}

                {/* Entra in un team esistente */}
                <section className="bg-[var(--bg)] rounded-2xl border border-[var(--border)] p-4">
                  <p className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-wider mb-3 flex items-center gap-1.5">
                    <UserPlus size={10} className="text-blue-400" /> {t('tp.joinTeam')}
                  </p>
                  <form onSubmit={handleJoinWarehouse} className="flex gap-2">
                    <input
                      type="text" value={joinCodeInput} onChange={e => setJoinCodeInput(e.target.value.toUpperCase())}
                      placeholder={t('tp.enterInvite')}
                      className="flex-1 bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl px-3 py-2 text-sm text-[var(--text)] placeholder-gray-700 outline-none focus:border-blue-500/50 font-mono"
                    />
                    <button type="submit" disabled={isJoining || !joinCodeInput.trim()}
                      className="px-4 py-2 bg-blue-600/80 hover:bg-blue-600 rounded-xl text-xs font-bold text-[var(--text)] transition-colors disabled:opacity-40 active:scale-95">
                      {isJoining ? <Loader2 size={14} className="animate-spin" /> : t('tp.join')}
                    </button>
                  </form>
                </section>

                <div className="h-2 lg:hidden" />
              </div>
            </div>
          </div>
        );
      })()}

      {/* ========== SPEDIZIONE PACKLINK (solo admin) ========== */}
      {shippingProduct && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[60] flex items-end sm:items-center justify-center p-0 sm:p-4"
          onClick={() => setShippingProduct(null)} {...swipeBack(() => setShippingProduct(null))}>
          <div className="bg-[var(--surface)] border border-[var(--border-2)] w-full sm:max-w-lg rounded-t-3xl sm:rounded-3xl max-h-[92vh] overflow-y-auto animate-slide-up"
            onClick={e => e.stopPropagation()}>

            {/* Header */}
            <div className="sticky top-0 bg-[var(--surface-blur)] backdrop-blur-xl border-b border-[var(--border)] p-5 flex items-center justify-between z-10">
              <div>
                <h2 className="font-semibold flex items-center gap-2"><Package size={16} className="text-[#9fb0bd]" /> {t('sh.title')}</h2>
                <p className="text-[11px] text-[var(--text-faint)] mt-0.5">{shippingProduct.brand} {shippingProduct.name} · {shippingProduct.size}</p>
              </div>
              <button onClick={() => setShippingProduct(null)} className="p-2 hover:bg-[var(--fill)] rounded-xl transition-colors">
                <X size={18} className="text-[var(--text-muted)]" />
              </button>
            </div>

            <div className="p-5 space-y-4">

              {/* STEP: FORM */}
              {shippingStep === 'form' && (<>

                {/* Mittente */}
                <div>
                  <p className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-wider mb-2">{t('sh.senderYou')}</p>
                  <div className="grid grid-cols-2 gap-2">
                    {[
                      { key: 'name',    label: t('sh.fName'),    placeholder: 'Mario Rossi',   span: 2 },
                      { key: 'address', label: t('sh.fAddress'), placeholder: 'Via Roma 1',    span: 2 },
                      { key: 'city',    label: t('sh.fCity'),    placeholder: 'Milano',        span: 1 },
                      { key: 'zip',     label: t('sh.fZip'),     placeholder: '20100',         span: 1 },
                      { key: 'phone',   label: t('sh.fPhone'),   placeholder: '+393331234567', span: 2 },
                    ].map(f => (
                      <div key={f.key} className={f.span === 2 ? 'col-span-2' : ''}>
                        <label className="text-[10px] text-[var(--text-faint)] block mb-1">{f.label}</label>
                        <input
                          value={shipFrom[f.key] || ''}
                          onChange={e => setShipFrom((p: any) => ({ ...p, [f.key]: e.target.value }))}
                          placeholder={f.placeholder}
                          className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl px-3 py-2 text-sm text-[var(--text)] placeholder-gray-700 outline-none focus:border-[#8397aa]/50"
                        />
                      </div>
                    ))}
                  </div>
                </div>

                {/* Destinatario */}
                <div>
                  <p className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-wider mb-2">{t('sh.recipient')}</p>
                  <div className="grid grid-cols-2 gap-2">
                    {[
                      { key: 'name',    label: t('sh.fName'),    placeholder: 'Luca Bianchi',  span: 2 },
                      { key: 'address', label: t('sh.fAddress'), placeholder: 'Via Milano 5',  span: 2 },
                      { key: 'city',    label: t('sh.fCity'),    placeholder: 'Roma',          span: 1 },
                      { key: 'zip',     label: t('sh.fZip'),     placeholder: '00100',         span: 1 },
                      { key: 'phone',   label: t('sh.fPhone'),   placeholder: '+393339876543', span: 2 },
                    ].map(f => (
                      <div key={f.key} className={f.span === 2 ? 'col-span-2' : ''}>
                        <label className="text-[10px] text-[var(--text-faint)] block mb-1">{f.label}</label>
                        <input
                          value={shipTo[f.key as keyof typeof shipTo] || ''}
                          onChange={e => setShipTo(p => ({ ...p, [f.key]: e.target.value }))}
                          placeholder={f.placeholder}
                          className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl px-3 py-2 text-sm text-[var(--text)] placeholder-gray-700 outline-none focus:border-[#8397aa]/50"
                        />
                      </div>
                    ))}
                  </div>
                </div>

                {/* Pacco preset */}
                <div>
                  <p className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-wider mb-2">{t('sh.packSize')}</p>
                  <div className="grid grid-cols-4 gap-2">
                    {SHIPPING_PRESETS.map(p => (
                      <button key={p.label} onClick={() => setShipPreset(p)}
                        className={`p-2.5 rounded-xl border text-center transition-all ${
                          shipPreset.label === p.label
                            ? 'bg-[#8397aa]/15 border-[#8397aa]/40 text-[var(--text)]'
                            : 'bg-[var(--surface-2)] border-[var(--border)] text-[var(--text-soft)] hover:border-[var(--border-3)]'
                        }`}>
                        <p className="text-xs font-bold">{p.label}</p>
                        <p className="text-[9px] text-[var(--text-faint)] mt-0.5">{p.weight}kg</p>
                      </button>
                    ))}
                  </div>
                  <p className="text-[10px] text-gray-700 mt-1.5">{shipPreset.length}×{shipPreset.width}×{shipPreset.height} cm · {shipPreset.weight} kg</p>
                </div>

                <button onClick={fetchRates} disabled={isLoadingRates}
                  className="w-full py-3.5 bg-[#6f8394]/80 hover:bg-[#6f8394] disabled:opacity-40 rounded-2xl text-sm font-bold text-[var(--text)] transition-colors flex items-center justify-center gap-2 active:scale-[0.98]">
                  {isLoadingRates ? <><Loader2 size={15} className="animate-spin" /> {t('sh.findingRates')}</> : <><Package size={15} /> {t('sh.seeRates')}</>}
                </button>
              </>)}

              {/* STEP: RATES */}
              {shippingStep === 'rates' && (<>
                <button onClick={() => setShippingStep('form')} className="text-xs text-[var(--text-soft)] hover:text-[var(--text)] flex items-center gap-1 transition-colors">
                  {t('sh.editData')}
                </button>
                <div className="space-y-2">
                  {shippingRates.map(r => (
                    <button key={r.id} onClick={() => setSelectedRate(r)}
                      className={`w-full flex items-center justify-between p-3.5 rounded-xl border transition-all text-left ${
                        selectedRate?.id === r.id
                          ? 'bg-[#8397aa]/10 border-[#8397aa]/40'
                          : 'bg-[var(--surface-2)] border-[var(--border)] hover:border-[var(--border-3)]'
                      }`}>
                      <div>
                        <p className="font-bold text-sm text-[var(--text)]">{r.carrier}</p>
                        <p className="text-[11px] text-[var(--text-soft)]">{r.name}{r.transitHours ? ` · ${r.transitHours}h` : ''}</p>
                      </div>
                      <p className={`font-bold text-base num ${selectedRate?.id === r.id ? 'text-[#9fb0bd]' : 'text-[var(--text)]'}`}>
                        {r.price.toFixed(2)}€
                      </p>
                    </button>
                  ))}
                </div>
                {selectedRate && (
                  <button onClick={bookShipment} disabled={isBooking}
                    className="w-full py-3.5 bg-[#6f8394]/80 hover:bg-[#6f8394] disabled:opacity-40 rounded-2xl text-sm font-bold text-[var(--text)] transition-colors flex items-center justify-center gap-2 active:scale-[0.98]">
                    {isBooking
                      ? <><Loader2 size={15} className="animate-spin" /> {t('sh.generating')}</>
                      : selectedRate.demo
                        ? <><Download size={15} /> {t('sh.genDemoLabel')} · {selectedRate.price.toFixed(2)}€</>
                        : <><Download size={15} /> {t('sh.bookDownload')} · {selectedRate.price.toFixed(2)}€</>}
                  </button>
                )}
              </>)}

              {/* STEP: DONE */}
              {shippingStep === 'done' && (
                <div className="text-center py-6 space-y-4">
                  <div className="w-14 h-14 rounded-full bg-green-500/15 border border-green-500/20 flex items-center justify-center mx-auto">
                    <CheckCircle className="text-green-400" size={24} />
                  </div>
                  <div>
                    <p className="font-bold text-[var(--text)]">{shippingRef?.startsWith('HQ-DEMO') ? t('sh.demoGenerated') : t('sh.shipmentBooked')}</p>
                    {shippingRef && <p className="text-xs text-[var(--text-soft)] mt-1 font-mono">{shippingRef}</p>}
                    <p className="text-xs text-[var(--text-faint)] mt-2">
                      {shippingRef?.startsWith('HQ-DEMO')
                        ? t('sh.demoNote')
                        : t('sh.trackingSaved')}
                    </p>
                  </div>
                  {shippingLabel
                    ? <a href={shippingLabel} target="_blank" rel="noopener noreferrer"
                        className="flex items-center justify-center gap-2 w-full py-3 bg-white hover:bg-gray-100 rounded-2xl text-sm font-bold text-black transition-colors">
                        <Download size={15} /> {t('sh.downloadPdf')}
                      </a>
                    : <p className="text-xs text-[var(--text-soft)]">{t('sh.labelOnPacklink')}</p>
                  }
                  <button onClick={() => setShippingProduct(null)}
                    className="w-full py-2.5 bg-[var(--fill)] hover:bg-[var(--fill-2)] rounded-2xl text-sm text-[var(--text-muted)] hover:text-[var(--text)] transition-colors">
                    {t('common.close')}
                  </button>
                </div>
              )}

            </div>
          </div>
        </div>
      )}

      {/* ========== GENERATORE ANNUNCI ========== */}
      {listingModalProduct && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[60] flex items-end sm:items-center justify-center p-0 sm:p-4"
          onClick={() => { setListingModalProduct(null); setListingResult(null); }} {...swipeBack(() => { setListingModalProduct(null); setListingResult(null); })}>
          <div className="bg-[var(--surface)] border border-[var(--border-2)] w-full sm:max-w-lg rounded-t-3xl sm:rounded-3xl max-h-[92vh] overflow-y-auto animate-slide-up"
            onClick={e => e.stopPropagation()}>

            {/* Header */}
            <div className="sticky top-0 bg-[var(--surface-blur)] backdrop-blur-xl border-b border-[var(--border)] p-5 flex items-center justify-between z-10">
              <div>
                <h2 className="font-semibold">{t('lst.title')}</h2>
                <p className="text-[11px] text-[var(--text-faint)] mt-0.5">{listingModalProduct.brand} {listingModalProduct.name} · {listingModalProduct.size}</p>
              </div>
              <button onClick={() => { setListingModalProduct(null); setListingResult(null); }}
                className="p-2 hover:bg-[var(--fill)] rounded-xl transition-colors">
                <X size={18} className="text-[var(--text-muted)]" />
              </button>
            </div>

            <div className="p-5 space-y-4">
              {/* Selezione piattaforma */}
              <div>
                <p className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-wider mb-3">{t('lst.choosePlatform')}</p>
                <div className="grid grid-cols-5 gap-2">
                  {([
                    { id: 'vinted',   label: 'Vinted',    emoji: '🟢' },
                    { id: 'ebay',     label: 'eBay',      emoji: '🔴' },
                    { id: 'depop',    label: 'Depop',     emoji: '🔴' },
                    { id: 'wallapop', label: 'Wallapop',  emoji: '🐾' },
                    { id: 'subito',   label: 'Subito',    emoji: '🟡' },
                  ] as const).map(p => (
                    <button key={p.id}
                      onClick={() => setListingPlatform(p.id)}
                      className={`flex flex-col items-center gap-1 p-2.5 rounded-xl border text-center transition-all active:scale-95 ${
                        listingPlatform === p.id
                          ? 'bg-[#8397aa]/15 border-[#8397aa]/40 text-[var(--text)]'
                          : 'bg-[var(--surface-2)] border-[var(--border)] text-[var(--text-soft)] hover:border-[var(--border-3)] hover:text-gray-300'
                      }`}>
                      <span className="text-lg">{p.emoji}</span>
                      <span className="text-[10px] font-bold">{p.label}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Bottone genera */}
              <button
                onClick={() => generateListingForProduct(listingPlatform)}
                disabled={isGeneratingListing}
                className="w-full py-3.5 bg-[#6f8394]/80 hover:bg-[#6f8394] disabled:bg-[#6f8394]/30 rounded-2xl text-sm font-bold text-[var(--text)] transition-colors flex items-center justify-center gap-2 active:scale-[0.98]">
                {isGeneratingListing
                  ? <><Loader2 size={16} className="animate-spin" /> {t('lst.generating')}</>
                  : <><Sparkles size={16} /> {t('lst.generateAI')}</>}
              </button>

              {/* Risultato */}
              {listingResult && (
                <div className="space-y-3">

                  {/* Titolo */}
                  <div className="bg-[var(--surface-2)] border border-[var(--border-2)] rounded-2xl p-4">
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-wider">{t('lst.heading')}</p>
                      <button onClick={() => copyToClipboard(listingResult.title, 'title')}
                        className={`flex items-center gap-1 text-[10px] font-bold px-2.5 py-1 rounded-lg transition-all ${
                          copiedField === 'title' ? 'bg-green-500/20 text-green-400' : 'bg-[var(--fill)] text-[var(--text-muted)] hover:text-[var(--text)]'
                        }`}>
                        <Copy size={11} /> {copiedField === 'title' ? t('lst.copied') : t('lst.copy')}
                      </button>
                    </div>
                    <p className="text-sm font-semibold text-[var(--text)] leading-snug">{listingResult.title}</p>
                    <p className="text-[10px] text-gray-700 mt-1">{listingResult.title.length}/80 {t('lst.chars')}</p>
                  </div>

                  {/* Descrizione */}
                  <div className="bg-[var(--surface-2)] border border-[var(--border-2)] rounded-2xl p-4">
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-wider">{t('lst.description')}</p>
                      <button onClick={() => copyToClipboard(listingResult.description, 'desc')}
                        className={`flex items-center gap-1 text-[10px] font-bold px-2.5 py-1 rounded-lg transition-all ${
                          copiedField === 'desc' ? 'bg-green-500/20 text-green-400' : 'bg-[var(--fill)] text-[var(--text-muted)] hover:text-[var(--text)]'
                        }`}>
                        <Copy size={11} /> {copiedField === 'desc' ? t('lst.copied') : t('lst.copy')}
                      </button>
                    </div>
                    <p className="text-sm text-gray-300 leading-relaxed whitespace-pre-line">{listingResult.description}</p>
                  </div>

                  {/* Hashtag (se presenti) */}
                  {listingResult.hashtags?.length > 0 && (
                    <div className="bg-[var(--surface-2)] border border-[var(--border-2)] rounded-2xl p-4">
                      <div className="flex items-center justify-between mb-2">
                        <p className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-wider">{t('lst.hashtags')}</p>
                        <button onClick={() => copyToClipboard(listingResult.hashtags.join(' '), 'tags')}
                          className={`flex items-center gap-1 text-[10px] font-bold px-2.5 py-1 rounded-lg transition-all ${
                            copiedField === 'tags' ? 'bg-green-500/20 text-green-400' : 'bg-[var(--fill)] text-[var(--text-muted)] hover:text-[var(--text)]'
                          }`}>
                          <Copy size={11} /> {copiedField === 'tags' ? t('lst.copied') : t('lst.copy')}
                        </button>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {listingResult.hashtags.map((tag: string) => (
                          <span key={tag} className="text-[11px] bg-[#8397aa]/10 text-[#9fb0bd] border border-[#8397aa]/20 px-2 py-0.5 rounded-full">{tag}</span>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Consiglio AI */}
                  {listingResult.tips && (
                    <div className="flex items-start gap-2 px-4 py-3 bg-[var(--fill)] border border-[var(--border)] rounded-xl">
                      <Sparkles size={13} className="text-yellow-500 shrink-0 mt-0.5" />
                      <p className="text-[12px] text-[var(--text-muted)] leading-relaxed">{listingResult.tips}</p>
                    </div>
                  )}

                  {/* CTA — apri piattaforma */}
                  {listingResult.deepLink && (
                    <a href={listingResult.deepLink} target="_blank" rel="noopener noreferrer"
                      className="flex items-center justify-center gap-2 w-full py-3 bg-[var(--fill)] hover:bg-[var(--fill-2)] border border-[var(--border-2)] rounded-2xl text-sm font-bold text-[var(--text)] transition-colors active:scale-[0.98]">
                      <Store size={15} /> {t('lst.open')} {(['vinted','ebay','depop','wallapop','subito'].find(p => p === listingResult.platform) || '').charAt(0).toUpperCase() + (listingResult.platform || '').slice(1)} →
                    </a>
                  )}

                  {/* Copia tutto */}
                  <button
                    onClick={() => copyToClipboard(
                      `${listingResult.title}\n\n${listingResult.description}${listingResult.hashtags?.length ? '\n\n' + listingResult.hashtags.join(' ') : ''}`,
                      'all'
                    )}
                    className={`w-full py-3 rounded-2xl text-sm font-bold transition-all active:scale-[0.98] ${
                      copiedField === 'all'
                        ? 'bg-green-500/20 text-green-400 border border-green-500/30'
                        : 'bg-[#6f8394]/70 hover:bg-[#6f8394] text-[var(--text)]'
                    }`}>
                    {copiedField === 'all' ? t('lst.allCopied') : t('lst.copyAll')}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ========== PROFIT SHARING MODAL ========== */}
      {showProfitSharesModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
          onClick={() => setShowProfitSharesModal(false)} {...swipeBack(() => setShowProfitSharesModal(false))}>
          <div className="bg-[var(--card)] rounded-3xl p-6 w-full max-w-md max-h-[80vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-xl font-bold text-[var(--text)]">
                {t('ps.title')}
              </h3>
              <button onClick={() => setShowProfitSharesModal(false)}
                className="p-2 hover:bg-[var(--bg)]/50 rounded-xl transition-colors">
                <X size={20} className="text-[var(--text)]/60" />
              </button>
            </div>
            
            <div className="mb-4">
              <p className="text-sm text-[var(--text)]/70 mb-2">
                {profitSharesMode === 'warehouse' ? t('ps.dept') : t('ps.subWarehouse')}: <span className="font-semibold text-[var(--text)]">{profitSharesName}</span>
              </p>
            </div>

            <div className="space-y-3 mb-4">
              <p className="text-sm font-semibold text-[var(--text)]/80">{t('ps.selectMembers')}</p>
              {teamData.length === 0 ? (
                <p className="text-sm text-[var(--text)]/50">{t('ps.noMembers')}</p>
              ) : (
                teamData.map((member: any) => {
                  const existingShare = profitShares.find(s => s.userId === member.userId);
                  const isSelected = !!existingShare;
                  
                  return (
                    <div key={member.userId} className="flex items-center gap-3 p-3 bg-[var(--bg)]/30 rounded-xl">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setProfitShares([...profitShares, {
                              userId: member.userId,
                              name: member.name,
                              percentage: ''
                            }]);
                          } else {
                            setProfitShares(profitShares.filter(s => s.userId !== member.userId));
                          }
                        }}
                        className="w-5 h-5 rounded accent-blue-500"
                      />
                      <div className="flex-1">
                        <p className="text-sm font-semibold text-[var(--text)]">{member.name}</p>
                      </div>
                      {isSelected && (
                        <input
                          type="number"
                          placeholder="%"
                          value={existingShare.percentage}
                          onChange={(e) => {
                            setProfitShares(profitShares.map(s =>
                              s.userId === member.userId
                                ? { ...s, percentage: e.target.value }
                                : s
                            ));
                          }}
                          className="w-20 px-3 py-2 bg-[var(--bg)] border border-[var(--text)]/10 rounded-xl text-sm text-[var(--text)] focus:outline-none focus:border-blue-500"
                        />
                      )}
                    </div>
                  );
                })
              )}
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => setShowProfitSharesModal(false)}
                className="flex-1 px-4 py-3 bg-[var(--bg)]/50 hover:bg-[var(--bg)] rounded-xl font-semibold text-[var(--text)]/70 transition-colors">
                {t('common.cancel')}
              </button>
              <button
                onClick={async () => {
                  const validShares = profitShares.filter(s => s.percentage && parseFloat(s.percentage) > 0);
                  if (validShares.length === 0) {
                    showToast(t('ts.selectMember'), 'err');
                    return;
                  }
                  
                  const total = validShares.reduce((sum, s) => sum + parseFloat(s.percentage), 0);
                  if (Math.abs(total - 100) > 0.01) {
                    showToast(t('ps.sumToast').replace('{n}', total.toFixed(1)), 'err');
                    return;
                  }

                  const endpoint = profitSharesMode === 'warehouse'
                    ? `/warehouses/${profitSharesParentId}/profit-shares`
                    : `/warehouses/sub/${profitSharesParentId}/profit-shares`;
                  
                  const { ok, data } = await apiCall(endpoint, {
                    method: 'PUT',
                    body: JSON.stringify({
                      shares: validShares.map(s => ({
                        userId: s.userId,
                        percentage: parseFloat(s.percentage)
                      }))
                    })
                  });

                  if (ok) {
                    showToast(t('ts.profitSharingDone'));
                    setShowProfitSharesModal(false);
                    setProfitShares([]);
                    fetchTeam();
                  } else {
                    showToast(data.error || t('ps.configError'), 'err');
                  }
                }}
                className="flex-1 px-4 py-3 bg-blue-500 hover:bg-blue-600 rounded-xl font-semibold text-white transition-colors">
                {t('common.save')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ========== MODALE: SCANSIONA BARCODE ========== */}
      {barcodeModalOpen && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
          onClick={() => setBarcodeModalOpen(false)} {...swipeBack(() => setBarcodeModalOpen(false))}>
          <div className="bg-[var(--card)] rounded-3xl p-5 w-full max-w-md" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-[var(--text)] flex items-center gap-2">
                <ScanLine size={18} className="text-[#8397aa]" /> {t('form.scanBarcode')}
              </h3>
              <button onClick={() => setBarcodeModalOpen(false)} className="p-2 hover:bg-[var(--fill)] rounded-lg">
                <X size={20} />
              </button>
            </div>

            {barcodeSupported ? (
              <>
                <div className="relative rounded-2xl overflow-hidden bg-black aspect-[4/3] mb-3">
                  <video ref={barcodeVideoRef} playsInline muted className="w-full h-full object-cover" />
                  <div className="absolute inset-x-8 top-1/2 -translate-y-1/2 h-0.5 bg-[#8397aa] shadow-[0_0_12px_2px_rgba(131,151,170,0.7)]" />
                </div>
                <p className="text-[11px] text-[var(--text-soft)] text-center mb-3">{t('bc.aim')}</p>
              </>
            ) : (
              <p className="text-xs text-[var(--text-soft)] mb-3">
                {t('bc.notSupported')}
              </p>
            )}

            {/* Inserimento manuale (sempre disponibile come fallback) */}
            <form onSubmit={(e) => { e.preventDefault(); if (barcodeManual.trim()) onBarcodeFound(barcodeManual.trim()); }}
              className="flex gap-2">
              <input value={barcodeManual} onChange={e => setBarcodeManual(e.target.value)}
                placeholder={t('bc.manualPlaceholder')}
                className="flex-1 bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl px-3 py-2 text-sm outline-none focus:border-[#8397aa]" />
              <button type="submit" disabled={!barcodeManual.trim()}
                className="px-4 py-2 rounded-xl bg-[#8397aa] text-white text-sm font-bold disabled:opacity-50">{t('market.searchBtn')}</button>
            </form>
          </div>
        </div>
      )}

      {/* ========== TOAST ========== */}
      {toast && (
        <div
          onClick={() => setToast(null)}
          className="fixed z-[100] left-4 right-4 lg:left-auto lg:right-6 lg:w-auto lg:max-w-sm flex items-center gap-3 px-4 py-3 rounded-2xl cursor-pointer animate-slide-up"
          style={{
            bottom: 'calc(5.5rem + env(safe-area-inset-bottom))',
            background: toast.type === 'ok'
              ? 'rgba(16,185,129,0.15)'
              : toast.type === 'err'
              ? 'rgba(239,68,68,0.15)'
              : 'rgba(234,179,8,0.15)',
            backdropFilter: 'blur(20px)',
            WebkitBackdropFilter: 'blur(20px)',
            border: `1px solid ${
              toast.type === 'ok' ? 'rgba(16,185,129,0.3)'
              : toast.type === 'err' ? 'rgba(239,68,68,0.3)'
              : 'rgba(234,179,8,0.3)'}`,
          }}
        >
          <div className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0 ${
            toast.type === 'ok' ? 'bg-emerald-500/20 text-emerald-400'
            : toast.type === 'err' ? 'bg-red-500/20 text-red-400'
            : 'bg-yellow-500/20 text-yellow-400'
          }`}>
            {toast.type === 'ok' ? <CheckCircle size={14} /> : <AlertTriangle size={14} />}
          </div>
          <span className={`text-sm font-semibold flex-1 ${
            toast.type === 'ok' ? 'text-emerald-300' : toast.type === 'err' ? 'text-red-300' : 'text-yellow-300'
          }`}>{toast.msg}</span>
          {toast.action && (
            <button onClick={(e) => { e.stopPropagation(); const fn = toast.action!.onClick; setToast(null); fn(); }}
              className="shrink-0 text-xs font-bold px-2.5 py-1 rounded-lg bg-[var(--text)]/10 hover:bg-[var(--text)]/20 text-[var(--text)] transition-colors">
              {toast.action.label}
            </button>
          )}
          <X size={13} className="shrink-0 text-[var(--text)]/30" />
        </div>
      )}
    </div>
  );
}
