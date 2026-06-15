import React, { useState, useEffect, useCallback, useMemo, useRef, Suspense, lazy } from 'react';
import { DynamicForm } from './components/DynamicForm';
// xlsx caricato on-demand (import dinamico) dentro gli handler: resta fuori dal bundle iniziale
// Grafico caricato in lazy: recharts finisce in un chunk separato, fuori dal bundle iniziale
const TrendChart = lazy(() => import('./components/TrendChart'));
import {
  Package, BarChart3, Plus, TrendingUp, Wallet, CheckCircle, Search, LayoutDashboard,
  PieChart as PieChartIcon, Loader2, Layers, DollarSign, Store, X, Edit, Settings,
  Users, Camera, UserPlus, Bell, Shield, Sparkles, AlertTriangle, TrendingDown,
  KeyRound, Copy, LogOut, Eye, EyeOff, Trophy, Trash2, Download, ArrowUpDown, Lock, Truck, StickyNote, ChevronDown, Mail, Sun, Moon,
  Image as ImageIcon, Lightbulb, Bug, HelpCircle, MoreHorizontal,
  Footprints, Shirt, Watch, ShoppingBag, Gem, Glasses, SprayCan, Smartphone,
  Disc3, ToyBrick, Coins, BookOpen, Palette, Guitar, Stamp
} from 'lucide-react';

// ==========================================
// CONFIGURAZIONE API
// ==========================================
// Stringa vuota = path relativo → il proxy Vite (o nginx in prod) smista le chiamate al backend
const API_URL = import.meta.env.VITE_API_URL || '';

// Tutte le chiamate API usano credentials: 'include' per inviare i cookies httpOnly
async function apiCall<T = any>(
  path: string, 
  opts: RequestInit = {}
): Promise<{ ok: boolean; data: T; status: number }> {
  const res = await fetch(`${API_URL}${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...opts.headers },
    ...opts,
  });
  
  // Auto-refresh token se scaduto
  if (res.status === 401) {
    const refreshRes = await fetch(`${API_URL}/auth/refresh`, { 
      method: 'POST', credentials: 'include' 
    });
    if (refreshRes.ok) {
      // Ritenta la richiesta originale
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
  purchasePrice: number; salePrice?: number; platform?: string; fees?: number; status: string;
  customShares?: string; photos?: string; createdAt?: string; soldAt?: string;
  marketPriceMin?: number; marketPriceMax?: number; marketPriceAvg?: number; authenticityScore?: number;
  trackingCode?: string; trackingCarrier?: string; trackingStatus?: string;
  trackingHistory?: string; trackingUpdatedAt?: string;
  notes?: string;
}

interface AppUser {
  id: string; name: string; email: string; twoFactorEnabled?: boolean;
  warehouses: Array<{ id: string; name: string; role: string; inviteCode: string | null; percentage: number; aiConfig: string | null }>;
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
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [user, setUser] = useState<AppUser | null>(null);
  const [bootLoading, setBootLoading] = useState(true);
  const [cookieConsent, setCookieConsent] = useState<boolean>(() => !!localStorage.getItem('hq_cookie_consent'));
  const [privacyOpen, setPrivacyOpen] = useState(false);
  const [marketingConsent, setMarketingConsent] = useState(false);
  
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
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
  
  // 2FA login
  const [require2FA, setRequire2FA] = useState(false);
  const [twoFactorCode, setTwoFactorCode] = useState('');
  
  const availableCategories = [
    { id: 'Scarpe', label: 'Scarpe', icon: '👟' },
    { id: 'Vestiti', label: 'Vestiti', icon: '👕' },
    { id: 'Pokemon', label: 'Pokémon', icon: '🃏' },
    { id: 'Orologi', label: 'Orologi', icon: '⌚' },
  ];
  
  // ----- DATA STATE -----
  const [products, setProducts] = useState<Product[]>([]);
  const [teamData, setTeamData] = useState<any[]>([]);
  const [notifications, setNotifications] = useState<AINotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [notifPanelOpen, setNotifPanelOpen] = useState(false);
  
  // ----- TEMA (scuro / chiaro / glass) -----
  const [theme, setTheme] = useState<'dark' | 'light' | 'glass'>(() => {
    try { return (localStorage.getItem('hq-theme') as 'dark' | 'light' | 'glass') || 'dark'; } catch { return 'dark'; }
  });
  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove('light', 'glass');
    if (theme === 'light' || theme === 'glass') root.classList.add(theme);
    try { localStorage.setItem('hq-theme', theme); } catch {}
  }, [theme]);

  // ----- UI STATE -----
  const [currentView, setCurrentView] = useState<'dashboard' | 'magazzino' | 'analytics' | 'tracking' | 'settings' | 'admin'>('dashboard');
  const [magazzinoView, setMagazzinoView] = useState<'instock' | 'sold'>('instock');
  const [searchTerm, setSearchTerm] = useState('');
  const [filterCat, setFilterCat] = useState('all');
  const [chartTimeframe, setChartTimeframe] = useState<'1D' | '1W' | '1M' | '1Y' | 'MAX'>('MAX');
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
  const [quantity, setQuantity] = useState('1');
  const [brand, setBrand] = useState('');
  const [name, setName] = useState('');
  const [size, setSize] = useState('42');
  const [condition, setCondition] = useState('DS');
  const [pokeName, setPokeName] = useState('');
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
  const [priceEstimate, setPriceEstimate] = useState<any>(null); // rimasto per compatibilità reset, non più usato in UI
  
  // ----- FOTO PRODOTTO -----
  const [productPhotos, setProductPhotos] = useState<string[]>([]);
  const [editPhotos, setEditPhotos] = useState<string[]>([]);

  // Quote condivise
  const [isSharedPurchase, setIsSharedPurchase] = useState(false);
  const [productShares, setProductShares] = useState<{userId: string, name: string, percentage: string | number}[]>([]);
  
  // ----- VENDITA & MODIFICA -----
  const [sellModalOpen, setSellModalOpen] = useState(false);
  const [productToSell, setProductToSell] = useState<{ids: string[], name: string, maxQty: number, suggestedPrice?: number, purchasePrice?: number} | null>(null);
  const [sellQuantity, setSellQuantity] = useState('1');
  const [sellPrice, setSellPrice] = useState('');
  const [sellPlatform, setSellPlatform] = useState('Vinted');
  const [sellPaymentMethod, setSellPaymentMethod] = useState('Nessuna Fee (Contanti/Bonifico)');
  const [sellFees, setSellFees] = useState('0');
  // Tracking opzionale della spedizione di vendita (OUTBOUND) direttamente nel flusso Vendi
  const [sellTrackingCode, setSellTrackingCode] = useState('');
  const [sellTrackingCarrier, setSellTrackingCarrier] = useState('Auto');
  
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [productToEdit, setProductToEdit] = useState<any>(null);
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
  const [isEditShared, setIsEditShared] = useState(false);
  const [editShares, setEditShares] = useState<{userId: string, name: string, percentage: string | number}[]>([]);
  
  // ----- TEAM -----
  const [isSavingTeam, setIsSavingTeam] = useState(false);
  const [newCatName, setNewCatName] = useState('');
  const [isAddingCat, setIsAddingCat] = useState(false);
  
  // ----- TOAST -----
  const [toast, setToast] = useState<{ msg: string; type: 'ok' | 'err' | 'warn'; action?: { label: string; onClick: () => void } } | null>(null);
  const toastRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Input fotocamera sempre montato: premendo "+" lo clicchiamo nel gesto utente
  // così su mobile la fotocamera si apre SUBITO (zero tap sprecati).
  const addCameraInputRef = useRef<HTMLInputElement | null>(null);
  const notifRef = useRef<HTMLDivElement | null>(null);
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

  // Long-press per entrare in selezione (sostituisce il tasto "Seleziona")
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFired = useRef(false);
  const startLongPress = (groupKey: string) => {
    longPressFired.current = false;
    longPressTimer.current = setTimeout(() => {
      longPressFired.current = true;
      setBulkMode(true);
      setSelectedGroupKeys(prev => { const n = new Set(prev); n.add(groupKey); return n; });
      if ('vibrate' in navigator) { try { navigator.vibrate(30); } catch {} }
    }, 450);
  };
  const cancelLongPress = () => {
    if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null; }
  };
  // Props riutilizzabili per ogni card: avvia/annulla long-press + click che gestisce toggle/edit
  const cardPressProps = (groupKey: string) => (!bulkMode ? {
    onMouseDown: () => startLongPress(groupKey),
    onMouseUp: cancelLongPress,
    onMouseLeave: cancelLongPress,
    onTouchStart: () => startLongPress(groupKey),
    onTouchEnd: cancelLongPress,
  } : {});
  const cardClick = (groupKey: string) => {
    if (longPressFired.current) { longPressFired.current = false; return; }
    if (bulkMode) toggleGroupSelection(groupKey);
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
  const [isImporting, setIsImporting] = useState(false);
  const [importErrors, setImportErrors] = useState<string[]>([]);

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

  // ----- ADMIN -----
  const [adminUsers, setAdminUsers] = useState<any[]>([]);
  const [adminLoading, setAdminLoading] = useState(false);
  const [adminLoaded, setAdminLoaded] = useState(false);
  const [adminPanelOpen, setAdminPanelOpen] = useState(false);
  const adminRefreshRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const ADMIN_EMAIL = 'noreply.hq.app@gmail.com';

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
  // Admin: vista corrente (Utenti / Richieste) + stato richieste
  const [adminView, setAdminView] = useState<'users' | 'feedback'>('users');
  const [adminFeedback, setAdminFeedback] = useState<any[]>([]);
  const [adminFbNuove, setAdminFbNuove] = useState(0);
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
    if (msg.length < 3) { showToast('Scrivi un messaggio un po’ più lungo', 'warn'); return; }
    setFeedbackSending(true);
    const { ok, data } = await apiCall('/api/feedback', {
      method: 'POST',
      body: JSON.stringify({ message: msg, type: feedbackType }),
    });
    setFeedbackSending(false);
    if (ok) {
      setFeedbackMsg('');
      showToast('Grazie! Il messaggio è stato inviato ✓');
    } else {
      showToast(data.error || 'Invio non riuscito', 'err');
    }
  };

  // ===== NOTIFICHE PUSH =====
  const pushSupported = typeof navigator !== 'undefined' && 'serviceWorker' in navigator && typeof window !== 'undefined' && 'PushManager' in window;

  const enablePush = async () => {
    if (!pushSupported) { showToast('Le notifiche non sono supportate su questo dispositivo/browser', 'warn'); return; }
    // Evita attese infinite: ogni passo ha un timeout
    const withTimeout = <T,>(p: Promise<T>, ms: number, label: string): Promise<T> =>
      Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('timeout:' + label)), ms))]);
    setPushBusy(true);
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') { showToast('Permesso notifiche negato', 'warn'); return; }
      const { ok, data } = await apiCall<any>('/api/push/vapid-public');
      if (!ok || !data?.key) { showToast('Push non ancora pronto lato server: attendi la fine del deploy e riprova', 'err'); return; }
      const reg = await withTimeout(navigator.serviceWorker.ready, 8000, 'sw');
      const existing = await reg.pushManager.getSubscription();
      const sub = existing || await withTimeout(reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(data.key) as BufferSource,
      }), 8000, 'subscribe');
      const res = await apiCall('/api/push/subscribe', { method: 'POST', body: JSON.stringify({ subscription: sub.toJSON() }) });
      if (res.ok) { setPushEnabled(true); localStorage.setItem('pushEnabled', '1'); showToast('Notifiche attivate ✓'); }
      else showToast('Errore salvataggio notifiche', 'err');
    } catch (err: any) {
      const msg = String(err?.message || '');
      showToast(msg.startsWith('timeout') ? 'Tempo scaduto: ricarica la pagina (per aggiornare l\'app) e riprova' : 'Errore attivazione notifiche', 'err');
    } finally { setPushBusy(false); }
  };

  const sendTestPush = async () => {
    setPushBusy(true);
    const { ok, data } = await apiCall('/api/push/test', { method: 'POST' });
    setPushBusy(false);
    if (ok) showToast('Notifica di prova inviata'); else showToast(data?.error || 'Errore invio', 'err');
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
      showToast('Notifiche disattivate');
    } catch { showToast('Errore', 'err'); }
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
    else showToast('Errore eliminazione', 'err');
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
  const [lotQty, setLotQty] = useState('');
  const [lotBrand, setLotBrand] = useState('');
  const [lotNotes, setLotNotes] = useState('');
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
    if (!shipTo.zip || shipTo.zip.length < 5) { showToast('Inserisci il CAP destinatario (5 cifre)', 'err'); return; }
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
        content: shippingProduct ? `${shippingProduct.brand} ${shippingProduct.name}` : 'Articolo',
      }),
    });
    setIsBooking(false);
    if (ok) {
      setShippingRef(data.reference);
      setShippingLabel(data.labelUrl);
      setShippingStep('done');
      if (data.labelHtml) {
        // Modalità demo: apri etichetta HTML in nuova finestra e stampa
        const w = window.open('', '_blank', 'width=600,height=800');
        if (w) { w.document.write(data.labelHtml); w.document.close(); }
      } else if (data.labelUrl) {
        window.open(data.labelUrl, '_blank');
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
  const [incSaving, setIncSaving] = useState(false);
  
  // ----- DERIVED -----
  const userCategories = user?.warehouses?.map(w => w.name.replace('Magazzino ', '')) || [];

  // Match tollerante tra la categoria rilevata dall'IA e i reparti esistenti:
  // gestisce maiuscole, accenti, spazi e SINONIMI (es. "Sneakers"/"Calzature" → reparto "Scarpe").
  // Così se un reparto esiste già, il prodotto ci finisce dentro invece di crearne un duplicato.
  const REPARTO_SYNONYMS: Record<string, string> = {
    scarpe: 'scarpe', scarpa: 'scarpe', sneakers: 'scarpe', sneaker: 'scarpe', calzature: 'scarpe', calzatura: 'scarpe', shoes: 'scarpe', shoe: 'scarpe', ginnastica: 'scarpe',
    vestiti: 'vestiti', vestito: 'vestiti', abbigliamento: 'vestiti', clothes: 'vestiti', clothing: 'vestiti', felpa: 'vestiti', felpe: 'vestiti', maglia: 'vestiti', maglietta: 'vestiti', magliette: 'vestiti', tshirt: 'vestiti', pantaloni: 'vestiti', giacca: 'vestiti', giacche: 'vestiti',
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
  const userInviteCodes = user?.warehouses?.filter(w => w.role === 'OWNER' && w.inviteCode) || [];
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
        const { ok, data } = await apiCall<{ user: AppUser }>('/auth/me');
        if (ok && data.user) {
          setUser(data.user);
          setIsAuthenticated(true);
        }
      } catch {
        // errore di rete o certificato non attendibile: mostra comunque il login
      } finally {
        setBootLoading(false);
      }
    })();
  }, []);
  
  // ==========================================
  // FETCH DATI
  // ==========================================
  const fetchProducts = useCallback(async () => {
    const { ok, data } = await apiCall<Product[]>('/products');
    if (ok && Array.isArray(data)) setProducts(data);
  }, []);
  
  const fetchTeam = useCallback(async () => {
    const { ok, data } = await apiCall<any[]>('/team');
    if (ok && Array.isArray(data)) setTeamData(data);
  }, []);
  
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
    fetchNotifications();
    checkStaleProducts();
    refreshMyPlan();
    
    // Polling notifiche ogni 30 secondi
    const interval = setInterval(fetchNotifications, 30000);
    // Controllo prodotti fermi ogni ora
    const staleInterval = setInterval(checkStaleProducts, 60 * 60 * 1000);
    return () => { clearInterval(interval); clearInterval(staleInterval); };
  }, [isAuthenticated, fetchProducts, fetchTeam, fetchNotifications, checkStaleProducts]);

  // Admin: badge richieste sempre aggiornato; carica dati quando si entra nella pagina Admin
  useEffect(() => {
    if (!isAuthenticated || user?.email?.toLowerCase() !== ADMIN_EMAIL.toLowerCase()) return;
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
      window.history.replaceState({}, '', '/');
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
      setActiveTemplate(ok && data?.fields?.length ? data : null);
    }).catch(() => setActiveTemplate(null));
  }, [category, isFormOpen]);
  
  // Init quote per acquisto condiviso (usa percentuali salvate del team, non divisione uguale)
  useEffect(() => {
    if (isSharedPurchase) {
      const currentTeam = teamData.find(t => t.warehouseName.replace('Magazzino ', '') === category);
      if (currentTeam && currentTeam.members.length > 0) {
        setProductShares(currentTeam.members.map((m: any) => ({
          userId: m.userId, name: m.name, percentage: m.percentage,
        })));
      }
    }
  }, [isSharedPurchase, category, teamData]);
  
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
  
  const activeProducts = filterCat === 'all' ? products : products.filter(p => p.category === filterCat);
  const stockValore = activeProducts.filter(p => p.status === 'IN STOCK').reduce((acc, p) => acc + p.purchasePrice, 0);
  const soldItemsTotal = activeProducts.filter(p => p.status === 'VENDUTO');
  const ricaviTotali = soldItemsTotal.reduce((acc, p) => acc + (p.salePrice || 0), 0);
  const costoVenduto = soldItemsTotal.reduce((acc, p) => acc + p.purchasePrice, 0);
  const totalFees = soldItemsTotal.reduce((acc, p) => acc + (p.fees || 0), 0);
  const profittoNetto = ricaviTotali - costoVenduto - totalFees;
  const roi = costoVenduto > 0 ? ((profittoNetto / costoVenduto) * 100).toFixed(2) : '0.00';
  
  const globalSold = products.filter(p => p.status === 'VENDUTO');
  const globalProfitto = globalSold.reduce((acc, p) => acc + ((p.salePrice || 0) - p.purchasePrice - (p.fees || 0)), 0);
  
  const mioProfitto = globalSold.reduce((acc, p) => {
    const profit = (p.salePrice || 0) - p.purchasePrice - (p.fees || 0);
    const shares = getShares(p);
    if (shares && shares.length > 0) {
      const myShare = shares.find((s: any) => s.userId === user?.id);
      return acc + (profit * ((myShare?.percentage || 0) / 100));
    } else {
      const team = teamData.find(t => t.warehouseName.replace('Magazzino ', '') === p.category);
      const myMember = team?.members?.find((m: any) => m.userId === user?.id);
      const myPct = myMember?.percentage ?? (team?.members?.length > 0 ? 100 / team.members.length : 100);
      return acc + (profit * (myPct / 100));
    }
  }, 0);
  
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
      const team = teamData.find(t => t.warehouseName.replace('Magazzino ', '') === p.category);
      if (team) {
        (team.members || []).forEach((m: any) => {
          if (!sociProfits[m.userId]) sociProfits[m.userId] = { name: m.name, profit: 0 };
          sociProfits[m.userId].profit += (profit * (m.percentage / 100));
        });
      }
    }
  });
  
  const filterByTimeframe = (dateString?: string) => {
    if (!dateString) return true;
    const date = new Date(dateString);
    const now = new Date();
    const diffDays = Math.ceil(Math.abs(now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24));
    switch (chartTimeframe) {
      case '1D': return diffDays <= 1;
      case '1W': return diffDays <= 7;
      case '1M': return diffDays <= 30;
      case '1Y': return diffDays <= 365;
      default: return true;
    }
  };
  
  const trendData = useMemo(() => Object.values(
    soldItemsTotal.filter(p => filterByTimeframe(p.soldAt || p.createdAt)).reduce((acc, p) => {
      const dateKey = (p.soldAt ? new Date(p.soldAt) : new Date())
        .toLocaleDateString('it-IT', { day: '2-digit', month: 'short' });
      if (!acc[dateKey]) acc[dateKey] = { date: dateKey, Ricavi: 0, Profitto: 0 };
      acc[dateKey].Ricavi += (p.salePrice || 0);
      acc[dateKey].Profitto += ((p.salePrice || 0) - p.purchasePrice - (p.fees || 0));
      return acc;
    }, {} as Record<string, any>)
  ), [soldItemsTotal, chartTimeframe]);

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
  const weekProfit = weekSales.reduce((a, p) => a + ((p.salePrice || 0) - p.purchasePrice - (p.fees || 0)), 0);
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
      const key = `${cat}-${p.brand.toLowerCase()}-${p.name.toLowerCase()}-${p.size}-${p.condition}`;
      if (!acc[key]) acc[key] = { ...p, category: cat, quantity: 0, ids: [], oldestDate: p.createdAt };
      acc[key].quantity += 1;
      acc[key].ids.push(p.id);
      if (p.createdAt && (!acc[key].oldestDate || p.createdAt < acc[key].oldestDate)) {
        acc[key].oldestDate = p.createdAt;
      }
      return acc;
    }, {} as Record<string, any>));
    return grouped.sort((a: any, b: any) => {
      let av: any, bv: any;
      if (sortField === 'price') { av = a.purchasePrice; bv = b.purchasePrice; }
      else if (sortField === 'name') { av = `${a.brand} ${a.name}`; bv = `${b.brand} ${b.name}`; }
      else { av = a.oldestDate || a.createdAt || ''; bv = b.oldestDate || b.createdAt || ''; }
      if (sortDir === 'asc') return av > bv ? 1 : -1;
      return av < bv ? 1 : -1;
    });
  }, [searchedProducts, filterCondition, filterPriceMin, filterPriceMax, sortField, sortDir, staleOnly]);

  const groupedSoldArray = Object.values(searchedProducts.filter(p => p.status === 'VENDUTO').reduce((acc, p) => {
    const cat = p.category || 'Scarpe';
    const plat = p.platform || 'Privato';
    const key = `${cat}-${p.brand.toLowerCase()}-${p.name.toLowerCase()}-${p.size}-${p.salePrice}-${plat}`;
    if (!acc[key]) acc[key] = { ...p, category: cat, platform: plat, quantity: 0, totalRevenue: 0, totalProfit: 0, totalFees: 0, ids: [] };
    acc[key].quantity += 1;
    acc[key].ids.push(p.id);
    acc[key].totalRevenue += (p.salePrice || 0);
    acc[key].totalFees += (p.fees || 0);
    acc[key].totalProfit += ((p.salePrice || 0) - p.purchasePrice - (p.fees || 0));
    return acc;
  }, {} as Record<string, any>));
  
  // ==========================================
  // HANDLERS AUTH
  // ==========================================
  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    setAuthPasswordErrors([]);
    
    if (authMode === 'register' && regType === 'new_team' && regCategories.length === 0) {
      setAuthError('Seleziona almeno una categoria per la tua Azienda');
      return;
    }
    
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
  const handleAddCategory = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newCatName) return;
    setIsAddingCat(true);
    showToast('Creo il reparto e genero icona con IA…', 'ok');
    const { ok, data } = await apiCall('/warehouses', {
      method: 'POST', body: JSON.stringify({ name: newCatName })
    });
    setIsAddingCat(false);
    if (ok) {
      setUser(data.user);
      setNewCatName('');
      fetchTeam();
      // L'icona del reparto è lucide (getCategoryIcon mappa per nome) — niente emoji nel toast
      showToast(`Reparto "${newCatName}" aggiunto!`);
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
    setPriceEstimate(null);
    setSize('42'); // default comodo (taglia scarpa più comune) — sempre modificabile
    setIsFormOpen(true);
    // Apri SUBITO la fotocamera nello stesso gesto del tap su "+"
    // (deve essere sincrono: niente setTimeout o il browser blocca la camera).
    // Solo su dispositivi touch (mobile/tablet): su desktop eviterei un dialog file a sorpresa.
    const isTouch = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches;
    if (isTouch) addCameraInputRef.current?.click();
  };

  // Crea al volo il reparto rilevato dall'IA (modalità Automatica) e lo seleziona.
  // Restituisce il nome del reparto creato (o null), così il salvataggio può usarlo subito.
  const createRepartoFromDetected = async (rawName: string): Promise<string | null> => {
    const nm = (rawName || '').trim();
    if (!nm || isAddingCat) return null;
    setIsAddingCat(true);
    showToast(`Creo il reparto "${nm}" con icona IA…`, 'ok');
    const { ok, data } = await apiCall('/warehouses', {
      method: 'POST', body: JSON.stringify({ name: nm })
    });
    setIsAddingCat(false);
    if (ok) {
      setUser(data.user);
      fetchTeam();
      setCategory(nm);        // seleziona il nuovo reparto (userCategories rimuove "Magazzino ")
      setDetectedReparto('');
      showToast(`Reparto "${nm}" creato e selezionato`);
      return nm;
    }
    showToast(data.error || 'Errore creazione reparto', 'err');
    return null;
  };

  // ==========================================
  // PIANI & STRUMENTI PRO
  // ==========================================
  const refreshMyPlan = async () => {
    const me = await apiCall<any>('/api/plans/me');
    if (me.ok) { setMyPlan(me.data.plan); setMyFeatures(me.data.features || []); }
  };
  const openPlanModal = async (tab: 'plans' | 'repricing' | 'offer' | 'channels' = 'plans') => {
    setPlanModalOpen(true);
    setProTab(tab);
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
    if (!offerProductId || !offerAmount) { showToast('Scegli prodotto e offerta', 'warn'); return; }
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
    if (!chProductId) { showToast('Scegli un prodotto', 'warn'); return; }
    setChSaving(true);
    const channels = chSelected.map(p => ({ platform: p, status: 'listed' }));
    const { ok, data } = await apiCall<any>(`/api/pro/channels/${chProductId}`, {
      method: 'PUT', body: JSON.stringify({ channels }),
    });
    setChSaving(false);
    if (ok) showToast('Canali salvati ✓');
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
        <button onClick={() => setProTab('plans')} className="mt-4 px-4 py-2 rounded-xl text-xs font-bold bg-[#8b5cf6] hover:bg-[#a78bfa] text-white">Vedi i piani</button>
      </div>
    );
  };

  // ==========================================
  // TEAM QUOTE
  // ==========================================
  const updateMemberPercentage = (warehouseId: string, membershipId: string, newPct: string) => {
    setTeamData(prev => prev.map(team => {
      if (team.warehouseId === warehouseId) {
        return { ...team, members: team.members.map((m: any) => 
          m.membershipId === membershipId ? { ...m, percentage: newPct } : m
        ) };
      }
      return team;
    }));
  };
  
  const savePercentages = async (warehouseId: string, members: any[]) => {
    const total = members.reduce((s, m) => s + (Number(m.percentage) || 0), 0);
    if (Math.round(total) !== 100) {
      showToast('Le percentuali devono sommare a 100%', 'err');
      return;
    }
    setIsSavingTeam(true);
    const { ok, data } = await apiCall('/team/percentage', {
      method: 'PUT',
      body: JSON.stringify({
        warehouseId,
        updates: members.map(m => ({
          userId: m.userId, membershipId: m.membershipId, percentage: Number(m.percentage)
        })),
      }),
    });
    setIsSavingTeam(false);
    if (ok) {
      showToast('Quote salvate con successo');
      fetchTeam();
    } else showToast(data.error || 'Errore', 'err');
  };
  
  // ==========================================
  // FOTO & IA — multi-photo (1-5)
  // ==========================================
  const applyAIScanResult = async (data: any, cat: string) => {
    const scan = data.scan;
    setScanResult(scan);
    setScanMarket(null);
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
    if (effCat === 'Pokemon') {
      if (scan.model) setPokeName(scan.model);
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

    // Verifica su eBay: conferma il riconoscimento con dati reali di mercato (valore + n. annunci).
    // Oggi solo eBay; in futuro eBay + StockX. Non blocca: gira in background.
    const vQuery = [scan.brand, scan.model || d.type].filter(Boolean).join(' ').trim();
    if (vQuery.length >= 2) {
      apiCall<any>('/api/ai/market-value', {
        method: 'POST',
        body: JSON.stringify({ query: vQuery, size: (d.size || '').toString() || undefined, condition: condition || undefined }),
      }).then(r => { if (r.ok) setScanMarket(r.data); }).catch(() => {});
    }
  };

  const runAIScan = async (imageBase64: string, cat: string) => {
    setIsScanning(true);
    setScanResult(null); setScanMarket(null); setPriceEstimate(null);
    try {
      // Modalità automatica (cat vuota o sentinella): non inviamo la categoria,
      // l'IA la rileva dalla foto e adatta i campi.
      const isAuto = !cat || cat === AUTO_CATEGORY;
      const { ok, data } = await apiCall('/api/ai/full-scan', {
        method: 'POST',
        body: JSON.stringify(isAuto ? { imageBase64, existingCategories: userCategories } : { imageBase64, category: cat }),
      });
      if (ok) await applyAIScanResult(data, cat);
      else showToast(data.error || 'Errore IA', 'err');
    } catch { showToast('Errore IA', 'err'); }
    finally { setIsScanning(false); }
  };

  const handlePhotoAdd = async (e: React.ChangeEvent<HTMLInputElement>, isEdit = false) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    const current = isEdit ? editPhotos : productPhotos;
    const remaining = 5 - current.length;
    if (remaining <= 0) { showToast('Massimo 5 foto per prodotto', 'warn'); return; }
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
      // Sempre re-scan con la nuova foto (reset risultati precedenti)
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
      setProductPhotos(prev => prev.filter((_, i) => i !== index));
      // Reset risultati IA quando si rimuove una foto
      setScanResult(null);
      setPriceEstimate(null);
    }
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
    const { ok, data } = await apiCall('/products/lot', {
      method: 'POST',
      body: JSON.stringify({
        category: lotCategory,
        lotName: lotName.trim(),
        totalPrice: total,
        quantity: qty,
        brand: lotBrand.trim() || null,
        notes: lotNotes.trim() || null,
      }),
    });
    if (ok) {
      await fetchProducts();
      setLotOpen(false);
      setLotName(''); setLotCategory(''); setLotTotal(''); setLotQty(''); setLotBrand(''); setLotNotes('');
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
        showToast('La somma delle quote deve essere 100%', 'err');
        return;
      }
    }
    
    setIsSaving(true);
    const qty = parseInt(quantity) || 1;
    const unitPrice = parseFloat(price);
    
    let finalBrand = brand, finalName = name, finalSize = size, finalCondition = condition;
    // Categoria effettiva: se non è selezionata ma l'IA ha rilevato un reparto, lo creo al volo e lo uso.
    let effCategory = category;
    if (!effCategory || effCategory === AUTO_CATEGORY) {
      if (detectedReparto) {
        const created = await createRepartoFromDetected(detectedReparto);
        if (!created) { setIsSaving(false); return; }
        effCategory = created;
      } else {
        showToast('Aggiungi una foto o scegli un reparto', 'err'); setIsSaving(false); return;
      }
    }
    if (isNaN(unitPrice) || unitPrice <= 0) { showToast('Inserisci un prezzo valido', 'err'); setIsSaving(false); return; }

    if (effCategory === 'Pokemon') {
      if (!pokeName) { showToast('Inserisci il nome della carta', 'err'); setIsSaving(false); return; }
      finalBrand = 'Pokémon'; finalName = pokeName; finalSize = 'Unisize';
      finalCondition = pokeGraded === 'Si' ? `Gradata ${pokeGrade}` : 'Raw (Non Gradata)';
    } else if (effCategory === 'Orologi') {
      if (!watchBrand || !watchModel) { showToast('Compila brand e modello orologio', 'err'); setIsSaving(false); return; }
      finalBrand = watchBrand; finalName = watchModel;
      finalSize = watchCase ? `${watchCase}mm${watchStrap ? ', ' + watchStrap : ''}` : (watchStrap || '-');
      finalCondition = watchMaterial ? `${condition} (${watchMaterial})` : condition;
    } else {
      if (!brand || !name) { showToast('Compila brand e nome prodotto', 'err'); setIsSaving(false); return; }
      // Per categorie custom, arricchisci il nome con materiale/colore se compilati
      if (effCategory !== 'Scarpe' && effCategory !== 'Vestiti') {
        const extras = [watchMaterial, watchStrap].filter(Boolean);
        if (extras.length > 0) finalName = `${name} — ${extras.join(', ')}`;
      }
    }
    
    // Snapshot delle percentuali attuali del team: rende ogni prodotto indipendente
    // dalle future modifiche alle quote nelle impostazioni
    const currentTeam = teamData.find(t => t.warehouseName.replace('Magazzino ', '') === effCategory);
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
            customShares: finalShares,
            photos: productPhotos.length > 0 ? productPhotos : undefined,
            attributes: Object.keys(dynamicAttrs).length > 0 ? dynamicAttrs : undefined,
            // Valore di mercato verificato da eBay durante lo scan: lo salviamo nel
            // prodotto così listing generator e riprezzamento usano dati reali.
            ...(scanMarket?.value ? { marketPriceAvg: Math.round(scanMarket.value) } : {}),
          }),
        });
        if (!ok) hasError = true;
      }
      
      if (hasError) showToast('Errore nel salvataggio', 'err');
      else {
        await fetchProducts();
        setIsFormOpen(false);
        showToast('Prodotto aggiunto al magazzino');
      }

      // Reset
      setBrand(''); setName(''); setPrice(''); setQuantity('1');
      setPokeName(''); setWatchBrand(''); setWatchModel('');
      setWatchCase(''); setWatchStrap(''); setWatchMaterial('');
      setIsSharedPurchase(false); setProductShares([]);
      setScanResult(null); setPriceEstimate(null);
      setProductPhotos([]);
      setDynamicAttrs({});
    } catch (err) {
      showToast('Errore di connessione', 'err');
    } finally { setIsSaving(false); }
  };
  
  const openSellModal = (ids: string[], itemName: string, p: Product) => {
    setProductToSell({
      ids, name: itemName, maxQty: ids.length,
      purchasePrice: p.purchasePrice,
    });
    setSellQuantity(ids.length.toString());
    setSellPrice('');
    setSellTrackingCode(''); setSellTrackingCarrier('Auto');
    setSellModalOpen(true);
  };
  
  const confirmSell = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!productToSell) return;
    
    const qtyToProcess = parseInt(sellQuantity) || 1;
    const idsToProcess = productToSell.ids.slice(0, qtyToProcess);
    const unitSalePrice = parseFloat(sellPrice) / qtyToProcess;
    const unitFees = (parseFloat(sellFees) || 0) / qtyToProcess;
    
    let hasError = false;
    for (const id of idsToProcess) {
      const { ok } = await apiCall(`/products/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ salePrice: unitSalePrice, platform: sellPlatform, fees: unitFees }),
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
    if (hasError) showToast('Errore nella vendita', 'err');
    else {
      await fetchProducts();
      setSellModalOpen(false);
      setProductToSell(null);
      showToast('Vendita registrata!', 'ok', { label: 'Annulla', onClick: () => undoSellIds(idsToProcess) });
    }
  };
  
  const openEditModal = (group: any) => {
    setProductToEdit(group);
    setEditBrand(group.brand); setEditName(group.name);
    setEditSize(group.size); setEditCondition(group.condition);
    setEditPrice(group.purchasePrice.toString());
    const shares = group.customShares && group.customShares !== '[]'
      ? JSON.parse(group.customShares) : [];
    setEditShares(shares);
    setIsEditShared(shares.length > 0);
    try {
      const photos = group.photos ? JSON.parse(group.photos) : [];
      setEditPhotos(Array.isArray(photos) ? photos : []);
    } catch { setEditPhotos([]); }
    setValuation(null);
    setEditModalOpen(true);
  };

  // Valutazione di mercato del prodotto (fonte reale, anti-falsi)
  const fetchValuation = async (group: any) => {
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
        showToast('Non riconosciuto — riprova con una foto più nitida del logo/etichetta', 'warn');
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
      showToast('Errore', 'err');
      setSourcingScanning(false); setSourcingCalcLoading(false);
    }
  };
  
  const handleSaveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (isEditShared && editShares.length > 0) {
      const total = editShares.reduce((s, x) => s + (Number(x.percentage) || 0), 0);
      if (Math.round(total) !== 100) { showToast('Le quote devono sommare a 100%', 'err'); return; }
    }
    
    // Se l'utente non ha toccato le quote, usa le shares originali del prodotto come snapshot
    // (così non vengono sovrascritte con null nel DB)
    const originalShares = productToEdit.customShares && productToEdit.customShares !== '[]'
      ? JSON.parse(productToEdit.customShares) : undefined;
    const editTeam = teamData.find(t => t.warehouseName.replace('Magazzino ', '') === productToEdit.category);
    const editSnapshotShares = editTeam?.members?.length > 0
      ? editTeam.members.map((m: any) => ({ userId: m.userId, name: m.name, percentage: m.percentage }))
      : undefined;
    const finalEditShares = isEditShared && editShares.length > 0
      ? editShares
      : (originalShares ?? editSnapshotShares);

    setIsSaving(true);
    let hasError = false;
    for (const id of productToEdit.ids) {
      const { ok } = await apiCall(`/products/${id}/edit`, {
        method: 'PUT',
        body: JSON.stringify({
          category: productToEdit.category,
          brand: editBrand, name: editName, size: editSize, condition: editCondition,
          purchasePrice: parseFloat(editPrice),
          customShares: finalEditShares,
          photos: editPhotos.length > 0 ? editPhotos : undefined,
        }),
      });
      if (!ok) hasError = true;
    }
    setIsSaving(false);
    if (hasError) showToast('Errore nella modifica', 'err');
    else {
      await fetchProducts();
      setEditModalOpen(false);
      setProductToEdit(null);
      showToast('Prodotto modificato');
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
    const ids: string[] = [];
    (groupedInStockArray as any[]).forEach((g: any) => {
      if (selectedGroupKeys.has(g.ids.join(','))) ids.push(...g.ids);
    });
    return ids;
  };

  // Undo: ripristina prodotti eliminati / riporta in stock prodotti venduti
  const undoDeleteIds = async (ids: string[]) => {
    await Promise.allSettled(ids.map(id => apiCall(`/products/${id}/restore`, { method: 'POST' })));
    await fetchProducts();
    showToast('Eliminazione annullata');
  };
  const undoSellIds = async (ids: string[]) => {
    await Promise.allSettled(ids.map(id => apiCall(`/products/${id}/return`, { method: 'POST' })));
    await fetchProducts();
    showToast('Vendita annullata — di nuovo in stock');
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
    setBulkMode(false);
    await fetchProducts();
    errors > 0 ? showToast(`Eliminati con ${errors} errori`, 'warn') : showToast(`${ids.length} prodotti eliminati`, 'ok', { label: 'Annulla', onClick: () => undoDeleteIds(ids) });
  };

  const handleBulkSell = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsBulkProcessing(true);
    const ids = getBulkSelectedIds();
    const salePrice = parseFloat(bulkSellPrice);
    const fees = parseFloat(bulkSellFees) || 0;
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
    setBulkMode(false);
    await fetchProducts();
    errors > 0 ? showToast(`Vendite con ${errors} errori`, 'warn') : showToast(`${ids.length} prodotti venduti!`, 'ok', { label: 'Annulla', onClick: () => undoSellIds(ids) });
  };

  // Reso: riporta un pezzo venduto in stock (operazione inversa della vendita) — immediato, niente conferma
  const handleReturn = async (group: any) => {
    const id = group.ids?.[0];
    if (!id) return;
    const { ok } = await apiCall(`/products/${id}/return`, { method: 'POST' });
    if (ok) { await fetchProducts(); showToast('Reso registrato — prodotto in stock'); }
    else showToast('Errore durante il reso', 'err');
  };

  // ==========================================
  // IMPORT EXCEL
  // ==========================================
  const handleExcelFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const data = await file.arrayBuffer();
      const XLSX = await import('xlsx');
      const workbook = XLSX.read(data, { type: 'array' });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const raw: any[] = XLSX.utils.sheet_to_json(sheet, { defval: '' });
      if (raw.length === 0) { showToast('File vuoto o formato non riconosciuto', 'err'); return; }
      const normalize = (k: string) => k.toLowerCase().trim().replace(/[_\s]+/g, ' ');
      const parsed = raw.map((row: any) => {
        const r: any = {};
        Object.keys(row).forEach(k => {
          const n = normalize(k);
          if (['brand', 'marca', 'marchio'].includes(n)) r.brand = String(row[k]).trim();
          else if (['nome', 'modello', 'name', 'model', 'descrizione', 'prodotto'].includes(n)) r.name = String(row[k]).trim();
          else if (['taglia', 'size', 'misura'].includes(n)) r.size = String(row[k]).trim();
          else if (['condizione', 'condition', 'stato'].includes(n)) r.condition = String(row[k]).trim();
          else if (['prezzo', 'price', 'prezzo acquisto', 'costo', 'purchase price'].includes(n)) r.price = parseFloat(String(row[k])) || 0;
          else if (['categoria', 'category', 'reparto', 'tipo'].includes(n)) r.category = String(row[k]).trim();
        });
        return r;
      });
      setImportRows(parsed);
      setImportCategory(userCategories[0] || '');
      setImportErrors([]);
      setImportOpen(true);
    } catch { showToast('Errore lettura file. Usa .xlsx, .xls o .csv', 'err'); }
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
    let success = 0, fail = 0;
    for (const row of valid) {
      const cat = row.category && userCategories.includes(row.category) ? row.category : importCategory;
      const { ok } = await apiCall('/products', {
        method: 'POST',
        body: JSON.stringify({
          category: cat, brand: row.brand, name: row.name,
          size: row.size || 'Unisize', condition: row.condition || 'DS', price: row.price,
        }),
      });
      ok ? success++ : fail++;
    }
    setIsImporting(false);
    await fetchProducts();
    setImportOpen(false); setImportRows([]); setImportErrors([]);
    fail > 0 ? showToast(`Importati ${success}, errori: ${fail}`, 'warn') : showToast(`${success} prodotti importati!`);
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
      showToast('Errore eliminazione — ricarico la lista', 'err');
      await fetchProducts(); // Re-sync se ci sono stati errori
    } else {
      showToast('Prodotto eliminato', 'ok', { label: 'Annulla', onClick: () => undoDeleteIds(ids) });
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
      showToast('Tracking salvato!');
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
    if (!incCategory) { showToast('Scegli un reparto', 'warn'); return; }
    if (!incBrand.trim() || !incName.trim()) { showToast('Inserisci brand e nome', 'warn'); return; }
    const priceNum = parseFloat(incPrice);
    if (isNaN(priceNum) || priceNum <= 0) { showToast('Inserisci un prezzo d\'acquisto valido', 'warn'); return; }
    if (incTrackCode.trim().length < 4) { showToast('Inserisci un codice tracking valido', 'warn'); return; }
    setIncSaving(true);
    const { ok, data } = await apiCall<any>('/products', {
      method: 'POST',
      body: JSON.stringify({ category: incCategory, brand: incBrand.trim(), name: incName.trim(), price: priceNum }),
    });
    if (!ok || !data?.id) { setIncSaving(false); showToast(data?.error || 'Errore creazione prodotto', 'err'); return; }
    const t = await apiCall(`/tracking/${data.id}`, {
      method: 'POST',
      body: JSON.stringify({ trackingCode: incTrackCode.trim(), carrier: incTrackCarrier, direction: 'INBOUND' }),
    });
    setIncSaving(false);
    await fetchProducts();
    setIncomingOpen(false);
    showToast(t.ok ? 'Acquisto in arrivo aggiunto e tracciato' : 'Prodotto creato, ma tracking non salvato', t.ok ? 'ok' : 'warn');
  };

  const handleRefreshTracking = async () => {
    if (!trackingProduct) return;
    setIsRefreshingTracking(true);
    const { ok, data } = await apiCall(`/tracking/${trackingProduct.ids[0]}/refresh`, { method: 'POST' });
    setIsRefreshingTracking(false);
    if (ok) {
      setTrackingDetail(data);
      await fetchProducts();
      showToast('Tracking aggiornato!');
    } else {
      showToast('Errore aggiornamento tracking', 'err');
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
      showToast('Stato aggiornato');
      if (status === 'DELIVERED') setTrackingModalOpen(false);
    } else showToast(data?.error || 'Errore aggiornamento stato', 'err');
  };

  // Link pubblico di tracciamento (nessun account/API): apre un tracker universale
  const trackingPublicUrl = (code: string) => `https://parcelsapp.com/en/tracking/${encodeURIComponent(code)}`;

  const handleRemoveTracking = async () => {
    if (!trackingProduct) return;
    const { ok } = await apiCall(`/tracking/${trackingProduct.ids[0]}`, { method: 'DELETE' });
    if (ok) {
      showToast('Tracking rimosso');
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
      showToast('Le password non corrispondono', 'err');
      return;
    }
    setChangePwdLoading(true);
    const { ok, data } = await apiCall('/auth/password', {
      method: 'PUT',
      body: JSON.stringify({ currentPassword: changePwdCurrent, newPassword: changePwdNew }),
    });
    setChangePwdLoading(false);
    if (ok) {
      showToast('Password cambiata! Rieffettua il login.');
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
      <div className="min-h-screen bg-[var(--surface-2)] flex flex-col items-center justify-center gap-6">
        <HQLoader />
        {/* Skeleton cards */}
        <div className="w-full max-w-sm px-6 space-y-3 mt-4">
          {[1,2,3].map(i => (
            <div key={i} className="skeleton h-14 w-full" style={{ opacity: 1 - i * 0.2 }} />
          ))}
        </div>
      </div>
    );
  }
  
  // ==========================================
  // RENDER: SCHERMATA AUTH
  // ==========================================
  if (!isAuthenticated) {
    return (
      <div className="min-h-screen bg-[var(--surface-2)] flex items-center justify-center p-4 font-sans">
        <div className="bg-[var(--surface)] border border-[var(--border)] p-8 rounded-3xl w-full max-w-md">
          {/* Logo HQ centrato */}
          <div className="flex justify-center mb-6">
            <div className="relative w-14 h-16">
              <span className="absolute top-0 left-0 text-[3rem] font-black leading-none text-[var(--text)]">H</span>
              <span className="absolute bottom-0 right-0 text-[3rem] font-black leading-none text-[var(--text)]/40">Q</span>
            </div>
          </div>
          <p className="text-center text-[var(--text-soft)] text-sm mb-8">
            {authMode === 'login' ? 'Accedi al tuo account' : 'Crea il tuo account'}
          </p>
          
          <form onSubmit={handleAuth} className="space-y-4">
            {require2FA ? (
              <div className="bg-blue-500/10 border border-blue-500/30 p-5 rounded-2xl">
                <div className="flex items-center gap-2 mb-3">
                  <Shield className="text-blue-500" size={20} />
                  <h3 className="text-[var(--text)] font-bold">Verifica 2FA</h3>
                </div>
                <p className="text-xs text-[var(--text-muted)] mb-4">
                  Inserisci il codice a 6 cifre dalla tua app authenticator (o un codice di backup).
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
                          regType === 'new_team' ? 'bg-[#8b5cf6] text-[var(--text)]' : 'text-[var(--text-soft)]'
                        }`}>Fonda un'Azienda</button>
                      <button type="button" onClick={() => setRegType('join_team')}
                        className={`flex-1 py-2 text-xs font-bold rounded-lg transition-colors ${
                          regType === 'join_team' ? 'bg-blue-600 text-[var(--text)]' : 'text-[var(--text-soft)]'
                        }`}>Entra in un Team</button>
                    </div>
                    
                    <div>
                      <label className="text-xs font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">Il tuo Nome</label>
                      <input type="text" required value={authName} onChange={e => setAuthName(e.target.value)}
                        className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-[var(--text)] focus:border-[#8b5cf6] outline-none"
                        placeholder="Es. Mario Rossi" />
                    </div>
                    
                    {regType === 'new_team' && (
                      <div className="mt-6 mb-4 border-t border-[var(--border-2)] pt-6">
                        <h3 className="text-lg font-bold text-[var(--text)] flex items-center gap-2 mb-1">
                          <Layers className="text-[var(--text)]" size={18} /> I tuoi Reparti
                        </h3>
                        <p className="text-xs text-[var(--text-soft)] mb-4">Seleziona cosa venderà la tua nuova azienda.</p>
                        <div className="grid grid-cols-2 gap-3">
                          {availableCategories.map(cat => (
                            <button key={cat.id} type="button" onClick={() => {
                              regCategories.includes(cat.id)
                                ? setRegCategories(regCategories.filter(c => c !== cat.id))
                                : setRegCategories([...regCategories, cat.id]);
                            }}
                              className={`p-4 rounded-xl border flex flex-col items-center justify-center gap-2 transition-all ${
                                regCategories.includes(cat.id)
                                  ? 'bg-[#8b5cf6]/10 border-[#8b5cf6] text-[var(--text)] shadow-[0_0_15px_rgba(139,92,246,0.2)]'
                                  : 'bg-[var(--surface-2)] border-[var(--border-2)] text-[var(--text-soft)] hover:border-gray-600 hover:text-gray-300'
                              }`}>
                              <span className="text-2xl">{cat.icon}</span>
                              <span className="text-sm font-bold">{cat.label}</span>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                    
                    {regType === 'join_team' && (
                      <div className="mt-6 mb-4 border-t border-[var(--border-2)] pt-6">
                        <h3 className="text-lg font-bold text-[var(--text)] flex items-center gap-2 mb-1">
                          <UserPlus className="text-blue-500" size={18} /> Codice Invito
                        </h3>
                        <p className="text-xs text-[var(--text-soft)] mb-4">Inserisci il codice fornito dal tuo socio.</p>
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
                    className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-[var(--text)] focus:border-[#8b5cf6] outline-none"
                    placeholder="mario@email.com" />
                </div>
                
                <div>
                  <label className="text-xs font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">Password</label>
                  <div className="relative">
                    <input type={showPassword ? 'text' : 'password'} required value={authPassword}
                      onChange={e => setAuthPassword(e.target.value)}
                      className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 pr-12 text-[var(--text)] focus:border-[#8b5cf6] outline-none"
                      placeholder="••••••••" />
                    <button type="button" onClick={() => setShowPassword(s => !s)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--text-soft)] hover:text-[var(--text)]">
                      {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                    </button>
                  </div>
                  {authMode === 'register' && (
                    <p className="text-[10px] text-[var(--text-soft)] mt-2">
                      Almeno 10 caratteri, una maiuscola, un numero e un carattere speciale.
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
              <div className="space-y-3 mt-4">
                <label className="flex items-start gap-3 cursor-pointer">
                  <input type="checkbox" required className="mt-0.5 shrink-0 accent-white w-4 h-4 rounded" />
                  <span className="text-[12px] text-[var(--text-soft)] leading-relaxed">
                    Ho letto e accetto la{' '}
                    <button type="button" onClick={() => setPrivacyOpen(true)} className="text-[var(--text)] underline underline-offset-2 hover:no-underline">
                      Privacy Policy
                    </button>
                    {' '}e il trattamento dei dati personali ai sensi del Regolamento UE 2016/679 (GDPR), incluso l'invio delle foto caricate a fornitori terzi di IA (Google Gemini, Groq) per il riconoscimento prodotto.{' '}
                    <span className="text-[var(--text-faint)]">Obbligatorio</span>
                  </span>
                </label>
                <label className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={marketingConsent}
                    onChange={e => setMarketingConsent(e.target.checked)}
                    className="mt-0.5 shrink-0 accent-white w-4 h-4 rounded"
                  />
                  <span className="text-[12px] text-[var(--text-soft)] leading-relaxed">
                    Acconsento a ricevere comunicazioni via email relative ad aggiornamenti del servizio, nuove funzionalità e novità di HQ. Il consenso è revocabile in qualsiasi momento dalle impostazioni del profilo.{' '}
                    <span className="text-[var(--text-faint)]">Facoltativo</span>
                  </span>
                </label>
              </div>
            )}

            <button type="submit" disabled={authLoading}
              className="w-full bg-[#8b5cf6] hover:bg-[#a78bfa] py-3 rounded-xl text-[var(--text)] font-bold transition-all disabled:opacity-50 mt-4 flex items-center justify-center">
              {authLoading ? <Loader2 className="animate-spin" size={20} /> :
                require2FA ? 'Verifica 2FA' : (authMode === 'login' ? 'Entra' : 'Registrati')}
            </button>
          </form>
          
          <div className="mt-6 text-center">
            <button type="button" 
              onClick={() => { setAuthMode(authMode === 'login' ? 'register' : 'login'); setAuthError(null); }}
              className="text-[var(--text-soft)] hover:text-[var(--text)] text-sm transition-colors font-bold">
              {authMode === 'login' ? 'Non hai un account? Registrati' : 'Hai già un account? Accedi'}
            </button>
          </div>
        </div>
      </div>
    );
  }
  

  // ========================================
  // RENDER PRINCIPALE - APP AUTENTICATA
  // ========================================
  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)] lg:pl-60" style={{ fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'SF Pro Text', 'Helvetica Neue', system-ui, sans-serif", paddingBottom: 'calc(5rem + env(safe-area-inset-bottom))' }}>

      {/* ========== SIDEBAR (solo desktop) ========== */}
      <aside className="hidden lg:flex lg:flex-col fixed left-0 top-0 bottom-0 w-60 z-40 bg-[var(--surface)] border-r border-[var(--border)] px-3 pt-6 pb-6">
        {/* Brand */}
        <div className="px-3 mb-7 flex items-center">
          <div className="relative w-[1.7rem] h-[1.8rem] shrink-0">
            <span className="absolute top-0 left-0 text-[1.25rem] font-black leading-none text-[var(--text)]">H</span>
            <span className="absolute bottom-0 right-[-2px] text-[1.25rem] font-black leading-none text-[var(--text)]/50">Q</span>
          </div>
          <span className="ml-2.5 text-[11px] font-bold uppercase tracking-[0.18em] text-[var(--text-faint)]">Reseller</span>
        </div>
        {/* Nav */}
        <nav className="flex flex-col gap-1">
          {[
            { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
            { id: 'magazzino', label: 'Magazzino', icon: Package },
            { id: 'analytics', label: 'Analytics', icon: BarChart3 },
            { id: 'tracking', label: 'Tracking', icon: Truck },
            { id: 'settings', label: 'Impostazioni', icon: Settings },
          ].map(tab => {
            const Icon = tab.icon;
            const active = currentView === tab.id;
            const badge = tab.id === 'tracking'
              ? products.filter(p => p.trackingCode && ['PENDING','IN_TRANSIT','OUT_FOR_DELIVERY'].includes(p.trackingStatus || 'PENDING')).length
              : 0;
            return (
              <button key={tab.id} onClick={() => navigateTo(tab.id as any)}
                className={`relative flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-semibold transition-colors ${
                  active ? 'bg-[#8b5cf6]/[0.12] text-[var(--text)]' : 'text-[var(--text-soft)] hover:bg-[var(--fill)] hover:text-[var(--text)]'
                }`}>
                {active && <span className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-5 bg-[#8b5cf6] rounded-r-full" />}
                <Icon size={18} /> {tab.label}
                {badge > 0 && <span className="ml-auto min-w-[20px] h-5 px-1 bg-blue-500 text-white rounded-full text-[10px] font-bold flex items-center justify-center">{badge}</span>}
              </button>
            );
          })}
        </nav>
        {/* Spazio + esci in fondo */}
        <div className="mt-auto pt-4 border-t border-[var(--border)]">
          <button onClick={handleLogout}
            className="w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-semibold text-[var(--text-soft)] hover:bg-[var(--fill)] hover:text-[var(--text)] transition-colors">
            <LogOut size={18} /> Esci
          </button>
        </div>
      </aside>

      {/* ========== HEADER ========== */}
      <header className="sticky top-0 z-40 bg-[var(--bg-blur)] backdrop-blur-xl border-b border-[var(--border)]"
        style={{ paddingTop: 'env(safe-area-inset-top)' }}>
        <div className="w-full max-w-[1280px] 2xl:max-w-[1440px] mx-auto px-4 lg:px-8 py-3.5 flex items-center">
          {/* Spacer sinistro per centrare il logo */}
          <div className="flex-1" />
          {/* Logo HQ centrato (come la mela) — nascosto su desktop: c'è nella sidebar */}
          <div className="flex items-center lg:hidden">
            <div className="relative w-[1.6rem] h-[1.7rem] shrink-0">
              <span className="absolute top-0 left-0 text-[1.15rem] font-black leading-none text-[var(--text)]">H</span>
              <span className="absolute bottom-0 right-[-2px] text-[1.15rem] font-black leading-none text-[var(--text)]/50">Q</span>
            </div>
          </div>

          {/* Azioni a destra */}
          <div className="flex-1 flex items-center justify-end gap-1.5">
            {/* Pulsante Aggiungi (solo desktop) */}
            <button onClick={() => openAddForm()}
              className="hidden lg:flex items-center gap-2 bg-[#8b5cf6] hover:bg-[#7c3aed] px-4 py-2 rounded-xl text-sm font-semibold transition-colors active:scale-95">
              <Plus size={15} /> Aggiungi
            </button>

            {/* Notifiche */}
            <div className="relative" ref={notifRef}>
              <button onClick={() => setNotifPanelOpen(!notifPanelOpen)}
                className="relative p-2 rounded-xl hover:bg-[var(--fill)] transition-colors">
                <Bell size={18} className="text-[var(--text-muted)]" />
                {unreadCount > 0 && (
                  <span className="absolute -top-0.5 -right-0.5 bg-[#8b5cf6] text-[var(--text)] text-[9px] font-bold rounded-full w-4 h-4 flex items-center justify-center">
                    {unreadCount > 9 ? '9+' : unreadCount}
                  </span>
                )}
              </button>

              {notifPanelOpen && (
                /* Mobile: pannello centrato in alto, largo quasi quanto lo schermo.
                   Desktop (sm+): dropdown ancorato a destra sotto la campanella.
                   Chiusura al tap-fuori gestita dal listener globale (vedi useEffect). */
                <div className="fixed sm:absolute left-1/2 sm:left-auto right-auto sm:right-0 -translate-x-1/2 sm:translate-x-0 top-16 sm:top-12 w-[calc(100vw-1.5rem)] max-w-sm sm:w-96 bg-[var(--surface-blur)] backdrop-blur-2xl border border-[var(--border-2)] rounded-2xl shadow-xl overflow-hidden z-50">
                  <div className="p-4 border-b border-[var(--border)] flex justify-between items-center">
                    <h3 className="font-semibold text-sm">Notifiche</h3>
                    {unreadCount > 0 && (
                      <button onClick={markAllNotificationsRead}
                        className="text-xs text-[var(--text-soft)] hover:text-gray-300 transition-colors">
                        Segna tutto letto
                      </button>
                    )}
                  </div>
                  <div className="max-h-96 overflow-y-auto">
                    {notifications.length === 0 ? (
                      <p className="p-8 text-center text-[var(--text-soft)] text-sm">Nessuna notifica</p>
                    ) : (
                      notifications.map((n: any) => (
                        <button key={n.id} onClick={() => markNotificationRead(n.id)}
                          className={`w-full text-left p-3.5 border-b border-[var(--border)] hover:bg-[var(--fill)] transition-colors ${
                            !n.read ? 'bg-[var(--fill)]' : ''
                          }`}>
                          <div className="flex items-start gap-3">
                            {!n.read && <div className="w-1.5 h-1.5 rounded-full bg-[#8b5cf6] mt-1.5 shrink-0" />}
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-semibold text-[var(--text)] truncate">{n.title}</p>
                              <p className="text-xs text-[var(--text-soft)] mt-0.5">{n.message}</p>
                              <p className="text-[10px] text-[var(--text-faint)] mt-1">
                                {new Date(n.createdAt).toLocaleString('it-IT')}
                              </p>
                            </div>
                          </div>
                        </button>
                      ))
                    )}
                  </div>
                </div>
              )}
            </div>

            {user.email.toLowerCase() === ADMIN_EMAIL.toLowerCase() && (
              <button onClick={() => navigateTo('admin')} title="Admin"
                className="p-2 rounded-xl hover:bg-[var(--fill)] transition-colors relative">
                <Shield size={18} className={currentView === 'admin' ? 'text-[#8b5cf6]' : 'text-[var(--text-muted)]'} />
                {adminFbNuove > 0 && (
                  <span className="absolute -top-0.5 -right-0.5 w-4 h-4 bg-[#8b5cf6] text-white rounded-full text-[9px] font-bold flex items-center justify-center">{adminFbNuove}</span>
                )}
              </button>
            )}

            <button onClick={() => navigateTo('settings')}
              className="p-2 rounded-xl hover:bg-[var(--fill)] transition-colors hidden sm:block lg:hidden">
              <Settings size={18} className="text-[var(--text-muted)]" />
            </button>

            <button onClick={handleLogout} title="Esci"
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
                      <span className="absolute bottom-0 left-1/2 -translate-x-1/2 w-10 h-0.5 bg-[#8b5cf6] rounded-full" />
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
      </header>
      
      <main key={currentView} className="w-full max-w-[1280px] 2xl:max-w-[1440px] mx-auto px-4 lg:px-8 py-5 lg:py-12 pb-28 lg:pb-16 animate-fade-in">

        {/* ========== DASHBOARD ========== */}
        {currentView === 'dashboard' && (
          <div className="space-y-5 lg:space-y-7">

            {/* Greeting — 3 colonne su desktop: giorno (sx) · saluto (centro) · stat (dx) */}
            <div className="flex flex-col sm:flex-row sm:items-center gap-4">
              {/* Sinistra: spacer per bilanciare e centrare il saluto */}
              <div className="hidden sm:block sm:flex-1" />
              {/* Centro: saluto + data */}
              <div className="sm:flex-1 sm:text-center min-w-0">
                <h2 className="text-3xl lg:text-4xl font-bold">
                  Ciao, <span className="text-[var(--text)]">{user.name.split(' ')[0]}</span>
                </h2>
                <p className="text-[11px] lg:text-xs text-[var(--text-faint)] font-semibold uppercase tracking-[0.1em] mt-1.5 capitalize">{new Date().toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' })}</p>
              </div>
              {/* Destra: cluster stat — riempie l'header su desktop */}
              <div className="hidden sm:flex sm:flex-1 items-stretch justify-end gap-5 lg:gap-7">
                <div className="flex flex-col items-end justify-center">
                  <p className="text-[9px] text-[var(--text-faint)] font-semibold uppercase tracking-[0.1em]">Settimana</p>
                  <p className={`text-xl lg:text-2xl font-bold num ${weekProfit >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {weekProfit >= 0 ? '+' : ''}{weekProfit.toFixed(0)}€
                  </p>
                  <p className="text-[11px] text-[var(--text-faint)]">{weekSales.length} {weekSales.length === 1 ? 'vendita' : 'vendite'}</p>
                </div>
                <div className="hidden lg:block w-px bg-[var(--border-2)]" />
                <div className="hidden lg:flex flex-col items-end justify-center">
                  <p className="text-[9px] text-[var(--text-faint)] font-semibold uppercase tracking-[0.1em]">Da spedire</p>
                  <p className="text-xl lg:text-2xl font-bold num text-blue-400">
                    {products.filter(p => p.trackingCode && ['PENDING', 'IN_TRANSIT', 'OUT_FOR_DELIVERY'].includes(p.trackingStatus || 'PENDING')).length}
                  </p>
                  <p className="text-[11px] text-[var(--text-faint)]">in transito</p>
                </div>
                <div className="hidden lg:block w-px bg-[var(--border-2)]" />
                <div className="hidden lg:flex flex-col items-end justify-center">
                  <p className="text-[9px] text-[var(--text-faint)] font-semibold uppercase tracking-[0.1em]">Fermi</p>
                  <p className={`text-xl lg:text-2xl font-bold num ${staleCount > 0 ? 'text-red-400' : 'text-[var(--text-faint)]'}`}>{staleCount}</p>
                  <p className="text-[11px] text-[var(--text-faint)]">oltre 30gg</p>
                </div>
              </div>
            </div>

            {/* Quanto lo pago? — strumento sourcing (prezzo max d'acquisto) */}
            <button onClick={openSourcing}
              className="w-full flex items-center justify-center gap-2 py-3 rounded-2xl border border-[#8b5cf6]/30 bg-[#8b5cf6]/[0.06] hover:bg-[#8b5cf6]/[0.12] text-sm font-bold text-[var(--text)] transition-colors">
              <DollarSign size={16} className="text-[#8b5cf6]" />
              Ricerca valore <span className="text-[var(--text-soft)] font-medium hidden sm:inline">· prezzo di mercato e max d'acquisto</span>
            </button>

            {/* Welcome / primo avvio — quando non ci sono ancora prodotti */}
            {products.length === 0 && (
              <section className="bg-[var(--surface)] border border-[#8b5cf6]/30 rounded-2xl p-6 lg:p-7 relative overflow-hidden">
                <div className="absolute inset-0 bg-[#8b5cf6]/[0.04] pointer-events-none" />
                <div className="relative">
                  <p className="text-[10px] font-bold text-[#8b5cf6] uppercase tracking-[0.12em] mb-2 flex items-center gap-1.5"><Sparkles size={12} /> Benvenuto in HQ</p>
                  <h3 className="text-xl lg:text-2xl font-bold mb-1.5">Iniziamo dal primo prodotto</h3>
                  <p className="text-sm text-[var(--text-soft)] mb-5 max-w-md">In pochi secondi aggiungi un articolo e HQ inizia a tracciare stock, vendite, profitti e spedizioni. Tutto in automatico.</p>
                  <div className="flex flex-wrap gap-2">
                    <button onClick={() => openAddForm()}
                      className="bg-[#8b5cf6] hover:bg-[#7c3aed] text-white px-5 py-2.5 rounded-xl font-bold text-sm flex items-center gap-2 transition-colors active:scale-95">
                      <Plus size={16} /> Aggiungi il primo prodotto
                    </button>
                    <button onClick={() => navigateTo('settings')}
                      className="bg-[var(--surface-2)] border border-[var(--border-2)] hover:border-[var(--border-3)] text-[var(--text-soft)] hover:text-[var(--text)] px-5 py-2.5 rounded-xl font-bold text-sm flex items-center gap-2 transition-colors">
                      <Download size={15} /> Importa da Excel
                    </button>
                  </div>
                </div>
              </section>
            )}

            {/* KPI principali */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              {/* Mio profitto */}
              <div className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-5 hover:border-[var(--border-2)] transition-colors">
                <p className="text-[10px] lg:text-xs font-semibold text-[var(--text-muted)] tracking-[0.12em] uppercase mb-4 flex items-center gap-1.5">
                  <Wallet size={10} /> Personale
                </p>
                <p className="text-2xl lg:text-3xl font-bold text-[var(--text)] num">{mioProfitto.toFixed(0)}€</p>
                <p className="text-[11px] text-[var(--text-faint)] mt-1.5">Quote personali</p>
              </div>

              {/* Team — clickable per team panel */}
              <div className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-5 cursor-pointer hover:border-[var(--border-2)] transition-colors group"
                onClick={() => setTeamPanelOpen(true)}>
                <p className="text-[10px] lg:text-xs font-semibold text-[var(--text-muted)] tracking-[0.12em] uppercase mb-4 flex items-center gap-1.5">
                  <Users size={10} /> Team
                </p>
                <p className="text-2xl lg:text-3xl font-bold text-violet-400 num">{globalProfitto.toFixed(0)}€</p>
                <div className="flex items-center justify-between mt-1.5">
                  <p className="text-[11px] text-[var(--text-faint)]">Profitto totale</p>
                  <span className="text-[9px] text-[var(--text-faint)] group-hover:text-[var(--text-muted)] transition-colors">Dettaglio →</span>
                </div>
              </div>

              {/* Stock */}
              <div className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-5 cursor-pointer hover:border-[var(--border-2)] transition-colors group"
                onClick={() => { setCurrentView('magazzino'); setMagazzinoView('instock'); }}>
                <p className="text-[10px] lg:text-xs font-semibold text-[var(--text-muted)] tracking-[0.12em] uppercase mb-4 flex items-center gap-1.5">
                  <Layers size={10} /> Stock
                </p>
                <p className="text-2xl lg:text-3xl font-bold num">{stockValore.toFixed(0)}€</p>
                <p className="text-[11px] text-[var(--text-faint)] mt-1.5">{inStockItems.length} pezzi · <span className="group-hover:text-[var(--text-muted)] transition-colors">Vedi →</span></p>
              </div>

              {/* Vendite */}
              <div className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-5 cursor-pointer hover:border-[var(--border-2)] transition-colors group"
                onClick={() => { setCurrentView('magazzino'); setMagazzinoView('sold'); }}>
                <p className="text-[10px] lg:text-xs font-semibold text-[var(--text-muted)] tracking-[0.12em] uppercase mb-4 flex items-center gap-1.5">
                  <TrendingUp size={10} /> Vendite
                </p>
                <p className="text-2xl lg:text-3xl font-bold text-emerald-400 num">{soldItemsTotal.length}</p>
                <p className="text-[11px] text-[var(--text-faint)] mt-1.5">{ricaviTotali.toFixed(0)}€ ricavi · <span className="group-hover:text-[var(--text-muted)] transition-colors">Vedi →</span></p>
              </div>
            </div>

            {/* Andamento (desktop) + Insights — 2/3 + 1/3 su desktop per riempire la fascia */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 lg:items-start">
              {/* Grafico Andamento Vendite — solo desktop */}
              <section className="hidden lg:flex lg:flex-col lg:col-span-2 bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-5">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="font-semibold">Andamento Vendite</h3>
                  <div className="flex gap-1 bg-[var(--surface-2)] p-1 rounded-xl border border-[var(--border-2)]">
                    {(['1D', '1W', '1M', '1Y', 'MAX'] as const).map(tf => (
                      <button key={tf} onClick={() => setChartTimeframe(tf)}
                        className={`px-3 py-1 text-xs font-bold rounded-lg transition-colors ${
                          chartTimeframe === tf ? 'bg-[#8b5cf6] text-white' : 'text-[var(--text-soft)] hover:text-[var(--text)]'
                        }`}>{tf}</button>
                    ))}
                  </div>
                </div>
                {trendData.length === 0 ? (
                  <div className="flex-1 flex flex-col items-center justify-center py-10 text-center">
                    <BarChart3 className="text-[var(--text-faint)] mb-3" size={36} />
                    <p className="text-[var(--text-soft)] text-sm">Nessun dato per questo periodo</p>
                  </div>
                ) : (
                  <Suspense fallback={<div className="h-[280px] flex items-center justify-center"><Loader2 className="animate-spin text-[var(--text-faint)]" size={28} /></div>}>
                    <TrendChart trendData={trendData} />
                  </Suspense>
                )}
                <div className="flex items-center gap-5 mt-3 justify-end">
                  <div className="flex items-center gap-1.5 text-[10px] text-[var(--text-soft)]"><span className="w-3 h-0.5 bg-green-500 rounded-full inline-block" />Ricavi</div>
                  <div className="flex items-center gap-1.5 text-[10px] text-[var(--text-soft)]"><span className="w-3 h-0.5 bg-[#8b5cf6] rounded-full inline-block" />Profitto</div>
                </div>
              </section>

              {/* Smart Insights */}
              {(staleCount > 0 || weekSales.length > 0 || bestCategoryEntry?.profit > 0) && (
              <section className="lg:col-span-1 bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-5">
                <p className="text-[9px] font-semibold text-[var(--text-soft)] uppercase tracking-[0.12em] mb-4 flex items-center gap-2">
                  <Sparkles size={10} /> Insights
                </p>
                <div className="space-y-3">
                  {staleCount > 0 && (
                    <div className="flex items-center gap-3 p-3 bg-red-900/15 border border-red-900/30 rounded-xl cursor-pointer hover:bg-red-900/25 transition-colors"
                      onClick={() => { setCurrentView('magazzino'); setSortField('date'); setSortDir('asc'); }}>
                      <AlertTriangle size={16} className="text-red-400 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-bold text-red-300">{staleCount} {staleCount === 1 ? 'prodotto fermo' : 'prodotti fermi'} da oltre 30 giorni</p>
                        <p className="text-[10px] text-[var(--text-soft)]">Valuta uno sconto per sbloccare capitale</p>
                      </div>
                      <span className="text-[10px] text-[var(--text-soft)] shrink-0">Vedi →</span>
                    </div>
                  )}
                  {weekSales.length > 0 && (
                    <div className="flex items-center gap-3 p-3 bg-green-900/15 border border-green-900/30 rounded-xl">
                      <TrendingUp size={16} className="text-green-400 shrink-0" />
                      <div>
                        <p className="text-sm font-bold text-green-300">
                          {weekSales.length} {weekSales.length === 1 ? 'vendita' : 'vendite'} questa settimana
                          {weekProfit > 0 && ` · +${weekProfit.toFixed(0)}€`}
                        </p>
                        <p className="text-[10px] text-[var(--text-soft)]">Ottimo ritmo di smaltimento stock</p>
                      </div>
                    </div>
                  )}
                  {bestCategoryEntry?.profit > 0 && (
                    <div className="flex items-center gap-3 p-3 bg-[#8b5cf6]/10 border border-[#8b5cf6]/20 rounded-xl">
                      <span className="text-xl shrink-0">{getCategoryIcon(bestCategoryEntry.cat)}</span>
                      <div>
                        <p className="text-sm font-bold">{bestCategoryEntry.cat} è il tuo reparto migliore</p>
                        <p className="text-[10px] text-[var(--text-soft)]">+{bestCategoryEntry.profit.toFixed(0)}€ · {bestCategoryEntry.count} vendite</p>
                      </div>
                    </div>
                  )}
                  {sellThroughRate > 0 && (
                    <div className="flex items-center gap-3">
                      <div className="flex-1">
                        <div className="flex items-center justify-between mb-1.5">
                          <p className="text-xs text-[var(--text-muted)] font-semibold">Sell-through rate</p>
                          <p className="text-xs font-bold text-[var(--text)] num">{sellThroughRate}%</p>
                        </div>
                        <div className="h-1.5 bg-black/40 rounded-full overflow-hidden">
                          <div className={`h-full rounded-full transition-all ${
                            sellThroughRate >= 60 ? 'bg-green-500' : sellThroughRate >= 30 ? 'bg-yellow-500' : 'bg-gray-600'
                          }`} style={{ width: `${sellThroughRate}%` }} />
                        </div>
                        <p className="text-[10px] text-[var(--text-faint)] mt-1">{globalSold.length} venduti su {totalItems} totali</p>
                      </div>
                    </div>
                  )}
                </div>
              </section>
              )}
            </div>

            {/* Libro Paga Soci */}
            {Object.keys(sociProfits).length > 1 && (
              <section className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-5 cursor-pointer hover:border-[var(--border-2)] transition-colors"
                onClick={() => setTeamPanelOpen(true)}>
                <div className="flex items-center justify-between mb-4">
                  <p className="text-[10px] lg:text-xs font-semibold text-[var(--text-muted)] tracking-[0.12em] uppercase flex items-center gap-1.5">
                    <Trophy size={10} /> Libro Paga
                  </p>
                  <span className="text-[9px] text-[var(--text-faint)] hover:text-[var(--text-muted)] transition-colors">Dettaglio →</span>
                </div>
                <div className="space-y-1.5">
                  {Object.values(sociProfits)
                    .sort((a: any, b: any) => b.profit - a.profit)
                    .map((socio: any, idx: number) => {
                      const maxP = Math.max(...Object.values(sociProfits).map((s: any) => s.profit), 1);
                      return (
                        <div key={idx} className={`flex items-center gap-3 p-3 rounded-xl transition-colors ${
                          socio.name === user.name ? 'bg-[var(--fill)] border border-[var(--border)]' : ''
                        }`}>
                          <div className="w-7 h-7 rounded-full bg-[var(--fill)] flex items-center justify-center text-xs font-semibold text-[var(--text-muted)] shrink-0">
                            {socio.name[0]?.toUpperCase()}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-1.5">
                              <span className="font-semibold text-sm truncate">{socio.name}</span>
                              {socio.name === user.name && (
                                <span className="text-[9px] bg-[var(--fill)] text-[var(--text-muted)] px-1.5 py-0.5 rounded-full shrink-0">tu</span>
                              )}
                            </div>
                            <div className="h-0.5 bg-[var(--fill)] rounded-full overflow-hidden">
                              <div className="h-full bg-[var(--fill-3)] rounded-full transition-all"
                                style={{ width: `${(socio.profit / maxP) * 100}%` }} />
                            </div>
                          </div>
                          <span className="font-semibold text-emerald-400 shrink-0 text-sm num">{socio.profit.toFixed(0)}€</span>
                        </div>
                      );
                    })}
                </div>
              </section>
            )}

            {/* Reparti */}
            <section>
              <p className="text-[9px] font-semibold text-[var(--text-faint)] tracking-[0.12em] uppercase mb-3">Reparti</p>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                {userCategories.map((cat: string) => {
                  const catAll = products.filter(p => p.category === cat);
                  const catStock = catAll.filter(p => p.status === 'IN STOCK');
                  const catSold = catAll.filter(p => p.status === 'VENDUTO');
                  const catProfit = catSold.reduce((a, p) => a + ((p.salePrice || 0) - p.purchasePrice - (p.fees || 0)), 0);
                  const catSellRate = catAll.length > 0 ? Math.round((catSold.length / catAll.length) * 100) : 0;
                  const catAvgMargin = catSold.length > 0
                    ? catSold.reduce((a, p) => a + (p.purchasePrice > 0 ? ((p.salePrice || 0) - p.purchasePrice - (p.fees || 0)) / p.purchasePrice * 100 : 0), 0) / catSold.length
                    : 0;
                  return (
                    <div key={cat} onClick={() => { setCurrentView('magazzino'); setFilterCat(cat); }}
                      className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-4 lg:p-5 hover:border-[var(--border-2)] transition-colors cursor-pointer group">
                      <div className="flex items-center justify-between mb-3 lg:mb-4">
                        <span className="text-xl lg:text-3xl">{getCategoryIcon(cat)}</span>
                        <span className="text-[9px] lg:text-[11px] font-bold px-2 py-0.5 rounded-full bg-[var(--fill)] text-[var(--text-muted)]">{catSellRate}%</span>
                      </div>
                      <p className="font-bold text-base lg:text-2xl leading-none">{cat}</p>
                      <p className="text-[11px] lg:text-sm text-[var(--text-soft)] mt-1 lg:mt-1.5 mb-3 lg:mb-4">{catStock.length} stock · {catSold.length} venduti</p>
                      <div className="h-0.5 lg:h-1 bg-[var(--fill)] rounded-full overflow-hidden mb-2.5 lg:mb-3">
                        <div className="h-full bg-[#8b5cf6] rounded-full" style={{ width: `${catSellRate}%` }} />
                      </div>
                      <div className="flex items-center justify-between">
                        <p className={`text-sm lg:text-lg font-bold num ${catProfit > 0 ? 'text-emerald-400' : catProfit < 0 ? 'text-red-400' : 'text-[var(--text-faint)]'}`}>
                          {catProfit > 0 ? '+' : ''}{catProfit.toFixed(0)}€
                        </p>
                        {catAvgMargin !== 0 && (
                          <p className="text-[11px] lg:text-sm text-[var(--text-soft)] num">avg {catAvgMargin > 0 ? '+' : ''}{catAvgMargin.toFixed(0)}%</p>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>


            {/* Spedizioni in corso */}
            {(() => {
              const active = products.filter((p: any) => p.trackingCode && ['PENDING', 'IN_TRANSIT', 'OUT_FOR_DELIVERY'].includes(p.trackingStatus || 'PENDING'));
              const stLabel = (s?: string) => {
                if (s === 'IN_TRANSIT') return { t: 'In transito', c: 'bg-blue-500/20 text-blue-400' };
                if (s === 'OUT_FOR_DELIVERY') return { t: 'In consegna', c: 'bg-violet-500/20 text-violet-400' };
                if (s === 'EXCEPTION') return { t: 'Eccezione', c: 'bg-red-500/20 text-red-400' };
                return { t: 'In attesa', c: 'bg-[var(--fill)] text-[var(--text-soft)]' };
              };
              return (
                <section className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-5">
                  <div className="flex items-center justify-between mb-4">
                    <p className="text-[9px] font-semibold text-[var(--text-faint)] tracking-[0.12em] uppercase flex items-center gap-2"><Truck size={12} /> Spedizioni in corso{active.length > 0 ? ` (${active.length})` : ''}</p>
                    <button onClick={() => navigateTo('tracking')} className="text-[10px] text-[var(--text-faint)] hover:text-[var(--text-muted)] transition-colors">Vedi tutto →</button>
                  </div>
                  {active.length === 0 ? (
                    <p className="text-sm text-[var(--text-soft)] text-center py-4">Nessuna spedizione in corso</p>
                  ) : (
                    <div className="space-y-2">
                      {active.slice(0, 5).map((p: any) => {
                        const st = stLabel(p.trackingStatus);
                        return (
                          <div key={p.id} onClick={() => navigateTo('tracking')}
                            className="flex items-center gap-3 p-2.5 rounded-xl hover:bg-[var(--fill)] cursor-pointer transition-colors">
                            <span className="text-xl shrink-0">{getCategoryIcon(p.category)}</span>
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-bold truncate">{p.brand} {p.name}</p>
                              <p className="text-[10px] text-[var(--text-faint)] font-mono truncate">{p.trackingCarrier || 'Corriere'} · {p.trackingCode}</p>
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
          </div>
        )}

        {/* ========== MAGAZZINO ========== */}
        {currentView === 'magazzino' && (
          <div className="space-y-3 lg:space-y-5">
            {/* Banner riprezzamento: prodotti fermi da oltre 30 giorni → apre lo strumento Pro */}
            {magazzinoView === 'instock' && (() => {
              const staleCount = products.filter((p: any) => p.status === 'IN STOCK' && (p.oldestDate || p.createdAt) && (Date.now() - new Date(p.oldestDate || p.createdAt).getTime()) / 86400000 > 30).length;
              if (staleCount === 0) return null;
              return (
                <button onClick={() => openPlanModal('repricing')}
                  className="w-full flex items-center justify-between gap-3 bg-yellow-500/10 border border-yellow-500/30 rounded-2xl px-4 py-3 hover:bg-yellow-500/15 transition-colors">
                  <span className="flex items-center gap-2 text-sm font-bold text-yellow-500"><AlertTriangle size={16} /> {staleCount} prodotti fermi da oltre 30 giorni</span>
                  <span className="text-xs font-bold text-yellow-400 shrink-0">Riprezza →</span>
                </button>
              );
            })()}
            {/* Riga 1: titolo + toggle IN STOCK/VENDUTI accanto, ricerca inline su desktop */}
            <div className="flex flex-col lg:flex-row lg:items-center gap-3">
              <div className="flex items-center gap-3 shrink-0">
                <h2 className="text-2xl lg:text-3xl font-semibold">Magazzino</h2>
                <div className="flex bg-[var(--surface)] p-1 rounded-xl border border-[var(--border-2)]">
                  <button onClick={() => { setMagazzinoView('instock'); setBulkMode(false); setSelectedGroupKeys(new Set()); }}
                    className={`px-3 lg:px-4 py-1.5 text-xs font-bold rounded-lg transition-colors ${
                      magazzinoView === 'instock' ? 'bg-[#8b5cf6] text-[var(--text)]' : 'text-[var(--text-soft)]'
                    }`}>IN STOCK</button>
                  <button onClick={() => { setMagazzinoView('sold'); setBulkMode(false); setSelectedGroupKeys(new Set()); }}
                    className={`px-3 lg:px-4 py-1.5 text-xs font-bold rounded-lg transition-colors ${
                      magazzinoView === 'sold' ? 'bg-green-600 text-[var(--text)]' : 'text-[var(--text-soft)]'
                    }`}>VENDUTI</button>
                </div>
                {bulkMode && (
                  <button onClick={() => { setBulkMode(false); setSelectedGroupKeys(new Set()); }}
                    className="px-3 py-1.5 text-xs font-bold rounded-xl border bg-[#8b5cf6] border-[#8b5cf6] text-[var(--text)] transition-colors">
                    ✕ Annulla
                  </button>
                )}
              </div>

              {/* Ricerca + reparto — inline su desktop, impilati su mobile */}
              <div className="flex flex-col lg:flex-row gap-2 lg:gap-3 lg:flex-1 lg:justify-end mt-2 lg:mt-0">
                <div className="relative flex-1 lg:max-w-md">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-soft)]" size={16} />
                  <input type="text" placeholder="Cerca brand o modello..."
                    value={searchTerm} onChange={(e: any) => setSearchTerm(e.target.value)}
                    className="w-full bg-[var(--surface)] border border-[var(--border)] rounded-xl pl-10 pr-4 py-2.5 text-sm focus:border-[#8b5cf6] outline-none" />
                </div>
                <select value={filterCat} onChange={(e: any) => setFilterCat(e.target.value)}
                  className="w-full lg:w-auto bg-[var(--surface)] border border-[var(--border)] rounded-xl px-3 py-2.5 text-sm focus:border-[#8b5cf6] outline-none shrink-0">
                  <option value="all">Tutti i reparti</option>
                  {userCategories.map((c: string) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
            </div>

            {magazzinoView === 'instock' && (
              <div className="flex flex-col lg:flex-row lg:flex-wrap gap-2 lg:items-center">
                {/* Ordina */}
                <div className="flex flex-wrap gap-2 items-center">
                  <span className="w-full lg:w-auto text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest flex items-center gap-1">
                    <ArrowUpDown size={12} /> Ordina:
                  </span>
                  {(['date','price','name'] as const).map(f => (
                    <button key={f} onClick={() => {
                      if (sortField === f) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
                      else { setSortField(f); setSortDir('desc'); }
                    }}
                      className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-colors ${
                        sortField === f ? 'bg-[#8b5cf6] text-[var(--text)]' : 'bg-[var(--surface)] border border-[var(--border)] text-[var(--text-soft)] hover:text-[var(--text)]'
                      }`}>
                      {f === 'date' ? 'Data' : f === 'price' ? 'Prezzo' : f === 'name' ? 'Nome' : 'Margine'}
                      {sortField === f && (sortDir === 'desc' ? ' ↓' : ' ↑')}
                    </button>
                  ))}
                  {/* Filtro rapido: Fermi (+30gg in stock) */}
                  <button onClick={() => setStaleOnly(s => !s)}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold transition-colors ${
                      staleOnly ? 'bg-red-500/20 text-red-400 border border-red-500/40' : 'bg-[var(--surface)] border border-[var(--border)] text-[var(--text-soft)] hover:text-[var(--text)]'
                    }`}>
                    <AlertTriangle size={12} /> Fermi
                  </button>
                </div>
                {/* Condizione */}
                <select value={filterCondition} onChange={(e: any) => setFilterCondition(e.target.value)}
                  className="w-full lg:w-auto lg:ml-auto bg-[var(--surface)] border border-[var(--border)] rounded-xl px-3 py-1.5 text-xs focus:border-[#8b5cf6] outline-none text-[var(--text-muted)]">
                  <option value="all">Condizione</option>
                  <option value="DS">DS</option>
                  <option value="VNDS">VNDS</option>
                  <option value="Used">Used</option>
                </select>
                {/* Prezzo */}
                <div className="flex gap-2">
                  <input type="number" placeholder="Min €" value={filterPriceMin}
                    onChange={(e: any) => setFilterPriceMin(e.target.value)}
                    className="w-16 bg-[var(--surface)] border border-[var(--border)] rounded-xl px-2.5 py-1.5 text-xs focus:border-[#8b5cf6] outline-none text-[var(--text-muted)]" />
                  <input type="number" placeholder="Max €" value={filterPriceMax}
                    onChange={(e: any) => setFilterPriceMax(e.target.value)}
                    className="w-16 bg-[var(--surface)] border border-[var(--border)] rounded-xl px-2.5 py-1.5 text-xs focus:border-[#8b5cf6] outline-none text-[var(--text-muted)]" />
                </div>
              </div>
            )}
            
            {/* Barra riassuntiva del set filtrato (solo in stock) */}
            {magazzinoView === 'instock' && groupedInStockArray.length > 0 && (() => {
              const pezzi = groupedInStockArray.reduce((a: number, g: any) => a + g.quantity, 0);
              const costo = groupedInStockArray.reduce((a: number, g: any) => a + g.purchasePrice * g.quantity, 0);
              return (
                <div className="flex flex-wrap items-center gap-x-5 gap-y-1 px-4 py-2.5 bg-[var(--surface)] border border-[var(--border)] rounded-xl text-sm">
                  <span className="text-[var(--text-soft)]"><span className="font-bold text-[var(--text)] num">{pezzi}</span> pezzi · <span className="font-bold text-[var(--text)] num">{groupedInStockArray.length}</span> modelli</span>
                  <span className="text-[var(--text-soft)] sm:ml-auto">Valore stock <span className="font-bold text-[var(--text)] num">{costo.toFixed(0)}€</span></span>
                </div>
              );
            })()}

            {/* Lista prodotti */}
            <div className="space-y-2.5">
              {magazzinoView === 'instock' ? (
                groupedInStockArray.length === 0 ? (
                  inStockItems.length === 0 ? (
                    /* Magazzino davvero vuoto → onboarding */
                    <div className="text-center py-16 px-5 bg-[var(--surface)] rounded-2xl border border-[var(--border)]">
                      <Package className="mx-auto text-[var(--text-faint)] mb-3" size={44} />
                      <p className="font-bold text-lg">Il tuo magazzino è vuoto</p>
                      <p className="text-sm text-[var(--text-soft)] mt-1 mb-5 max-w-sm mx-auto">Aggiungi il primo prodotto per iniziare a tracciare stock, vendite e profitti.</p>
                      <div className="flex flex-wrap gap-2 justify-center">
                        <button onClick={() => openAddForm()}
                          className="bg-[#8b5cf6] hover:bg-[#7c3aed] text-white px-5 py-2.5 rounded-xl font-bold text-sm flex items-center gap-2 transition-colors active:scale-95">
                          <Plus size={16} /> Aggiungi prodotto
                        </button>
                        <button onClick={() => navigateTo('settings')}
                          className="bg-[var(--surface-2)] border border-[var(--border-2)] hover:border-[var(--border-3)] text-[var(--text-soft)] hover:text-[var(--text)] px-5 py-2.5 rounded-xl font-bold text-sm flex items-center gap-2 transition-colors">
                          <Download size={15} /> Importa da Excel
                        </button>
                      </div>
                    </div>
                  ) : (
                    /* Filtri/ricerca attivi → nessun risultato */
                    <div className="text-center py-16 px-5 bg-[var(--surface)] rounded-2xl border border-[var(--border)]">
                      <Search className="mx-auto text-[var(--text-faint)] mb-3" size={40} />
                      <p className="font-bold">Nessun risultato</p>
                      <p className="text-sm text-[var(--text-soft)] mt-1 mb-4">Prova a modificare ricerca o filtri.</p>
                      <button onClick={() => { setSearchTerm(''); setFilterCat('all'); setFilterCondition('all'); setFilterPriceMin(''); setFilterPriceMax(''); setStaleOnly(false); }}
                        className="bg-[var(--surface-2)] border border-[var(--border-2)] hover:border-[var(--border-3)] text-[var(--text-soft)] hover:text-[var(--text)] px-4 py-2 rounded-xl font-bold text-xs transition-colors">
                        Azzera filtri
                      </button>
                    </div>
                  )
                ) : (
                  <div className="flex flex-col gap-2.5 lg:grid lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 lg:gap-3">
                  {groupedInStockArray.map((g: any) => {
                    const groupKey = g.ids.join(',');
                    const isSelected = selectedGroupKeys.has(groupKey);
                    const isAdmin = user!.email.toLowerCase() === ADMIN_EMAIL.toLowerCase();
                    let photoUrl: string | null = null;
                    try { const ph = g.photos ? JSON.parse(g.photos) : []; if (ph.length > 0) photoUrl = ph[0]; } catch {}
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

                      {/* ===== MOBILE/TABLET: card a riga ===== */}
                      <div
                        onClick={() => cardClick(groupKey)}
                        {...cardPressProps(groupKey)}
                        className={`lg:hidden bg-[var(--surface)] border rounded-2xl overflow-hidden transition-all relative ${
                          bulkMode ? 'cursor-pointer select-none' : ''
                        } ${isSelected ? 'border-[#8b5cf6] shadow-sm' : 'border-[var(--border)]'}`}>
                        {bulkMode && (
                          <div className={`absolute top-3 right-3 z-10 w-6 h-6 rounded-full border-2 flex items-center justify-center ${isSelected ? 'bg-[#8b5cf6] border-[#8b5cf6]' : 'border-gray-600 bg-[var(--surface-2)]'}`}>
                            {isSelected && <CheckCircle size={14} className="text-[var(--text)]" />}
                          </div>
                        )}
                        <div className="flex items-center gap-3 p-3.5">
                          {photoUrl
                            ? <div className="w-16 h-16 rounded-xl overflow-hidden shrink-0 border border-[var(--border-2)]"><img src={photoUrl} alt="" className="w-full h-full object-cover" /></div>
                            : <span className="text-3xl shrink-0 w-16 text-center">{getCategoryIcon(g.category)}</span>}
                          <div className={`flex-1 min-w-0 ${!bulkMode && isAdmin ? 'cursor-pointer' : ''}`}
                            onClick={!bulkMode && isAdmin ? () => openEditModal(g) : undefined}>
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span className="font-bold text-sm truncate">{g.brand} {g.name}</span>
                              {g.quantity > 1 && <span className="text-[10px] bg-[#8b5cf6]/20 text-[var(--text)] px-1.5 py-0.5 rounded-full font-bold shrink-0">×{g.quantity}</span>}
                              {daysBadge}{trackBadge}
                            </div>
                            <p className="text-xs text-[var(--text-soft)] mt-1">{g.size} · {g.condition} · <span className="text-gray-300 font-semibold">{g.purchasePrice.toFixed(0)}€</span></p>
                            {shares?.length > 0 && <p className="text-[10px] text-blue-400/70 mt-0.5 truncate">{shares.map((x:any)=>`${x.name} ${x.percentage}%`).join(' · ')}</p>}
                            {!bulkMode && (
                              <button onClick={(e) => { e.stopPropagation(); setNotesModalProduct(g); setNotesInput(g.notes || ''); }}
                                className={`mt-1 text-[11px] flex items-center gap-1 ${g.notes ? 'text-[var(--text-soft)]' : 'text-gray-700'}`}>
                                <StickyNote size={10} /><span className="truncate max-w-[180px]">{g.notes || 'Aggiungi nota…'}</span>
                              </button>
                            )}
                          </div>
                          {!bulkMode && (
                            <div className="flex flex-col gap-1 shrink-0">
                              <button onClick={() => openTrackingModal(g)} className="px-3 py-1.5 bg-[var(--fill)] text-[var(--text-muted)] rounded-lg text-xs font-bold">Track</button>
                              {isAdmin
                                ? <button onClick={() => openListingModal(g)} className="px-3 py-1.5 bg-violet-500/15 text-violet-400 rounded-lg text-xs font-bold">Annuncio</button>
                                : <button onClick={() => openEditModal(g)} className="px-3 py-1.5 bg-[var(--fill)] text-[var(--text-muted)] rounded-lg text-xs font-bold">Modifica</button>}
                              {!isAdmin && <button onClick={() => openSellModal(g.ids, `${g.brand} ${g.name}`, g)} className="px-3 py-1.5 bg-green-500/15 text-green-400 rounded-lg text-xs font-bold">Vendi</button>}
                            </div>
                          )}
                        </div>
                        {!bulkMode && isAdmin && (
                          <div className="flex border-t border-[var(--border)]">
                            <button onClick={() => openShipping(g)} className="flex-1 flex items-center justify-center gap-1.5 py-2.5 text-xs font-bold text-violet-400 hover:bg-violet-900/15"><Package size={13} /> Spedisci</button>
                            <div className="w-px bg-[var(--fill)]" />
                            <button onClick={() => openSellModal(g.ids, `${g.brand} ${g.name}`, g)} className="flex-1 flex items-center justify-center gap-1.5 py-2.5 text-xs font-bold text-green-400 hover:bg-green-900/15"><DollarSign size={13} /> Vendi</button>
                          </div>
                        )}
                      </div>

                      {/* ===== DESKTOP: card a cubetto ===== */}
                      <div
                        onClick={() => cardClick(groupKey)}
                        {...cardPressProps(groupKey)}
                        className={`hidden lg:flex flex-col bg-[var(--surface)] border rounded-2xl overflow-hidden transition-all duration-200 relative hover:-translate-y-1 hover:shadow-xl hover:shadow-black/25 ${
                          bulkMode ? 'cursor-pointer select-none' : ''
                        } ${isSelected ? 'border-[#8b5cf6] shadow-sm' : 'border-[var(--border)] hover:border-[var(--border-2)]'}`}>
                        <div
                          className={`relative aspect-square bg-[var(--surface-2)] flex items-center justify-center overflow-hidden ${!bulkMode && isAdmin ? 'cursor-pointer' : ''}`}
                          onClick={!bulkMode && isAdmin ? () => openEditModal(g) : undefined}>
                          {photoUrl
                            ? <img src={photoUrl} alt="" className="w-full h-full object-cover" />
                            : <span className="text-5xl opacity-80">{getCategoryIcon(g.category)}</span>}
                          <div className="absolute top-2 left-2 flex flex-col gap-1 items-start">
                            {g.quantity > 1 && <span className="text-[10px] bg-[#8b5cf6] text-[var(--text)] px-2 py-0.5 rounded-full font-bold shadow">×{g.quantity}</span>}
                            {days !== null && <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold shadow ${days > 30 ? 'bg-red-500 text-[var(--text)]' : days > 14 ? 'bg-yellow-500 text-black' : 'bg-black/50 backdrop-blur text-gray-300'}`}>{days}g</span>}
                            {g.trackingStatus && <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold flex items-center gap-0.5 shadow ${g.trackingStatus === 'IN_TRANSIT' ? 'bg-blue-500 text-[var(--text)]' : g.trackingStatus === 'DELIVERED' ? 'bg-green-500 text-[var(--text)]' : g.trackingStatus === 'EXCEPTION' ? 'bg-red-500 text-[var(--text)]' : 'bg-black/50 backdrop-blur text-gray-300'}`}><Truck size={9} />{g.trackingStatus === 'IN_TRANSIT' ? 'Transito' : g.trackingStatus === 'DELIVERED' ? 'Consegnato' : g.trackingStatus === 'OUT_FOR_DELIVERY' ? 'In consegna' : 'Track'}</span>}
                          </div>
                          {bulkMode && (
                            <div className={`absolute top-2 right-2 z-10 w-6 h-6 rounded-full border-2 flex items-center justify-center ${isSelected ? 'bg-[#8b5cf6] border-[#8b5cf6]' : 'border-[var(--border-3)] bg-black/40 backdrop-blur'}`}>
                              {isSelected && <CheckCircle size={14} className="text-[var(--text)]" />}
                            </div>
                          )}
                        </div>
                        <div className="p-4 flex-1 flex flex-col items-start text-left">
                          <p className="font-bold text-base leading-tight line-clamp-2 w-full">{g.brand} {g.name}</p>
                          <p className="text-sm text-[var(--text-muted)] mt-1.5">{g.size} · {g.condition}</p>
                          <p className="text-2xl font-bold text-[var(--text)] mt-auto pt-2 num">{g.purchasePrice.toFixed(0)}€</p>
                          {shares?.length > 0 && <p className="text-[11px] text-blue-400/70 mt-1.5 truncate max-w-full">{shares.map((x:any)=>`${x.name} ${x.percentage}%`).join(' · ')}</p>}
                          {!bulkMode && (
                            <button onClick={(e) => { e.stopPropagation(); setNotesModalProduct(g); setNotesInput(g.notes || ''); }}
                              className={`mt-2 text-xs flex items-center justify-start gap-1 max-w-full ${g.notes ? 'text-[var(--text-soft)] hover:text-gray-300' : 'text-gray-700 hover:text-[var(--text-soft)]'}`}>
                              <StickyNote size={11} className="shrink-0" /><span className="truncate">{g.notes || 'Aggiungi nota…'}</span>
                            </button>
                          )}
                        </div>
                        {!bulkMode && (
                          <div className="border-t border-[var(--border)] p-2.5 flex flex-col gap-1.5">
                            <div className="grid grid-cols-2 gap-1.5">
                              <button onClick={() => openTrackingModal(g)} className={`py-2 rounded-lg text-xs font-bold transition-colors flex items-center justify-center gap-1 ${g.trackingCode ? 'bg-blue-500/15 text-blue-400 hover:bg-blue-500/25' : 'bg-[var(--fill)] text-[var(--text-muted)] hover:bg-[var(--fill-2)] hover:text-[var(--text)]'}`}><Truck size={12} /> Track</button>
                              {isAdmin
                                ? <button onClick={() => openListingModal(g)} className="py-2 rounded-lg text-xs font-bold bg-violet-500/15 text-violet-400 hover:bg-violet-500/25 hover:text-violet-300 transition-colors flex items-center justify-center gap-1"><Store size={12} /> Annuncio</button>
                                : <button onClick={() => openEditModal(g)} className="py-2 rounded-lg text-xs font-bold bg-[var(--fill)] text-[var(--text-muted)] hover:bg-[var(--fill-2)] hover:text-[var(--text)] transition-colors flex items-center justify-center gap-1"><Edit size={12} /> Modifica</button>}
                            </div>
                            {isAdmin ? (
                              <div className="grid grid-cols-2 gap-1.5">
                                <button onClick={() => openShipping(g)} className="py-2 rounded-lg text-xs font-bold bg-violet-500/15 text-violet-400 hover:bg-violet-500/25 hover:text-violet-300 transition-colors flex items-center justify-center gap-1"><Package size={12} /> Spedisci</button>
                                <button onClick={() => openSellModal(g.ids, `${g.brand} ${g.name}`, g)} className="py-2 rounded-lg text-xs font-bold bg-green-500/20 text-green-400 hover:bg-green-500/30 hover:text-green-300 transition-colors flex items-center justify-center gap-1"><DollarSign size={12} /> Vendi</button>
                              </div>
                            ) : (
                              <button onClick={() => openSellModal(g.ids, `${g.brand} ${g.name}`, g)} className="py-2 rounded-lg text-sm font-bold bg-green-500/20 text-green-400 hover:bg-green-500/30 hover:text-green-300 transition-colors flex items-center justify-center gap-1.5"><DollarSign size={14} /> Vendi</button>
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
                    <p className="text-[var(--text-muted)] font-semibold">Nessuna vendita ancora</p>
                    <p className="text-[var(--text-faint)] text-sm mt-1 mb-5">Registra la tua prima vendita dalla sezione IN STOCK</p>
                    <button onClick={() => setMagazzinoView('instock')}
                      className="bg-[var(--surface-2)] border border-[var(--border-2)] hover:border-[var(--border-3)] text-[var(--text-soft)] hover:text-[var(--text)] px-5 py-2.5 rounded-xl font-bold text-sm transition-colors">
                      Vai a IN STOCK
                    </button>
                  </div>
                ) : (
                  (() => {
                    const platColors: Record<string, string> = {
                      'Vinted': 'text-teal-300 bg-teal-500/15 border-teal-500/20',
                      'StockX': 'text-green-300 bg-green-500/15 border-green-500/20',
                      'eBay': 'text-yellow-300 bg-yellow-500/15 border-yellow-500/20',
                      'Subito': 'text-violet-300 bg-violet-500/15 border-violet-500/20',
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

                      if (g.salePrice === 0) {
                        return (
                          <div key={g.ids.join(',')} className="bg-[var(--surface)] border border-yellow-500/20 rounded-2xl overflow-hidden">
                            <div className="flex items-center gap-3 p-4">
                              {photos.length > 0
                                ? <div className="w-12 h-12 rounded-xl overflow-hidden shrink-0 border border-[var(--border)]"><img src={photos[0]} alt="" className="w-full h-full object-cover" /></div>
                                : <span className="text-2xl shrink-0 opacity-60">{getCategoryIcon(g.category)}</span>}
                              <div className="flex-1 min-w-0">
                                <p className="font-bold text-sm">{g.brand} {g.name}</p>
                                <p className="text-[10px] text-[var(--text-soft)]">{g.size} · {g.condition}</p>
                              </div>
                              <button onClick={() => openSellModal(g.ids, `${g.brand} ${g.name}`, g)}
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
                        <div key={g.ids.join(',')} className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl overflow-hidden hover:border-[var(--border-2)] transition-all group">
                          <div className="flex items-center gap-3 p-4">
                            {photos.length > 0
                              ? <div className="w-12 h-12 rounded-xl overflow-hidden shrink-0 border border-[var(--border)] group-hover:border-[var(--border-2)] transition-colors"><img src={photos[0]} alt="" className="w-full h-full object-cover" /></div>
                              : <span className="text-2xl shrink-0 opacity-40">{getCategoryIcon(g.category)}</span>}
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-1.5 flex-wrap mb-0.5">
                                <p className="font-bold text-sm">{g.brand} {g.name}</p>
                                {g.quantity > 1 && (
                                  <span className="text-[9px] bg-green-500/15 border border-green-500/25 text-green-400 px-1.5 py-0.5 rounded-full font-semibold shrink-0">×{g.quantity}</span>
                                )}
                              </div>
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="text-[10px] text-[var(--text-faint)]">{g.size}</span>
                                <span className={`text-[9px] font-semibold px-2 py-0.5 rounded-full border ${platCls}`}>{g.platform}</span>
                                {soldDate && <span className="text-[10px] text-gray-700">{soldDate}</span>}
                              </div>
                            </div>
                            <div className="text-right shrink-0 ml-2">
                              <p className={`font-semibold text-base ${g.totalProfit >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
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
                            <span className="text-[10px] text-gray-700 flex items-center gap-1">
                              {g.purchasePrice?.toFixed(0)}€
                              <span className="text-gray-800 mx-0.5">→</span>
                              <span className="text-[var(--text-soft)] font-bold">{g.totalRevenue.toFixed(0)}€</span>
                            </span>
                            {g.totalFees > 0 && (
                              <span className="text-[10px] text-gray-700">· {g.totalFees.toFixed(0)}€ fee</span>
                            )}
                            <button onClick={() => handleReturn(g)}
                              className="ml-auto flex items-center gap-1.5 bg-blue-500/15 border border-blue-500/25 text-blue-400 hover:bg-blue-500/25 px-3 py-1.5 rounded-xl text-xs font-bold transition-colors">
                              ↩ Reso
                            </button>
                          </div>
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
        {currentView === 'analytics' && (
          <div className="space-y-5">
            <div className="flex items-center justify-between">
              <h2 className="text-3xl font-semibold">Analytics</h2>
              <button onClick={exportCSV}
                className="flex items-center gap-2 bg-[var(--surface)] border border-[var(--border-2)] hover:border-[var(--border-3)] px-4 py-2 rounded-xl text-sm font-bold transition-colors text-[var(--text-soft)] hover:text-[var(--text)] active:scale-95">
                <Download size={15} /> CSV
              </button>
            </div>

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
              const netto = ricavi - costo - fees;
              const roi = costo > 0 ? (netto / costo * 100) : 0;
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
                const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
                const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url; a.download = `report-${reportMonth.y}-${String(reportMonth.m + 1).padStart(2, '0')}.csv`; a.click();
                URL.revokeObjectURL(url);
              };
              const label = new Date(reportMonth.y, reportMonth.m, 1).toLocaleDateString('it-IT', { month: 'long', year: 'numeric' });
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
                    <h3 className="font-semibold">Conto economico</h3>
                    <div className="flex items-center gap-2">
                      {monthSold.length > 0 && (
                        <button onClick={exportMonth} title="Esporta CSV del mese"
                          className="flex items-center gap-1.5 bg-[var(--surface-2)] border border-[var(--border-2)] hover:border-[var(--border-3)] text-[var(--text-soft)] hover:text-[var(--text)] px-2.5 py-1.5 rounded-lg text-xs font-bold transition-colors">
                          <Download size={13} /> <span className="hidden sm:inline">Esporta</span>
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
                    <p className="text-center py-8 text-sm text-[var(--text-soft)] capitalize">Nessuna vendita in {label}</p>
                  ) : (
                    <>
                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                      <div className="bg-[var(--surface-2)] rounded-xl p-4">
                        <p className="text-[10px] uppercase tracking-widest text-[var(--text-faint)] font-bold mb-1">Ricavi</p>
                        <p className="text-2xl font-bold num">{ricavi.toFixed(0)}€</p>
                        <p className="text-[11px] text-[var(--text-soft)] mt-1">{monthSold.length} {monthSold.length === 1 ? 'vendita' : 'vendite'}</p>
                      </div>
                      <div className="bg-[var(--surface-2)] rounded-xl p-4">
                        <p className="text-[10px] uppercase tracking-widest text-[var(--text-faint)] font-bold mb-1">Costi + Fee</p>
                        <p className="text-2xl font-bold num text-[var(--text-soft)]">-{(costo + fees).toFixed(0)}€</p>
                        <p className="text-[11px] text-[var(--text-soft)] mt-1">{costo.toFixed(0)}€ merce · {fees.toFixed(0)}€ fee</p>
                      </div>
                      <div className="bg-[var(--surface-2)] rounded-xl p-4">
                        <p className="text-[10px] uppercase tracking-widest text-[var(--text-faint)] font-bold mb-1">Profitto netto</p>
                        <p className={`text-2xl font-bold num ${netto >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{netto >= 0 ? '+' : ''}{netto.toFixed(0)}€</p>
                        <p className="text-[11px] text-[var(--text-soft)] mt-1">
                          ROI {roi >= 0 ? '+' : ''}{roi.toFixed(0)}%
                          {hasPrev && <span className={`ml-1.5 font-bold ${deltaPct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{deltaPct >= 0 ? '▲' : '▼'}{Math.abs(deltaPct).toFixed(0)}% <span className="font-normal text-[var(--text-faint)]">vs mese prec.</span></span>}
                        </p>
                      </div>
                      <div className="bg-[var(--surface-2)] rounded-xl p-4">
                        <p className="text-[10px] uppercase tracking-widest text-[var(--text-faint)] font-bold mb-1">Top piattaforma</p>
                        <p className="text-2xl font-bold truncate">{topPlat ? topPlat[0] : '—'}</p>
                        {topPlat && <p className="text-[11px] text-[var(--text-soft)] mt-1 num">{topPlat[1] >= 0 ? '+' : ''}{topPlat[1].toFixed(0)}€ profitto</p>}
                      </div>
                    </div>
                    {catRows.length > 0 && (
                      <div className="mt-4 pt-4 border-t border-[var(--border)]">
                        <p className="text-[10px] uppercase tracking-widest text-[var(--text-faint)] font-bold mb-3">Profitto per reparto</p>
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
                <p className="text-[11px] text-[var(--text-faint)] mt-1.5">Return on Investment</p>
              </div>
              <div className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-4">
                <p className="text-[10px] lg:text-xs font-semibold text-[var(--text-muted)] tracking-[0.12em] uppercase mb-3 flex items-center gap-1.5">
                  <Wallet size={10} /> Profitto Netto
                </p>
                <p className={`text-2xl lg:text-3xl font-bold num ${profittoNetto >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{profittoNetto.toFixed(0)}€</p>
                <p className="text-[11px] text-[var(--text-faint)] mt-1.5">Dopo fees · {ricaviTotali.toFixed(0)}€ ricavi</p>
              </div>
              <div className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-4">
                <p className="text-[10px] lg:text-xs font-semibold text-[var(--text-muted)] tracking-[0.12em] uppercase mb-3 flex items-center gap-1.5">
                  <Layers size={10} /> Stock
                </p>
                <p className="text-2xl lg:text-3xl font-bold num">{stockValore.toFixed(0)}€</p>
                <p className="text-[11px] text-[var(--text-faint)] mt-1.5">Capitale immobilizzato</p>
              </div>
              <div className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-4">
                <p className="text-[10px] lg:text-xs font-semibold text-[var(--text-muted)] tracking-[0.12em] uppercase mb-3 flex items-center gap-1.5">
                  <DollarSign size={10} /> Vendite
                </p>
                <p className="text-2xl lg:text-3xl font-bold text-violet-400 num">{soldItemsTotal.length}</p>
                <p className="text-[11px] text-[var(--text-faint)] mt-1.5">Totali · {sellThroughRate}% sell-through</p>
              </div>
            </div>

            {/* KPI row 2: metriche operative */}
            <div className="grid grid-cols-3 gap-2">
              <div className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-3 text-center">
                <p className={`text-xl font-bold num ${avgMarginPct >= 20 ? 'text-emerald-400' : avgMarginPct >= 0 ? 'text-violet-400' : 'text-red-400'}`}>
                  {avgMarginPct >= 0 ? '+' : ''}{avgMarginPct.toFixed(1)}%
                </p>
                <p className="text-[9px] text-[var(--text-faint)] font-semibold mt-1.5 leading-tight">
                  <span className="sm:hidden">Margine</span>
                  <span className="hidden sm:inline">Margine Medio</span>
                </p>
              </div>
              <div className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-3 text-center">
                <p className="text-xl font-bold text-violet-400 num">{Math.round(avgDaysToSell)}</p>
                <p className="text-[9px] text-[var(--text-faint)] font-semibold mt-1.5 leading-tight">
                  <span className="sm:hidden">Gg/vendita</span>
                  <span className="hidden sm:inline">Giorni medi vendita</span>
                </p>
              </div>
              <div className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-3 text-center">
                <p className="text-xl font-bold text-[var(--text)] num">{sellThroughRate}%</p>
                <p className="text-[9px] text-[var(--text-faint)] font-semibold mt-1.5 leading-tight">Sell-through</p>
              </div>
            </div>

            {/* Grafico */}
            <section className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-5">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-5">
                <h3 className="font-semibold">Andamento Vendite</h3>
                <div className="flex gap-1 bg-[var(--surface-2)] p-1 rounded-xl border border-[var(--border-2)]">
                  {(['1D', '1W', '1M', '1Y', 'MAX'] as const).map(tf => (
                    <button key={tf} onClick={() => setChartTimeframe(tf)}
                      className={`px-3 py-1 text-xs font-bold rounded-lg transition-colors ${
                        chartTimeframe === tf ? 'bg-[#8b5cf6] text-[var(--text)]' : 'text-[var(--text-soft)] hover:text-[var(--text)]'
                      }`}>{tf}</button>
                  ))}
                </div>
              </div>
              {trendData.length === 0 ? (
                <div className="text-center py-10">
                  <BarChart3 className="mx-auto text-gray-800 mb-3" size={36} />
                  <p className="text-[var(--text-soft)] text-sm">Nessun dato per questo periodo</p>
                </div>
              ) : (
                <Suspense fallback={<div className="h-[280px] flex items-center justify-center"><Loader2 className="animate-spin text-gray-700" size={28} /></div>}>
                  <TrendChart trendData={trendData} />
                </Suspense>
              )}
              <div className="flex items-center gap-5 mt-3 justify-end">
                <div className="flex items-center gap-1.5 text-[10px] text-[var(--text-soft)]"><span className="w-3 h-0.5 bg-green-500 rounded-full inline-block" />Ricavi</div>
                <div className="flex items-center gap-1.5 text-[10px] text-[var(--text-soft)]"><span className="w-3 h-0.5 bg-[#8b5cf6] rounded-full inline-block" />Profitto</div>
              </div>
            </section>

            {/* Piattaforme + Soci — 2 colonne su desktop */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
              {platformBreakdown.length > 0 && (
                <section className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-5">
                  <div className="flex items-center gap-2 mb-4">
                    <Store className="text-[var(--text)]" size={15} />
                    <h3 className="font-semibold">Piattaforme</h3>
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
                              <span className="text-[10px] text-[var(--text-soft)]">{stats.count} vend.</span>
                              <span className="text-sm font-semibold text-green-400">+{stats.profit.toFixed(0)}€</span>
                            </div>
                          </div>
                          <div className="h-2 bg-black/40 rounded-full overflow-hidden mb-1">
                            <div className="h-full bg-gradient-to-r from-[#8b5cf6] to-violet-400 rounded-full"
                              style={{ width: `${(stats.revenue / maxRev) * 100}%` }} />
                          </div>
                          <div className="flex justify-between">
                            <span className="text-[10px] text-[var(--text-faint)]">{stats.revenue.toFixed(0)}€ ricavi · {stats.fees.toFixed(0)}€ fee</span>
                            <span className="text-[10px] text-[var(--text-soft)]">{platMargin >= 0 ? '+' : ''}{platMargin.toFixed(0)}€/vend.</span>
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
                    <Users className="text-violet-400" size={15} />
                    <h3 className="font-semibold">Soci</h3>
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
                                  <span className="text-[9px] bg-[#8b5cf6]/20 text-[var(--text)] px-1.5 py-0.5 rounded-full">TU</span>
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
                    <h3 className="font-semibold">Top 3 Vendite</h3>
                  </div>
                  <div className="space-y-3">
                    {top.map((p, i) => {
                      const medals = ['🥇', '🥈', '🥉'];
                      const margin = p.purchasePrice > 0 ? ((p.profit / p.purchasePrice) * 100) : 0;
                      return (
                        <div key={p.id} className="flex items-center gap-3 p-3 bg-[var(--surface-2)] rounded-xl">
                          <span className="text-lg shrink-0">{medals[i]}</span>
                          <div className="flex-1 min-w-0">
                            <p className="font-bold text-sm truncate">{p.brand} {p.name}</p>
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
                    <h3 className="font-semibold">Reparti</h3>
                  </div>
                  <div className="overflow-x-auto -mx-1">
                    <table className="w-full text-[11px]">
                      <thead>
                        <tr className="border-b border-[var(--border-2)]">
                          {['Reparto', 'Totale', 'Venduti', 'Stock', 'Sell-through', 'Capitale', 'Profitto', 'Gg/vendita'].map(h => (
                            <th key={h} className="text-left text-[var(--text-faint)] font-semibold uppercase tracking-wider py-2 pr-4 last:pr-0">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[var(--border)]">
                        {rows.map(r => (
                          <tr key={r.cat} className="hover:bg-[var(--fill)] transition-colors">
                            <td className="py-2.5 pr-4 font-bold text-[var(--text)]">{getCategoryIcon(r.cat)} {r.cat}</td>
                            <td className="py-2.5 pr-4 text-[var(--text-muted)] num">{r.total}</td>
                            <td className="py-2.5 pr-4 text-violet-400 num">{r.sold}</td>
                            <td className="py-2.5 pr-4 text-[var(--text-muted)] num">{r.inStock}</td>
                            <td className="py-2.5 pr-4">
                              <div className="flex items-center gap-2">
                                <div className="w-16 h-1.5 bg-[var(--fill)] rounded-full overflow-hidden">
                                  <div className="h-full bg-[#8b5cf6] rounded-full" style={{ width: `${r.st}%` }} />
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
                    <h3 className="font-semibold">Dead Stock Alert</h3>
                    <span className="bg-yellow-500/10 text-yellow-400 text-[10px] font-bold px-2 py-0.5 rounded-full">{staleProducts.length} prodotti</span>
                  </div>
                  <span className="text-[10px] text-[var(--text-faint)]">fermi da +{staleThreshold} giorni · {staleProducts.reduce((s: number, p: any) => s + (p.purchasePrice || 0), 0).toFixed(0)}€ immobilizzati</span>
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
                          <p className="text-sm font-bold truncate">{p.brand} {p.name}</p>
                          <p className="text-[10px] text-[var(--text-soft)]">{p.size} · {p.condition}</p>
                        </div>
                        <div className="text-right shrink-0">
                          <p className="text-sm font-semibold text-[var(--text)]">{(p.purchasePrice || 0).toFixed(0)}€</p>
                          <p className="text-[10px] text-yellow-600">{days} giorni</p>
                        </div>
                      </div>
                    );
                  })}
                  {staleProducts.length > 5 && (
                    <p className="text-[11px] text-[var(--text-faint)] text-center pt-1">+{staleProducts.length - 5} altri prodotti fermi</p>
                  )}
                </div>
              </section>
            )}
          </div>
        )}

        {/* ========== TRACKING PAGE ========== */}
        {currentView === 'tracking' && (() => {
          const allTracked = products.filter(p => p.trackingCode);
          const active = allTracked.filter(p => ['PENDING','IN_TRANSIT','OUT_FOR_DELIVERY'].includes(p.trackingStatus || 'PENDING'));
          const delivered = allTracked.filter(p => p.trackingStatus === 'DELIVERED');
          const exceptions = allTracked.filter(p => p.trackingStatus === 'EXCEPTION' || p.trackingStatus === 'RETURNED');

          const statusLabel = (s?: string) => {
            if (s === 'IN_TRANSIT') return { text: 'In transito', cls: 'bg-blue-500/20 text-blue-400', dot: 'bg-blue-400' };
            if (s === 'OUT_FOR_DELIVERY') return { text: 'In consegna', cls: 'bg-violet-500/20 text-violet-400', dot: 'bg-violet-400' };
            if (s === 'DELIVERED') return { text: 'Consegnato', cls: 'bg-green-500/20 text-green-400', dot: 'bg-green-400' };
            if (s === 'EXCEPTION') return { text: 'Eccezione', cls: 'bg-red-500/20 text-red-400', dot: 'bg-red-400' };
            if (s === 'RETURNED') return { text: 'Reso', cls: 'bg-violet-500/20 text-violet-400', dot: 'bg-violet-400' };
            return { text: 'In attesa', cls: 'bg-[var(--fill)] text-[var(--text-soft)]', dot: 'bg-gray-600' };
          };

          const TrackCard = ({ p }: { p: Product }) => {
            let photos: string[] = [];
            try { photos = p.photos ? JSON.parse(p.photos) : []; } catch {}
            const st = statusLabel(p.trackingStatus);
            const updatedAgo = p.trackingUpdatedAt
              ? (() => {
                  const mins = Math.floor((Date.now() - new Date(p.trackingUpdatedAt).getTime()) / 60000);
                  if (mins < 60) return `${mins}m fa`;
                  const hrs = Math.floor(mins / 60);
                  if (hrs < 24) return `${hrs}h fa`;
                  return `${Math.floor(hrs / 24)}g fa`;
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
                      <p className="font-bold text-sm">{p.brand} {p.name}</p>
                      <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold flex items-center gap-1 shrink-0 ${st.cls}`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${st.dot}`} />
                        {st.text}
                      </span>
                    </div>
                    <p className="text-xs text-[var(--text-soft)] mt-0.5 font-mono truncate">{p.trackingCode}</p>
                    <div className="flex items-center gap-2 mt-1 flex-wrap">
                      <span className="text-[10px] text-[var(--text-faint)] bg-[var(--fill)] px-2 py-0.5 rounded-full">{p.trackingCarrier}</span>
                      {updatedAgo && <span className="text-[10px] text-[var(--text-faint)]">aggiornato {updatedAgo}</span>}
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
                    <p className="text-xs text-yellow-400 font-bold">📦 Spedizione consegnata — vendita da completare</p>
                    <button
                      onClick={() => openSellModal([p.id], `${p.brand} ${p.name}`, p)}
                      className="text-[10px] bg-yellow-500/20 hover:bg-yellow-500/30 text-yellow-400 px-3 py-1.5 rounded-xl font-bold transition-colors">
                      Completa
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
                  <h2 className="text-3xl font-semibold">Tracking</h2>
                  <p className="text-[var(--text-soft)] text-sm mt-1">Monitora le tue spedizioni</p>
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={openIncoming}
                    className="flex items-center gap-2 bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white px-4 py-2.5 rounded-xl text-sm font-bold transition-colors">
                    <Plus size={16} /> <span className="hidden sm:inline">Acquisto in arrivo</span><span className="sm:hidden">In arrivo</span>
                  </button>
                  {active.length > 0 && (
                    <button onClick={handleRefreshAllTrackings} disabled={isRefreshingAll}
                      className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 px-4 py-2.5 rounded-xl text-sm font-bold transition-colors">
                      {isRefreshingAll ? <Loader2 className="animate-spin" size={16} /> : <Truck size={16} />}
                      <span className="hidden sm:inline">{isRefreshingAll ? 'Aggiornamento...' : 'Aggiorna tutto'}</span>
                    </button>
                  )}
                </div>
              </div>

              {/* Stats */}
              <div className="grid grid-cols-3 gap-3">
                {[
                  { label: 'Attive', value: active.length, color: 'text-blue-400', bg: 'bg-[var(--surface)] border-blue-500/20', glow: 'bg-blue-500/8' },
                  { label: 'Consegnate', value: delivered.length, color: 'text-emerald-400', bg: 'bg-[var(--surface)] border-green-500/20', glow: 'bg-green-500/8' },
                  { label: 'Eccezioni', value: exceptions.length, color: 'text-red-400', bg: 'bg-[var(--surface)] border-red-500/20', glow: 'bg-red-500/8' },
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
                  <p className="text-[var(--text-muted)] font-semibold">Nessuna spedizione tracciata</p>
                  <p className="text-[var(--text-faint)] text-sm mt-1">Usa "Acquisto in arrivo" qui sopra, oppure traccia da Magazzino → Track</p>
                </div>
              )}

              {/* Sezione: Attive */}
              {active.length > 0 && (
                <div className="space-y-3">
                  <h3 className="text-[10px] lg:text-xs font-semibold text-[var(--text-muted)] tracking-[0.12em] uppercase flex items-center gap-2">
                    <span className="w-2 h-2 bg-blue-400 rounded-full animate-pulse" />
                    Spedizioni attive ({active.length})
                  </h3>
                  {active.map(p => <TrackCard key={p.id} p={p} />)}
                </div>
              )}

              {/* Sezione: Eccezioni / Resi */}
              {exceptions.length > 0 && (
                <div className="space-y-3">
                  <h3 className="text-[10px] lg:text-xs font-semibold text-[var(--text-muted)] tracking-[0.12em] uppercase flex items-center gap-2">
                    <span className="w-2 h-2 bg-red-400 rounded-full" />
                    Eccezioni / Resi ({exceptions.length})
                  </h3>
                  {exceptions.map(p => <TrackCard key={p.id} p={p} />)}
                </div>
              )}

              {/* Sezione: Consegnate */}
              {delivered.length > 0 && (
                <div className="space-y-3">
                  <h3 className="text-[10px] lg:text-xs font-semibold text-[var(--text-muted)] tracking-[0.12em] uppercase flex items-center gap-2">
                    <span className="w-2 h-2 bg-green-400 rounded-full" />
                    Consegnate ({delivered.length})
                  </h3>
                  {delivered.map(p => <TrackCard key={p.id} p={p} />)}
                </div>
              )}
            </div>
          );
        })()}

        {/* ========== SETTINGS ========== */}
        {currentView === 'settings' && (
          <div className="space-y-5">
            <h2 className="text-3xl font-semibold">Impostazioni</h2>

            {/* SEZIONE: Piani & Pro */}
            <section className="bg-gradient-to-br from-[#8b5cf6]/10 to-[var(--surface)] border border-[#8b5cf6]/30 rounded-2xl p-6">
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-start gap-3">
                  <Sparkles className="text-[#8b5cf6] mt-0.5" size={22} />
                  <div>
                    <h3 className="text-lg font-bold tracking-tighter">Piani &amp; Strumenti Pro</h3>
                    <p className="text-xs text-[var(--text-soft)] mt-1">
                      Piano attuale: <b className="text-[var(--text)] uppercase">{myPlan}</b> · sblocca riprezzamento, assistente trattative e multi-canale.
                    </p>
                  </div>
                </div>
                <button onClick={() => openPlanModal()}
                  className="px-4 py-2 rounded-xl text-xs font-bold bg-[#8b5cf6] hover:bg-[#a78bfa] text-white transition-colors whitespace-nowrap">
                  Vedi piani
                </button>
              </div>
            </section>

            {/* SEZIONE: Notifiche push */}
            <section className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-6">
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-start gap-3">
                  <Bell className={pushEnabled ? 'text-[#8b5cf6] mt-0.5' : 'text-[var(--text-soft)] mt-0.5'} size={22} />
                  <div>
                    <h3 className="text-lg font-bold tracking-tighter">Notifiche</h3>
                    <p className="text-xs text-[var(--text-soft)] mt-1">
                      {pushEnabled
                        ? '✓ Attive su questo dispositivo: vendite, spedizioni e avvisi anche ad app chiusa.'
                        : 'Ricevi avvisi (vendite, spedizioni, prodotti fermi) direttamente sul dispositivo.'}
                    </p>
                  </div>
                </div>
                <button onClick={() => pushEnabled ? disablePush() : enablePush()} disabled={pushBusy || !pushSupported}
                  className={`px-4 py-2 rounded-xl text-xs font-bold transition-colors whitespace-nowrap disabled:opacity-40 ${
                    pushEnabled ? 'bg-red-600/20 hover:bg-red-600/30 text-red-400' : 'bg-[#8b5cf6] hover:bg-[#a78bfa] text-white'
                  }`}>
                  {pushBusy ? <Loader2 size={14} className="animate-spin" /> : pushEnabled ? 'Disattiva' : 'Attiva'}
                </button>
              </div>
              {pushEnabled && user?.warehouses?.some(w => w.role === 'OWNER') && (
                <button onClick={sendTestPush} disabled={pushBusy}
                  className="mt-4 w-full py-2 rounded-xl border border-[var(--border-2)] bg-[var(--surface-2)] text-xs font-bold text-[var(--text-soft)] hover:text-[var(--text)] hover:border-[var(--border-3)] transition-colors disabled:opacity-40 flex items-center justify-center gap-2">
                  <Bell size={13} /> Invia notifica di prova
                </button>
              )}
              {!pushSupported && (
                <p className="text-[10px] text-[var(--text-faint)] mt-3">Su iPhone le notifiche funzionano solo se aggiungi l'app alla schermata Home.</p>
              )}
            </section>

            {/* SEZIONE: Prodotti Fermi */}
            <section className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-6">
              <div className="flex items-center gap-2 mb-4">
                <AlertTriangle className="text-yellow-500" size={18} />
                <h3 className="text-lg font-bold tracking-tighter">Notifiche Prodotti Fermi</h3>
              </div>
              <p className="text-xs text-[var(--text-soft)] mb-4">
                Ricevi una notifica quando hai prodotti in magazzino da troppo tempo, con suggerimento di sconto basato sull'IA.
              </p>
              <div className="flex items-center gap-3 mb-4">
                <label className="text-sm text-[var(--text-muted)] flex-1">Avvisami dopo</label>
                <input 
                  type="number" min="7" max="365" value={staleThreshold}
                  onChange={(e: any) => {
                    const v = parseInt(e.target.value) || 60;
                    setStaleThreshold(v);
                    localStorage.setItem('staleThreshold', v.toString());
                  }}
                  className="w-24 bg-[var(--surface-2)] border border-[var(--border-2)] rounded-lg px-3 py-2 text-sm text-right focus:border-[#8b5cf6] outline-none"
                />
                <span className="text-sm text-[var(--text-muted)]">giorni</span>
              </div>
              {staleProducts.length > 0 ? (
                <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-3">
                  <p className="text-sm font-bold text-yellow-400 mb-2">
                    ⏰ Hai {staleProducts.length} prodott{staleProducts.length === 1 ? 'o fermo' : 'i fermi'}
                  </p>
                  <div className="space-y-2 max-h-64 overflow-y-auto">
                    {staleProducts.slice(0, 10).map((sp: any) => (
                      <div key={sp.id} className="text-xs bg-[var(--surface-2)] p-2 rounded-lg">
                        <p className="text-[var(--text)] font-bold">{sp.brand} {sp.name}</p>
                        <p className="text-[var(--text-soft)]">
                          {sp.daysInStock}g in stock • Sconto: <span className="text-yellow-400 font-bold">-{sp.suggestedDiscount}%</span> → <span className="text-green-400">€{sp.suggestedPrice}</span>
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <p className="text-xs text-[var(--text-faint)] italic">✓ Nessun prodotto fermo oltre la soglia</p>
              )}
              <button 
                onClick={checkStaleProducts}
                className="mt-3 w-full bg-yellow-600/20 hover:bg-yellow-600/30 text-yellow-400 py-2 rounded-xl text-xs font-bold transition-colors">
                Ricontrolla ora
              </button>
            </section>
            
            {/* SEZIONE: 2FA */}
            <section className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-6">
              <div className="flex items-start justify-between gap-4 mb-4">
                <div className="flex items-start gap-3">
                  <Shield className={user.twoFactorEnabled ? 'text-green-400' : 'text-[var(--text-soft)]'} size={24} />
                  <div>
                    <h3 className="text-lg font-bold tracking-tighter">Autenticazione a Due Fattori</h3>
                    <p className="text-xs text-[var(--text-soft)] mt-1">
                      {user.twoFactorEnabled 
                        ? '✓ 2FA attivo. Il tuo account ha un livello di sicurezza extra.' 
                        : 'Aggiungi un livello di sicurezza al tuo account.'}
                    </p>
                  </div>
                </div>
                {user.twoFactorEnabled ? (
                  <button onClick={handle2FADisable}
                    className="px-4 py-2 bg-red-600/20 hover:bg-red-600/30 text-red-400 rounded-xl text-xs font-bold transition-colors whitespace-nowrap">
                    Disabilita
                  </button>
                ) : (
                  <button onClick={handle2FASetupStart} disabled={twoFaLoading}
                    className="px-4 py-2 bg-[#8b5cf6] hover:bg-[#a78bfa] rounded-xl text-xs font-bold transition-colors whitespace-nowrap">
                    Attiva 2FA
                  </button>
                )}
              </div>
            </section>
            
            {/* SEZIONE: CAMBIA PASSWORD */}
            <section className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-6">
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-start gap-3">
                  <Lock className="text-[var(--text-soft)] mt-0.5" size={22} />
                  <div>
                    <h3 className="text-lg font-bold tracking-tighter">Password</h3>
                    <p className="text-xs text-[var(--text-soft)] mt-1">Cambia la password del tuo account.</p>
                  </div>
                </div>
                <button onClick={() => setChangePwdOpen(true)}
                  className="px-4 py-2 bg-[#8b5cf6] hover:bg-[#a78bfa] rounded-xl text-xs font-bold transition-colors whitespace-nowrap">
                  Cambia
                </button>
              </div>
            </section>

            {/* SEZIONE: Reparti & Codici Invito */}
            <section className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-6">
              <div className="flex items-center gap-2 mb-5">
                <Layers className="text-[var(--text)]" size={18} />
                <h3 className="text-lg font-bold tracking-tighter">I tuoi Reparti</h3>
              </div>
              
              <div className="space-y-3 mb-6">
                {user.warehouses.map((w: any) => (
                  <div key={w.id} className="bg-[var(--surface-2)] p-4 rounded-xl border border-[var(--border-2)]">
                    <div className="flex items-center justify-between flex-wrap gap-3">
                      <div className="flex items-center gap-3">
                        <span className="text-2xl">{getCategoryIcon(w.name.replace('Magazzino ', ''))}</span>
                        <div>
                          <p className="font-bold">{w.name}</p>
                          <p className="text-[10px] text-[var(--text-soft)] uppercase">
                            {w.role === 'OWNER' ? 'Fondatore' : 'Membro'} • Quota {w.percentage}%
                          </p>
                        </div>
                      </div>
                      {w.inviteCode && (
                        <button 
                          onClick={() => {
                            navigator.clipboard.writeText(w.inviteCode);
                            showToast('Codice copiato!');
                          }}
                          className="flex items-center gap-2 bg-blue-600/20 hover:bg-blue-600/30 text-blue-400 px-3 py-2 rounded-lg text-xs font-mono">
                          <KeyRound size={12} /> {w.inviteCode} <Copy size={12} />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
              
              {isFounder && (
                <form onSubmit={handleAddCategory} className="flex flex-col sm:flex-row gap-3 pt-5 border-t border-[var(--border-2)]">
                  <input type="text" value={newCatName}
                    onChange={(e: any) => setNewCatName(e.target.value)}
                    placeholder="Nome nuovo reparto (es. Borse, Vinili...)"
                    className="flex-1 bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl px-4 py-2 text-sm focus:border-[#8b5cf6] outline-none" />
                  <button type="submit" disabled={isAddingCat}
                    className="bg-[#8b5cf6] hover:bg-[#a78bfa] px-5 py-2 rounded-xl text-sm font-bold transition-colors whitespace-nowrap">
                    {isAddingCat ? <Loader2 className="animate-spin" size={16} /> : '+ Aggiungi Reparto'}
                  </button>
                </form>
              )}
            </section>
            
            {/* SEZIONE: Team & Quote */}
            {teamData.map((team: any) => (
              <section key={team.warehouseId} className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-6">
                <div className="flex items-center gap-2 mb-5">
                  <Users className="text-blue-500" size={18} />
                  <h3 className="text-lg font-bold tracking-tighter">Soci di {team.warehouseName}</h3>
                </div>
                
                <div className="space-y-3 mb-4">
                  {team.members.map((m: any) => (
                    <div key={m.membershipId} className="flex items-center gap-3 bg-[var(--surface-2)] p-3 rounded-xl">
                      <div className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-500 to-blue-700 flex items-center justify-center font-bold text-sm">
                        {m.name[0]?.toUpperCase()}
                      </div>
                      <div className="flex-1">
                        <p className="font-bold text-sm">{m.name}</p>
                        <p className="text-[10px] text-[var(--text-soft)] uppercase">{m.role === 'OWNER' ? 'Fondatore' : 'Membro'}</p>
                      </div>
                      <input type="number" min="0" max="100" value={m.percentage}
                        onChange={(e: any) => updateMemberPercentage(team.warehouseId, m.membershipId, e.target.value)}
                        className="w-20 bg-[var(--surface)] border border-[var(--border)] rounded-lg px-3 py-1.5 text-sm text-right focus:border-[#8b5cf6] outline-none" />
                      <span className="text-[var(--text-soft)] text-xs">%</span>
                    </div>
                  ))}
                </div>

                <p className={`text-xs font-bold mb-3 ${
                  Math.round(team.members.reduce((s: number, m: any) => s + (Number(m.percentage) || 0), 0)) === 100
                    ? 'text-green-500' : 'text-yellow-500'
                }`}>
                  Totale: {team.members.reduce((s: number, m: any) => s + (Number(m.percentage) || 0), 0).toFixed(0)}%
                  {Math.round(team.members.reduce((s: number, m: any) => s + (Number(m.percentage) || 0), 0)) !== 100 && ' (deve essere 100%)'}
                </p>

                <button onClick={() => savePercentages(team.warehouseId, team.members)}
                  disabled={isSavingTeam}
                  className="w-full bg-blue-600 hover:bg-blue-500 py-2 rounded-xl text-sm font-bold transition-colors flex items-center justify-center gap-2">
                  {isSavingTeam ? <Loader2 className="animate-spin" size={16} /> : 'Salva Quote'}
                </button>

                {/* Elimina reparto — solo OWNER, piccolo e discreto */}
                {team.myRole === 'OWNER' && user.warehouses.length > 1 && (
                  <div className="mt-4 pt-4 border-t border-[var(--border)] flex justify-end">
                    <button
                      onClick={async () => {
                        if (!confirm(`Eliminare il reparto "${team.warehouseName.replace('Magazzino ', '')}"? Tutti i prodotti associati verranno rimossi.`)) return;
                        const { ok, data } = await apiCall(`/warehouses/${team.warehouseId}`, { method: 'DELETE' });
                        if (ok) { setUser(data.user); await fetchTeam(); showToast('Reparto eliminato'); }
                        else showToast(data.error || 'Errore', 'err');
                      }}
                      className="text-[11px] text-red-500/40 hover:text-red-400/70 transition-colors flex items-center gap-1"
                    >
                      <Trash2 size={11} /> Elimina reparto
                    </button>
                  </div>
                )}
              </section>
            ))}

            {/* ===== ENTRA IN UN MAGAZZINO ===== */}
            <section className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-5">
              <div className="flex items-center gap-2 mb-1">
                <UserPlus size={15} className="text-[var(--text-muted)]" />
                <h3 className="font-semibold text-sm">Entra in un Magazzino</h3>
              </div>
              <p className="text-[11px] text-[var(--text-faint)] mb-4">Hai ricevuto un codice invito? Inseriscilo qui per unirti al team.</p>
              <form onSubmit={handleJoinWarehouse} className="flex flex-col gap-2">
                <input
                  value={joinCodeInput}
                  onChange={e => setJoinCodeInput(e.target.value.toUpperCase())}
                  placeholder="Codice invito (es: ABC123XY)"
                  maxLength={20}
                  className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl px-4 py-3 text-sm font-mono tracking-widest focus:border-[var(--border-3)] outline-none uppercase"
                />
                <button type="submit" disabled={isJoining || !joinCodeInput.trim()}
                  className="w-full py-3 bg-white text-black rounded-xl text-sm font-semibold hover:bg-gray-200 transition-colors disabled:opacity-40">
                  {isJoining ? <Loader2 size={16} className="animate-spin mx-auto" /> : 'Entra nel Magazzino'}
                </button>
              </form>
            </section>

            {/* ===== DATI: import/export ===== */}
            <section className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-5">
              <div className="flex items-center gap-2 mb-1">
                <Download size={15} className="text-[var(--text-muted)]" />
                <h3 className="font-semibold text-sm">Dati</h3>
              </div>
              <p className="text-[11px] text-[var(--text-faint)] mb-4">Importa prodotti da Excel/CSV nel tuo magazzino.</p>
              <div className="flex flex-wrap gap-2">
                <label className="px-4 py-2.5 text-xs font-bold rounded-xl border border-[var(--border-2)] bg-[var(--surface-2)] text-gray-300 hover:text-[var(--text)] hover:border-[var(--border-3)] cursor-pointer transition-colors flex items-center gap-2">
                  <Download size={14} /> Importa Excel
                  <input type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleExcelFile} />
                </label>
              </div>
            </section>

            {/* SEZIONE: Aiuto & Assistenza — il messaggio arriva all'admin via email */}
            <section className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-6">
              <div className="flex items-center gap-2 mb-1">
                <Mail size={18} className="text-[#8b5cf6]" />
                <h3 className="text-lg font-bold tracking-tighter">Aiuto & Assistenza</h3>
              </div>
              <p className="text-xs text-[var(--text-soft)] mb-4">
                Hai una domanda, un'idea o hai trovato un problema? Scrivici: il messaggio arriva direttamente a noi.
              </p>
              <div className="flex flex-wrap gap-2 mb-3">
                {([
                  { v: 'idea', label: 'Idea', Icon: Lightbulb },
                  { v: 'bug', label: 'Problema', Icon: Bug },
                  { v: 'domanda', label: 'Domanda', Icon: HelpCircle },
                  { v: 'altro', label: 'Altro', Icon: MoreHorizontal },
                ] as const).map(o => (
                  <button key={o.v} type="button" onClick={() => setFeedbackType(o.v)}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold border transition-colors ${
                      feedbackType === o.v
                        ? 'bg-[#8b5cf6]/10 border-[#8b5cf6] text-[var(--text)]'
                        : 'bg-[var(--surface-2)] border-[var(--border-2)] text-[var(--text-soft)] hover:border-gray-600'
                    }`}>
                    <o.Icon size={14} /> {o.label}
                  </button>
                ))}
              </div>
              <textarea value={feedbackMsg} onChange={(e: any) => setFeedbackMsg(e.target.value)}
                maxLength={4000} rows={4}
                placeholder="Scrivi qui il tuo messaggio…"
                className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm focus:border-[#8b5cf6] outline-none resize-none" />
              <div className="flex items-center justify-between gap-3 mt-3">
                <span className="text-[10px] text-[var(--text-faint)]">{feedbackMsg.length}/4000</span>
                <button onClick={sendFeedback} disabled={feedbackSending || feedbackMsg.trim().length < 3}
                  className="px-5 py-2 bg-[#8b5cf6] hover:bg-[#a78bfa] rounded-xl text-sm font-bold transition-colors disabled:opacity-40 flex items-center gap-2">
                  {feedbackSending ? <Loader2 className="animate-spin" size={16} /> : <Mail size={15} />}
                  Invia
                </button>
              </div>
            </section>

            {/* SEZIONE: Aspetto / Tema — in fondo, poco rilevante */}
            <section className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-6">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                <div className="flex items-start gap-3">
                  {theme === 'light' ? <Sun className="text-[#8b5cf6] mt-0.5" size={22} /> : theme === 'glass' ? <Sparkles className="text-[#8b5cf6] mt-0.5" size={22} /> : <Moon className="text-[#8b5cf6] mt-0.5" size={22} />}
                  <div>
                    <h3 className="text-lg font-bold tracking-tighter">Aspetto</h3>
                    <p className="text-xs text-[var(--text-soft)] mt-1">Scegli il tema: scuro, chiaro o vetro.</p>
                  </div>
                </div>
                <div className="flex bg-[var(--surface-2)] p-1 rounded-xl border border-[var(--border-2)] shrink-0 self-center sm:self-auto">
                  <button onClick={() => setTheme('dark')}
                    className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-lg transition-colors ${
                      theme === 'dark' ? 'bg-[#8b5cf6] text-white' : 'text-[var(--text-soft)]'
                    }`}>
                    <Moon size={13} /> Scuro
                  </button>
                  <button onClick={() => setTheme('light')}
                    className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-lg transition-colors ${
                      theme === 'light' ? 'bg-[#8b5cf6] text-white' : 'text-[var(--text-soft)]'
                    }`}>
                    <Sun size={13} /> Chiaro
                  </button>
                  <button onClick={() => setTheme('glass')}
                    className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-lg transition-colors ${
                      theme === 'glass' ? 'bg-[#8b5cf6] text-white' : 'text-[var(--text-soft)]'
                    }`}>
                    <Sparkles size={13} /> Glass
                  </button>
                </div>
              </div>
            </section>

            {/* ===== ELIMINAZIONE ACCOUNT ===== */}
            <section className="bg-[var(--surface)] border border-red-500/30 rounded-2xl p-5">
              <div className="flex items-center gap-2 mb-1">
                <AlertTriangle size={15} className="text-red-500" />
                <h3 className="font-semibold text-sm text-red-500">Eliminazione Account</h3>
              </div>
              <p className="text-[11px] text-[var(--text-muted)] mb-4">
                L'eliminazione dell'account è permanente e irreversibile. Tutti i tuoi prodotti, dati e accessi verranno cancellati definitivamente.
              </p>
              <button onClick={() => setDeleteAccountStep(1)}
                className="px-4 py-2 rounded-xl border border-red-500/40 text-red-500 text-xs font-semibold hover:bg-red-500 hover:text-white transition-colors">
                Elimina il mio account
              </button>
            </section>

          </div>
        )}

        {/* ========== PAGINA ADMIN (dedicata, solo ADMIN_EMAIL) ========== */}
        {currentView === 'admin' && user.email.toLowerCase() === ADMIN_EMAIL.toLowerCase() && (
          <div className="space-y-5">
            <div className="flex items-center gap-2">
              <Shield size={24} className="text-[#8b5cf6]" />
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
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors ${adminView === 'users' ? 'bg-[#8b5cf6] text-white' : 'bg-[var(--fill)] text-[var(--text-soft)]'}`}>
                  Utenti
                </button>
                <button onClick={() => { setAdminView('feedback'); fetchAdminFeedback(); }}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors flex items-center gap-1.5 ${adminView === 'feedback' ? 'bg-[#8b5cf6] text-white' : 'bg-[var(--fill)] text-[var(--text-soft)]'}`}>
                  Richieste
                  {adminFbNuove > 0 && (
                    <span className={`text-[9px] px-1.5 py-0.5 rounded-full ${adminView === 'feedback' ? 'bg-white/25' : 'bg-[#8b5cf6] text-white'}`}>{adminFbNuove}</span>
                  )}
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
                              className="text-[10px] bg-[var(--fill)] border border-[var(--border-2)] rounded-lg px-2 py-1 outline-none focus:border-[#8b5cf6]">
                              <option value="free">Free</option>
                              <option value="starter">Starter 9.99</option>
                              <option value="pro">Pro 19.99</option>
                              <option value="business">Business 39.99</option>
                            </select>
                          </div>
                        </div>
                        {u.email.toLowerCase() !== ADMIN_EMAIL.toLowerCase() && (
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
              {adminView === 'feedback' && (
                <div className="divide-y divide-[var(--border)] max-h-[34rem] overflow-y-auto">
                  {adminFeedback.length === 0 ? (
                    <p className="p-6 text-center text-xs text-[var(--text-faint)]">Nessuna richiesta al momento.</p>
                  ) : adminFeedback.map(f => (
                    <div key={f.id} className="px-4 py-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="text-[9px] uppercase font-bold px-1.5 py-0.5 rounded-full bg-[var(--fill)] text-[var(--text-soft)]">{f.type}</span>
                            {f.status === 'nuova'
                              ? <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-[#8b5cf6] text-white font-bold">nuova</span>
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
                            className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-2.5 text-sm focus:border-[#8b5cf6] outline-none resize-none" />
                          <div className="flex items-center justify-end gap-2 mt-2">
                            <button onClick={() => { setReplyingId(null); setReplyText(''); }}
                              className="px-3 py-1.5 text-xs font-bold text-[var(--text-soft)] hover:text-[var(--text)] transition-colors">Annulla</button>
                            <button onClick={() => sendAdminReply(f.id)} disabled={replySending || replyText.trim().length < 2}
                              className="px-4 py-1.5 bg-[#8b5cf6] hover:bg-[#a78bfa] rounded-lg text-xs font-bold transition-colors disabled:opacity-40 flex items-center gap-1.5">
                              {replySending ? <Loader2 size={13} className="animate-spin" /> : <Mail size={13} />}
                              Invia via email
                            </button>
                          </div>
                        </div>
                      ) : (
                        <button onClick={() => { setReplyingId(f.id); setReplyText(f.reply || ''); }}
                          className="mt-2 text-xs font-bold text-[#8b5cf6] hover:text-[#a78bfa] transition-colors">
                          {f.reply ? 'Modifica risposta' : '↩ Rispondi'}
                        </button>
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

      {/* ========== COMMAND PALETTE (⌘K / Ctrl+K) ========== */}
      {cmdOpen && (() => {
        const q = cmdQuery.trim().toLowerCase();
        const baseActions: any[] = [
          { key: 'nav-dashboard', icon: LayoutDashboard, label: 'Vai a Dashboard', sub: '', run: () => navigateTo('dashboard') },
          { key: 'nav-magazzino', icon: Package, label: 'Vai a Magazzino', sub: '', run: () => navigateTo('magazzino') },
          { key: 'nav-analytics', icon: BarChart3, label: 'Vai ad Analytics', sub: '', run: () => navigateTo('analytics') },
          { key: 'nav-tracking', icon: Truck, label: 'Vai a Tracking', sub: '', run: () => navigateTo('tracking') },
          { key: 'nav-settings', icon: Settings, label: 'Vai a Impostazioni', sub: '', run: () => navigateTo('settings') },
          { key: 'act-add', icon: Plus, label: 'Aggiungi prodotto', sub: 'Nuovo inserimento in magazzino', run: () => openAddForm() },
          { key: 'act-sourcing', icon: DollarSign, label: 'Ricerca valore', sub: 'Prezzo di mercato e max d\'acquisto per il margine voluto', run: () => openSourcing() },
        ];
        // Azioni sui selezionati (quando sei in modalità selezione)
        if (bulkMode && getBulkSelectedIds().length > 0) {
          const n = getBulkSelectedIds().length;
          baseActions.push(
            { key: 'act-bulk-sell', icon: DollarSign, label: `Vendi selezionati (${n})`, sub: '', run: () => setBulkSellOpen(true) },
            { key: 'act-bulk-del', icon: Trash2, label: `Elimina selezionati (${n})`, sub: '', run: () => setBulkDeleteConfirmOpen(true) },
          );
        }
        baseActions.push(
          { key: 'act-theme-dark', icon: Moon, label: 'Tema scuro', sub: '', run: () => setTheme('dark') },
          { key: 'act-theme-light', icon: Sun, label: 'Tema chiaro', sub: '', run: () => setTheme('light') },
          { key: 'act-theme-glass', icon: Sparkles, label: 'Tema vetro (glass)', sub: '', run: () => setTheme('glass') },
          { key: 'act-logout', icon: LogOut, label: 'Esci', sub: '', run: () => handleLogout() },
        );
        const navActions = baseActions.filter(a => !q || a.label.toLowerCase().includes(q));
        const prodItems = (q.length > 0
          ? products.filter((p: any) => `${p.brand} ${p.name} ${p.size || ''} ${p.category || ''}`.toLowerCase().includes(q)).slice(0, 8)
          : []
        ).map((p: any) => ({
          key: `prod-${p.id}`, icon: Package,
          label: `${p.brand} ${p.name}`,
          sub: `${p.size ? p.size + ' · ' : ''}${p.category || ''} · ${p.status === 'VENDUTO' ? 'venduto' : 'in stock'}`,
          run: () => {
            setCurrentView('magazzino');
            setMagazzinoView(p.status === 'VENDUTO' ? 'sold' : 'instock');
            setFilterCat('all');
            setSearchTerm(`${p.brand} ${p.name}`);
            window.scrollTo({ top: 0, behavior: 'smooth' });
          },
        }));
        const items = [...navActions, ...prodItems];
        const sel = Math.min(cmdIndex, Math.max(0, items.length - 1));
        const close = () => { setCmdOpen(false); setCmdQuery(''); setCmdIndex(0); };
        const choose = (i: number) => { const it = items[i]; if (it) { it.run(); close(); } };
        return (
          <div className="fixed inset-0 z-[60] flex items-start justify-center p-4 pt-[12vh] bg-black/60 backdrop-blur-sm" onClick={close}>
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
                  placeholder="Cerca prodotti o azioni…"
                  className="flex-1 bg-transparent py-4 text-sm outline-none placeholder:text-[var(--text-faint)]" />
                <kbd className="hidden sm:block text-[10px] text-[var(--text-faint)] border border-[var(--border-2)] rounded px-1.5 py-0.5">ESC</kbd>
              </div>
              <div className="max-h-[50vh] overflow-y-auto py-2">
                {items.length === 0 ? (
                  <p className="px-4 py-8 text-center text-sm text-[var(--text-soft)]">Nessun risultato</p>
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
                <span className="flex items-center gap-1"><kbd className="border border-[var(--border-2)] rounded px-1">↑</kbd><kbd className="border border-[var(--border-2)] rounded px-1">↓</kbd> naviga</span>
                <span className="flex items-center gap-1"><kbd className="border border-[var(--border-2)] rounded px-1">↵</kbd> apri</span>
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
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
          <div className="bg-[var(--surface)] border-t sm:border border-[var(--border-2)] rounded-t-3xl sm:rounded-3xl w-full max-w-md max-h-[92vh] overflow-y-auto">
            <div className="flex justify-center pt-3 pb-1 sm:hidden"><div className="w-10 h-1 bg-gray-700 rounded-full" /></div>
            <div className="sticky top-0 bg-[var(--surface)] border-b border-[var(--border)] p-5 flex items-center justify-between z-10">
              <div className="flex items-center gap-2">
                <DollarSign size={20} className="text-[#8b5cf6]" />
                <h2 className="text-xl font-semibold">Ricerca valore</h2>
              </div>
              <button onClick={() => setSourcingOpen(false)} className="p-2 hover:bg-[var(--fill)] rounded-lg transition-colors"><X size={20} /></button>
            </div>

            <div className="p-5 space-y-4">
              <p className="text-xs text-[var(--text-soft)]">Scatta una foto dell'oggetto: l'IA lo riconosce e ti dice il <b>valore di mercato</b> e il <b>prezzo massimo d'acquisto</b> per il margine che vuoi. Niente da scrivere.</p>

              {/* Solo foto */}
              <button type="button" onClick={() => sourcingCamInputRef.current?.click()} disabled={sourcingScanning || sourcingCalcLoading}
                className="w-full py-4 rounded-2xl border border-violet-500/40 bg-violet-500/10 hover:bg-violet-500/20 text-sm font-bold flex items-center justify-center gap-2 transition-colors disabled:opacity-40">
                {(sourcingScanning || sourcingCalcLoading)
                  ? <><Loader2 size={18} className="animate-spin text-violet-400" /> {sourcingScanning ? 'Riconoscimento…' : 'Valutazione…'}</>
                  : <><Camera size={18} className="text-violet-400" /> Scatta foto</>}
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
                          className={`flex-1 py-2 rounded-lg text-xs font-bold border transition-colors ${sourcingMargin === m ? 'bg-[#8b5cf6]/10 border-[#8b5cf6] text-[var(--text)]' : 'bg-[var(--surface-2)] border-[var(--border-2)] text-[var(--text-soft)]'}`}>
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

      {/* ========== FAB MOBILE ========== */}
      <button
        onClick={() => openAddForm()}
        className="lg:hidden fixed z-40 bg-[#8b5cf6] rounded-full shadow-xl flex items-center justify-center active:scale-90 transition-all"
        style={{ width: 54, height: 54, bottom: 'calc(5.5rem + env(safe-area-inset-bottom))', right: 16 }}
      >
        <Plus size={24} />
      </button>

      {/* ========== ADD TYPE PICKER ========== */}

      {/* ========== MOBILE BOTTOM NAV — minimal iOS style ========== */}
      <nav
        className="lg:hidden fixed bottom-0 left-0 right-0 z-30"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        {/* Sfondo quasi invisibile — frosted glass leggero */}
        <div className="absolute inset-0 bg-[var(--bg-overlay)] backdrop-blur-2xl" />
        {/* Separatore appena percettibile */}
        <div className="absolute top-0 left-0 right-0 h-px bg-[var(--fill)]" />

        <div className="relative grid grid-cols-5 px-2">
          {[
            { id: 'dashboard',  icon: LayoutDashboard },
            { id: 'magazzino',  icon: Package },
            { id: 'analytics',  icon: BarChart3 },
            { id: 'tracking',   icon: Truck },
            { id: 'settings',   icon: Settings },
          ].map(tab => {
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
                    <span className="absolute -top-1 -right-1.5 w-3.5 h-3.5 bg-[#8b5cf6] text-[var(--text)] rounded-full text-[8px] font-bold flex items-center justify-center">
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
      </nav>
      
      {/* ========== MODALE: AGGIUNGI PRODOTTO ========== */}
      {isFormOpen && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
          <div className="bg-[var(--surface)] border-t sm:border border-[var(--border-2)] rounded-t-3xl sm:rounded-3xl w-full max-w-2xl max-h-[92vh] overflow-y-auto">
            {/* Drag handle (solo mobile) */}
            <div className="flex justify-center pt-3 pb-1 sm:hidden">
              <div className="w-10 h-1 bg-gray-700 rounded-full" />
            </div>
            <div className="sticky top-0 bg-[var(--surface)] border-b border-[var(--border)] p-5 flex items-center justify-between z-10">
              <div>
                <h2 className="text-xl font-semibold">Aggiungi Prodotto</h2>
                <button type="button"
                  onClick={() => { setIsFormOpen(false); setLotCategory(userCategories[0] || ''); setLotOpen(true); }}
                  className="text-[11px] text-[var(--text-faint)] hover:text-[var(--text-muted)] transition-colors mt-0.5 flex items-center gap-1">
                  <Layers size={10} /> Stai comprando un lotto? Clicca qui
                </button>
              </div>
              <button onClick={() => setIsFormOpen(false)}
                className="p-2 hover:bg-[var(--fill)] rounded-lg transition-colors">
                <X size={20} />
              </button>
            </div>
            
            <form onSubmit={handleSave} className="p-5 space-y-5">
              
              {/* Tabs categoria — in Automatico foto-first la griglia è nascosta
                  finché non c'è una foto o non la si apre a mano (vista minimale). */}
              {(() => {
                const autoCollapsed = category === AUTO_CATEGORY && productPhotos.length === 0 && !scanResult && !showRepartoGrid;
                if (autoCollapsed) {
                  return (
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[11px] text-[var(--text-soft)] flex items-center gap-1.5">
                        <Sparkles size={12} className="text-violet-400" /> Modalità automatica — aggiungi una foto
                      </span>
                      <button type="button" onClick={() => setShowRepartoGrid(true)}
                        className="text-[11px] font-bold text-[var(--text-soft)] hover:text-[var(--text)] transition-colors">
                        Scegli reparto a mano
                      </button>
                    </div>
                  );
                }
                return (
                <div>
                <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">Reparto</label>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {/* Automatico: l'IA rileva il reparto dalla foto */}
                  <button type="button"
                    onClick={() => { setCategory(AUTO_CATEGORY); setDetectedReparto(''); }}
                    className={`p-3 rounded-xl text-sm font-bold border transition-all ${
                      category === AUTO_CATEGORY
                        ? 'bg-violet-500/15 border-violet-500 text-[var(--text)]'
                        : 'bg-[var(--surface-2)] border-[var(--border-2)] text-[var(--text-soft)] hover:border-gray-600'
                    }`}>
                    <span className="block text-xl mb-1"><Sparkles size="1em" className="inline-block align-[-0.125em]" /></span>
                    Automatico
                  </button>
                  {userCategories.map((cat: string) => (
                    <button key={cat} type="button" onClick={() => { setCategory(cat); setSize(defaultSizeForCategory(cat)); setDetectedReparto(''); }}
                      className={`p-3 rounded-xl text-sm font-bold border transition-all ${
                        category === cat
                          ? 'bg-[#8b5cf6]/10 border-[#8b5cf6] text-[var(--text)]'
                          : 'bg-[var(--surface-2)] border-[var(--border-2)] text-[var(--text-soft)] hover:border-gray-600'
                      }`}>
                      <span className="block text-xl mb-1">{getCategoryIcon(cat)}</span>
                      {cat}
                    </button>
                  ))}
                </div>
                {/* Esito modalità automatica */}
                {category === AUTO_CATEGORY && (
                  detectedReparto ? (
                    <div className="mt-2 flex items-center justify-between gap-2 flex-wrap">
                      <p className="text-[11px] text-[var(--text-muted)] flex items-center gap-1.5">
                        <Sparkles size={11} className="text-violet-400" />
                        Rilevato: <b className="text-[var(--text)]">{detectedReparto}</b> — reparto non presente.
                      </p>
                      <button type="button" disabled={isAddingCat}
                        onClick={() => createRepartoFromDetected(detectedReparto)}
                        className="text-[11px] font-bold px-2.5 py-1.5 rounded-lg bg-violet-500/15 border border-violet-500/40 text-violet-300 hover:bg-violet-500/25 transition-colors disabled:opacity-40 flex items-center gap-1">
                        {isAddingCat ? <Loader2 size={11} className="animate-spin" /> : <Plus size={11} />}
                        Crea reparto "{detectedReparto}"
                      </button>
                    </div>
                  ) : (
                    <p className="text-[11px] text-[var(--text-muted)] mt-2 flex items-center gap-1.5">
                      <Sparkles size={11} className="text-violet-400" />
                      Aggiungi una foto: l'IA capisce da sola di che prodotto si tratta.
                    </p>
                  )
                )}
              </div>
                );
              })()}

              {/* FOTO + IA SCAN — multi-foto (max 5) */}
              <div className="bg-gradient-to-br from-violet-500/10 to-[#8b5cf6]/10 border border-violet-500/30 rounded-2xl p-4">
                <div className="flex items-center justify-between mb-2">
                  <label className="flex items-center gap-2">
                    <Sparkles className="text-violet-400" size={16} />
                    <span className="text-xs font-bold text-[var(--text)]">Foto + Analisi IA</span>
                  </label>
                  <span className="text-[10px] text-[var(--text-soft)]">{productPhotos.length}/5 foto</span>
                </div>
                <p className="text-[10px] text-[var(--text-muted)] mb-3">
                  {category === AUTO_CATEGORY
                    ? "Scatta o carica una foto: l'IA capisce categoria, brand e modello e prepara i campi giusti."
                    : "Aggiungi 1–5 foto. La prima scatena l'IA che riconosce brand e modello. Puoi ri-scansionare qualsiasi foto."}
                </p>

                {/* Griglia foto */}
                <div className="grid grid-cols-5 gap-2 mb-3">
                  {productPhotos.map((photo, i) => (
                    <div key={i} className="relative aspect-square rounded-xl overflow-hidden bg-[var(--surface-2)] border border-violet-500/30">
                      <img src={photo} alt={`foto ${i + 1}`} className="w-full h-full object-cover" />
                      <button type="button" onClick={() => removePhoto(i)}
                        className="absolute top-1 right-1 w-5 h-5 bg-black/70 rounded-full flex items-center justify-center hover:bg-red-600 transition-colors">
                        <X size={10} />
                      </button>
                      <button type="button" onClick={() => runAIScan(photo, category)}
                        disabled={isScanning}
                        className="absolute bottom-0 left-0 right-0 bg-violet-600/80 hover:bg-violet-500/90 py-0.5 text-[9px] font-bold text-center transition-colors disabled:opacity-40">
                        Scansiona
                      </button>
                    </div>
                  ))}
                  {productPhotos.length < 5 && (
                    // Tile principale: apre DIRETTAMENTE la fotocamera (capture) su mobile
                    <label className={`aspect-square rounded-xl border-2 border-dashed border-violet-500/30 hover:border-violet-500 flex flex-col items-center justify-center cursor-pointer transition-colors ${isScanning ? 'pointer-events-none opacity-40' : ''}`}>
                      <input type="file" accept="image/*" capture="environment" className="hidden"
                        onChange={(e: any) => handlePhotoAdd(e, false)} disabled={isScanning} />
                      {isScanning ? (
                        <Loader2 className="animate-spin text-violet-400" size={18} />
                      ) : (
                        <>
                          <Camera size={18} className="text-violet-400 mb-1" />
                          <span className="text-[9px] text-[var(--text-soft)]">Scatta</span>
                        </>
                      )}
                    </label>
                  )}
                </div>

                {/* Alternativa: scegli dalla libreria (senza capture → galleria/file) */}
                {productPhotos.length < 5 && !isScanning && (
                  <label className="flex items-center justify-center gap-2 w-full mb-3 py-2 rounded-xl border border-violet-500/30 hover:border-violet-500 text-[11px] font-bold text-[var(--text-soft)] hover:text-[var(--text)] cursor-pointer transition-colors">
                    <input type="file" accept="image/*" multiple className="hidden"
                      onChange={(e: any) => handlePhotoAdd(e, false)} disabled={isScanning} />
                    <ImageIcon size={13} className="text-violet-400" />
                    Scegli dalla libreria
                  </label>
                )}

                {isScanning && (
                  <p className="text-xs text-violet-400 flex items-center gap-2 mb-2">
                    <Loader2 className="animate-spin" size={12} /> Analisi IA in corso...
                  </p>
                )}

                {scanResult && (
                  <div className="space-y-2 text-xs">
                    <div className={`p-2 rounded-lg ${
                      scanResult.confidence === 'HIGH' ? 'bg-green-500/10 text-green-400' :
                      scanResult.confidence === 'MEDIUM' ? 'bg-yellow-500/10 text-yellow-400' :
                      'bg-red-500/10 text-red-400'
                    }`}>
                      <span className="font-bold">Riconoscimento: {scanResult.confidence}</span>
                      {scanResult.autoDetected && scanResult.detectedCategory && (
                        <p className="opacity-90">Categoria rilevata: <b>{scanResult.detectedCategory}</b></p>
                      )}
                      {scanResult.brand && <p>{scanResult.brand} {scanResult.model}</p>}
                      {scanResult.warnings?.map((w: any, i: number) => <p key={i}>⚠️ {w}</p>)}
                    </div>
                    {/* Verifica eBay del riconoscimento (valore di mercato reale) */}
                    {scanMarket && scanMarket.configured !== false && (
                      scanMarket.value != null ? (
                        <div className="p-2 rounded-lg bg-blue-500/10 text-blue-300 flex items-center gap-1.5">
                          <CheckCircle size={13} className="shrink-0" />
                          <span><b>Verificato su eBay</b> · valore ~{Math.round(scanMarket.value)}€ <span className="opacity-70">({scanMarket.sample} annunci · {scanMarket.source})</span></span>
                        </div>
                      ) : (
                        <div className="p-2 rounded-lg bg-[var(--surface-2)] text-[var(--text-soft)] flex items-center gap-1.5">
                          <Search size={13} className="shrink-0" />
                          <span>Nessun riscontro su eBay per questo modello — ricontrolla brand/modello.</span>
                        </div>
                      )
                    )}
                    {/* Tabella dinamica: attributi estratti dall'IA */}
                    {(() => {
                      const d = scanResult.details || {};
                      const LABELS: Record<string, string> = {
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
                              <span className="text-[var(--text-muted)] font-medium text-right truncate">{v === true ? 'Sì' : String(v)}</span>
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
                    <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">Nome Carta</label>
                    <input type="text" required value={pokeName}
                      onChange={(e: any) => setPokeName(e.target.value)}
                      placeholder="Es. Charizard 4/102"
                      className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm focus:border-[#8b5cf6] outline-none" />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">Gradata?</label>
                      <select value={pokeGraded} onChange={(e: any) => setPokeGraded(e.target.value)}
                        className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm focus:border-[#8b5cf6] outline-none">
                        <option value="No">No (Raw)</option>
                        <option value="Si">Sì</option>
                      </select>
                    </div>
                    {pokeGraded === 'Si' && (
                      <div>
                        <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">Grade</label>
                        <input type="text" value={pokeGrade}
                          onChange={(e: any) => setPokeGrade(e.target.value)}
                          placeholder="10, 9.5..."
                          className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm focus:border-[#8b5cf6] outline-none" />
                      </div>
                    )}
                  </div>
                </>
              ) : category === 'Orologi' ? (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">Brand</label>
                      <input type="text" required value={watchBrand}
                        onChange={(e: any) => setWatchBrand(e.target.value)}
                        placeholder="Rolex" 
                        className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm focus:border-[#8b5cf6] outline-none" />
                    </div>
                    <div>
                      <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">Modello</label>
                      <input type="text" required value={watchModel}
                        onChange={(e: any) => setWatchModel(e.target.value)}
                        placeholder="Submariner"
                        className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm focus:border-[#8b5cf6] outline-none" />
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">Cassa</label>
                      <input type="text" value={watchCase}
                        onChange={(e: any) => setWatchCase(e.target.value)}
                        placeholder="41mm"
                        className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm focus:border-[#8b5cf6] outline-none" />
                    </div>
                    <div>
                      <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">Cinturino</label>
                      <input type="text" value={watchStrap}
                        onChange={(e: any) => setWatchStrap(e.target.value)}
                        placeholder="Oyster"
                        className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm focus:border-[#8b5cf6] outline-none" />
                    </div>
                    <div>
                      <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">Materiale</label>
                      <input type="text" value={watchMaterial}
                        onChange={(e: any) => setWatchMaterial(e.target.value)}
                        placeholder="Acciaio"
                        className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm focus:border-[#8b5cf6] outline-none" />
                    </div>
                  </div>
                  <div>
                    <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">Condizione</label>
                    <select value={condition} onChange={(e: any) => setCondition(e.target.value)}
                      className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm focus:border-[#8b5cf6] outline-none">
                      <option value="">— Non specificata (aggiungi dopo)</option>
                      <option value="Full Set">Full Set</option>
                      <option value="Solo Box">Solo Box</option>
                      <option value="Solo Carta">Solo Carta</option>
                      <option value="Naked">Naked</option>
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
                                {f.label}{!f.required && <span className="text-gray-700 normal-case font-normal ml-1">(opz.)</span>}
                              </label>
                              {f.type === 'select' ? (
                                <select value={val} onChange={(e: any) => setVal(e.target.value)}
                                  required={f.required}
                                  className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm focus:border-[#8b5cf6] outline-none">
                                  <option value="">Seleziona...</option>
                                  {(f.options || []).map((opt: string) => <option key={opt} value={opt}>{opt}</option>)}
                                </select>
                              ) : (
                                <input type={f.type === 'number' ? 'number' : 'text'}
                                  value={val} onChange={(e: any) => setVal(e.target.value)}
                                  required={f.required}
                                  placeholder={f.placeholder || ''}
                                  className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm focus:border-[#8b5cf6] outline-none" />
                              )}
                            </div>
                          );
                        })}
                        {/* Condizione dal config AI */}
                        <div>
                          <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">Condizione</label>
                          <select value={condition} onChange={(e: any) => setCondition(e.target.value)}
                            className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm focus:border-[#8b5cf6] outline-none">
                            <option value="">— Non specificata (aggiungi dopo)</option>
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
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">Brand</label>
                      <input type="text" required value={brand}
                        onChange={(e: any) => setBrand(e.target.value)}
                        placeholder={category === 'Scarpe' ? 'Nike' : category === 'Vestiti' ? 'Supreme' : 'Louis Vuitton'}
                        className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm focus:border-[#8b5cf6] outline-none" />
                    </div>
                    <div>
                      <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">Modello</label>
                      <input type="text" required value={name}
                        onChange={(e: any) => setName(e.target.value)}
                        placeholder={category === 'Scarpe' ? 'Air Jordan 1 Chicago' : category === 'Vestiti' ? 'Box Logo Hoodie' : 'Neverfull MM'}
                        className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm focus:border-[#8b5cf6] outline-none" />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      {/* Taglia — sempre input libero con suggerimenti datalist */}
                      <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">
                        {category === 'Scarpe' ? 'Taglia (EU)' : category === 'Vestiti' ? 'Taglia' : 'Dimensione / Taglia'}
                      </label>
                      <input
                        list={`size-suggestions-${category}`}
                        value={size}
                        onChange={(e: any) => setSize(e.target.value)}
                        placeholder={category === 'Scarpe' ? 'es. 42, 42.5, US 9' : category === 'Vestiti' ? 'es. M, L, XL' : 'es. MM, 30cm, Small'}
                        className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm focus:border-[#8b5cf6] outline-none"
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
                      <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">Condizione</label>
                      <select value={condition} onChange={(e: any) => setCondition(e.target.value)}
                        className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm focus:border-[#8b5cf6] outline-none">
                        <option value="">— Non specificata (aggiungi dopo)</option>
                        <option value="DS">DS (Nuovo)</option>
                        <option value="VNDS">VNDS (Quasi nuovo)</option>
                        <option value="Used">Used (Usato)</option>
                        <option value="Worn">Worn (Molto usato)</option>
                      </select>
                    </div>
                  </div>
                  {/* Campi dinamici dalla CategoryTemplate (JSONB) */}
                  {activeTemplate && activeTemplate.fields?.length > 0 && (
                    <div className="border-t border-[var(--border-2)] pt-4">
                      <p className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest mb-3">Dettagli Categoria</p>
                      <DynamicForm
                        fields={activeTemplate.fields}
                        values={dynamicAttrs}
                        onChange={(key, value) => setDynamicAttrs(prev => ({ ...prev, [key]: value }))}
                        disabled={isSaving}
                      />
                    </div>
                  )}
                </>
              );})()}

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">Prezzo Acquisto €</label>
                  <input type="number" step="0.01" required value={price}
                    onChange={(e: any) => setPrice(e.target.value)}
                    className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm focus:border-[#8b5cf6] outline-none" />
                </div>
                <div>
                  <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">Quantità</label>
                  <input type="number" min="1" required value={quantity}
                    onChange={(e: any) => setQuantity(e.target.value)}
                    className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm focus:border-[#8b5cf6] outline-none" />
                </div>
              </div>
              
              {/* Quote del team */}
              {(() => {
                const currentTeam = teamData.find((t: any) => t.warehouseName.replace('Magazzino ', '') === category);
                if (!currentTeam || currentTeam.members.length <= 1) return null;
                return (
                  <div className="border-t border-[var(--border-2)] pt-4">
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-2">
                        <Users size={14} className="text-blue-400" />
                        <span className="text-sm font-bold">Quote del Team</span>
                      </div>
                      {!isSharedPurchase ? (
                        <button type="button"
                          onClick={() => setIsSharedPurchase(true)}
                          className="text-xs text-[var(--text)] hover:text-[#a78bfa] font-bold transition-colors">
                          Cambia percentuali
                        </button>
                      ) : (
                        <button type="button"
                          onClick={() => { setIsSharedPurchase(false); setProductShares([]); }}
                          className="text-xs text-[var(--text-soft)] hover:text-[var(--text)] font-bold transition-colors">
                          Ripristina default
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
                        <p className="text-[10px] text-[var(--text-faint)] mt-1">Quote default del team — modifica in Impostazioni</p>
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
                          Totale: {productShares.reduce((s, x) => s + (Number(x.percentage) || 0), 0).toFixed(0)}% (deve essere 100%)
                        </p>
                      </div>
                    )}
                  </div>
                );
              })()}
              
              <button type="submit" disabled={isSaving}
                className="w-full bg-[#8b5cf6] hover:bg-[#a78bfa] py-3 rounded-xl font-bold transition-colors disabled:opacity-50 flex items-center justify-center">
                {isSaving ? <Loader2 className="animate-spin" size={20} /> : 'Salva Prodotto'}
              </button>
              </>)}
            </form>
          </div>
        </div>
      )}
      
      {/* ========== MODALE: VENDI ========== */}
      {sellModalOpen && productToSell && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
          <div className="bg-[var(--surface)] border-t sm:border border-[var(--border-2)] rounded-t-3xl sm:rounded-3xl w-full max-w-md max-h-[92vh] overflow-y-auto">
            <div className="flex justify-center pt-3 pb-1 sm:hidden"><div className="w-10 h-1 bg-gray-700 rounded-full" /></div>
            <div className="sticky top-0 bg-[var(--surface)] border-b border-[var(--border)] p-5 flex items-center justify-between">
              <h2 className="text-xl font-semibold">Registra Vendita</h2>
              <button onClick={() => setSellModalOpen(false)}
                className="p-2 hover:bg-[var(--fill)] rounded-lg transition-colors">
                <X size={20} />
              </button>
            </div>
            
            <form onSubmit={confirmSell} className="p-5 space-y-4">
              <p className="text-sm text-[var(--text-muted)]">{productToSell.name}</p>
              
              
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">Quantità</label>
                  <input type="number" min="1" max={productToSell.maxQty}
                    value={sellQuantity} onChange={(e: any) => setSellQuantity(e.target.value)}
                    className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm focus:border-[#8b5cf6] outline-none" />
                  <p className="text-[10px] text-[var(--text-soft)] mt-1">Max disponibile: {productToSell.maxQty}</p>
                </div>
                <div>
                  <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">Prezzo Totale €</label>
                  <input type="number" step="0.01" required value={sellPrice}
                    onChange={(e: any) => setSellPrice(e.target.value)}
                    className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm focus:border-[#8b5cf6] outline-none" />
                </div>
              </div>
              
              <div>
                <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">Piattaforma</label>
                <select value={sellPlatform} onChange={(e: any) => setSellPlatform(e.target.value)}
                  className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm focus:border-[#8b5cf6] outline-none">
                  <option value="Vinted">Vinted</option>
                  <option value="Subito">Subito</option>
                  <option value="StockX">StockX (12% fee)</option>
                  <option value="eBay">eBay</option>
                  <option value="Privato">Privato</option>
                </select>
              </div>
              
              <div>
                <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">Metodo Pagamento</label>
                <select value={sellPaymentMethod} onChange={(e: any) => setSellPaymentMethod(e.target.value)}
                  className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm focus:border-[#8b5cf6] outline-none">
                  <option>Nessuna Fee (Contanti/Bonifico)</option>
                  <option>PayPal Beni e Servizi</option>
                </select>
              </div>
              
              <div className="bg-[var(--surface-2)] p-3 rounded-xl space-y-1.5">
                <div className="flex justify-between text-xs">
                  <span className="text-[var(--text-soft)]">Fees calcolate</span>
                  <span className="font-bold text-red-400">-{sellFees}€</span>
                </div>
                {productToSell?.purchasePrice && sellPrice && (() => {
                  const qty = parseInt(sellQuantity) || 1;
                  const totalCost = productToSell.purchasePrice! * qty;
                  const saleTotal = parseFloat(sellPrice) || 0;
                  const feesNum = parseFloat(sellFees) || 0;
                  const profit = saleTotal - totalCost - feesNum;
                  const margin = totalCost > 0 ? (profit / totalCost * 100) : 0;
                  return (
                    <>
                      <div className="flex justify-between text-xs border-t border-[var(--border-2)] pt-1.5">
                        <span className="text-[var(--text-soft)]">Profitto atteso</span>
                        <span className={`font-bold ${profit >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                          {profit >= 0 ? '+' : ''}{profit.toFixed(2)}€
                        </span>
                      </div>
                      <div className="flex justify-between text-xs">
                        <span className="text-[var(--text-soft)]">Margine</span>
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
                  <Truck size={12} /> Tracking spedizione <span className="text-[var(--text-faint)] normal-case font-normal">(opzionale)</span>
                </label>
                <div className="grid grid-cols-2 gap-3">
                  <input type="text" value={sellTrackingCode} onChange={(e: any) => setSellTrackingCode(e.target.value)}
                    placeholder="Codice tracking"
                    className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm focus:border-[#8b5cf6] outline-none" />
                  <select value={sellTrackingCarrier} onChange={(e: any) => setSellTrackingCarrier(e.target.value)}
                    className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm focus:border-[#8b5cf6] outline-none">
                    {['Auto','BRT','GLS','Poste Italiane','SDA','DHL','UPS','FedEx','TNT','Amazon Logistics','Nexive'].map(c => (
                      <option key={c} value={c}>{c === 'Auto' ? 'Auto-rileva' : c}</option>
                    ))}
                  </select>
                </div>
                <p className="text-[10px] text-[var(--text-faint)] mt-1.5">Lascia vuoto se spedisci dopo: potrai aggiungerlo dalla card del venduto.</p>
              </div>

              <button type="submit"
                className="w-full bg-green-600 hover:bg-green-500 py-3 rounded-xl font-bold transition-colors">
                Conferma Vendita
              </button>
            </form>
          </div>
        </div>
      )}
      
      {/* ========== MODALE: MODIFICA PRODOTTO ========== */}
      {editModalOpen && productToEdit && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
          <div className="bg-[var(--surface)] border-t sm:border border-[var(--border-2)] rounded-t-3xl sm:rounded-3xl w-full max-w-md max-h-[92vh] overflow-y-auto">
            <div className="flex justify-center pt-3 pb-1 sm:hidden"><div className="w-10 h-1 bg-gray-700 rounded-full" /></div>
            <div className="sticky top-0 bg-[var(--surface)] border-b border-[var(--border)] p-5 flex items-center justify-between">
              <h2 className="text-xl font-semibold">Modifica Prodotto</h2>
              <button onClick={() => setEditModalOpen(false)}
                className="p-2 hover:bg-[var(--fill)] rounded-lg transition-colors">
                <X size={20} />
              </button>
            </div>
            
            <form onSubmit={handleSaveEdit} className="p-5 space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">Brand</label>
                  <input type="text" required value={editBrand}
                    onChange={(e: any) => setEditBrand(e.target.value)}
                    className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm focus:border-[#8b5cf6] outline-none" />
                </div>
                <div>
                  <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">Nome</label>
                  <input type="text" required value={editName}
                    onChange={(e: any) => setEditName(e.target.value)}
                    className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm focus:border-[#8b5cf6] outline-none" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">Taglia</label>
                  <input type="text" value={editSize}
                    onChange={(e: any) => setEditSize(e.target.value)}
                    className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm focus:border-[#8b5cf6] outline-none" />
                </div>
                <div>
                  <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">Condizione</label>
                  <input type="text" value={editCondition}
                    onChange={(e: any) => setEditCondition(e.target.value)}
                    className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm focus:border-[#8b5cf6] outline-none" />
                </div>
              </div>

              {/* Valutazione di mercato (fonte reale, anti-falsi) */}
              <div className="bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <TrendingUp size={15} className="text-[#8b5cf6] shrink-0" />
                    <span className="text-sm font-bold">Valutazione di mercato</span>
                  </div>
                  <button type="button" onClick={() => fetchValuation(productToEdit)} disabled={valLoading}
                    className="shrink-0 text-xs font-bold px-3 py-1.5 rounded-lg bg-[#8b5cf6] text-white hover:bg-[#7c3aed] disabled:opacity-50 transition-colors flex items-center gap-1.5">
                    {valLoading ? <Loader2 size={13} className="animate-spin" /> : <Search size={13} />} Valuta
                  </button>
                </div>
                {valuation && (
                  <div className="mt-3">
                    {valuation.configured === false ? (
                      <p className="text-[var(--text-soft)] text-xs">Fonte prezzi non ancora attiva. Quando colleghiamo eBay/StockX qui vedrai la valutazione reale — autenticata e anti-falsi.</p>
                    ) : valuation.value == null ? (
                      <p className="text-[var(--text-soft)] text-xs">Nessuna quotazione affidabile trovata per questo prodotto.</p>
                    ) : (
                      <div className="flex items-end justify-between gap-2">
                        <div>
                          <p className="text-2xl font-bold num">{valuation.value}€</p>
                          <p className="text-[11px] text-[var(--text-faint)] mt-0.5">{valuation.source} · {valuation.sample} comp{valuation.authenticatedOnly ? ' autenticate' : ''}</p>
                        </div>
                        <span className={`text-[10px] font-bold px-2 py-1 rounded-full ${valuation.confidence === 'alta' ? 'bg-emerald-500/20 text-emerald-400' : valuation.confidence === 'media' ? 'bg-yellow-500/20 text-yellow-400' : 'bg-[var(--fill)] text-[var(--text-soft)]'}`}>confidenza {valuation.confidence}</span>
                      </div>
                    )}
                  </div>
                )}
              </div>
              <div>
                <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">Prezzo Acquisto €</label>
                <input type="number" step="0.01" required value={editPrice}
                  onChange={(e: any) => setEditPrice(e.target.value)}
                  className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm focus:border-[#8b5cf6] outline-none" />
              </div>

              {/* Foto prodotto nel modale modifica */}
              <div className="border-t border-[var(--border-2)] pt-4">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <Camera size={14} className="text-violet-400" />
                    <span className="text-sm font-bold">Foto</span>
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
                    <label className="aspect-square rounded-xl border-2 border-dashed border-gray-700 hover:border-violet-500 flex flex-col items-center justify-center cursor-pointer transition-colors">
                      <input type="file" accept="image/*" multiple className="hidden"
                        onChange={(e: any) => handlePhotoAdd(e, true)} />
                      <Camera size={16} className="text-[var(--text-soft)] mb-0.5" />
                      <span className="text-[9px] text-[var(--text-soft)]">Aggiungi</span>
                    </label>
                  )}
                </div>
              </div>

              {/* Quote del team nel modale di modifica */}
              {(() => {
                const currentTeam = teamData.find((t: any) => t.warehouseName.replace('Magazzino ', '') === productToEdit?.category);
                if (!currentTeam || currentTeam.members.length <= 1) return null;
                return (
                  <div className="border-t border-[var(--border-2)] pt-4">
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-2">
                        <Users size={14} className="text-blue-400" />
                        <span className="text-sm font-bold">Quote del Team</span>
                      </div>
                      {!isEditShared ? (
                        <button type="button"
                          onClick={() => {
                            setIsEditShared(true);
                            setEditShares(currentTeam.members.map((m: any) => ({
                              userId: m.userId, name: m.name, percentage: m.percentage,
                            })));
                          }}
                          className="text-xs text-[var(--text)] hover:text-[#a78bfa] font-bold transition-colors">
                          Cambia percentuali
                        </button>
                      ) : (
                        <button type="button"
                          onClick={() => { setIsEditShared(false); setEditShares([]); }}
                          className="text-xs text-[var(--text-soft)] hover:text-[var(--text)] font-bold transition-colors">
                          Ripristina default
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
                        <p className="text-[10px] text-[var(--text-faint)] mt-1">Quote default del team — modifica in Impostazioni</p>
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
                          Totale: {editShares.reduce((s, x) => s + (Number(x.percentage) || 0), 0).toFixed(0)}% (deve essere 100%)
                        </p>
                      </div>
                    )}
                  </div>
                );
              })()}

              <div className="flex gap-3">
                <button type="submit" disabled={isSaving}
                  className="flex-1 bg-[#8b5cf6] hover:bg-[#a78bfa] py-3 rounded-xl font-bold transition-colors disabled:opacity-50 flex items-center justify-center">
                  {isSaving ? <Loader2 className="animate-spin" size={20} /> : 'Salva Modifiche'}
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
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-[var(--surface)] border border-[var(--border)] rounded-3xl w-full max-w-md max-h-[90vh] overflow-y-auto">
            <div className="border-b border-[var(--border-2)] p-5 flex items-center justify-between">
              <h2 className="text-xl font-semibold flex items-center gap-2">
                <Shield className="text-[var(--text)]" size={20} /> Attiva 2FA
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
                    <p>1. Scarica un'app come <span className="text-[var(--text)] font-bold">Google Authenticator</span> o <span className="text-[var(--text)] font-bold">Authy</span></p>
                    <p>2. Scansiona il QR qui sotto</p>
                    <p>3. Inserisci il codice generato dall'app</p>
                  </div>
                  
                  {twoFaQR && (
                    <div className="bg-white p-4 rounded-2xl flex items-center justify-center">
                      <img src={twoFaQR} alt="QR 2FA" className="w-48 h-48" />
                    </div>
                  )}
                  
                  <div>
                    <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">Codice dall'app</label>
                    <input type="text" inputMode="numeric" value={twoFaCode}
                      onChange={(e: any) => setTwoFaCode(e.target.value)}
                      placeholder="000000" maxLength={6}
                      className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-center font-mono text-2xl tracking-widest focus:border-[#8b5cf6] outline-none" />
                  </div>
                  
                  <button onClick={handle2FAVerify} disabled={twoFaLoading || twoFaCode.length !== 6}
                    className="w-full bg-[#8b5cf6] hover:bg-[#a78bfa] py-3 rounded-xl font-bold transition-colors disabled:opacity-50 flex items-center justify-center">
                    {twoFaLoading ? <Loader2 className="animate-spin" size={20} /> : 'Attiva 2FA'}
                  </button>
                </>
              ) : (
                <>
                  <div className="bg-green-500/10 border border-green-500/30 rounded-xl p-4">
                    <p className="font-bold text-green-400 mb-1 flex items-center gap-2">
                      <CheckCircle size={16} /> 2FA attivato!
                    </p>
                    <p className="text-xs text-gray-300">Salva questi codici di backup in un posto sicuro. Ti permetteranno di accedere se perdi l'authenticator.</p>
                  </div>
                  
                  <div className="bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-4">
                    <p className="text-xs font-bold text-[var(--text-soft)] mb-3 uppercase tracking-widest">Codici di Backup</p>
                    <div className="grid grid-cols-2 gap-2 font-mono text-sm">
                      {twoFaBackupCodes.map((c: string, i: number) => (
                        <div key={i} className="bg-[var(--surface)] p-2 rounded text-center">{c}</div>
                      ))}
                    </div>
                    <button onClick={() => {
                      navigator.clipboard.writeText(twoFaBackupCodes.join('\n'));
                      showToast('Codici copiati!');
                    }}
                      className="mt-3 w-full bg-[var(--fill)] hover:bg-[var(--fill)] py-2 rounded-lg text-xs font-bold transition-colors flex items-center justify-center gap-2">
                      <Copy size={12} /> Copia tutti i codici
                    </button>
                  </div>
                  
                  <p className="text-xs text-yellow-400 bg-yellow-500/10 p-3 rounded-xl">
                    ⚠️ Ogni codice è usabile UNA SOLA VOLTA. Stampali o salvali in un password manager.
                  </p>
                  
                  <button onClick={() => { setTwoFaSetupOpen(false); setTwoFaBackupCodes(null); setTwoFaCode(''); }}
                    className="w-full bg-[#8b5cf6] hover:bg-[#a78bfa] py-3 rounded-xl font-bold transition-colors">
                    Ho salvato i codici
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ========== MODALE: DISABILITA 2FA ========== */}
      {twoFaDisableOpen && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
          <div className="bg-[var(--surface)] border-t sm:border border-[var(--border-2)] rounded-t-3xl sm:rounded-3xl w-full max-w-md p-6">
            <div className="flex justify-center mb-4 sm:hidden"><div className="w-10 h-1 bg-gray-700 rounded-full" /></div>
            <div className="flex items-center gap-2 mb-5">
              <Shield className="text-red-400" size={20} />
              <h3 className="text-lg font-semibold">Disabilita 2FA</h3>
            </div>
            <div className="space-y-4">
              <div>
                <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">Password account</label>
                <input type="password" value={twoFaDisablePwd}
                  onChange={e => setTwoFaDisablePwd(e.target.value)}
                  placeholder="••••••••"
                  className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-[var(--text)] outline-none focus:border-red-500" />
              </div>
              <div>
                <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">Codice dall'app 2FA</label>
                <input type="text" inputMode="numeric" value={twoFaDisableOtp}
                  onChange={e => setTwoFaDisableOtp(e.target.value)}
                  maxLength={6} placeholder="000000"
                  className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-[var(--text)] font-mono text-center text-2xl tracking-widest outline-none focus:border-red-500" />
              </div>
              <button onClick={confirm2FADisable}
                disabled={!twoFaDisablePwd || twoFaDisableOtp.length < 6}
                className="w-full bg-red-600 hover:bg-red-500 disabled:opacity-40 py-3 rounded-xl font-bold text-sm transition-colors">
                Conferma disabilitazione
              </button>
              <button onClick={() => setTwoFaDisableOpen(false)}
                className="w-full bg-[var(--fill)] hover:bg-[var(--fill)] py-3 rounded-xl font-bold text-sm transition-colors">
                Annulla
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ========== BARRA BULK ACTIONS ========== */}
      {bulkMode && (
        <div className="fixed left-0 right-0 z-40 px-4 transition-all"
          style={{ bottom: 'calc(5rem + env(safe-area-inset-bottom) + 8px)' }}>
          <div className={`bg-[#1a1a1a] border rounded-2xl p-3 flex items-center gap-2 shadow-2xl transition-all ${
            selectedGroupKeys.size > 0 ? 'border-[#8b5cf6]/50' : 'border-gray-700'
          }`}>
            <button onClick={() => { setBulkMode(false); setSelectedGroupKeys(new Set()); }}
              className="shrink-0 w-8 h-8 flex items-center justify-center rounded-lg hover:bg-white/10 text-gray-300 hover:text-white transition-colors">
              <X size={16} />
            </button>
            <button onClick={selectAllGroups}
              className="text-xs text-gray-300 hover:text-white font-bold transition-colors shrink-0 px-2">
              Tutti
            </button>
            <div className="flex-1 text-center">
              <span className="text-sm font-bold text-white">
                {selectedGroupKeys.size > 0
                  ? `${getBulkSelectedIds().length} pezzi selezionati`
                  : 'Tieni premuto una card per selezionare'}
              </span>
            </div>
            <button
              onClick={() => setBulkDeleteConfirmOpen(true)}
              disabled={selectedGroupKeys.size === 0}
              className="px-3 py-2 bg-red-600/20 hover:bg-red-600/30 text-red-400 rounded-xl text-xs font-bold disabled:opacity-30 transition-colors">
              <Trash2 size={14} />
            </button>
            <button
              onClick={() => setBulkSellOpen(true)}
              disabled={selectedGroupKeys.size === 0}
              className="px-4 py-2 bg-green-600 hover:bg-green-500 text-white rounded-xl text-xs font-bold disabled:opacity-30 transition-colors flex items-center gap-1.5">
              <DollarSign size={14} /> Vendi
            </button>
          </div>
        </div>
      )}

      {/* ========== MODALE: BULK VENDI ========== */}
      {bulkSellOpen && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
          <div className="bg-[var(--surface)] border-t sm:border border-[var(--border-2)] rounded-t-3xl sm:rounded-3xl w-full max-w-md p-6">
            <div className="flex justify-center mb-4 sm:hidden"><div className="w-10 h-1 bg-gray-700 rounded-full" /></div>
            <h2 className="text-xl font-semibold mb-1">Vendi in Blocco</h2>
            <p className="text-xs text-[var(--text-soft)] mb-5">
              {getBulkSelectedIds().length} prodotti — stessa piattaforma e stesso prezzo unitario per tutti
            </p>
            <form onSubmit={handleBulkSell} className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">Prezzo unitario €</label>
                  <input type="number" step="0.01" required value={bulkSellPrice}
                    onChange={e => setBulkSellPrice(e.target.value)}
                    className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm focus:border-[#8b5cf6] outline-none" />
                </div>
                <div>
                  <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">Fees unitarie €</label>
                  <input type="number" step="0.01" value={bulkSellFees}
                    onChange={e => setBulkSellFees(e.target.value)}
                    className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm focus:border-[#8b5cf6] outline-none" />
                </div>
              </div>
              <div>
                <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">Piattaforma</label>
                <select value={bulkSellPlatform} onChange={e => setBulkSellPlatform(e.target.value)}
                  className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm focus:border-[#8b5cf6] outline-none">
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
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
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
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
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
              <div className="bg-blue-500/10 border border-blue-500/30 rounded-xl p-3 text-xs text-blue-400">
                <p className="font-bold mb-1">Colonne riconosciute (intestazione prima riga):</p>
                <p className="font-mono">Brand • Nome • Taglia • Condizione • Prezzo • Categoria</p>
                <button onClick={downloadImportTemplate}
                  className="mt-2 text-[10px] underline hover:text-blue-300 transition-colors">
                  Scarica template .xlsx con esempi →
                </button>
              </div>

              <div className="flex items-center gap-3">
                <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest flex-1">
                  Reparto di default <span className="text-[var(--text-faint)]">(per righe senza colonna Categoria)</span>
                </label>
                <select value={importCategory} onChange={e => setImportCategory(e.target.value)}
                  className="bg-[var(--surface-2)] border border-[var(--border-2)] rounded-lg px-3 py-2 text-sm focus:border-[#8b5cf6] outline-none">
                  {userCategories.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>

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
                  className="flex-1 bg-[#8b5cf6] hover:bg-[#a78bfa] disabled:opacity-50 py-3 rounded-xl font-bold text-sm transition-colors flex items-center justify-center gap-2">
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
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
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

              {/* Nome lotto */}
              <div>
                <label className="text-[10px] font-semibold text-[var(--text-soft)] uppercase tracking-[0.1em] block mb-2">Nome Lotto</label>
                <input required value={lotName} onChange={e => setLotName(e.target.value)}
                  placeholder="Es: Bundle Pokemon Giugno, Lotto Scarpe Verano..."
                  className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm text-[var(--text)] placeholder-gray-600 focus:border-[var(--border-3)] outline-none" />
              </div>

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
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-end sm:items-center justify-center z-[80] p-0 sm:p-4">
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
                    <h3 className="font-semibold">Eliminare l'account?</h3>
                    <p className="text-[11px] text-[var(--text-soft)]">Questa azione è permanente e irreversibile</p>
                  </div>
                </div>
                <div className="bg-red-500/[0.06] border border-red-500/[0.15] rounded-xl p-4 mb-5 space-y-1.5">
                  {['Tutti i tuoi prodotti e dati di vendita', 'Le foto dei prodotti', 'La tua cronologia e audit log', 'L\'accesso a tutti i magazzini', 'Il tuo account e le credenziali'].map(item => (
                    <div key={item} className="flex items-start gap-2 text-[12px] text-red-300/70">
                      <span className="text-red-500 mt-0.5 shrink-0">×</span> {item}
                    </div>
                  ))}
                </div>
                <p className="text-[11px] text-[var(--text-faint)] mb-5">I tuoi soci non verranno eliminati. I prodotti condivisi resteranno visibili al team.</p>
                <div className="flex gap-2">
                  <button onClick={() => setDeleteAccountStep(0)}
                    className="flex-1 py-3 rounded-xl border border-[var(--border-2)] text-sm text-[var(--text-muted)] hover:text-[var(--text)] transition-colors">
                    Annulla
                  </button>
                  <button onClick={() => setDeleteAccountStep(2)}
                    className="flex-1 py-3 rounded-xl bg-red-500/15 border border-red-500/30 text-red-400 text-sm font-semibold hover:bg-red-500/25 transition-colors">
                    Continua
                  </button>
                </div>
              </div>
            )}

            {/* STEP 2: Conferma email */}
            {deleteAccountStep === 2 && (
              <div className="p-6">
                <h3 className="font-semibold mb-1">Conferma la tua email</h3>
                <p className="text-[12px] text-[var(--text-soft)] mb-4">Scrivi la tua email per confermare l'eliminazione</p>
                <p className="text-xs text-[var(--text-faint)] bg-[var(--fill)] border border-[var(--border)] rounded-xl p-3 mb-4 font-mono">{user?.email}</p>
                <input
                  value={deleteEmailConfirm}
                  onChange={e => setDeleteEmailConfirm(e.target.value)}
                  placeholder="Scrivi qui la tua email"
                  className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm focus:border-red-500/40 outline-none mb-4"
                  autoFocus
                />
                <div className="flex gap-2">
                  <button onClick={() => setDeleteAccountStep(1)}
                    className="flex-1 py-3 rounded-xl border border-[var(--border-2)] text-sm text-[var(--text-muted)] transition-colors">
                    Indietro
                  </button>
                  <button
                    onClick={() => {
                      if (deleteEmailConfirm.toLowerCase() !== user?.email?.toLowerCase()) {
                        showToast('Email non corrisponde', 'err'); return;
                      }
                      setDeleteAccountStep(3);
                    }}
                    disabled={!deleteEmailConfirm}
                    className="flex-1 py-3 rounded-xl bg-red-500/15 border border-red-500/30 text-red-400 text-sm font-semibold disabled:opacity-40 transition-colors">
                    Continua
                  </button>
                </div>
              </div>
            )}

            {/* STEP 3: Inserisci password */}
            {deleteAccountStep === 3 && (
              <div className="p-6">
                <h3 className="font-semibold mb-1">Inserisci la tua password</h3>
                <p className="text-[12px] text-[var(--text-soft)] mb-4">Per sicurezza conferma la tua password attuale</p>
                <input
                  type="password"
                  value={deletePasswordConfirm}
                  onChange={e => setDeletePasswordConfirm(e.target.value)}
                  placeholder="Password attuale"
                  className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm focus:border-red-500/40 outline-none mb-4"
                  autoFocus
                />
                <div className="flex gap-2">
                  <button onClick={() => setDeleteAccountStep(2)}
                    className="flex-1 py-3 rounded-xl border border-[var(--border-2)] text-sm text-[var(--text-muted)] transition-colors">
                    Indietro
                  </button>
                  <button
                    onClick={() => { if (deletePasswordConfirm.length >= 6) setDeleteAccountStep(4); }}
                    disabled={deletePasswordConfirm.length < 6}
                    className="flex-1 py-3 rounded-xl bg-red-500/15 border border-red-500/30 text-red-400 text-sm font-semibold disabled:opacity-40 transition-colors">
                    Continua
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
                <h3 className="font-semibold text-center mb-1">Ultima conferma</h3>
                <p className="text-[12px] text-[var(--text-soft)] text-center mb-5">Una volta eliminato non potrai recuperare nulla</p>
                <label className="flex items-start gap-3 cursor-pointer mb-5 p-3 bg-red-500/[0.05] border border-red-500/[0.12] rounded-xl">
                  <input type="checkbox" checked={deleteCheckbox} onChange={e => setDeleteCheckbox(e.target.checked)}
                    className="mt-0.5 shrink-0 w-4 h-4 accent-red-500" />
                  <span className="text-[12px] text-[var(--text-muted)] leading-relaxed">
                    Capisco che questa azione è permanente e che perderò tutti i miei dati, prodotti e accessi senza possibilità di recupero.
                  </span>
                </label>
                <div className="flex gap-2">
                  <button onClick={() => { setDeleteAccountStep(0); setDeleteEmailConfirm(''); setDeletePasswordConfirm(''); setDeleteCheckbox(false); }}
                    className="flex-1 py-3 rounded-xl border border-[var(--border-2)] text-sm text-[var(--text-muted)] transition-colors">
                    Annulla
                  </button>
                  <button onClick={handleDeleteAccount}
                    disabled={!deleteCheckbox || isDeletingAccount}
                    className="flex-1 py-3 rounded-xl bg-red-600 text-[var(--text)] text-sm font-semibold disabled:opacity-40 hover:bg-red-700 transition-colors">
                    {isDeletingAccount ? <Loader2 size={16} className="animate-spin mx-auto" /> : 'Elimina Account'}
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
                <p className="text-sm font-semibold text-[var(--text)] mb-1">Informativa Cookie</p>
                <p className="text-[12px] text-[var(--text-soft)] leading-relaxed">
                  Usiamo solo cookie <span className="text-gray-300">strettamente necessari</span> per l'autenticazione e il funzionamento dell'app. Nessun cookie di marketing o profilazione.{' '}
                  <button onClick={() => setPrivacyOpen(true)} className="text-[var(--text)] underline underline-offset-2 hover:no-underline">
                    Privacy Policy
                  </button>
                </p>
              </div>
            </div>
            <div className="flex gap-2">
              <button onClick={() => setPrivacyOpen(true)}
                className="flex-1 py-2 rounded-xl border border-[var(--border-2)] text-xs text-[var(--text-muted)] hover:text-[var(--text)] transition-colors">
                Leggi tutto
              </button>
              <button onClick={() => { localStorage.setItem('hq_cookie_consent', '1'); setCookieConsent(true); }}
                className="flex-1 py-2 rounded-xl bg-white text-black text-xs font-semibold hover:bg-gray-200 transition-colors">
                Accetta e Continua
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ========== MODALE: PIANI & STRUMENTI PRO ========== */}
      {planModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={() => setPlanModalOpen(false)}>
          <div className="bg-[var(--surface)] border border-[var(--border)] w-full sm:max-w-3xl sm:rounded-2xl rounded-t-2xl max-h-[92vh] flex flex-col overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="p-5 border-b border-[var(--border)] flex items-center justify-between shrink-0">
              <div className="flex items-center gap-2">
                <Sparkles className="text-[#8b5cf6]" size={20} />
                <h2 className="font-semibold text-base">Piani &amp; Strumenti Pro</h2>
                <span className="text-[10px] uppercase font-bold bg-[var(--fill)] px-2 py-0.5 rounded-full">{myPlan}</span>
              </div>
              <button onClick={() => setPlanModalOpen(false)} className="p-2 hover:bg-[var(--fill)] rounded-xl transition-colors"><X size={18} /></button>
            </div>

            {/* Tabs */}
            <div className="flex gap-1.5 p-3 border-b border-[var(--border)] overflow-x-auto shrink-0">
              {([['plans','Piani'],['repricing','Stock fermo'],['offer','Trattative'],['channels','Multi-canale']] as [typeof proTab,string][]).map(([id,label]) => (
                <button key={id} onClick={() => setProTab(id)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold whitespace-nowrap transition-colors ${proTab === id ? 'bg-[#8b5cf6] text-white' : 'bg-[var(--fill)] text-[var(--text-soft)]'}`}>
                  {label}
                </button>
              ))}
            </div>

            <div className="p-4 overflow-y-auto">
              {/* TAB: PIANI */}
              {proTab === 'plans' && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {planCatalog.map(p => (
                    <div key={p.id} className={`rounded-2xl border p-4 ${p.id === myPlan ? 'border-[#8b5cf6] bg-[#8b5cf6]/5' : 'border-[var(--border-2)] bg-[var(--surface-2)]'}`}>
                      <div className="flex items-baseline justify-between">
                        <h3 className="font-bold text-lg">{p.name}</h3>
                        <span className="font-bold num">{p.priceMonthly === 0 ? 'Gratis' : `${p.priceMonthly}€`}<span className="text-[10px] text-[var(--text-faint)] font-normal">{p.priceMonthly === 0 ? '' : '/mese'}</span></span>
                      </div>
                      <p className="text-[11px] text-[var(--text-soft)] mt-0.5">{p.tagline}</p>
                      <ul className="mt-3 space-y-1.5">
                        {p.highlights.map((h: string, i: number) => (
                          <li key={i} className="flex items-start gap-2 text-[11px] text-[var(--text-soft)]">
                            <CheckCircle size={13} className="text-[#8b5cf6] mt-0.5 shrink-0" /> <span>{h}</span>
                          </li>
                        ))}
                      </ul>
                      {p.id === myPlan && <p className="mt-3 text-center text-[10px] font-bold text-[#8b5cf6] uppercase">Piano attuale</p>}
                    </div>
                  ))}
                  {user?.email?.toLowerCase() === ADMIN_EMAIL.toLowerCase() && (
                    <p className="sm:col-span-2 text-[10px] text-[var(--text-faint)] text-center mt-1">Modalità admin: cambia il piano (anche il tuo) dal Pannello Admin → Utenti per testare le funzioni.</p>
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
                      <p className="text-xs text-[var(--text-soft)]">Prodotti fermi da oltre 30 giorni con prezzo consigliato.</p>
                      <button onClick={loadRepricing} disabled={repricingLoading}
                        className="px-3 py-1.5 rounded-xl text-xs font-bold bg-[#8b5cf6] hover:bg-[#a78bfa] text-white disabled:opacity-40">
                        {repricingLoading ? <Loader2 size={14} className="animate-spin" /> : 'Analizza'}
                      </button>
                    </div>
                    {repricingList && repricingList.length === 0 && <p className="text-xs text-center text-[var(--text-faint)] py-6">Nessun prodotto fermo.</p>}
                    {repricingList && repricingList.map((r: any) => (
                      <div key={r.id} className="flex items-center justify-between bg-[var(--surface-2)] rounded-xl p-3">
                        <div className="min-w-0">
                          <p className="text-sm font-bold truncate">{r.brand} {r.name}</p>
                          <p className="text-[10px] text-[var(--text-faint)]">{r.daysInStock} giorni · taglia {r.size}</p>
                        </div>
                        <div className="text-right shrink-0 ml-3">
                          <p className="text-sm font-bold text-[#8b5cf6] num">{r.suggestedPrice}€</p>
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
                      className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-2.5 text-sm outline-none focus:border-[#8b5cf6]">
                      <option value="">Scegli un prodotto in stock…</option>
                      {products.filter((p: any) => p.status === 'IN STOCK').map((p: any) => (
                        <option key={p.id} value={p.id}>{p.brand} {p.name} ({p.size})</option>
                      ))}
                    </select>
                    <div className="flex gap-2">
                      <input type="number" inputMode="decimal" value={offerAmount} onChange={e => setOfferAmount(e.target.value)} placeholder="Offerta ricevuta €"
                        className="flex-1 bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-2.5 text-sm outline-none focus:border-[#8b5cf6]" />
                      <input type="number" inputMode="decimal" value={offerMargin} onChange={e => setOfferMargin(e.target.value)} placeholder="Margine % min"
                        className="w-28 bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-2.5 text-sm outline-none focus:border-[#8b5cf6]" />
                    </div>
                    <button onClick={runOffer} disabled={offerLoading}
                      className="w-full py-2.5 rounded-xl text-sm font-bold bg-[#8b5cf6] hover:bg-[#a78bfa] text-white disabled:opacity-40 flex items-center justify-center gap-2">
                      {offerLoading ? <Loader2 size={16} className="animate-spin" /> : 'Cosa rispondo?'}
                    </button>
                    {offerResult && (
                      <div className="space-y-2 bg-[var(--surface-2)] rounded-xl p-3">
                        <div className="flex items-center gap-2">
                          <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full ${offerResult.decision === 'accept' ? 'bg-green-500/15 text-green-400' : offerResult.decision === 'counter' ? 'bg-yellow-500/15 text-yellow-500' : 'bg-red-500/15 text-red-400'}`}>
                            {offerResult.decision === 'accept' ? 'Accetta' : offerResult.decision === 'counter' ? `Contro-offerta ${offerResult.counterPrice}€` : `Rifiuta (proponi ${offerResult.counterPrice}€)`}
                          </span>
                          <span className="text-[10px] text-[var(--text-faint)]">min {offerResult.minPrice}€ · margine {offerResult.offerMargin}€</span>
                        </div>
                        <p className="text-sm text-[var(--text)] bg-[var(--fill)] rounded-lg p-2.5">{offerResult.message}</p>
                        <div className="flex items-center justify-between">
                          <p className="text-[10px] text-[var(--text-faint)] italic">{offerResult.reasoning}</p>
                          <button onClick={() => { navigator.clipboard?.writeText(offerResult.message); showToast('Messaggio copiato'); }}
                            className="flex items-center gap-1 text-[10px] font-bold text-[#8b5cf6]"><Copy size={12} /> Copia</button>
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
                    <p className="text-xs text-[var(--text-soft)]">Segna su quali canali hai pubblicato il prodotto. Quando si vende, ti ricordi di ritirarlo dagli altri.</p>
                    <select value={chProductId} onChange={e => setChProductId(e.target.value)}
                      className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-2.5 text-sm outline-none focus:border-[#8b5cf6]">
                      <option value="">Scegli un prodotto in stock…</option>
                      {products.filter((p: any) => p.status === 'IN STOCK').map((p: any) => (
                        <option key={p.id} value={p.id}>{p.brand} {p.name} ({p.size})</option>
                      ))}
                    </select>
                    <div className="flex flex-wrap gap-2">
                      {['Vinted','eBay','Depop','Subito','Wallapop','StockX'].map(pl => {
                        const on = chSelected.includes(pl);
                        return (
                          <button key={pl} onClick={() => setChSelected(prev => on ? prev.filter(x => x !== pl) : [...prev, pl])}
                            className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-colors ${on ? 'bg-[#8b5cf6] text-white' : 'bg-[var(--fill)] text-[var(--text-soft)]'}`}>
                            {pl}
                          </button>
                        );
                      })}
                    </div>
                    <button onClick={saveChannels} disabled={chSaving}
                      className="w-full py-2.5 rounded-xl text-sm font-bold bg-[#8b5cf6] hover:bg-[#a78bfa] text-white disabled:opacity-40 flex items-center justify-center gap-2">
                      {chSaving ? <Loader2 size={16} className="animate-spin" /> : <><Store size={15} /> Salva canali</>}
                    </button>
                  </div>
                )
              )}
            </div>
          </div>
        </div>
      )}

      {/* ========== MODALE: PRIVACY POLICY ========== */}
      {privacyOpen && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-end sm:items-center justify-center z-[110] p-0 sm:p-4">
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
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-end sm:items-center justify-center z-[60] p-0 sm:p-4">
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
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-end sm:items-center justify-center z-[60] p-0 sm:p-4">
          <div className="bg-[var(--surface)] border-t sm:border border-[var(--border-2)] rounded-t-3xl sm:rounded-3xl w-full max-w-sm p-6">
            <div className="flex justify-center mb-4 sm:hidden"><div className="w-10 h-1 bg-gray-700 rounded-full" /></div>
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-red-500/20 flex items-center justify-center">
                <Trash2 className="text-red-400" size={20} />
              </div>
              <div>
                <h3 className="font-semibold text-base">Elimina prodotto</h3>
                <p className="text-xs text-[var(--text-soft)]">Questa azione è irreversibile</p>
              </div>
            </div>
            <p className="text-sm text-[var(--text-muted)] mb-6">
              Stai eliminando <span className="text-[var(--text)] font-bold">{productToDelete.brand} {productToDelete.name}</span>
              {productToDelete.quantity > 1 && ` (${productToDelete.quantity} pezzi)`}.
            </p>
            <div className="flex gap-3">
              <button onClick={() => setDeleteConfirmOpen(false)}
                className="flex-1 bg-[var(--fill)] hover:bg-[var(--fill)] py-3 rounded-xl font-bold text-sm transition-colors">
                Annulla
              </button>
              <button onClick={handleDeleteProduct}
                className="flex-1 bg-red-600 hover:bg-red-500 py-3 rounded-xl font-bold text-sm transition-colors">
                Elimina
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ========== MODALE: CAMBIA PASSWORD ========== */}
      {changePwdOpen && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-end sm:items-center justify-center z-[60] p-0 sm:p-4">
          <div className="bg-[var(--surface)] border-t sm:border border-[var(--border-2)] rounded-t-3xl sm:rounded-3xl w-full max-w-sm p-6">
            <div className="flex justify-center mb-4 sm:hidden"><div className="w-10 h-1 bg-gray-700 rounded-full" /></div>
            <div className="flex items-center gap-3 mb-5">
              <Lock className="text-[var(--text)]" size={22} />
              <h3 className="font-semibold text-base">Cambia Password</h3>
            </div>
            <form onSubmit={handleChangePassword} className="space-y-4">
              <div>
                <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">Password attuale</label>
                <input type="password" required value={changePwdCurrent}
                  onChange={e => setChangePwdCurrent(e.target.value)}
                  placeholder="••••••••"
                  className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-[var(--text)] outline-none focus:border-[#8b5cf6]" />
              </div>
              <div>
                <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">Nuova password</label>
                <input type="password" required value={changePwdNew}
                  onChange={e => setChangePwdNew(e.target.value)}
                  placeholder="••••••••"
                  className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-[var(--text)] outline-none focus:border-[#8b5cf6]" />
                <p className="text-[10px] text-[var(--text-soft)] mt-1">Min. 10 caratteri, maiuscola, numero e carattere speciale.</p>
              </div>
              <div>
                <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">Conferma nuova password</label>
                <input type="password" required value={changePwdConfirm}
                  onChange={e => setChangePwdConfirm(e.target.value)}
                  placeholder="••••••••"
                  className={`w-full bg-[var(--surface-2)] border rounded-xl p-3 text-[var(--text)] outline-none focus:border-[#8b5cf6] ${
                    changePwdConfirm && changePwdNew !== changePwdConfirm ? 'border-red-500' : 'border-[var(--border-2)]'
                  }`} />
              </div>
              <div className="flex gap-3 pt-2">
                <button type="button" onClick={() => { setChangePwdOpen(false); setChangePwdCurrent(''); setChangePwdNew(''); setChangePwdConfirm(''); }}
                  className="flex-1 bg-[var(--fill)] hover:bg-[var(--fill)] py-3 rounded-xl font-bold text-sm transition-colors">
                  Annulla
                </button>
                <button type="submit" disabled={changePwdLoading || (!!changePwdConfirm && changePwdNew !== changePwdConfirm)}
                  className="flex-1 bg-[#8b5cf6] hover:bg-[#a78bfa] disabled:opacity-50 py-3 rounded-xl font-bold text-sm transition-colors flex items-center justify-center">
                  {changePwdLoading ? <Loader2 className="animate-spin" size={16} /> : 'Salva'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ========== MODALE: TRACKING SPEDIZIONE ========== */}
      {/* ========== MODALE: ACQUISTO IN ARRIVO ========== */}
      {incomingOpen && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-end sm:items-center justify-center z-[60] p-0 sm:p-4" onClick={() => setIncomingOpen(false)}>
          <div className="bg-[var(--surface)] border-t sm:border border-[var(--border-2)] rounded-t-3xl sm:rounded-3xl w-full max-w-md p-6 max-h-[92vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="flex justify-center mb-4 sm:hidden"><div className="w-10 h-1 bg-gray-700 rounded-full" /></div>
            <div className="flex items-center justify-between mb-5">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-[var(--accent)]/15 flex items-center justify-center"><Truck className="text-[var(--accent)]" size={20} /></div>
                <div>
                  <h3 className="font-semibold text-base">Acquisto in arrivo</h3>
                  <p className="text-xs text-[var(--text-soft)]">Lo metto in stock e ne traccio l'arrivo</p>
                </div>
              </div>
              <button onClick={() => setIncomingOpen(false)}><X size={20} className="text-[var(--text-soft)] hover:text-[var(--text)]" /></button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">Reparto</label>
                <select value={incCategory} onChange={(e: any) => setIncCategory(e.target.value)}
                  className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm focus:border-[var(--accent)] outline-none">
                  {userCategories.length === 0 && <option value="">— crea prima un reparto —</option>}
                  {userCategories.map((c: string) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">Brand</label>
                  <input value={incBrand} onChange={(e: any) => setIncBrand(e.target.value)} placeholder="Nike"
                    className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm focus:border-[var(--accent)] outline-none" />
                </div>
                <div>
                  <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">Prezzo acquisto €</label>
                  <input type="number" step="0.01" value={incPrice} onChange={(e: any) => setIncPrice(e.target.value)} placeholder="0"
                    className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm focus:border-[var(--accent)] outline-none" />
                </div>
              </div>
              <div>
                <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">Nome / Modello</label>
                <input value={incName} onChange={(e: any) => setIncName(e.target.value)} placeholder="Air Jordan 1 Chicago"
                  className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm focus:border-[var(--accent)] outline-none" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">Codice tracking</label>
                  <input value={incTrackCode} onChange={(e: any) => setIncTrackCode(e.target.value)} placeholder="ABC123..."
                    className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm focus:border-[var(--accent)] outline-none" />
                </div>
                <div>
                  <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">Vettore</label>
                  <select value={incTrackCarrier} onChange={(e: any) => setIncTrackCarrier(e.target.value)}
                    className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-sm focus:border-[var(--accent)] outline-none">
                    {(carrierList.length ? carrierList.map(c => c.key) : ['Auto','BRT','GLS','Poste Italiane','SDA','DHL','UPS','FedEx','TNT','Amazon Logistics','Nexive']).map(k => (
                      <option key={k} value={k}>{k === 'Auto' ? 'Auto-rileva' : k}</option>
                    ))}
                  </select>
                </div>
              </div>
              <button onClick={createIncoming} disabled={incSaving}
                className="w-full bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white py-3 rounded-xl font-bold transition-colors disabled:opacity-50 flex items-center justify-center gap-2">
                {incSaving ? <Loader2 className="animate-spin" size={18} /> : <><Plus size={16} /> Aggiungi e traccia</>}
              </button>
            </div>
          </div>
        </div>
      )}

      {trackingModalOpen && trackingProduct && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-end sm:items-center justify-center z-[60] p-0 sm:p-4">
          <div className="bg-[var(--surface)] border-t sm:border border-[var(--border-2)] rounded-t-3xl sm:rounded-3xl w-full max-w-md p-6 max-h-[90vh] overflow-y-auto">
            <div className="flex justify-center mb-4 sm:hidden"><div className="w-10 h-1 bg-gray-700 rounded-full" /></div>
            <div className="flex items-center justify-between mb-5">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-blue-500/20 flex items-center justify-center">
                  <Truck className="text-blue-400" size={20} />
                </div>
                <div>
                  <h3 className="font-semibold text-base">{trackingProduct.status === 'VENDUTO' ? 'Spedizione di vendita' : 'Spedizione in arrivo'}</h3>
                  <p className="text-xs text-[var(--text-soft)]">{trackingProduct.brand} {trackingProduct.name}</p>
                </div>
              </div>
              <button onClick={() => setTrackingModalOpen(false)}>
                <X size={20} className="text-[var(--text-soft)] hover:text-[var(--text)]" />
              </button>
            </div>

            {/* Stato corrente */}
            {trackingProduct.trackingCode && (
              <div className={`mb-5 p-4 rounded-2xl border flex items-center justify-between gap-3 ${
                trackingProduct.trackingStatus === 'DELIVERED' ? 'border-green-800 bg-green-900/20' :
                trackingProduct.trackingStatus === 'OUT_FOR_DELIVERY' ? 'border-violet-800 bg-violet-900/20' :
                trackingProduct.trackingStatus === 'IN_TRANSIT' ? 'border-blue-800 bg-blue-900/20' :
                trackingProduct.trackingStatus === 'EXCEPTION' ? 'border-red-800 bg-red-900/20' :
                'border-[var(--border-2)] bg-[var(--fill)]/30'
              }`}>
                <div className="min-w-0">
                  <p className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest">Stato attuale</p>
                  <p className="font-bold text-sm mt-0.5">
                    {trackingProduct.trackingStatus === 'IN_TRANSIT' ? '🚚 In transito' :
                     trackingProduct.trackingStatus === 'OUT_FOR_DELIVERY' ? '📦 In consegna oggi' :
                     trackingProduct.trackingStatus === 'DELIVERED' ? '✅ Consegnato' :
                     trackingProduct.trackingStatus === 'EXCEPTION' ? '⚠️ Eccezione' :
                     '⏳ In attesa'}
                  </p>
                  <p className="text-[10px] text-[var(--text-soft)] mt-0.5 truncate">{trackingProduct.trackingCarrier} • {trackingProduct.trackingCode}</p>
                </div>
                <button onClick={handleRefreshTracking} disabled={isRefreshingTracking}
                  className="flex items-center gap-1.5 text-xs text-blue-400 hover:text-blue-300 font-bold bg-blue-900/30 px-3 py-2 rounded-xl disabled:opacity-50 shrink-0 transition-colors">
                  {isRefreshingTracking ? <Loader2 className="animate-spin" size={12} /> : <Truck size={12} />} Aggiorna
                </button>
              </div>
            )}

            {/* Tracciamento senza API: link pubblico al corriere + stato manuale */}
            {trackingProduct.trackingCode && (
              <div className="mb-5 space-y-3">
                <a href={trackingPublicUrl(trackingProduct.trackingCode)} target="_blank" rel="noopener noreferrer"
                  className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl border border-[var(--border-2)] bg-[var(--surface-2)] text-sm font-bold text-[var(--text-soft)] hover:text-[var(--text)] hover:border-[var(--border-3)] transition-colors">
                  <Truck size={14} /> Vedi stato sul corriere ↗
                </a>
                <div>
                  <p className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest mb-2">Aggiorna stato a mano</p>
                  <div className="grid grid-cols-2 gap-2">
                    {([['IN_TRANSIT','🚚 In transito'],['OUT_FOR_DELIVERY','📦 In consegna'],['DELIVERED','✅ Consegnato'],['EXCEPTION','⚠️ Problema']] as [string,string][]).map(([s,label]) => (
                      <button key={s} onClick={() => setManualStatus(s)}
                        className={`py-2 rounded-xl text-xs font-bold transition-colors ${trackingProduct.trackingStatus === s ? 'bg-[var(--accent)] text-white' : 'bg-[var(--fill)] text-[var(--text-soft)] hover:text-[var(--text)]'}`}>
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* Storico eventi */}
            {trackingDetail?.history?.length > 0 && (
              <div className="mb-5">
                <p className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest mb-3">Storico eventi</p>
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
                <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">Codice Tracking</label>
                <input type="text" value={trackingInput}
                  onChange={e => setTrackingInput(e.target.value.toUpperCase())}
                  placeholder="ES: BRT123456789IT"
                  className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl p-3 text-[var(--text)] outline-none focus:border-blue-500 font-mono text-sm uppercase"
                />
              </div>
              <div>
                <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-2">Vettore</label>
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
                Annulla
              </button>
              <button onClick={handleSaveTracking} disabled={!trackingInput.trim() || isSavingTracking}
                className="flex-1 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 py-3 rounded-xl font-bold text-sm transition-colors flex items-center justify-center gap-2">
                {isSavingTracking ? <Loader2 className="animate-spin" size={16} /> : <><Truck size={15} /> Salva</>}
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
          if (ok) { await apiCall('/auth/me').then(r => r.ok && setUser(r.data.user)); showToast('Codice invito rigenerato'); }
          else showToast(data.error || 'Errore rigenerazione', 'err');
        };

        const kickMember = async (membershipId: string) => {
          const { ok, data } = await apiCall(`/team/members/${membershipId}`, { method: 'DELETE' });
          if (ok) { await fetchTeam(); setKickConfirm(null); showToast('Membro rimosso dal team'); }
          else showToast(data.error || 'Errore', 'err');
        };

        const saveEditedQuotes = async (team: any) => {
          const updates = team.members.map((m: any) => ({
            userId: m.userId, membershipId: m.membershipId,
            percentage: Number(editQuoteValues[m.membershipId] ?? m.percentage),
          }));
          const total = updates.reduce((s: number, u: any) => s + u.percentage, 0);
          if (Math.round(total) !== 100) { showToast('La somma deve essere 100%', 'err'); return; }
          setIsSavingTeam(true);
          const { ok, data } = await apiCall('/team/percentage', {
            method: 'PUT', body: JSON.stringify({ warehouseId: team.warehouseId, updates }),
          });
          setIsSavingTeam(false);
          if (ok) { fetchTeam(); setEditQuoteWarehouse(null); showToast('Quote aggiornate'); }
          else showToast(data.error || 'Errore', 'err');
        };

        return (
          <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-[70] flex items-end lg:justify-end"
            onClick={() => setTeamPanelOpen(false)}>
            <div
              className="bg-[var(--surface)] border-t lg:border-t-0 lg:border-l border-[var(--border-2)] w-full lg:w-[460px] max-h-[92vh] lg:h-full overflow-y-auto rounded-t-3xl lg:rounded-none animate-slide-up lg:animate-slide-right"
              onClick={e => e.stopPropagation()}>

              {/* Header sticky */}
              <div className="sticky top-0 bg-[var(--surface-blur)] backdrop-blur-xl border-b border-[var(--border)] p-5 flex items-center justify-between z-10">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-2xl bg-violet-500/15 border border-violet-500/20 flex items-center justify-center">
                    <Users className="text-violet-400" size={18} />
                  </div>
                  <div>
                    <h2 className="font-semibold text-base leading-none">Il Tuo Team</h2>
                    <p className="text-[10px] text-[var(--text-faint)] mt-0.5">{totalSoci} {totalSoci === 1 ? 'socio' : 'soci'} · {teamData.length} {teamData.length === 1 ? 'reparto' : 'reparti'}</p>
                  </div>
                </div>
                <button onClick={() => setTeamPanelOpen(false)} className="p-2 hover:bg-[var(--fill)] rounded-xl transition-colors">
                  <X size={19} className="text-[var(--text-muted)]" />
                </button>
              </div>

              {/* Stats rapide globali */}
              <div className="grid grid-cols-4 gap-2 p-4 border-b border-[var(--border)]">
                {[
                  { label: 'Soci', value: totalSoci, color: 'text-violet-400' },
                  { label: 'In Stock', value: totalStock, color: 'text-[var(--text)]' },
                  { label: 'Venduti', value: totalSoldCount, color: 'text-blue-400' },
                  { label: 'Profitto', value: (totalProfit >= 0 ? '+' : '') + totalProfit.toFixed(0) + '€', color: totalProfit >= 0 ? 'text-emerald-400' : 'text-red-400' },
                ].map(s => (
                  <div key={s.label} className="bg-[var(--surface-2)] rounded-xl p-2.5 text-center">
                    <p className={`text-sm font-bold num ${s.color}`}>{s.value}</p>
                    <p className="text-[9px] text-[var(--text-faint)] mt-0.5 uppercase tracking-wider">{s.label}</p>
                  </div>
                ))}
              </div>

              <div className="p-4 space-y-5">

                {/* Per ogni reparto */}
                {teamData.map((team: any) => {
                  const cat = team.warehouseName.replace('Magazzino ', '');
                  const teamProds = products.filter(p => p.category === cat);
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

                  // Pareggio conti: quanto spetta ad ogni membro sul profitto totale
                  const settleAmounts = memberProfits.map((m: any) => ({
                    ...m,
                    spettante: teamProfit * (m.percentage / 100),
                  }));

                  return (
                    <section key={team.warehouseId} className="bg-[var(--bg)] rounded-2xl border border-[var(--border)] overflow-hidden">

                      {/* Reparto header */}
                      <div className="p-4 border-b border-[var(--border)]">
                        <div className="flex items-center justify-between mb-3">
                          <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-xl bg-[#111] border border-[var(--border)] flex items-center justify-center text-xl shrink-0">
                              {getCategoryIcon(cat)}
                            </div>
                            <div>
                              <p className="font-bold">{cat}</p>
                              <p className="text-[10px] text-[var(--text-faint)]">{team.members.length} soci · {teamStock.length} stock · {teamSold.length} vendite</p>
                            </div>
                          </div>
                          <div className="text-right">
                            <p className={`font-semibold num ${teamProfit > 0 ? 'text-emerald-400' : teamProfit < 0 ? 'text-red-400' : 'text-[var(--text-faint)]'}`}>
                              {teamProfit > 0 ? '+' : ''}{teamProfit.toFixed(0)}€
                            </p>
                            <p className="text-[10px] text-[var(--text-faint)] mt-0.5">{teamRevenue.toFixed(0)}€ ricavi · {sellThrough}% sell-through</p>
                          </div>
                        </div>

                        {/* Mini progress sell-through */}
                        <div className="h-1 bg-[var(--fill)] rounded-full overflow-hidden">
                          <div className="h-full bg-gradient-to-r from-[#8b5cf6] to-violet-400 rounded-full transition-all" style={{ width: `${sellThrough}%` }} />
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
                              <div className={`flex items-center gap-3 p-3.5 transition-colors ${isMe ? 'bg-[#8b5cf6]/[0.04]' : 'hover:bg-[var(--fill)]'}`}>
                                {/* Rank medal o avatar */}
                                <div className="relative shrink-0">
                                  <div className="w-9 h-9 rounded-full bg-gradient-to-br from-violet-500 to-blue-600 flex items-center justify-center font-black text-xs shadow-sm">
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
                                    {isMe && <span className="text-[8px] bg-[#8b5cf6]/20 text-[var(--text)] px-1.5 py-0.5 rounded-full font-semibold">TU</span>}
                                    <span className={`text-[8px] px-1.5 py-0.5 rounded-full font-semibold ${m.role === 'OWNER' ? 'bg-[#8b5cf6]/15 text-[var(--text)]/80' : 'bg-[var(--fill)] text-[var(--text-soft)]'}`}>
                                      {m.role === 'OWNER' ? 'Owner' : 'Socio'}
                                    </span>
                                  </div>
                                  {/* Contribuzione */}
                                  <div className="flex items-center gap-2 mt-0.5">
                                    <span className="text-[10px] text-[var(--text-faint)]">{m.productsAdded ?? 0} aggiunti · {m.productsSold ?? 0} venduti</span>
                                  </div>
                                </div>

                                {/* Destra: % e profitto */}
                                <div className="flex items-center gap-2 shrink-0">
                                  {isEditing ? (
                                    <input
                                      type="number" min="0" max="100" step="1"
                                      value={editQuoteValues[m.membershipId] ?? m.percentage}
                                      onChange={e => setEditQuoteValues(prev => ({ ...prev, [m.membershipId]: e.target.value }))}
                                      className="w-14 bg-[var(--surface-2)] border border-[var(--border-2)] rounded-lg px-2 py-1 text-xs text-center text-[var(--text)] outline-none focus:border-[#8b5cf6]"
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
                                      title="Rimuovi dal team">
                                      <X size={12} />
                                    </button>
                                  )}
                                </div>
                              </div>

                              {/* Conferma kick */}
                              {kickConfirm === m.membershipId && (
                                <div className="mx-3.5 mb-3 p-3 bg-red-500/10 border border-red-500/20 rounded-xl flex items-center justify-between gap-3">
                                  <p className="text-xs text-red-300">Rimuovere <strong>{m.name}</strong>?</p>
                                  <div className="flex gap-2">
                                    <button onClick={() => setKickConfirm(null)} className="text-[11px] text-[var(--text-soft)] hover:text-[var(--text)] px-2 py-1 rounded-lg hover:bg-[var(--fill)]">Annulla</button>
                                    <button onClick={() => kickMember(m.membershipId)} className="text-[11px] text-red-300 hover:text-red-200 bg-red-500/20 hover:bg-red-500/30 px-3 py-1 rounded-lg font-bold">Rimuovi</button>
                                  </div>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>

                      {/* Footer reparto */}
                      <div className="p-4 border-t border-[var(--border)] space-y-3">

                        {/* Pareggio conti */}
                        {teamProfit !== 0 && (
                          <div className="bg-[var(--surface-2)] rounded-xl p-3">
                            <div className="flex items-center gap-1.5 mb-2.5">
                              <DollarSign size={11} className="text-emerald-500" />
                              <p className="text-[10px] font-bold text-[var(--text-muted)] uppercase tracking-wider">Pareggio conti</p>
                              <span className="ml-auto text-[10px] text-[var(--text-faint)] num">{teamProfit >= 0 ? '+' : ''}{teamProfit.toFixed(0)}€ totali</span>
                            </div>
                            <div className="space-y-1.5">
                              {settleAmounts.map((m: any) => (
                                <div key={m.membershipId} className="flex items-center justify-between">
                                  <div className="flex items-center gap-1.5">
                                    <div className="w-4 h-4 rounded-full bg-gradient-to-br from-violet-500 to-blue-600 flex items-center justify-center font-black text-[7px]">
                                      {m.name[0]?.toUpperCase()}
                                    </div>
                                    <span className="text-xs text-[var(--text-muted)]">{m.name}</span>
                                    <span className="text-[10px] text-gray-700">{m.percentage}%</span>
                                  </div>
                                  <span className={`text-sm font-bold num ${m.spettante >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                                    {m.spettante >= 0 ? '+' : ''}{m.spettante.toFixed(2)}€
                                  </span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Modifica Quote (OWNER only) */}
                        {isOwnerHere && (
                          isEditing ? (
                            <div className="space-y-2">
                              <div className="flex items-center justify-between text-[10px]">
                                <span className="text-[var(--text-faint)]">
                                  Totale: {team.members.reduce((s: number, m: any) => s + (Number(editQuoteValues[m.membershipId] ?? m.percentage) || 0), 0)}%
                                  {Math.round(team.members.reduce((s: number, m: any) => s + (Number(editQuoteValues[m.membershipId] ?? m.percentage) || 0), 0)) !== 100 && (
                                    <span className="text-red-400 ml-1">· deve essere 100%</span>
                                  )}
                                </span>
                              </div>
                              <div className="flex gap-2">
                                <button onClick={() => { setEditQuoteWarehouse(null); setEditQuoteValues({}); }}
                                  className="flex-1 py-2 text-xs font-bold text-[var(--text-soft)] hover:text-[var(--text)] bg-[var(--fill)] hover:bg-[var(--fill)] rounded-xl transition-colors">
                                  Annulla
                                </button>
                                <button onClick={() => saveEditedQuotes(team)} disabled={isSavingTeam}
                                  className="flex-1 py-2 text-xs font-bold text-[var(--text)] bg-[#8b5cf6]/80 hover:bg-[#8b5cf6] rounded-xl transition-colors disabled:opacity-40">
                                  {isSavingTeam ? 'Salvo...' : 'Salva Quote'}
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
                              <Edit size={11} /> Modifica Quote
                            </button>
                          )
                        )}

                        {/* Sezione invito */}
                        {isOwnerHere && team.inviteCode && (
                          <div className="bg-[var(--surface-2)] rounded-xl p-3 border border-[var(--border)]">
                            <p className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-wider mb-2 flex items-center gap-1.5">
                              <UserPlus size={10} /> Invita un socio
                            </p>
                            <div className="flex gap-2">
                              <div className="flex-1 bg-[#111] border border-[var(--border-2)] rounded-xl px-3 py-2 flex items-center gap-2 overflow-hidden">
                                <KeyRound size={11} className="text-[var(--text-faint)] shrink-0" />
                                <span className="font-mono text-xs text-gray-300 truncate">{team.inviteCode}</span>
                              </div>
                              <button
                                onClick={() => { navigator.clipboard.writeText(team.inviteCode); showToast('Codice copiato!'); }}
                                className="px-3 bg-[var(--fill)] hover:bg-[var(--fill-2)] border border-[var(--border-2)] rounded-xl text-[var(--text-muted)] hover:text-[var(--text)] transition-colors active:scale-95">
                                <Copy size={14} />
                              </button>
                              <button
                                onClick={() => regenerateInvite(team.warehouseId)}
                                disabled={isRegenerating === team.warehouseId}
                                className="px-3 bg-[var(--fill)] hover:bg-[var(--fill-2)] border border-[var(--border-2)] rounded-xl text-[var(--text-muted)] hover:text-[var(--text)] transition-colors disabled:opacity-40 active:scale-95"
                                title="Rigenera codice">
                                {isRegenerating === team.warehouseId
                                  ? <Loader2 size={14} className="animate-spin" />
                                  : <ArrowUpDown size={14} />}
                              </button>
                            </div>
                            <p className="text-[10px] text-gray-700 mt-1.5">Condividi questo codice — il tuo socio lo userà durante la registrazione</p>
                          </div>
                        )}
                      </div>
                    </section>
                  );
                })}

                {/* Entra in un team esistente */}
                <section className="bg-[var(--bg)] rounded-2xl border border-[var(--border)] p-4">
                  <p className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-wider mb-3 flex items-center gap-1.5">
                    <UserPlus size={10} className="text-blue-400" /> Entra in un Team
                  </p>
                  <form onSubmit={handleJoinWarehouse} className="flex gap-2">
                    <input
                      type="text" value={joinCodeInput} onChange={e => setJoinCodeInput(e.target.value.toUpperCase())}
                      placeholder="Inserisci codice invito"
                      className="flex-1 bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl px-3 py-2 text-sm text-[var(--text)] placeholder-gray-700 outline-none focus:border-blue-500/50 font-mono"
                    />
                    <button type="submit" disabled={isJoining || !joinCodeInput.trim()}
                      className="px-4 py-2 bg-blue-600/80 hover:bg-blue-600 rounded-xl text-xs font-bold text-[var(--text)] transition-colors disabled:opacity-40 active:scale-95">
                      {isJoining ? <Loader2 size={14} className="animate-spin" /> : 'Entra'}
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
          onClick={() => setShippingProduct(null)}>
          <div className="bg-[var(--surface)] border border-[var(--border-2)] w-full sm:max-w-lg rounded-t-3xl sm:rounded-3xl max-h-[92vh] overflow-y-auto animate-slide-up"
            onClick={e => e.stopPropagation()}>

            {/* Header */}
            <div className="sticky top-0 bg-[var(--surface-blur)] backdrop-blur-xl border-b border-[var(--border)] p-5 flex items-center justify-between z-10">
              <div>
                <h2 className="font-semibold flex items-center gap-2"><Package size={16} className="text-violet-400" /> Spedizione</h2>
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
                  <p className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-wider mb-2">Mittente (tu)</p>
                  <div className="grid grid-cols-2 gap-2">
                    {[
                      { key: 'name',    label: 'Nome',     placeholder: 'Mario Rossi',   span: 2 },
                      { key: 'address', label: 'Indirizzo',placeholder: 'Via Roma 1',    span: 2 },
                      { key: 'city',    label: 'Città',    placeholder: 'Milano',        span: 1 },
                      { key: 'zip',     label: 'CAP',      placeholder: '20100',         span: 1 },
                      { key: 'phone',   label: 'Telefono', placeholder: '+393331234567', span: 2 },
                    ].map(f => (
                      <div key={f.key} className={f.span === 2 ? 'col-span-2' : ''}>
                        <label className="text-[10px] text-[var(--text-faint)] block mb-1">{f.label}</label>
                        <input
                          value={shipFrom[f.key] || ''}
                          onChange={e => setShipFrom((p: any) => ({ ...p, [f.key]: e.target.value }))}
                          placeholder={f.placeholder}
                          className="w-full bg-[#111] border border-[var(--border-2)] rounded-xl px-3 py-2 text-sm text-[var(--text)] placeholder-gray-700 outline-none focus:border-violet-500/50"
                        />
                      </div>
                    ))}
                  </div>
                </div>

                {/* Destinatario */}
                <div>
                  <p className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-wider mb-2">Destinatario</p>
                  <div className="grid grid-cols-2 gap-2">
                    {[
                      { key: 'name',    label: 'Nome',     placeholder: 'Luca Bianchi',  span: 2 },
                      { key: 'address', label: 'Indirizzo',placeholder: 'Via Milano 5',  span: 2 },
                      { key: 'city',    label: 'Città',    placeholder: 'Roma',          span: 1 },
                      { key: 'zip',     label: 'CAP',      placeholder: '00100',         span: 1 },
                      { key: 'phone',   label: 'Telefono', placeholder: '+393339876543', span: 2 },
                    ].map(f => (
                      <div key={f.key} className={f.span === 2 ? 'col-span-2' : ''}>
                        <label className="text-[10px] text-[var(--text-faint)] block mb-1">{f.label}</label>
                        <input
                          value={shipTo[f.key as keyof typeof shipTo] || ''}
                          onChange={e => setShipTo(p => ({ ...p, [f.key]: e.target.value }))}
                          placeholder={f.placeholder}
                          className="w-full bg-[#111] border border-[var(--border-2)] rounded-xl px-3 py-2 text-sm text-[var(--text)] placeholder-gray-700 outline-none focus:border-violet-500/50"
                        />
                      </div>
                    ))}
                  </div>
                </div>

                {/* Pacco preset */}
                <div>
                  <p className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-wider mb-2">Dimensioni pacco</p>
                  <div className="grid grid-cols-4 gap-2">
                    {SHIPPING_PRESETS.map(p => (
                      <button key={p.label} onClick={() => setShipPreset(p)}
                        className={`p-2.5 rounded-xl border text-center transition-all ${
                          shipPreset.label === p.label
                            ? 'bg-violet-500/15 border-violet-500/40 text-[var(--text)]'
                            : 'bg-[#111] border-[var(--border)] text-[var(--text-soft)] hover:border-[var(--border-3)]'
                        }`}>
                        <p className="text-xs font-bold">{p.label}</p>
                        <p className="text-[9px] text-[var(--text-faint)] mt-0.5">{p.weight}kg</p>
                      </button>
                    ))}
                  </div>
                  <p className="text-[10px] text-gray-700 mt-1.5">{shipPreset.length}×{shipPreset.width}×{shipPreset.height} cm · {shipPreset.weight} kg</p>
                </div>

                <button onClick={fetchRates} disabled={isLoadingRates}
                  className="w-full py-3.5 bg-violet-600/80 hover:bg-violet-600 disabled:opacity-40 rounded-2xl text-sm font-bold text-[var(--text)] transition-colors flex items-center justify-center gap-2 active:scale-[0.98]">
                  {isLoadingRates ? <><Loader2 size={15} className="animate-spin" /> Cerco tariffe…</> : <><Package size={15} /> Vedi tariffe corrieri</>}
                </button>
              </>)}

              {/* STEP: RATES */}
              {shippingStep === 'rates' && (<>
                <button onClick={() => setShippingStep('form')} className="text-xs text-[var(--text-soft)] hover:text-[var(--text)] flex items-center gap-1 transition-colors">
                  ← Modifica dati
                </button>
                <div className="space-y-2">
                  {shippingRates.map(r => (
                    <button key={r.id} onClick={() => setSelectedRate(r)}
                      className={`w-full flex items-center justify-between p-3.5 rounded-xl border transition-all text-left ${
                        selectedRate?.id === r.id
                          ? 'bg-violet-500/10 border-violet-500/40'
                          : 'bg-[#111] border-[var(--border)] hover:border-[var(--border-3)]'
                      }`}>
                      <div>
                        <p className="font-bold text-sm text-[var(--text)]">{r.carrier}</p>
                        <p className="text-[11px] text-[var(--text-soft)]">{r.name}{r.transitHours ? ` · ${r.transitHours}h` : ''}</p>
                      </div>
                      <p className={`font-bold text-base num ${selectedRate?.id === r.id ? 'text-violet-400' : 'text-[var(--text)]'}`}>
                        {r.price.toFixed(2)}€
                      </p>
                    </button>
                  ))}
                </div>
                {selectedRate && (
                  <button onClick={bookShipment} disabled={isBooking}
                    className="w-full py-3.5 bg-violet-600/80 hover:bg-violet-600 disabled:opacity-40 rounded-2xl text-sm font-bold text-[var(--text)] transition-colors flex items-center justify-center gap-2 active:scale-[0.98]">
                    {isBooking
                      ? <><Loader2 size={15} className="animate-spin" /> Generazione…</>
                      : selectedRate.demo
                        ? <><Download size={15} /> Genera etichetta demo · {selectedRate.price.toFixed(2)}€</>
                        : <><Download size={15} /> Prenota e scarica etichetta · {selectedRate.price.toFixed(2)}€</>}
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
                    <p className="font-bold text-[var(--text)]">{shippingRef?.startsWith('HQ-DEMO') ? 'Etichetta demo generata!' : 'Spedizione prenotata!'}</p>
                    {shippingRef && <p className="text-xs text-[var(--text-soft)] mt-1 font-mono">{shippingRef}</p>}
                    <p className="text-xs text-[var(--text-faint)] mt-2">
                      {shippingRef?.startsWith('HQ-DEMO')
                        ? 'Modalità demo — etichetta aperta per la stampa. Aggiungi le credenziali Sendcloud per spedizioni reali.'
                        : 'Il tracking è stato salvato automaticamente sul prodotto.'}
                    </p>
                  </div>
                  {shippingLabel
                    ? <a href={shippingLabel} target="_blank" rel="noopener noreferrer"
                        className="flex items-center justify-center gap-2 w-full py-3 bg-white hover:bg-gray-100 rounded-2xl text-sm font-bold text-black transition-colors">
                        <Download size={15} /> Scarica etichetta PDF
                      </a>
                    : <p className="text-xs text-[var(--text-soft)]">L'etichetta sarà disponibile sul sito Packlink.</p>
                  }
                  <button onClick={() => setShippingProduct(null)}
                    className="w-full py-2.5 bg-[var(--fill)] hover:bg-[var(--fill-2)] rounded-2xl text-sm text-[var(--text-muted)] hover:text-[var(--text)] transition-colors">
                    Chiudi
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
          onClick={() => { setListingModalProduct(null); setListingResult(null); }}>
          <div className="bg-[var(--surface)] border border-[var(--border-2)] w-full sm:max-w-lg rounded-t-3xl sm:rounded-3xl max-h-[92vh] overflow-y-auto animate-slide-up"
            onClick={e => e.stopPropagation()}>

            {/* Header */}
            <div className="sticky top-0 bg-[var(--surface-blur)] backdrop-blur-xl border-b border-[var(--border)] p-5 flex items-center justify-between z-10">
              <div>
                <h2 className="font-semibold">Genera Annuncio</h2>
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
                <p className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-wider mb-3">Scegli la piattaforma</p>
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
                          ? 'bg-violet-500/15 border-violet-500/40 text-[var(--text)]'
                          : 'bg-[#111] border-[var(--border)] text-[var(--text-soft)] hover:border-[var(--border-3)] hover:text-gray-300'
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
                className="w-full py-3.5 bg-violet-600/80 hover:bg-violet-600 disabled:bg-violet-600/30 rounded-2xl text-sm font-bold text-[var(--text)] transition-colors flex items-center justify-center gap-2 active:scale-[0.98]">
                {isGeneratingListing
                  ? <><Loader2 size={16} className="animate-spin" /> Generazione in corso…</>
                  : <><Sparkles size={16} /> Genera con IA</>}
              </button>

              {/* Risultato */}
              {listingResult && (
                <div className="space-y-3">

                  {/* Titolo */}
                  <div className="bg-[var(--surface-2)] border border-[var(--border-2)] rounded-2xl p-4">
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-wider">Titolo</p>
                      <button onClick={() => copyToClipboard(listingResult.title, 'title')}
                        className={`flex items-center gap-1 text-[10px] font-bold px-2.5 py-1 rounded-lg transition-all ${
                          copiedField === 'title' ? 'bg-green-500/20 text-green-400' : 'bg-[var(--fill)] text-[var(--text-muted)] hover:text-[var(--text)]'
                        }`}>
                        <Copy size={11} /> {copiedField === 'title' ? 'Copiato!' : 'Copia'}
                      </button>
                    </div>
                    <p className="text-sm font-semibold text-[var(--text)] leading-snug">{listingResult.title}</p>
                    <p className="text-[10px] text-gray-700 mt-1">{listingResult.title.length}/80 caratteri</p>
                  </div>

                  {/* Descrizione */}
                  <div className="bg-[var(--surface-2)] border border-[var(--border-2)] rounded-2xl p-4">
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-wider">Descrizione</p>
                      <button onClick={() => copyToClipboard(listingResult.description, 'desc')}
                        className={`flex items-center gap-1 text-[10px] font-bold px-2.5 py-1 rounded-lg transition-all ${
                          copiedField === 'desc' ? 'bg-green-500/20 text-green-400' : 'bg-[var(--fill)] text-[var(--text-muted)] hover:text-[var(--text)]'
                        }`}>
                        <Copy size={11} /> {copiedField === 'desc' ? 'Copiato!' : 'Copia'}
                      </button>
                    </div>
                    <p className="text-sm text-gray-300 leading-relaxed whitespace-pre-line">{listingResult.description}</p>
                  </div>

                  {/* Hashtag (se presenti) */}
                  {listingResult.hashtags?.length > 0 && (
                    <div className="bg-[var(--surface-2)] border border-[var(--border-2)] rounded-2xl p-4">
                      <div className="flex items-center justify-between mb-2">
                        <p className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-wider">Hashtag</p>
                        <button onClick={() => copyToClipboard(listingResult.hashtags.join(' '), 'tags')}
                          className={`flex items-center gap-1 text-[10px] font-bold px-2.5 py-1 rounded-lg transition-all ${
                            copiedField === 'tags' ? 'bg-green-500/20 text-green-400' : 'bg-[var(--fill)] text-[var(--text-muted)] hover:text-[var(--text)]'
                          }`}>
                          <Copy size={11} /> {copiedField === 'tags' ? 'Copiato!' : 'Copia'}
                        </button>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {listingResult.hashtags.map((tag: string) => (
                          <span key={tag} className="text-[11px] bg-violet-500/10 text-violet-400 border border-violet-500/20 px-2 py-0.5 rounded-full">{tag}</span>
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
                      <Store size={15} /> Apri {(['vinted','ebay','depop','wallapop','subito'].find(p => p === listingResult.platform) || '').charAt(0).toUpperCase() + (listingResult.platform || '').slice(1)} →
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
                        : 'bg-violet-600/70 hover:bg-violet-600 text-[var(--text)]'
                    }`}>
                    {copiedField === 'all' ? '✓ Tutto copiato!' : 'Copia tutto'}
                  </button>
                </div>
              )}
            </div>
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
