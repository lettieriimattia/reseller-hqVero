import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import * as XLSX from 'xlsx';
import { DynamicForm } from './components/DynamicForm';
import {
  Package, BarChart3, Plus, TrendingUp, Wallet, CheckCircle, Search, LayoutDashboard,
  PieChart as PieChartIcon, Loader2, Layers, DollarSign, Store, X, Edit, Settings,
  Users, Camera, UserPlus, Bell, Shield, Sparkles, AlertTriangle, TrendingDown,
  KeyRound, Copy, LogOut, Eye, EyeOff, Trophy, Trash2, Download, ArrowUpDown, Lock, Truck, StickyNote, ChevronDown, Mail
} from 'lucide-react';
import { XAxis, YAxis, Tooltip, ResponsiveContainer, AreaChart, Area } from 'recharts';

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
function StatCard({ title, value, sub, icon, color = 'text-white', onClick }: any) {
  return (
    <div
      onClick={onClick}
      className={`bg-[#0f0f0f] border border-white/[0.05] p-5 rounded-2xl transition-colors ${
        onClick ? 'cursor-pointer hover:border-white/[0.1]' : ''
      }`}
    >
      <div className="flex justify-between items-start mb-4">
        <span className="text-[9px] font-semibold text-gray-500 tracking-[0.12em] uppercase">{title}</span>
        {icon}
      </div>
      <p className={`text-2xl font-semibold num ${color}`}>{value}</p>
      <p className="text-[11px] text-gray-600 mt-1.5">{sub}</p>
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
  
  // ----- UI STATE -----
  const [currentView, setCurrentView] = useState<'dashboard' | 'magazzino' | 'analytics' | 'tracking' | 'settings'>('dashboard');
  const [magazzinoView, setMagazzinoView] = useState<'instock' | 'sold'>('instock');
  const [searchTerm, setSearchTerm] = useState('');
  const [filterCat, setFilterCat] = useState('all');
  const [chartTimeframe, setChartTimeframe] = useState<'1D' | '1W' | '1M' | '1Y' | 'MAX'>('MAX');
  
  // ----- FORM PRODOTTO -----
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  
  const [category, setCategory] = useState('');
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
  const [priceEstimate, setPriceEstimate] = useState<any>(null); // rimasto per compatibilità reset, non più usato in UI
  const [authResult, setAuthResult] = useState<any>(null);
  
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
  
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [productToEdit, setProductToEdit] = useState<any>(null);
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
  const [toast, setToast] = useState<{ msg: string; type: 'ok' | 'err' | 'warn' } | null>(null);
  const toastRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = useCallback((msg: string, type: 'ok' | 'err' | 'warn' = 'ok') => {
    if (toastRef.current) clearTimeout(toastRef.current);
    setToast({ msg, type });
    toastRef.current = setTimeout(() => setToast(null), 3200);
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

  // ----- ENTRA IN MAGAZZINO -----
  const [joinCodeInput, setJoinCodeInput] = useState('');
  const [isJoining, setIsJoining] = useState(false);

  // ----- ELIMINA ACCOUNT -----
  const [deleteAccountStep, setDeleteAccountStep] = useState(0); // 0=chiuso, 1=warning, 2=email, 3=password, 4=finale
  const [deleteEmailConfirm, setDeleteEmailConfirm] = useState('');
  const [deletePasswordConfirm, setDeletePasswordConfirm] = useState('');
  const [deleteCheckbox, setDeleteCheckbox] = useState(false);
  const [isDeletingAccount, setIsDeletingAccount] = useState(false);

  // ----- ADMIN -----
  const [adminUsers, setAdminUsers] = useState<any[]>([]);
  const [adminLoading, setAdminLoading] = useState(false);
  const [adminLoaded, setAdminLoaded] = useState(false);
  const [adminPanelOpen, setAdminPanelOpen] = useState(false);
  const adminRefreshRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const ADMIN_EMAIL = 'noreply.hq.app@gmail.com';

  const fetchAdminUsers = async () => {
    setAdminLoading(true);
    const { ok, data } = await apiCall('/admin/users');
    if (ok) { setAdminUsers(data.users || []); setAdminLoaded(true); }
    else showToast(data?.error || 'Errore caricamento utenti admin', 'err');
    setAdminLoading(false);
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

  const toggleAdminPanel = async () => {
    if (!adminPanelOpen) {
      setAdminPanelOpen(true);
      if (!adminLoaded) await fetchAdminUsers();
      // Auto-refresh ogni 5 minuti quando il pannello è aperto
      adminRefreshRef.current = setInterval(fetchAdminUsers, 5 * 60 * 1000);
    } else {
      setAdminPanelOpen(false);
      if (adminRefreshRef.current) { clearInterval(adminRefreshRef.current); adminRefreshRef.current = null; }
    }
  };

  const exportAdminExcel = () => {
    if (!adminUsers.length) return;
    const rows = adminUsers.map(u => ({
      'Nome': u.name,
      'Email': u.email,
      'Registrato il': new Date(u.createdAt).toLocaleDateString('it-IT'),
      'Ultimo accesso': u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleDateString('it-IT') : '—',
      '2FA': u.twoFactorEnabled ? 'Sì' : 'No',
      'Reparti': u.warehouses.map((w: any) => `${w.name}(${w.role})`).join(', '),
      'Prodotti Totali': u.stats.totalProducts,
      'In Stock': u.stats.inStock,
      'Venduti': u.stats.sold,
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Utenti');
    XLSX.writeFile(wb, `HQ_Utenti_${new Date().toISOString().slice(0,10)}.xlsx`);
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
  
  // ----- DERIVED -----
  const userCategories = user?.warehouses?.map(w => w.name.replace('Magazzino ', '')) || [];
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
    
    // Polling notifiche ogni 30 secondi
    const interval = setInterval(fetchNotifications, 30000);
    // Controllo prodotti fermi ogni ora
    const staleInterval = setInterval(checkStaleProducts, 60 * 60 * 1000);
    return () => { clearInterval(interval); clearInterval(staleInterval); };
  }, [isAuthenticated, fetchProducts, fetchTeam, fetchNotifications, checkStaleProducts]);
  
  useEffect(() => {
    if (userCategories.length > 0 && category === '') setCategory(userCategories[0]);
    if (category === 'Scarpe') setSize('42');
    else if (category === 'Vestiti') setSize('M');
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
  
  const getCategoryIcon = (cat: any) => {
    switch (cat?.toLowerCase()) {
      case 'scarpe': return '👟';
      case 'vestiti': return '👕';
      case 'orologi': return '⌚';
      case 'pokemon': return '🃏';
      default: {
        // Cerca emoji dal config AI del warehouse
        const config = getCategoryConfig(cat);
        if (config?.emoji) return config.emoji;
        return '📦';
      }
    }
  };
  
  const shoeSizes = Array.from({ length: 25 }, (_, i) => (36 + i * 0.5).toString());
  const clothingSizes = ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL'];
  
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
  }, [searchedProducts, filterCondition, filterPriceMin, filterPriceMax, sortField, sortDir]);

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
      setUser(data.user);  // contiene già aiConfig con emoji
      setNewCatName('');
      fetchTeam();
      const config = data.user?.warehouses?.find((w: any) => w.name.includes(newCatName));
      const emoji = config?.aiConfig ? (() => { try { return JSON.parse(config.aiConfig).emoji; } catch { return ''; } })() : '';
      showToast(`${emoji} Reparto "${newCatName}" aggiunto!`);
    } else showToast(data.error || 'Errore', 'err');
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
  const applyAIScanResult = (data: any, cat: string) => {
    setScanResult(data.scan);
    setPriceEstimate(data.price);
    setAuthResult(data.authenticity);
    if (data.scan?.confidence !== 'LOW') {
      if (cat === 'Pokemon' && data.scan?.model) { setPokeName(data.scan.model); }
      else if (cat === 'Scarpe' && data.scan?.brand && data.scan?.model) { setBrand(data.scan.brand); setName(data.scan.model); }
      else if (cat === 'Vestiti' && data.scan?.brand && data.scan?.model) { setBrand(data.scan.brand); setName(data.scan.model); }
      else if (cat === 'Orologi' && data.scan?.brand && data.scan?.model) {
        setWatchBrand(data.scan.brand); setWatchModel(data.scan.model);
        if (data.scan.details?.caseSize) setWatchCase(data.scan.details.caseSize.toString());
        if (data.scan.details?.material) setWatchMaterial(data.scan.details.material);
      }
    }
  };

  const runAIScan = async (imageBase64: string, cat: string) => {
    setIsScanning(true);
    setScanResult(null); setPriceEstimate(null); setAuthResult(null);
    try {
      const { ok, data } = await apiCall('/api/ai/full-scan', {
        method: 'POST',
        body: JSON.stringify({ imageBase64, category: cat }),
      });
      if (ok) applyAIScanResult(data, cat);
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
        setAuthResult(null);
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
      setAuthResult(null);
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
    if (!category) { showToast('Seleziona un reparto', 'err'); setIsSaving(false); return; }
    if (isNaN(unitPrice) || unitPrice <= 0) { showToast('Inserisci un prezzo valido', 'err'); setIsSaving(false); return; }

    if (category === 'Pokemon') {
      if (!pokeName) { showToast('Inserisci il nome della carta', 'err'); setIsSaving(false); return; }
      finalBrand = 'Pokémon'; finalName = pokeName; finalSize = 'Unisize';
      finalCondition = pokeGraded === 'Si' ? `Gradata ${pokeGrade}` : 'Raw (Non Gradata)';
    } else if (category === 'Orologi') {
      if (!watchBrand || !watchModel) { showToast('Compila brand e modello orologio', 'err'); setIsSaving(false); return; }
      finalBrand = watchBrand; finalName = watchModel;
      finalSize = watchCase ? `${watchCase}mm${watchStrap ? ', ' + watchStrap : ''}` : (watchStrap || '-');
      finalCondition = watchMaterial ? `${condition} (${watchMaterial})` : condition;
    } else {
      if (!brand || !name) { showToast('Compila brand e nome prodotto', 'err'); setIsSaving(false); return; }
      // Per categorie custom, arricchisci il nome con materiale/colore se compilati
      if (category !== 'Scarpe' && category !== 'Vestiti') {
        const extras = [watchMaterial, watchStrap].filter(Boolean);
        if (extras.length > 0) finalName = `${name} — ${extras.join(', ')}`;
      }
    }
    
    // Snapshot delle percentuali attuali del team: rende ogni prodotto indipendente
    // dalle future modifiche alle quote nelle impostazioni
    const currentTeam = teamData.find(t => t.warehouseName.replace('Magazzino ', '') === category);
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
            category, brand: finalBrand, name: finalName,
            size: finalSize, condition: finalCondition, price: unitPrice,
            customShares: finalShares,
            photos: productPhotos.length > 0 ? productPhotos : undefined,
            authenticityScore: authResult?.score,
            attributes: Object.keys(dynamicAttrs).length > 0 ? dynamicAttrs : undefined,
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
      setScanResult(null); setPriceEstimate(null); setAuthResult(null);
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
    if (hasError) showToast('Errore nella vendita', 'err');
    else {
      await fetchProducts();
      setSellModalOpen(false);
      setProductToSell(null);
      showToast('Vendita registrata!');
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
    setEditModalOpen(true);
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
    errors > 0 ? showToast(`Eliminati con ${errors} errori`, 'warn') : showToast(`${ids.length} prodotti eliminati`);
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
    errors > 0 ? showToast(`Vendite con ${errors} errori`, 'warn') : showToast(`${ids.length} prodotti venduti!`);
  };

  // ==========================================
  // IMPORT EXCEL
  // ==========================================
  const handleExcelFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const data = await file.arrayBuffer();
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

  const downloadImportTemplate = () => {
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
    // Ottimisticamente rimuovi dalla UI prima della chiamata API
    setProducts(prev => prev.filter(p => !productToDelete.ids.includes(p.id)));
    setDeleteConfirmOpen(false);
    setProductToDelete(null);
    setEditModalOpen(false);

    const results = await Promise.allSettled(
      productToDelete.ids.map(id => apiCall(`/products/${id}`, { method: 'DELETE' }))
    );
    const errors = results.filter(r => r.status === 'rejected' || (r.status === 'fulfilled' && !r.value.ok)).length;

    if (errors > 0) {
      showToast('Errore eliminazione — ricarico la lista', 'err');
      await fetchProducts(); // Re-sync se ci sono stati errori
    } else {
      showToast('Prodotto eliminato');
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
    const { ok, data } = await apiCall(`/tracking/${trackingProduct.ids[0]}`, {
      method: 'POST',
      body: JSON.stringify({ trackingCode: trackingInput.trim(), carrier: trackingCarrierSel }),
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
      <div className="min-h-screen bg-[#0a0a0a] flex flex-col items-center justify-center gap-6">
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
      <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center p-4 font-sans">
        <div className="bg-[#0f0f0f] border border-white/[0.05] p-8 rounded-3xl w-full max-w-md">
          {/* Logo HQ centrato */}
          <div className="flex justify-center mb-6">
            <div className="relative w-14 h-16">
              <span className="absolute top-0 left-0 text-[3rem] font-black leading-none text-white">H</span>
              <span className="absolute bottom-0 right-0 text-[3rem] font-black leading-none text-white/40">Q</span>
            </div>
          </div>
          <p className="text-center text-gray-500 text-sm mb-8">
            {authMode === 'login' ? 'Accedi al tuo account' : 'Crea il tuo account'}
          </p>
          
          <form onSubmit={handleAuth} className="space-y-4">
            {require2FA ? (
              <div className="bg-blue-500/10 border border-blue-500/30 p-5 rounded-2xl">
                <div className="flex items-center gap-2 mb-3">
                  <Shield className="text-blue-500" size={20} />
                  <h3 className="text-white font-bold">Verifica 2FA</h3>
                </div>
                <p className="text-xs text-gray-400 mb-4">
                  Inserisci il codice a 6 cifre dalla tua app authenticator (o un codice di backup).
                </p>
                <input 
                  type="text" autoFocus inputMode="numeric" required
                  value={twoFactorCode} onChange={e => setTwoFactorCode(e.target.value)}
                  className="w-full bg-[#0a0a0a] border border-white/[0.07] rounded-xl p-3 text-white outline-none focus:border-blue-500 font-mono text-center text-2xl tracking-widest"
                  placeholder="000000" maxLength={8}
                />
              </div>
            ) : (
              <>
                {authMode === 'register' && (
                  <>
                    <div className="flex bg-[#0a0a0a] p-1 rounded-xl border border-white/[0.07] mb-6">
                      <button type="button" onClick={() => setRegType('new_team')}
                        className={`flex-1 py-2 text-xs font-bold rounded-lg transition-colors ${
                          regType === 'new_team' ? 'bg-[#ff4d00] text-white' : 'text-gray-500'
                        }`}>Fonda un'Azienda</button>
                      <button type="button" onClick={() => setRegType('join_team')}
                        className={`flex-1 py-2 text-xs font-bold rounded-lg transition-colors ${
                          regType === 'join_team' ? 'bg-blue-600 text-white' : 'text-gray-500'
                        }`}>Entra in un Team</button>
                    </div>
                    
                    <div>
                      <label className="text-xs font-bold text-gray-500 uppercase tracking-widest block mb-2">Il tuo Nome</label>
                      <input type="text" required value={authName} onChange={e => setAuthName(e.target.value)}
                        className="w-full bg-[#0a0a0a] border border-white/[0.07] rounded-xl p-3 text-white focus:border-[#ff4d00] outline-none"
                        placeholder="Es. Mario Rossi" />
                    </div>
                    
                    {regType === 'new_team' && (
                      <div className="mt-6 mb-4 border-t border-white/[0.07] pt-6">
                        <h3 className="text-lg font-bold text-white flex items-center gap-2 mb-1">
                          <Layers className="text-white" size={18} /> I tuoi Reparti
                        </h3>
                        <p className="text-xs text-gray-500 mb-4">Seleziona cosa venderà la tua nuova azienda.</p>
                        <div className="grid grid-cols-2 gap-3">
                          {availableCategories.map(cat => (
                            <button key={cat.id} type="button" onClick={() => {
                              regCategories.includes(cat.id)
                                ? setRegCategories(regCategories.filter(c => c !== cat.id))
                                : setRegCategories([...regCategories, cat.id]);
                            }}
                              className={`p-4 rounded-xl border flex flex-col items-center justify-center gap-2 transition-all ${
                                regCategories.includes(cat.id)
                                  ? 'bg-[#ff4d00]/10 border-[#ff4d00] text-white shadow-[0_0_15px_rgba(255,77,0,0.2)]'
                                  : 'bg-[#0a0a0a] border-white/[0.07] text-gray-500 hover:border-gray-600 hover:text-gray-300'
                              }`}>
                              <span className="text-2xl">{cat.icon}</span>
                              <span className="text-sm font-bold">{cat.label}</span>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                    
                    {regType === 'join_team' && (
                      <div className="mt-6 mb-4 border-t border-white/[0.07] pt-6">
                        <h3 className="text-lg font-bold text-white flex items-center gap-2 mb-1">
                          <UserPlus className="text-blue-500" size={18} /> Codice Invito
                        </h3>
                        <p className="text-xs text-gray-500 mb-4">Inserisci il codice fornito dal tuo socio.</p>
                        <input type="text" required value={joinCode}
                          onChange={e => setJoinCode(e.target.value.toUpperCase())}
                          className="w-full bg-[#0a0a0a] border border-blue-500/50 rounded-xl p-3 text-white outline-none font-mono"
                          placeholder="INV-XXXXXXXX" />
                      </div>
                    )}
                  </>
                )}
                
                <div className="pt-2">
                  <label className="text-xs font-bold text-gray-500 uppercase tracking-widest block mb-2">Email</label>
                  <input type="email" required value={authEmail}
                    onChange={e => setAuthEmail(e.target.value)}
                    className="w-full bg-[#0a0a0a] border border-white/[0.07] rounded-xl p-3 text-white focus:border-[#ff4d00] outline-none"
                    placeholder="mario@email.com" />
                </div>
                
                <div>
                  <label className="text-xs font-bold text-gray-500 uppercase tracking-widest block mb-2">Password</label>
                  <div className="relative">
                    <input type={showPassword ? 'text' : 'password'} required value={authPassword}
                      onChange={e => setAuthPassword(e.target.value)}
                      className="w-full bg-[#0a0a0a] border border-white/[0.07] rounded-xl p-3 pr-12 text-white focus:border-[#ff4d00] outline-none"
                      placeholder="••••••••" />
                    <button type="button" onClick={() => setShowPassword(s => !s)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-white">
                      {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                    </button>
                  </div>
                  {authMode === 'register' && (
                    <p className="text-[10px] text-gray-500 mt-2">
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
                  <span className="text-[12px] text-gray-500 leading-relaxed">
                    Ho letto e accetto la{' '}
                    <button type="button" onClick={() => setPrivacyOpen(true)} className="text-white underline underline-offset-2 hover:no-underline">
                      Privacy Policy
                    </button>
                    {' '}e il trattamento dei dati personali ai sensi del Regolamento UE 2016/679 (GDPR).{' '}
                    <span className="text-gray-600">Obbligatorio</span>
                  </span>
                </label>
                <label className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={marketingConsent}
                    onChange={e => setMarketingConsent(e.target.checked)}
                    className="mt-0.5 shrink-0 accent-white w-4 h-4 rounded"
                  />
                  <span className="text-[12px] text-gray-500 leading-relaxed">
                    Acconsento a ricevere comunicazioni via email relative ad aggiornamenti del servizio, nuove funzionalità e novità di HQ. Il consenso è revocabile in qualsiasi momento dalle impostazioni del profilo.{' '}
                    <span className="text-gray-600">Facoltativo</span>
                  </span>
                </label>
              </div>
            )}

            <button type="submit" disabled={authLoading}
              className="w-full bg-[#ff4d00] hover:bg-[#ff6a2a] py-3 rounded-xl text-white font-bold transition-all disabled:opacity-50 mt-4 flex items-center justify-center">
              {authLoading ? <Loader2 className="animate-spin" size={20} /> :
                require2FA ? 'Verifica 2FA' : (authMode === 'login' ? 'Entra' : 'Registrati')}
            </button>
          </form>
          
          <div className="mt-6 text-center">
            <button type="button" 
              onClick={() => { setAuthMode(authMode === 'login' ? 'register' : 'login'); setAuthError(null); }}
              className="text-gray-500 hover:text-white text-sm transition-colors font-bold">
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
  // -------- VERDICT BADGE (per legit check) --------
  const verdictBadge = (verdict?: string, score?: number) => {
    if (!verdict) return null;
    const config: Record<string, { bg: string; text: string; label: string; icon: any }> = {
      LIKELY_AUTHENTIC: { bg: 'bg-green-500/10 border-green-500/40', text: 'text-green-400', label: 'Probabile Originale', icon: CheckCircle },
      SUSPICIOUS: { bg: 'bg-red-500/10 border-red-500/40', text: 'text-red-400', label: 'Sospetto', icon: AlertTriangle },
      NEEDS_VERIFICATION: { bg: 'bg-yellow-500/10 border-yellow-500/40', text: 'text-yellow-400', label: 'Da Verificare', icon: AlertTriangle },
    };
    const c = config[verdict] || config.NEEDS_VERIFICATION;
    const Icon = c.icon;
    return (
      <div className={`${c.bg} border rounded-xl p-3 flex items-center gap-3`}>
        <Icon className={c.text} size={20} />
        <div className="flex-1">
          <p className={`text-sm font-bold ${c.text}`}>{c.label}</p>
          {score !== undefined && <p className="text-xs text-gray-400">Score: {score}/100</p>}
        </div>
      </div>
    );
  };
  
  return (
    <div className="min-h-screen bg-[#080808] text-white" style={{ fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'SF Pro Text', 'Helvetica Neue', system-ui, sans-serif", paddingBottom: 'calc(5rem + env(safe-area-inset-bottom))' }}>

      {/* ========== HEADER ========== */}
      <header className="sticky top-0 z-40 bg-[#080808]/95 backdrop-blur-xl border-b border-white/[0.05]"
        style={{ paddingTop: 'env(safe-area-inset-top)' }}>
        <div className="w-full px-4 lg:px-8 py-3.5 flex justify-between items-center">
          <div className="flex items-center">
            {/* Staggered HQ logo */}
            <div className="relative w-[1.6rem] h-[1.7rem] shrink-0 mr-2">
              <span className="absolute top-0 left-0 text-[1.15rem] font-black leading-none text-white">H</span>
              <span className="absolute bottom-0 right-[-2px] text-[1.15rem] font-black leading-none text-white/50">Q</span>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            {/* Pulsante Aggiungi (solo desktop) */}
            <button onClick={() => setIsFormOpen(true)}
              className="hidden lg:flex items-center gap-2 bg-[#ff4d00] hover:bg-[#e84400] px-4 py-2 rounded-xl text-sm font-semibold transition-colors active:scale-95">
              <Plus size={15} /> Aggiungi
            </button>

            {/* Notifiche */}
            <div className="relative">
              <button onClick={() => setNotifPanelOpen(!notifPanelOpen)}
                className="relative p-2 rounded-xl hover:bg-white/[0.05] transition-colors">
                <Bell size={18} className="text-gray-400" />
                {unreadCount > 0 && (
                  <span className="absolute -top-0.5 -right-0.5 bg-[#ff4d00] text-white text-[9px] font-bold rounded-full w-4 h-4 flex items-center justify-center">
                    {unreadCount > 9 ? '9+' : unreadCount}
                  </span>
                )}
              </button>

              {notifPanelOpen && (
                <div className="absolute right-0 top-12 w-80 sm:w-96 bg-[#0f0f0f] border border-white/[0.07] rounded-2xl shadow-xl overflow-hidden z-50">
                  <div className="p-4 border-b border-white/[0.05] flex justify-between items-center">
                    <h3 className="font-semibold text-sm">Notifiche</h3>
                    {unreadCount > 0 && (
                      <button onClick={markAllNotificationsRead}
                        className="text-xs text-gray-500 hover:text-gray-300 transition-colors">
                        Segna tutto letto
                      </button>
                    )}
                  </div>
                  <div className="max-h-96 overflow-y-auto">
                    {notifications.length === 0 ? (
                      <p className="p-8 text-center text-gray-500 text-sm">Nessuna notifica</p>
                    ) : (
                      notifications.map((n: any) => (
                        <button key={n.id} onClick={() => markNotificationRead(n.id)}
                          className={`w-full text-left p-3.5 border-b border-white/[0.04] hover:bg-white/[0.02] transition-colors ${
                            !n.read ? 'bg-white/[0.02]' : ''
                          }`}>
                          <div className="flex items-start gap-3">
                            {!n.read && <div className="w-1.5 h-1.5 rounded-full bg-[#ff4d00] mt-1.5 shrink-0" />}
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-semibold text-white truncate">{n.title}</p>
                              <p className="text-xs text-gray-500 mt-0.5">{n.message}</p>
                              <p className="text-[10px] text-gray-600 mt-1">
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

            <button onClick={() => navigateTo('settings')}
              className="p-2 rounded-xl hover:bg-white/[0.05] transition-colors hidden sm:block">
              <Settings size={18} className="text-gray-400" />
            </button>

            <button onClick={handleLogout} title="Esci"
              className="p-2 rounded-xl hover:bg-white/[0.05] transition-colors">
              <LogOut size={18} className="text-gray-400" />
            </button>
            
          </div>
        </div>
        
        {/* Tabs */}
        <nav className="border-t border-white/[0.05] hidden lg:block">
          <div className="w-full px-8">
            <div className="flex gap-0">
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
                    className={`relative flex items-center gap-2 px-4 py-3.5 text-xs font-semibold tracking-wide transition-colors ${
                      active ? 'text-white' : 'text-gray-500 hover:text-gray-300'
                    }`}>
                    {active && (
                      <span className="absolute bottom-0 left-1/2 -translate-x-1/2 w-8 h-0.5 bg-[#ff4d00] rounded-full" />
                    )}
                    <Icon size={14} /> {tab.label}
                    {trackingBadge > 0 && (
                      <span className="w-4 h-4 bg-blue-500 text-white rounded-full text-[9px] font-semibold flex items-center justify-center">
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
      
      <main key={currentView} className="w-full px-4 lg:px-6 py-5 lg:py-8 pb-28 lg:pb-8 animate-fade-in">

        {/* ========== DASHBOARD ========== */}
        {currentView === 'dashboard' && (
          <div className="space-y-5">

            {/* Greeting */}
            <div className="flex items-end justify-between">
              <div>
                <p className="text-[11px] text-gray-600 font-semibold uppercase tracking-[0.1em]">{new Date().toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' })}</p>
                <h2 className="text-3xl font-bold mt-1">
                  Ciao, <span className="text-white">{user.name.split(' ')[0]}</span>
                </h2>
              </div>
              {weekSales.length > 0 && (
                <div className="hidden sm:flex flex-col items-end gap-0.5">
                  <p className="text-[9px] text-gray-600 font-semibold uppercase tracking-[0.1em]">Settimana</p>
                  <p className={`text-xl font-bold num ${weekProfit >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {weekProfit >= 0 ? '+' : ''}{weekProfit.toFixed(0)}€
                  </p>
                  <p className="text-[11px] text-gray-600">{weekSales.length} {weekSales.length === 1 ? 'vendita' : 'vendite'}</p>
                </div>
              )}
            </div>

            {/* KPI principali */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              {/* Mio profitto */}
              <div className="bg-[#0f0f0f] border border-white/[0.05] rounded-2xl p-5 hover:border-white/[0.1] transition-colors">
                <p className="text-[9px] font-semibold text-gray-500 tracking-[0.12em] uppercase mb-4 flex items-center gap-1.5">
                  <Wallet size={10} /> Personale
                </p>
                <p className="text-2xl font-bold text-white num">{mioProfitto.toFixed(0)}€</p>
                <p className="text-[11px] text-gray-600 mt-1.5">Quote personali</p>
              </div>

              {/* Team — clickable per team panel */}
              <div className="bg-[#0f0f0f] border border-white/[0.05] rounded-2xl p-5 cursor-pointer hover:border-white/[0.1] transition-colors group"
                onClick={() => setTeamPanelOpen(true)}>
                <p className="text-[9px] font-semibold text-gray-500 tracking-[0.12em] uppercase mb-4 flex items-center gap-1.5">
                  <Users size={10} /> Team
                </p>
                <p className="text-2xl font-bold text-purple-400 num">{globalProfitto.toFixed(0)}€</p>
                <div className="flex items-center justify-between mt-1.5">
                  <p className="text-[11px] text-gray-600">Profitto totale</p>
                  <span className="text-[9px] text-gray-600 group-hover:text-gray-400 transition-colors">Dettaglio →</span>
                </div>
              </div>

              {/* Stock */}
              <div className="bg-[#0f0f0f] border border-white/[0.05] rounded-2xl p-5 cursor-pointer hover:border-white/[0.1] transition-colors group"
                onClick={() => { setCurrentView('magazzino'); setMagazzinoView('instock'); }}>
                <p className="text-[9px] font-semibold text-gray-500 tracking-[0.12em] uppercase mb-4 flex items-center gap-1.5">
                  <Layers size={10} /> Stock
                </p>
                <p className="text-2xl font-bold num">{stockValore.toFixed(0)}€</p>
                <p className="text-[11px] text-gray-600 mt-1.5">{inStockItems.length} pezzi · <span className="group-hover:text-gray-400 transition-colors">Vedi →</span></p>
              </div>

              {/* Vendite */}
              <div className="bg-[#0f0f0f] border border-white/[0.05] rounded-2xl p-5 cursor-pointer hover:border-white/[0.1] transition-colors group"
                onClick={() => { setCurrentView('magazzino'); setMagazzinoView('sold'); }}>
                <p className="text-[9px] font-semibold text-gray-500 tracking-[0.12em] uppercase mb-4 flex items-center gap-1.5">
                  <TrendingUp size={10} /> Vendite
                </p>
                <p className="text-2xl font-bold text-emerald-400 num">{soldItemsTotal.length}</p>
                <p className="text-[11px] text-gray-600 mt-1.5">{ricaviTotali.toFixed(0)}€ ricavi · <span className="group-hover:text-gray-400 transition-colors">Vedi →</span></p>
              </div>
            </div>

            {/* Smart Insights */}
            {(staleCount > 0 || weekSales.length > 0 || bestCategoryEntry?.profit > 0) && (
              <section className="bg-[#0f0f0f] border border-white/[0.05] rounded-2xl p-5">
                <p className="text-[9px] font-semibold text-gray-500 uppercase tracking-[0.12em] mb-4 flex items-center gap-2">
                  <Sparkles size={10} /> Insights
                </p>
                <div className="space-y-3">
                  {staleCount > 0 && (
                    <div className="flex items-center gap-3 p-3 bg-red-900/15 border border-red-900/30 rounded-xl cursor-pointer hover:bg-red-900/25 transition-colors"
                      onClick={() => { setCurrentView('magazzino'); setSortField('date'); setSortDir('asc'); }}>
                      <AlertTriangle size={16} className="text-red-400 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-bold text-red-300">{staleCount} {staleCount === 1 ? 'prodotto fermo' : 'prodotti fermi'} da oltre 30 giorni</p>
                        <p className="text-[10px] text-gray-500">Valuta uno sconto per sbloccare capitale</p>
                      </div>
                      <span className="text-[10px] text-gray-500 shrink-0">Vedi →</span>
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
                        <p className="text-[10px] text-gray-500">Ottimo ritmo di smaltimento stock</p>
                      </div>
                    </div>
                  )}
                  {bestCategoryEntry?.profit > 0 && (
                    <div className="flex items-center gap-3 p-3 bg-[#ff4d00]/10 border border-[#ff4d00]/20 rounded-xl">
                      <span className="text-xl shrink-0">{getCategoryIcon(bestCategoryEntry.cat)}</span>
                      <div>
                        <p className="text-sm font-bold">{bestCategoryEntry.cat} è il tuo reparto migliore</p>
                        <p className="text-[10px] text-gray-500">+{bestCategoryEntry.profit.toFixed(0)}€ · {bestCategoryEntry.count} vendite</p>
                      </div>
                    </div>
                  )}
                  {sellThroughRate > 0 && (
                    <div className="flex items-center gap-3">
                      <div className="flex-1">
                        <div className="flex items-center justify-between mb-1.5">
                          <p className="text-xs text-gray-400 font-semibold">Sell-through rate</p>
                          <p className="text-xs font-bold text-white num">{sellThroughRate}%</p>
                        </div>
                        <div className="h-1.5 bg-black/40 rounded-full overflow-hidden">
                          <div className={`h-full rounded-full transition-all ${
                            sellThroughRate >= 60 ? 'bg-green-500' : sellThroughRate >= 30 ? 'bg-yellow-500' : 'bg-gray-600'
                          }`} style={{ width: `${sellThroughRate}%` }} />
                        </div>
                        <p className="text-[10px] text-gray-600 mt-1">{globalSold.length} venduti su {totalItems} totali</p>
                      </div>
                    </div>
                  )}
                </div>
              </section>
            )}

            {/* Libro Paga Soci */}
            {Object.keys(sociProfits).length > 1 && (
              <section className="bg-[#0f0f0f] border border-white/[0.05] rounded-2xl p-5 cursor-pointer hover:border-white/[0.1] transition-colors"
                onClick={() => setTeamPanelOpen(true)}>
                <div className="flex items-center justify-between mb-4">
                  <p className="text-[9px] font-semibold text-gray-500 tracking-[0.12em] uppercase flex items-center gap-1.5">
                    <Trophy size={10} /> Libro Paga
                  </p>
                  <span className="text-[9px] text-gray-600 hover:text-gray-400 transition-colors">Dettaglio →</span>
                </div>
                <div className="space-y-1.5">
                  {Object.values(sociProfits)
                    .sort((a: any, b: any) => b.profit - a.profit)
                    .map((socio: any, idx: number) => {
                      const maxP = Math.max(...Object.values(sociProfits).map((s: any) => s.profit), 1);
                      return (
                        <div key={idx} className={`flex items-center gap-3 p-3 rounded-xl transition-colors ${
                          socio.name === user.name ? 'bg-white/[0.03] border border-white/[0.06]' : ''
                        }`}>
                          <div className="w-7 h-7 rounded-full bg-white/[0.06] flex items-center justify-center text-xs font-semibold text-gray-400 shrink-0">
                            {socio.name[0]?.toUpperCase()}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-1.5">
                              <span className="font-semibold text-sm truncate">{socio.name}</span>
                              {socio.name === user.name && (
                                <span className="text-[9px] bg-white/[0.06] text-gray-400 px-1.5 py-0.5 rounded-full shrink-0">tu</span>
                              )}
                            </div>
                            <div className="h-0.5 bg-white/[0.04] rounded-full overflow-hidden">
                              <div className="h-full bg-white/20 rounded-full transition-all"
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
              <p className="text-[9px] font-semibold text-gray-600 tracking-[0.12em] uppercase mb-3">Reparti</p>
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
                      className="bg-[#0f0f0f] border border-white/[0.05] rounded-2xl p-4 hover:border-white/[0.1] transition-colors cursor-pointer group">
                      <div className="flex items-center justify-between mb-3">
                        <span className="text-xl">{getCategoryIcon(cat)}</span>
                        <span className="text-[9px] font-semibold px-2 py-0.5 rounded-full bg-white/[0.04] text-gray-500">{catSellRate}%</span>
                      </div>
                      <p className="font-semibold text-base leading-none">{cat}</p>
                      <p className="text-[11px] text-gray-600 mt-0.5 mb-3">{catStock.length} stock · {catSold.length} venduti</p>
                      <div className="h-0.5 bg-white/[0.04] rounded-full overflow-hidden mb-2.5">
                        <div className="h-full bg-[#ff4d00] rounded-full" style={{ width: `${catSellRate}%` }} />
                      </div>
                      <div className="flex items-center justify-between">
                        <p className={`text-sm font-semibold num ${catProfit > 0 ? 'text-emerald-400' : catProfit < 0 ? 'text-red-400' : 'text-gray-600'}`}>
                          {catProfit > 0 ? '+' : ''}{catProfit.toFixed(0)}€
                        </p>
                        {catAvgMargin !== 0 && (
                          <p className="text-[11px] text-gray-600 num">avg {catAvgMargin > 0 ? '+' : ''}{catAvgMargin.toFixed(0)}%</p>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          </div>
        )}
        
        {/* ========== MAGAZZINO ========== */}
        {currentView === 'magazzino' && (
          <div className="space-y-5">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
              <h2 className="text-3xl font-semibold">Magazzino</h2>

              <div className="flex flex-wrap items-center gap-2">
                {magazzinoView === 'instock' && (
                  <>
                    <button onClick={toggleBulkMode}
                      className={`px-3 py-2 text-xs font-bold rounded-xl border transition-colors ${
                        bulkMode ? 'bg-[#ff4d00] border-[#ff4d00] text-white' : 'bg-[#0f0f0f] border-white/[0.07] text-gray-400 hover:text-white'
                      }`}>
                      {bulkMode ? `✓ Selezione ON` : 'Seleziona'}
                    </button>
                    <label className="px-3 py-2 text-xs font-bold rounded-xl border border-white/[0.07] bg-[#0f0f0f] text-gray-400 hover:text-white cursor-pointer transition-colors flex items-center gap-1.5">
                      <Download size={13} /> Importa Excel
                      <input type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleExcelFile} />
                    </label>
                  </>
                )}
                <div className="flex bg-[#0f0f0f] p-1 rounded-xl border border-white/[0.07]">
                  <button onClick={() => { setMagazzinoView('instock'); setBulkMode(false); setSelectedGroupKeys(new Set()); }}
                    className={`px-4 py-2 text-xs font-bold rounded-lg transition-colors ${
                      magazzinoView === 'instock' ? 'bg-[#ff4d00] text-white' : 'text-gray-500'
                    }`}>IN STOCK</button>
                  <button onClick={() => { setMagazzinoView('sold'); setBulkMode(false); setSelectedGroupKeys(new Set()); }}
                    className={`px-4 py-2 text-xs font-bold rounded-lg transition-colors ${
                      magazzinoView === 'sold' ? 'bg-green-600 text-white' : 'text-gray-500'
                    }`}>VENDUTI</button>
                </div>
              </div>
            </div>
            
            <div className="flex flex-col sm:flex-row gap-3">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" size={16} />
                <input type="text" placeholder="Cerca brand o modello..."
                  value={searchTerm} onChange={(e: any) => setSearchTerm(e.target.value)}
                  className="w-full bg-[#0f0f0f] border border-white/[0.05] rounded-xl pl-10 pr-4 py-3 text-sm focus:border-[#ff4d00] outline-none" />
              </div>
              <select value={filterCat} onChange={(e: any) => setFilterCat(e.target.value)}
                className="bg-[#0f0f0f] border border-white/[0.05] rounded-xl px-4 py-3 text-sm focus:border-[#ff4d00] outline-none">
                <option value="all">Tutti i reparti</option>
                {userCategories.map((c: string) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>

            {magazzinoView === 'instock' && (
              <div className="flex flex-wrap gap-2 items-center">
                <span className="text-[10px] font-bold text-gray-500 uppercase tracking-widest flex items-center gap-1">
                  <ArrowUpDown size={12} /> Ordina:
                </span>
                {(['date','price','name'] as const).map(f => (
                  <button key={f} onClick={() => {
                    if (sortField === f) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
                    else { setSortField(f); setSortDir('desc'); }
                  }}
                    className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors ${
                      sortField === f ? 'bg-[#ff4d00] text-white' : 'bg-[#0f0f0f] border border-white/[0.05] text-gray-500 hover:text-white'
                    }`}>
                    {f === 'date' ? 'Data' : f === 'price' ? 'Prezzo' : f === 'name' ? 'Nome' : 'Margine'}
                    {sortField === f && (sortDir === 'desc' ? ' ↓' : ' ↑')}
                  </button>
                ))}
                <div className="ml-auto flex gap-2">
                  <select value={filterCondition} onChange={(e: any) => setFilterCondition(e.target.value)}
                    className="bg-[#0f0f0f] border border-white/[0.05] rounded-lg px-3 py-1.5 text-xs focus:border-[#ff4d00] outline-none text-gray-400">
                    <option value="all">Condizione</option>
                    <option value="DS">DS</option>
                    <option value="VNDS">VNDS</option>
                    <option value="Used">Used</option>
                  </select>
                  <input type="number" placeholder="Min €" value={filterPriceMin}
                    onChange={(e: any) => setFilterPriceMin(e.target.value)}
                    className="w-20 bg-[#0f0f0f] border border-white/[0.05] rounded-lg px-3 py-1.5 text-xs focus:border-[#ff4d00] outline-none text-gray-400" />
                  <input type="number" placeholder="Max €" value={filterPriceMax}
                    onChange={(e: any) => setFilterPriceMax(e.target.value)}
                    className="w-20 bg-[#0f0f0f] border border-white/[0.05] rounded-lg px-3 py-1.5 text-xs focus:border-[#ff4d00] outline-none text-gray-400" />
                </div>
              </div>
            )}
            
            {/* Lista prodotti */}
            <div className="space-y-2.5">
              {magazzinoView === 'instock' ? (
                groupedInStockArray.length === 0 ? (
                  <div className="text-center py-16 bg-[#0f0f0f] rounded-2xl border border-white/[0.05]">
                    <Package className="mx-auto text-gray-800 mb-3" size={44} />
                    <p className="text-gray-500 font-bold">Nessun prodotto in stock</p>
                  </div>
                ) : (
                  groupedInStockArray.map((g: any) => {
                    const groupKey = g.ids.join(',');
                    const isSelected = selectedGroupKeys.has(groupKey);
                    return (
                    <div key={groupKey}
                      onClick={bulkMode ? () => toggleGroupSelection(groupKey) : undefined}
                      className={`bg-[#0f0f0f] border rounded-2xl overflow-hidden transition-all relative ${
                        bulkMode ? 'cursor-pointer select-none' : ''
                      } ${isSelected ? 'border-[#ff4d00] shadow-[0_0_16px_rgba(255,77,0,0.15)]' : 'border-white/5 hover:border-white/10'}`}>
                      {/* Checkbox bulk */}
                      {bulkMode && (
                        <div className={`absolute top-3 right-3 z-10 w-6 h-6 rounded-full border-2 flex items-center justify-center transition-colors ${
                          isSelected ? 'bg-[#ff4d00] border-[#ff4d00]' : 'border-gray-600 bg-[#0a0a0a]'
                        }`}>
                          {isSelected && <CheckCircle size={14} className="text-white" />}
                        </div>
                      )}
                      {/* Card compatta — tutto inline */}
                      <div className="flex items-center gap-3 px-3 py-3">
                        {/* Foto o emoji */}
                        {(() => {
                          try {
                            const photos = g.photos ? JSON.parse(g.photos) : [];
                            if (photos.length > 0) return (
                              <div className="w-11 h-11 rounded-xl overflow-hidden shrink-0 border border-white/[0.07]">
                                <img src={photos[0]} alt="" className="w-full h-full object-cover" />
                              </div>
                            );
                          } catch {}
                          return <span className="text-2xl shrink-0 w-11 text-center">{getCategoryIcon(g.category)}</span>;
                        })()}

                        {/* Info prodotto */}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="font-bold text-sm truncate">{g.brand} {g.name}</span>
                            {g.quantity > 1 && <span className="text-[10px] bg-[#ff4d00]/20 text-white px-1.5 py-0.5 rounded-full font-bold shrink-0">×{g.quantity}</span>}
                            {(() => {
                              const days = g.oldestDate || g.createdAt ? Math.floor((Date.now() - new Date(g.oldestDate || g.createdAt).getTime()) / 86400000) : null;
                              if (!days) return null;
                              return <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-bold shrink-0 ${days > 30 ? 'bg-red-500/20 text-red-400' : days > 14 ? 'bg-yellow-500/20 text-yellow-400' : 'bg-white/5 text-gray-600'}`}>{days}g</span>;
                            })()}
                            {g.authenticityScore != null && <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-bold flex items-center gap-0.5 shrink-0 ${g.authenticityScore >= 70 ? 'bg-green-500/20 text-green-400' : g.authenticityScore >= 40 ? 'bg-yellow-500/20 text-yellow-400' : 'bg-red-500/20 text-red-400'}`}><Shield size={9} />{g.authenticityScore}</span>}
                            {g.trackingStatus && <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-bold flex items-center gap-0.5 shrink-0 ${g.trackingStatus === 'IN_TRANSIT' ? 'bg-blue-500/20 text-blue-400' : g.trackingStatus === 'DELIVERED' ? 'bg-green-500/20 text-green-400' : g.trackingStatus === 'EXCEPTION' ? 'bg-red-500/20 text-red-400' : 'bg-white/5 text-gray-500'}`}><Truck size={9} />{g.trackingStatus === 'IN_TRANSIT' ? 'Transito' : g.trackingStatus === 'DELIVERED' ? 'Consegnato' : g.trackingStatus === 'OUT_FOR_DELIVERY' ? 'In consegna' : 'Track'}</span>}
                          </div>
                          <div className="flex items-center gap-2 mt-0.5">
                            <span className="text-[11px] text-gray-500">{g.size} · {g.condition} · <span className="text-gray-300 font-semibold">{g.purchasePrice.toFixed(0)}€</span></span>
                            {(() => { const s = getShares(g); return s?.length ? <span className="text-[10px] text-blue-400/70">{s.map((x:any)=>`${x.name} ${x.percentage}%`).join(' · ')}</span> : null; })()}
                          </div>
                          {/* Note inline — click per modificare */}
                          {!bulkMode && (
                            <button onClick={() => { setNotesModalProduct(g); setNotesInput(g.notes || ''); }}
                              className={`mt-1 text-[11px] flex items-center gap-1 transition-colors ${g.notes ? 'text-gray-500 hover:text-gray-300' : 'text-gray-700 hover:text-gray-500'}`}>
                              <StickyNote size={10} />
                              <span className="truncate max-w-[180px]">{g.notes || 'Aggiungi nota…'}</span>
                            </button>
                          )}
                        </div>

                        {/* Azioni destra — 3 bottoni impilati */}
                        {!bulkMode && (
                          <div className="flex flex-col gap-1 shrink-0">
                            <button onClick={() => openTrackingModal(g)}
                              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors ${
                                g.trackingCode
                                  ? 'bg-blue-500/15 hover:bg-blue-500/25 text-blue-400 hover:text-blue-300'
                                  : 'bg-white/[0.05] hover:bg-white/[0.09] text-gray-500 hover:text-gray-300'
                              }`}>
                              Track
                            </button>
                            <button onClick={() => openEditModal(g)}
                              className="px-3 py-1.5 bg-white/[0.05] hover:bg-white/[0.09] text-gray-400 hover:text-white rounded-lg text-xs font-bold transition-colors">
                              Modifica
                            </button>
                            <button onClick={() => openSellModal(g.ids, `${g.brand} ${g.name}`, g)}
                              className="px-3 py-1.5 bg-green-500/15 hover:bg-green-500/25 text-green-400 hover:text-green-300 rounded-lg text-xs font-bold transition-colors">
                              Vendi
                            </button>
                          </div>
                        )}
                      </div>
                      {/* Riga admin — solo per admin, molto discreta */}
                      {!bulkMode && user!.email.toLowerCase() === ADMIN_EMAIL.toLowerCase() && (
                        <div className="flex border-t border-white/[0.04] px-3 py-1.5 gap-3">
                          <button onClick={() => openShipping(g)} className="flex items-center gap-1 text-[10px] text-orange-500/50 hover:text-orange-400 transition-colors">
                            <Package size={10} /> Spedisci
                          </button>
                          <button onClick={() => openListingModal(g)} className="flex items-center gap-1 text-[10px] text-purple-500/50 hover:text-purple-400 transition-colors">
                            <Store size={10} /> Annuncio
                          </button>
                        </div>
                      )}
                    </div>
                  );
                  })
                )
              ) : (
                groupedSoldArray.length === 0 ? (
                  <div className="text-center py-16 bg-[#0f0f0f] rounded-2xl border border-white/[0.05]">
                    <CheckCircle className="mx-auto text-gray-800 mb-4" size={40} />
                    <p className="text-gray-400 font-semibold">Nessuna vendita ancora</p>
                    <p className="text-gray-600 text-sm mt-1">Vai su IN STOCK e registra la tua prima vendita</p>
                  </div>
                ) : (
                  (() => {
                    const platColors: Record<string, string> = {
                      'Vinted': 'text-teal-300 bg-teal-500/15 border-teal-500/20',
                      'StockX': 'text-green-300 bg-green-500/15 border-green-500/20',
                      'eBay': 'text-yellow-300 bg-yellow-500/15 border-yellow-500/20',
                      'Subito': 'text-orange-300 bg-orange-500/15 border-orange-500/20',
                      'Privato': 'text-gray-400 bg-white/5 border-white/10',
                    };
                    return groupedSoldArray.map((g: any) => {
                      const marginPct = g.totalRevenue > 0 && g.purchasePrice > 0
                        ? ((g.totalProfit / (g.purchasePrice * g.quantity)) * 100)
                        : null;
                      const soldDate = g.soldAt ? new Date(g.soldAt).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' }) : null;
                      let photos: string[] = [];
                      try { photos = g.photos ? JSON.parse(g.photos) : []; } catch {}
                      const platCls = platColors[g.platform] || 'text-gray-400 bg-white/5 border-white/10';

                      if (g.salePrice === 0) {
                        return (
                          <div key={g.ids.join(',')} className="bg-[#0f0f0f] border border-yellow-500/20 rounded-2xl overflow-hidden">
                            <div className="flex items-center gap-3 p-4">
                              {photos.length > 0
                                ? <div className="w-12 h-12 rounded-xl overflow-hidden shrink-0 border border-white/[0.05]"><img src={photos[0]} alt="" className="w-full h-full object-cover" /></div>
                                : <span className="text-2xl shrink-0 opacity-60">{getCategoryIcon(g.category)}</span>}
                              <div className="flex-1 min-w-0">
                                <p className="font-bold text-sm">{g.brand} {g.name}</p>
                                <p className="text-[10px] text-gray-500">{g.size} · {g.condition}</p>
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
                        <div key={g.ids.join(',')} className="bg-[#0f0f0f] border border-white/[0.05] rounded-2xl overflow-hidden hover:border-white/10 transition-all group">
                          <div className="flex items-center gap-3 p-4">
                            {photos.length > 0
                              ? <div className="w-12 h-12 rounded-xl overflow-hidden shrink-0 border border-white/[0.05] group-hover:border-white/10 transition-colors"><img src={photos[0]} alt="" className="w-full h-full object-cover" /></div>
                              : <span className="text-2xl shrink-0 opacity-40">{getCategoryIcon(g.category)}</span>}
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-1.5 flex-wrap mb-0.5">
                                <p className="font-bold text-sm">{g.brand} {g.name}</p>
                                {g.quantity > 1 && (
                                  <span className="text-[9px] bg-green-500/15 border border-green-500/25 text-green-400 px-1.5 py-0.5 rounded-full font-semibold shrink-0">×{g.quantity}</span>
                                )}
                              </div>
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="text-[10px] text-gray-600">{g.size}</span>
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
                          <div className="flex items-center gap-2 px-4 pb-3 border-t border-white/4 pt-2.5">
                            <span className="text-[10px] text-gray-700 flex items-center gap-1">
                              {g.purchasePrice?.toFixed(0)}€
                              <span className="text-gray-800 mx-0.5">→</span>
                              <span className="text-gray-500 font-bold">{g.totalRevenue.toFixed(0)}€</span>
                            </span>
                            {g.totalFees > 0 && (
                              <span className="text-[10px] text-gray-700">· {g.totalFees.toFixed(0)}€ fee</span>
                            )}
                          </div>
                        </div>
                      );
                    });
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
                className="flex items-center gap-2 bg-[#0f0f0f] border border-white/[0.07] hover:border-white/15 px-4 py-2 rounded-xl text-sm font-bold transition-colors text-gray-500 hover:text-white active:scale-95">
                <Download size={15} /> CSV
              </button>
            </div>

            {/* KPI row 1: principali */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <div className="bg-[#0f0f0f] border border-white/[0.05] rounded-2xl p-4">
                <p className="text-[9px] font-semibold text-gray-500 tracking-[0.12em] uppercase mb-3 flex items-center gap-1.5">
                  <TrendingUp size={10} /> ROI
                </p>
                <p className={`text-2xl font-bold num ${parseFloat(roi) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{roi}%</p>
                <p className="text-[11px] text-gray-600 mt-1.5">Return on Investment</p>
              </div>
              <div className="bg-[#0f0f0f] border border-white/[0.05] rounded-2xl p-4">
                <p className="text-[9px] font-semibold text-gray-500 tracking-[0.12em] uppercase mb-3 flex items-center gap-1.5">
                  <Wallet size={10} /> Profitto Netto
                </p>
                <p className={`text-2xl font-bold num ${profittoNetto >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{profittoNetto.toFixed(0)}€</p>
                <p className="text-[11px] text-gray-600 mt-1.5">Dopo fees · {ricaviTotali.toFixed(0)}€ ricavi</p>
              </div>
              <div className="bg-[#0f0f0f] border border-white/[0.05] rounded-2xl p-4">
                <p className="text-[9px] font-semibold text-gray-500 tracking-[0.12em] uppercase mb-3 flex items-center gap-1.5">
                  <Layers size={10} /> Stock
                </p>
                <p className="text-2xl font-bold num">{stockValore.toFixed(0)}€</p>
                <p className="text-[11px] text-gray-600 mt-1.5">Capitale immobilizzato</p>
              </div>
              <div className="bg-[#0f0f0f] border border-white/[0.05] rounded-2xl p-4">
                <p className="text-[9px] font-semibold text-gray-500 tracking-[0.12em] uppercase mb-3 flex items-center gap-1.5">
                  <DollarSign size={10} /> Vendite
                </p>
                <p className="text-2xl font-bold text-purple-400 num">{soldItemsTotal.length}</p>
                <p className="text-[11px] text-gray-600 mt-1.5">Totali · {sellThroughRate}% sell-through</p>
              </div>
            </div>

            {/* KPI row 2: metriche operative */}
            <div className="grid grid-cols-3 gap-2">
              <div className="bg-[#0f0f0f] border border-white/[0.05] rounded-2xl p-3 text-center">
                <p className={`text-xl font-bold num ${avgMarginPct >= 20 ? 'text-emerald-400' : avgMarginPct >= 0 ? 'text-purple-400' : 'text-red-400'}`}>
                  {avgMarginPct >= 0 ? '+' : ''}{avgMarginPct.toFixed(1)}%
                </p>
                <p className="text-[9px] text-gray-600 font-semibold mt-1.5 leading-tight">
                  <span className="sm:hidden">Margine</span>
                  <span className="hidden sm:inline">Margine Medio</span>
                </p>
              </div>
              <div className="bg-[#0f0f0f] border border-white/[0.05] rounded-2xl p-3 text-center">
                <p className="text-xl font-bold text-purple-400 num">{Math.round(avgDaysToSell)}</p>
                <p className="text-[9px] text-gray-600 font-semibold mt-1.5 leading-tight">
                  <span className="sm:hidden">Gg/vendita</span>
                  <span className="hidden sm:inline">Giorni medi vendita</span>
                </p>
              </div>
              <div className="bg-[#0f0f0f] border border-white/[0.05] rounded-2xl p-3 text-center">
                <p className="text-xl font-bold text-white num">{sellThroughRate}%</p>
                <p className="text-[9px] text-gray-600 font-semibold mt-1.5 leading-tight">Sell-through</p>
              </div>
            </div>

            {/* Grafico */}
            <section className="bg-[#0f0f0f] border border-white/[0.05] rounded-2xl p-5">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-5">
                <h3 className="font-semibold">Andamento Vendite</h3>
                <div className="flex gap-1 bg-[#0a0a0a] p-1 rounded-xl border border-white/[0.07]">
                  {(['1D', '1W', '1M', '1Y', 'MAX'] as const).map(tf => (
                    <button key={tf} onClick={() => setChartTimeframe(tf)}
                      className={`px-3 py-1 text-xs font-bold rounded-lg transition-colors ${
                        chartTimeframe === tf ? 'bg-[#ff4d00] text-white' : 'text-gray-500 hover:text-white'
                      }`}>{tf}</button>
                  ))}
                </div>
              </div>
              {trendData.length === 0 ? (
                <div className="text-center py-10">
                  <BarChart3 className="mx-auto text-gray-800 mb-3" size={36} />
                  <p className="text-gray-500 text-sm">Nessun dato per questo periodo</p>
                </div>
              ) : (
                <ResponsiveContainer width="100%" height={280}>
                  <AreaChart data={trendData} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
                    <defs>
                      <linearGradient id="profGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#ff4d00" stopOpacity={0.35} />
                        <stop offset="100%" stopColor="#ff4d00" stopOpacity={0} />
                      </linearGradient>
                      <linearGradient id="ricaGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#22c55e" stopOpacity={0.25} />
                        <stop offset="100%" stopColor="#22c55e" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <XAxis dataKey="date" stroke="#333" fontSize={10} tickLine={false} axisLine={false} />
                    <YAxis stroke="#333" fontSize={10} tickLine={false} axisLine={false} />
                    <Tooltip
                      contentStyle={{ backgroundColor: '#0a0a0a', border: '1px solid #222', borderRadius: 12, fontSize: 12 }}
                      labelStyle={{ color: '#aaa', fontWeight: 'bold' }} />
                    <Area type="monotone" dataKey="Ricavi" stroke="#22c55e" fill="url(#ricaGrad)" strokeWidth={2} dot={false} />
                    <Area type="monotone" dataKey="Profitto" stroke="#ff4d00" fill="url(#profGrad)" strokeWidth={2} dot={false} />
                  </AreaChart>
                </ResponsiveContainer>
              )}
              <div className="flex items-center gap-5 mt-3 justify-end">
                <div className="flex items-center gap-1.5 text-[10px] text-gray-500"><span className="w-3 h-0.5 bg-green-500 rounded-full inline-block" />Ricavi</div>
                <div className="flex items-center gap-1.5 text-[10px] text-gray-500"><span className="w-3 h-0.5 bg-[#ff4d00] rounded-full inline-block" />Profitto</div>
              </div>
            </section>

            {/* Piattaforme + Soci — 2 colonne su desktop */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
              {platformBreakdown.length > 0 && (
                <section className="bg-[#0f0f0f] border border-white/[0.05] rounded-2xl p-5">
                  <div className="flex items-center gap-2 mb-4">
                    <Store className="text-white" size={15} />
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
                              <span className="text-[10px] text-gray-500">{stats.count} vend.</span>
                              <span className="text-sm font-semibold text-green-400">+{stats.profit.toFixed(0)}€</span>
                            </div>
                          </div>
                          <div className="h-2 bg-black/40 rounded-full overflow-hidden mb-1">
                            <div className="h-full bg-gradient-to-r from-[#ff4d00] to-orange-400 rounded-full"
                              style={{ width: `${(stats.revenue / maxRev) * 100}%` }} />
                          </div>
                          <div className="flex justify-between">
                            <span className="text-[10px] text-gray-600">{stats.revenue.toFixed(0)}€ ricavi · {stats.fees.toFixed(0)}€ fee</span>
                            <span className="text-[10px] text-gray-500">{platMargin >= 0 ? '+' : ''}{platMargin.toFixed(0)}€/vend.</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </section>
              )}

              {Object.keys(sociProfits).length > 0 && (
                <section className="bg-[#0f0f0f] border border-white/[0.05] rounded-2xl p-5">
                  <div className="flex items-center gap-2 mb-4">
                    <Users className="text-purple-400" size={15} />
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
                                  <span className="text-[9px] bg-[#ff4d00]/20 text-white px-1.5 py-0.5 rounded-full">TU</span>
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
                <section className="bg-[#0f0f0f] border border-white/[0.05] rounded-2xl p-5">
                  <div className="flex items-center gap-2 mb-4">
                    <Trophy className="text-white" size={15} />
                    <h3 className="font-semibold">Top 3 Vendite</h3>
                  </div>
                  <div className="space-y-3">
                    {top.map((p, i) => {
                      const medals = ['🥇', '🥈', '🥉'];
                      const margin = p.purchasePrice > 0 ? ((p.profit / p.purchasePrice) * 100) : 0;
                      return (
                        <div key={p.id} className="flex items-center gap-3 p-3 bg-[#0a0a0a] rounded-xl">
                          <span className="text-lg shrink-0">{medals[i]}</span>
                          <div className="flex-1 min-w-0">
                            <p className="font-bold text-sm truncate">{p.brand} {p.name}</p>
                            <p className="text-[10px] text-gray-500">{p.size} · {p.platform} · {p.purchasePrice.toFixed(0)}€→{(p.salePrice || 0).toFixed(0)}€</p>
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
                <section className="bg-[#0f0f0f] border border-white/[0.05] rounded-2xl p-5">
                  <div className="flex items-center gap-2 mb-4">
                    <PieChartIcon className="text-white" size={15} />
                    <h3 className="font-semibold">Reparti</h3>
                  </div>
                  <div className="overflow-x-auto -mx-1">
                    <table className="w-full text-[11px]">
                      <thead>
                        <tr className="border-b border-white/[0.07]">
                          {['Reparto', 'Totale', 'Venduti', 'Stock', 'Sell-through', 'Capitale', 'Profitto', 'Gg/vendita'].map(h => (
                            <th key={h} className="text-left text-gray-600 font-semibold uppercase tracking-wider py-2 pr-4 last:pr-0">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-white/[0.04]">
                        {rows.map(r => (
                          <tr key={r.cat} className="hover:bg-white/[0.02] transition-colors">
                            <td className="py-2.5 pr-4 font-bold text-white">{getCategoryIcon(r.cat)} {r.cat}</td>
                            <td className="py-2.5 pr-4 text-gray-400 num">{r.total}</td>
                            <td className="py-2.5 pr-4 text-purple-400 num">{r.sold}</td>
                            <td className="py-2.5 pr-4 text-gray-400 num">{r.inStock}</td>
                            <td className="py-2.5 pr-4">
                              <div className="flex items-center gap-2">
                                <div className="w-16 h-1.5 bg-white/[0.06] rounded-full overflow-hidden">
                                  <div className="h-full bg-[#ff4d00] rounded-full" style={{ width: `${r.st}%` }} />
                                </div>
                                <span className={`num font-semibold ${r.st >= 60 ? 'text-emerald-400' : r.st >= 30 ? 'text-yellow-400' : 'text-red-400'}`}>{r.st}%</span>
                              </div>
                            </td>
                            <td className="py-2.5 pr-4 text-gray-400 num">{r.capital.toFixed(0)}€</td>
                            <td className={`py-2.5 pr-4 num font-semibold ${r.profit >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{r.profit >= 0 ? '+' : ''}{r.profit.toFixed(0)}€</td>
                            <td className="py-2.5 text-gray-500 num">{r.avgDays ?? '—'}</td>
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
              <section className="bg-[#0f0f0f] border border-yellow-500/20 rounded-2xl p-5">
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-2">
                    <AlertTriangle className="text-yellow-500" size={15} />
                    <h3 className="font-semibold">Dead Stock Alert</h3>
                    <span className="bg-yellow-500/10 text-yellow-400 text-[10px] font-bold px-2 py-0.5 rounded-full">{staleProducts.length} prodotti</span>
                  </div>
                  <span className="text-[10px] text-gray-600">fermi da +{staleThreshold} giorni · {staleProducts.reduce((s: number, p: any) => s + (p.purchasePrice || 0), 0).toFixed(0)}€ immobilizzati</span>
                </div>
                <div className="space-y-2">
                  {staleProducts.slice(0, 5).map((p: any) => {
                    const days = p.createdAt ? Math.floor((Date.now() - new Date(p.createdAt).getTime()) / 86400000) : 0;
                    return (
                      <div key={p.id} className="flex items-center gap-3 p-3 bg-[#0a0a0a] rounded-xl">
                        <div className="w-8 h-8 rounded-lg bg-yellow-500/10 flex items-center justify-center flex-shrink-0">
                          <span className="text-base">{getCategoryIcon(p.category)}</span>
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-bold truncate">{p.brand} {p.name}</p>
                          <p className="text-[10px] text-gray-500">{p.size} · {p.condition}</p>
                        </div>
                        <div className="text-right shrink-0">
                          <p className="text-sm font-semibold text-white">{(p.purchasePrice || 0).toFixed(0)}€</p>
                          <p className="text-[10px] text-yellow-600">{days} giorni</p>
                        </div>
                      </div>
                    );
                  })}
                  {staleProducts.length > 5 && (
                    <p className="text-[11px] text-gray-600 text-center pt-1">+{staleProducts.length - 5} altri prodotti fermi</p>
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
            if (s === 'OUT_FOR_DELIVERY') return { text: 'In consegna', cls: 'bg-orange-500/20 text-orange-400', dot: 'bg-orange-400' };
            if (s === 'DELIVERED') return { text: 'Consegnato', cls: 'bg-green-500/20 text-green-400', dot: 'bg-green-400' };
            if (s === 'EXCEPTION') return { text: 'Eccezione', cls: 'bg-red-500/20 text-red-400', dot: 'bg-red-400' };
            if (s === 'RETURNED') return { text: 'Reso', cls: 'bg-purple-500/20 text-purple-400', dot: 'bg-purple-400' };
            return { text: 'In attesa', cls: 'bg-white/5 text-gray-500', dot: 'bg-gray-600' };
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
              <div className="bg-[#0f0f0f] border border-white/[0.05] rounded-2xl overflow-hidden hover:border-white/10 transition-all">
                <div className="flex items-center gap-3 p-4">
                  {photos.length > 0 ? (
                    <div className="w-12 h-12 rounded-xl overflow-hidden shrink-0 border border-white/[0.07]">
                      <img src={photos[0]} alt="" className="w-full h-full object-cover" />
                    </div>
                  ) : (
                    <div className="w-12 h-12 rounded-xl bg-white/5 flex items-center justify-center shrink-0 text-xl">
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
                    <p className="text-xs text-gray-500 mt-0.5 font-mono truncate">{p.trackingCode}</p>
                    <div className="flex items-center gap-2 mt-1 flex-wrap">
                      <span className="text-[10px] text-gray-600 bg-white/5 px-2 py-0.5 rounded-full">{p.trackingCarrier}</span>
                      {updatedAgo && <span className="text-[10px] text-gray-600">aggiornato {updatedAgo}</span>}
                    </div>
                  </div>
                  <button
                    onClick={() => { setCurrentView('magazzino'); setMagazzinoView('instock'); setTimeout(() => openTrackingModal({ ...p, ids: [p.id], quantity: 1 }), 100); }}
                    className="shrink-0 p-2 hover:bg-white/5 rounded-xl transition-colors text-gray-500 hover:text-white">
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
                  <p className="text-gray-500 text-sm mt-1">Monitora le tue spedizioni</p>
                </div>
                {active.length > 0 && (
                  <button onClick={handleRefreshAllTrackings} disabled={isRefreshingAll}
                    className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 px-4 py-2.5 rounded-xl text-sm font-bold transition-colors">
                    {isRefreshingAll ? <Loader2 className="animate-spin" size={16} /> : <Truck size={16} />}
                    {isRefreshingAll ? 'Aggiornamento...' : 'Aggiorna tutto'}
                  </button>
                )}
              </div>

              {/* Stats */}
              <div className="grid grid-cols-3 gap-3">
                {[
                  { label: 'Attive', value: active.length, color: 'text-blue-400', bg: 'bg-[#0f0f0f] border-blue-500/20', glow: 'bg-blue-500/8' },
                  { label: 'Consegnate', value: delivered.length, color: 'text-emerald-400', bg: 'bg-[#0f0f0f] border-green-500/20', glow: 'bg-green-500/8' },
                  { label: 'Eccezioni', value: exceptions.length, color: 'text-red-400', bg: 'bg-[#0f0f0f] border-red-500/20', glow: 'bg-red-500/8' },
                ].map(s => (
                  <div key={s.label} className={`${s.bg} border rounded-2xl p-4 text-center relative overflow-hidden`}>
                    <div className={`absolute inset-0 ${s.glow} pointer-events-none`} />
                    <p className={`text-2xl font-bold ${s.color}`}>{s.value}</p>
                    <p className="text-[9px] text-gray-600 font-semibold tracking-[0.1em] uppercase mt-1.5">{s.label}</p>
                  </div>
                ))}
              </div>

              {/* Nessun tracking */}
              {allTracked.length === 0 && (
                <div className="text-center py-16 bg-[#0f0f0f] rounded-2xl border border-white/[0.05]">
                  <Truck className="mx-auto text-gray-800 mb-3" size={44} />
                  <p className="text-gray-400 font-semibold">Nessuna spedizione tracciata</p>
                  <p className="text-gray-600 text-sm mt-1">Aggiungi un codice tracking da Magazzino → Track</p>
                </div>
              )}

              {/* Sezione: Attive */}
              {active.length > 0 && (
                <div className="space-y-3">
                  <h3 className="text-[9px] font-semibold text-gray-500 tracking-[0.12em] uppercase flex items-center gap-2">
                    <span className="w-2 h-2 bg-blue-400 rounded-full animate-pulse" />
                    Spedizioni attive ({active.length})
                  </h3>
                  {active.map(p => <TrackCard key={p.id} p={p} />)}
                </div>
              )}

              {/* Sezione: Eccezioni / Resi */}
              {exceptions.length > 0 && (
                <div className="space-y-3">
                  <h3 className="text-[9px] font-semibold text-gray-500 tracking-[0.12em] uppercase flex items-center gap-2">
                    <span className="w-2 h-2 bg-red-400 rounded-full" />
                    Eccezioni / Resi ({exceptions.length})
                  </h3>
                  {exceptions.map(p => <TrackCard key={p.id} p={p} />)}
                </div>
              )}

              {/* Sezione: Consegnate */}
              {delivered.length > 0 && (
                <div className="space-y-3">
                  <h3 className="text-[9px] font-semibold text-gray-500 tracking-[0.12em] uppercase flex items-center gap-2">
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

            {/* ===== PANNELLO ADMIN (collassabile) ===== */}
            {user.email.toLowerCase() === ADMIN_EMAIL.toLowerCase() && (
              <section className="bg-[#0f0f0f] border border-white/[0.05] rounded-2xl overflow-hidden">
                {/* Header sempre visibile — click per aprire/chiudere */}
                <button onClick={toggleAdminPanel}
                  className="w-full p-5 flex items-center justify-between hover:bg-white/[0.02] transition-colors">
                  <div className="flex items-center gap-2">
                    <Shield size={15} className="text-gray-500" />
                    <span className="font-semibold text-sm">Admin</span>
                    {adminLoaded && (
                      <span className="text-[10px] bg-white/[0.05] text-gray-500 px-2 py-0.5 rounded-full">
                        {adminUsers.length} utenti
                      </span>
                    )}
                    {adminPanelOpen && adminLoaded && (
                      <span className="text-[9px] text-green-500/60 flex items-center gap-1">
                        <span className="w-1.5 h-1.5 rounded-full bg-green-500/60 inline-block" />
                        live
                      </span>
                    )}
                  </div>
                  <ChevronDown size={16} className={`text-gray-600 transition-transform duration-200 ${adminPanelOpen ? 'rotate-180' : ''}`} />
                </button>

                {/* Contenuto collassabile */}
                {adminPanelOpen && (
                  <div className="border-t border-white/[0.05]">
                    {/* Toolbar */}
                    <div className="px-5 py-3 flex items-center justify-between border-b border-white/[0.04]">
                      <p className="text-[10px] text-gray-600">Auto-aggiornamento ogni 5 min</p>
                      <div className="flex gap-2">
                        <button onClick={sendTestEmail}
                          className="flex items-center gap-1.5 px-3 py-1.5 bg-white/[0.05] hover:bg-white/[0.08] rounded-xl text-xs font-semibold transition-colors">
                          <Mail size={12} /> Test Email
                        </button>
                        {adminLoaded && (
                          <button onClick={exportAdminExcel}
                            className="flex items-center gap-1.5 px-3 py-1.5 bg-white/[0.05] hover:bg-white/[0.08] rounded-xl text-xs font-semibold transition-colors">
                            <Download size={12} /> Excel
                          </button>
                        )}
                        <button onClick={fetchAdminUsers} disabled={adminLoading}
                          className="flex items-center gap-1.5 px-3 py-1.5 bg-white/[0.07] hover:bg-white/[0.1] rounded-xl text-xs font-semibold transition-colors disabled:opacity-40">
                          {adminLoading ? <Loader2 size={12} className="animate-spin" /> : <Users size={12} />}
                          Aggiorna
                        </button>
                      </div>
                    </div>

                    {adminLoaded && (
                      <>
                        {/* KPI */}
                        <div className="grid grid-cols-2 border-b border-white/[0.04]">
                          {[
                            { label: 'Utenti', value: adminUsers.length },
                            { label: 'Prodotti totali', value: adminUsers.reduce((a, u) => a + u.stats.totalProducts, 0) },
                          ].map(s => (
                            <div key={s.label} className="p-3 text-center border-r border-white/[0.04] last:border-0">
                              <p className="text-base font-bold num">{s.value}</p>
                              <p className="text-[9px] text-gray-600 mt-0.5">{s.label}</p>
                            </div>
                          ))}
                        </div>

                        {/* Lista utenti */}
                        <div className="divide-y divide-white/[0.03] max-h-96 overflow-y-auto">
                          {adminUsers.map(u => (
                            <div key={u.id} className="px-4 py-3 flex items-start gap-3">
                              <div className="w-7 h-7 rounded-full bg-white/[0.06] flex items-center justify-center text-xs font-semibold shrink-0 mt-0.5">
                                {u.name?.[0]?.toUpperCase()}
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-1.5 flex-wrap">
                                  <span className="font-semibold text-sm">{u.name}</span>
                                  {u.twoFactorEnabled && <span className="text-[8px] bg-green-500/15 text-green-400 px-1.5 py-0.5 rounded-full">2FA</span>}
                                </div>
                                <p className="text-[10px] text-gray-500">{u.email}</p>
                                <p className="text-[10px] text-gray-700 mt-0.5">
                                  {u.stats.inStock} in stock · {u.stats.sold} venduti · {u.stats.totalProducts} totali
                                </p>
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

                    {!adminLoaded && adminLoading && (
                      <div className="p-6 flex justify-center">
                        <Loader2 size={20} className="animate-spin text-gray-600" />
                      </div>
                    )}
                  </div>
                )}
              </section>
            )}

            {/* SEZIONE: Prodotti Fermi */}
            <section className="bg-[#0f0f0f] border border-white/[0.05] rounded-2xl p-6">
              <div className="flex items-center gap-2 mb-4">
                <AlertTriangle className="text-yellow-500" size={18} />
                <h3 className="text-lg font-bold tracking-tighter">Notifiche Prodotti Fermi</h3>
              </div>
              <p className="text-xs text-gray-500 mb-4">
                Ricevi una notifica quando hai prodotti in magazzino da troppo tempo, con suggerimento di sconto basato sull'IA.
              </p>
              <div className="flex items-center gap-3 mb-4">
                <label className="text-sm text-gray-400 flex-1">Avvisami dopo</label>
                <input 
                  type="number" min="7" max="365" value={staleThreshold}
                  onChange={(e: any) => {
                    const v = parseInt(e.target.value) || 60;
                    setStaleThreshold(v);
                    localStorage.setItem('staleThreshold', v.toString());
                  }}
                  className="w-24 bg-[#0a0a0a] border border-white/[0.07] rounded-lg px-3 py-2 text-sm text-right focus:border-[#ff4d00] outline-none"
                />
                <span className="text-sm text-gray-400">giorni</span>
              </div>
              {staleProducts.length > 0 ? (
                <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-3">
                  <p className="text-sm font-bold text-yellow-400 mb-2">
                    ⏰ Hai {staleProducts.length} prodott{staleProducts.length === 1 ? 'o fermo' : 'i fermi'}
                  </p>
                  <div className="space-y-2 max-h-64 overflow-y-auto">
                    {staleProducts.slice(0, 10).map((sp: any) => (
                      <div key={sp.id} className="text-xs bg-[#0a0a0a] p-2 rounded-lg">
                        <p className="text-white font-bold">{sp.brand} {sp.name}</p>
                        <p className="text-gray-500">
                          {sp.daysInStock}g in stock • Sconto: <span className="text-yellow-400 font-bold">-{sp.suggestedDiscount}%</span> → <span className="text-green-400">€{sp.suggestedPrice}</span>
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <p className="text-xs text-gray-600 italic">✓ Nessun prodotto fermo oltre la soglia</p>
              )}
              <button 
                onClick={checkStaleProducts}
                className="mt-3 w-full bg-yellow-600/20 hover:bg-yellow-600/30 text-yellow-400 py-2 rounded-xl text-xs font-bold transition-colors">
                Ricontrolla ora
              </button>
            </section>
            
            {/* SEZIONE: 2FA */}
            <section className="bg-[#0f0f0f] border border-white/[0.05] rounded-2xl p-6">
              <div className="flex items-start justify-between gap-4 mb-4">
                <div className="flex items-start gap-3">
                  <Shield className={user.twoFactorEnabled ? 'text-green-400' : 'text-gray-500'} size={24} />
                  <div>
                    <h3 className="text-lg font-bold tracking-tighter">Autenticazione a Due Fattori</h3>
                    <p className="text-xs text-gray-500 mt-1">
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
                    className="px-4 py-2 bg-[#ff4d00] hover:bg-[#ff6a2a] rounded-xl text-xs font-bold transition-colors whitespace-nowrap">
                    Attiva 2FA
                  </button>
                )}
              </div>
            </section>
            
            {/* SEZIONE: CAMBIA PASSWORD */}
            <section className="bg-[#0f0f0f] border border-white/[0.05] rounded-2xl p-6">
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-start gap-3">
                  <Lock className="text-gray-500 mt-0.5" size={22} />
                  <div>
                    <h3 className="text-lg font-bold tracking-tighter">Password</h3>
                    <p className="text-xs text-gray-500 mt-1">Cambia la password del tuo account.</p>
                  </div>
                </div>
                <button onClick={() => setChangePwdOpen(true)}
                  className="px-4 py-2 bg-[#ff4d00] hover:bg-[#ff6a2a] rounded-xl text-xs font-bold transition-colors whitespace-nowrap">
                  Cambia
                </button>
              </div>
            </section>

            {/* SEZIONE: Reparti & Codici Invito */}
            <section className="bg-[#0f0f0f] border border-white/[0.05] rounded-2xl p-6">
              <div className="flex items-center gap-2 mb-5">
                <Layers className="text-white" size={18} />
                <h3 className="text-lg font-bold tracking-tighter">I tuoi Reparti</h3>
              </div>
              
              <div className="space-y-3 mb-6">
                {user.warehouses.map((w: any) => (
                  <div key={w.id} className="bg-[#0a0a0a] p-4 rounded-xl border border-white/[0.07]">
                    <div className="flex items-center justify-between flex-wrap gap-3">
                      <div className="flex items-center gap-3">
                        <span className="text-2xl">{getCategoryIcon(w.name.replace('Magazzino ', ''))}</span>
                        <div>
                          <p className="font-bold">{w.name}</p>
                          <p className="text-[10px] text-gray-500 uppercase">
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
                <form onSubmit={handleAddCategory} className="flex flex-col sm:flex-row gap-3 pt-5 border-t border-white/[0.07]">
                  <input type="text" value={newCatName}
                    onChange={(e: any) => setNewCatName(e.target.value)}
                    placeholder="Nome nuovo reparto (es. Borse, Vinili...)"
                    className="flex-1 bg-[#0a0a0a] border border-white/[0.07] rounded-xl px-4 py-2 text-sm focus:border-[#ff4d00] outline-none" />
                  <button type="submit" disabled={isAddingCat}
                    className="bg-[#ff4d00] hover:bg-[#ff6a2a] px-5 py-2 rounded-xl text-sm font-bold transition-colors whitespace-nowrap">
                    {isAddingCat ? <Loader2 className="animate-spin" size={16} /> : '+ Aggiungi Reparto'}
                  </button>
                </form>
              )}
            </section>
            
            {/* SEZIONE: Team & Quote */}
            {teamData.map((team: any) => (
              <section key={team.warehouseId} className="bg-[#0f0f0f] border border-white/[0.05] rounded-2xl p-6">
                <div className="flex items-center gap-2 mb-5">
                  <Users className="text-blue-500" size={18} />
                  <h3 className="text-lg font-bold tracking-tighter">Soci di {team.warehouseName}</h3>
                </div>
                
                <div className="space-y-3 mb-4">
                  {team.members.map((m: any) => (
                    <div key={m.membershipId} className="flex items-center gap-3 bg-[#0a0a0a] p-3 rounded-xl">
                      <div className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-500 to-blue-700 flex items-center justify-center font-bold text-sm">
                        {m.name[0]?.toUpperCase()}
                      </div>
                      <div className="flex-1">
                        <p className="font-bold text-sm">{m.name}</p>
                        <p className="text-[10px] text-gray-500 uppercase">{m.role === 'OWNER' ? 'Fondatore' : 'Membro'}</p>
                      </div>
                      <input type="number" min="0" max="100" value={m.percentage}
                        onChange={(e: any) => updateMemberPercentage(team.warehouseId, m.membershipId, e.target.value)}
                        className="w-20 bg-[#0f0f0f] border border-white/[0.05] rounded-lg px-3 py-1.5 text-sm text-right focus:border-[#ff4d00] outline-none" />
                      <span className="text-gray-500 text-xs">%</span>
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
                  <div className="mt-4 pt-4 border-t border-white/[0.04] flex justify-end">
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
            <section className="bg-[#0f0f0f] border border-white/[0.05] rounded-2xl p-5">
              <div className="flex items-center gap-2 mb-1">
                <UserPlus size={15} className="text-gray-400" />
                <h3 className="font-semibold text-sm">Entra in un Magazzino</h3>
              </div>
              <p className="text-[11px] text-gray-600 mb-4">Hai ricevuto un codice invito? Inseriscilo qui per unirti al team.</p>
              <form onSubmit={handleJoinWarehouse} className="flex flex-col gap-2">
                <input
                  value={joinCodeInput}
                  onChange={e => setJoinCodeInput(e.target.value.toUpperCase())}
                  placeholder="Codice invito (es: ABC123XY)"
                  maxLength={20}
                  className="w-full bg-[#0a0a0a] border border-white/[0.07] rounded-xl px-4 py-3 text-sm font-mono tracking-widest focus:border-white/[0.2] outline-none uppercase"
                />
                <button type="submit" disabled={isJoining || !joinCodeInput.trim()}
                  className="w-full py-3 bg-white text-black rounded-xl text-sm font-semibold hover:bg-gray-200 transition-colors disabled:opacity-40">
                  {isJoining ? <Loader2 size={16} className="animate-spin mx-auto" /> : 'Entra nel Magazzino'}
                </button>
              </form>
            </section>

            {/* ===== ELIMINAZIONE ACCOUNT ===== */}
            <section className="bg-[#0f0f0f] border border-red-500/[0.12] rounded-2xl p-5">
              <div className="flex items-center gap-2 mb-1">
                <AlertTriangle size={15} className="text-red-500/60" />
                <h3 className="font-semibold text-sm text-red-400/80">Eliminazione Account</h3>
              </div>
              <p className="text-[11px] text-gray-600 mb-4">
                L'eliminazione dell'account è permanente e irreversibile. Tutti i tuoi prodotti, dati e accessi verranno cancellati definitivamente.
              </p>
              <button onClick={() => setDeleteAccountStep(1)}
                className="px-4 py-2 rounded-xl border border-red-500/30 text-red-400/70 text-xs font-semibold hover:bg-red-500/10 hover:text-red-400 transition-colors">
                Elimina il mio account
              </button>
            </section>

          </div>
        )}
      </main>
      
      {/* ========== FAB MOBILE ========== */}
      <button
        onClick={() => setIsFormOpen(true)}
        className="lg:hidden fixed z-40 bg-[#ff4d00] rounded-full shadow-xl flex items-center justify-center active:scale-90 transition-all"
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
        <div className="absolute inset-0 bg-[#080808]/70 backdrop-blur-2xl" />
        {/* Separatore appena percettibile */}
        <div className="absolute top-0 left-0 right-0 h-px bg-white/[0.04]" />

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
                  active ? 'text-white' : 'text-white/25'
                }`}>
                <div className="relative">
                  <Icon size={22} strokeWidth={active ? 2 : 1.5} />
                  {badge > 0 && (
                    <span className="absolute -top-1 -right-1.5 w-3.5 h-3.5 bg-[#ff4d00] text-white rounded-full text-[8px] font-bold flex items-center justify-center">
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
          <div className="bg-[#0f0f0f] border-t sm:border border-white/[0.07] rounded-t-3xl sm:rounded-3xl w-full max-w-2xl max-h-[92vh] overflow-y-auto">
            {/* Drag handle (solo mobile) */}
            <div className="flex justify-center pt-3 pb-1 sm:hidden">
              <div className="w-10 h-1 bg-gray-700 rounded-full" />
            </div>
            <div className="sticky top-0 bg-[#0f0f0f] border-b border-white/[0.05] p-5 flex items-center justify-between z-10">
              <div>
                <h2 className="text-xl font-semibold">Aggiungi Prodotto</h2>
                <button type="button"
                  onClick={() => { setIsFormOpen(false); setLotCategory(userCategories[0] || ''); setLotOpen(true); }}
                  className="text-[11px] text-gray-600 hover:text-gray-400 transition-colors mt-0.5 flex items-center gap-1">
                  <Layers size={10} /> Stai comprando un lotto? Clicca qui
                </button>
              </div>
              <button onClick={() => setIsFormOpen(false)}
                className="p-2 hover:bg-white/5 rounded-lg transition-colors">
                <X size={20} />
              </button>
            </div>
            
            <form onSubmit={handleSave} className="p-5 space-y-5">
              
              {/* Tabs categoria */}
              <div>
                <label className="text-[10px] font-bold text-gray-500 uppercase tracking-widest block mb-2">Reparto</label>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {userCategories.map((cat: string) => (
                    <button key={cat} type="button" onClick={() => setCategory(cat)}
                      className={`p-3 rounded-xl text-sm font-bold border transition-all ${
                        category === cat 
                          ? 'bg-[#ff4d00]/10 border-[#ff4d00] text-white' 
                          : 'bg-[#0a0a0a] border-white/[0.07] text-gray-500 hover:border-gray-600'
                      }`}>
                      <span className="block text-xl mb-1">{getCategoryIcon(cat)}</span>
                      {cat}
                    </button>
                  ))}
                </div>
              </div>
              
              {/* FOTO + IA SCAN — multi-foto (max 5) */}
              <div className="bg-gradient-to-br from-purple-500/10 to-[#ff4d00]/10 border border-purple-500/30 rounded-2xl p-4">
                <div className="flex items-center justify-between mb-2">
                  <label className="flex items-center gap-2">
                    <Sparkles className="text-purple-400" size={16} />
                    <span className="text-xs font-bold text-white">Foto + Analisi IA</span>
                  </label>
                  <span className="text-[10px] text-gray-500">{productPhotos.length}/5 foto</span>
                </div>
                <p className="text-[10px] text-gray-400 mb-3">
                  Aggiungi 1–5 foto. La prima scatena l'IA (riconoscimento + prezzo + legit check). Puoi ri-scansionare qualsiasi foto.
                </p>

                {/* Griglia foto */}
                <div className="grid grid-cols-5 gap-2 mb-3">
                  {productPhotos.map((photo, i) => (
                    <div key={i} className="relative aspect-square rounded-xl overflow-hidden bg-[#0a0a0a] border border-purple-500/30">
                      <img src={photo} alt={`foto ${i + 1}`} className="w-full h-full object-cover" />
                      <button type="button" onClick={() => removePhoto(i)}
                        className="absolute top-1 right-1 w-5 h-5 bg-black/70 rounded-full flex items-center justify-center hover:bg-red-600 transition-colors">
                        <X size={10} />
                      </button>
                      <button type="button" onClick={() => runAIScan(photo, category)}
                        disabled={isScanning}
                        className="absolute bottom-0 left-0 right-0 bg-purple-600/80 hover:bg-purple-500/90 py-0.5 text-[9px] font-bold text-center transition-colors disabled:opacity-40">
                        Scansiona
                      </button>
                    </div>
                  ))}
                  {productPhotos.length < 5 && (
                    <label className={`aspect-square rounded-xl border-2 border-dashed border-purple-500/30 hover:border-purple-500 flex flex-col items-center justify-center cursor-pointer transition-colors ${isScanning ? 'pointer-events-none opacity-40' : ''}`}>
                      <input type="file" accept="image/*" multiple className="hidden"
                        onChange={(e: any) => handlePhotoAdd(e, false)} disabled={isScanning} />
                      {isScanning ? (
                        <Loader2 className="animate-spin text-purple-400" size={18} />
                      ) : (
                        <>
                          <Camera size={18} className="text-purple-400 mb-1" />
                          <span className="text-[9px] text-gray-500">Aggiungi</span>
                        </>
                      )}
                    </label>
                  )}
                </div>

                {isScanning && (
                  <p className="text-xs text-purple-400 flex items-center gap-2 mb-2">
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
                      {scanResult.brand && <p>{scanResult.brand} {scanResult.model}</p>}
                      {scanResult.warnings?.map((w: any, i: number) => <p key={i}>⚠️ {w}</p>)}
                    </div>
                    {authResult && (
                      <>
                        {verdictBadge(authResult.verdict, authResult.score)}
                        {authResult.redFlags?.length > 0 && (
                          <div className="bg-red-500/5 rounded-lg p-2">
                            <p className="text-red-400 font-bold mb-1">🚩 Red flags:</p>
                            {authResult.redFlags.map((f: string, i: number) => <p key={i} className="text-gray-400">• {f}</p>)}
                          </div>
                        )}
                        {authResult.greenFlags?.length > 0 && (
                          <div className="bg-green-500/5 rounded-lg p-2">
                            <p className="text-green-400 font-bold mb-1">✓ Positivi:</p>
                            {authResult.greenFlags.map((f: string, i: number) => <p key={i} className="text-gray-400">• {f}</p>)}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
              
              {/* Form campi specifici per categoria */}
              {category === 'Pokemon' ? (
                <>
                  <div>
                    <label className="text-[10px] font-bold text-gray-500 uppercase tracking-widest block mb-2">Nome Carta</label>
                    <input type="text" required value={pokeName}
                      onChange={(e: any) => setPokeName(e.target.value)}
                      placeholder="Es. Charizard 4/102"
                      className="w-full bg-[#0a0a0a] border border-white/[0.07] rounded-xl p-3 text-sm focus:border-[#ff4d00] outline-none" />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-[10px] font-bold text-gray-500 uppercase tracking-widest block mb-2">Gradata?</label>
                      <select value={pokeGraded} onChange={(e: any) => setPokeGraded(e.target.value)}
                        className="w-full bg-[#0a0a0a] border border-white/[0.07] rounded-xl p-3 text-sm focus:border-[#ff4d00] outline-none">
                        <option value="No">No (Raw)</option>
                        <option value="Si">Sì</option>
                      </select>
                    </div>
                    {pokeGraded === 'Si' && (
                      <div>
                        <label className="text-[10px] font-bold text-gray-500 uppercase tracking-widest block mb-2">Grade</label>
                        <input type="text" value={pokeGrade}
                          onChange={(e: any) => setPokeGrade(e.target.value)}
                          placeholder="10, 9.5..."
                          className="w-full bg-[#0a0a0a] border border-white/[0.07] rounded-xl p-3 text-sm focus:border-[#ff4d00] outline-none" />
                      </div>
                    )}
                  </div>
                </>
              ) : category === 'Orologi' ? (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-[10px] font-bold text-gray-500 uppercase tracking-widest block mb-2">Brand</label>
                      <input type="text" required value={watchBrand}
                        onChange={(e: any) => setWatchBrand(e.target.value)}
                        placeholder="Rolex" 
                        className="w-full bg-[#0a0a0a] border border-white/[0.07] rounded-xl p-3 text-sm focus:border-[#ff4d00] outline-none" />
                    </div>
                    <div>
                      <label className="text-[10px] font-bold text-gray-500 uppercase tracking-widest block mb-2">Modello</label>
                      <input type="text" required value={watchModel}
                        onChange={(e: any) => setWatchModel(e.target.value)}
                        placeholder="Submariner"
                        className="w-full bg-[#0a0a0a] border border-white/[0.07] rounded-xl p-3 text-sm focus:border-[#ff4d00] outline-none" />
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <label className="text-[10px] font-bold text-gray-500 uppercase tracking-widest block mb-2">Cassa</label>
                      <input type="text" value={watchCase}
                        onChange={(e: any) => setWatchCase(e.target.value)}
                        placeholder="41mm"
                        className="w-full bg-[#0a0a0a] border border-white/[0.07] rounded-xl p-3 text-sm focus:border-[#ff4d00] outline-none" />
                    </div>
                    <div>
                      <label className="text-[10px] font-bold text-gray-500 uppercase tracking-widest block mb-2">Cinturino</label>
                      <input type="text" value={watchStrap}
                        onChange={(e: any) => setWatchStrap(e.target.value)}
                        placeholder="Oyster"
                        className="w-full bg-[#0a0a0a] border border-white/[0.07] rounded-xl p-3 text-sm focus:border-[#ff4d00] outline-none" />
                    </div>
                    <div>
                      <label className="text-[10px] font-bold text-gray-500 uppercase tracking-widest block mb-2">Materiale</label>
                      <input type="text" value={watchMaterial}
                        onChange={(e: any) => setWatchMaterial(e.target.value)}
                        placeholder="Acciaio"
                        className="w-full bg-[#0a0a0a] border border-white/[0.07] rounded-xl p-3 text-sm focus:border-[#ff4d00] outline-none" />
                    </div>
                  </div>
                  <div>
                    <label className="text-[10px] font-bold text-gray-500 uppercase tracking-widest block mb-2">Condizione</label>
                    <select value={condition} onChange={(e: any) => setCondition(e.target.value)}
                      className="w-full bg-[#0a0a0a] border border-white/[0.07] rounded-xl p-3 text-sm focus:border-[#ff4d00] outline-none">
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
                              <label className="text-[10px] font-bold text-gray-500 uppercase tracking-widest block mb-2">
                                {f.label}{!f.required && <span className="text-gray-700 normal-case font-normal ml-1">(opz.)</span>}
                              </label>
                              {f.type === 'select' ? (
                                <select value={val} onChange={(e: any) => setVal(e.target.value)}
                                  required={f.required}
                                  className="w-full bg-[#0a0a0a] border border-white/[0.07] rounded-xl p-3 text-sm focus:border-[#ff4d00] outline-none">
                                  <option value="">Seleziona...</option>
                                  {(f.options || []).map((opt: string) => <option key={opt} value={opt}>{opt}</option>)}
                                </select>
                              ) : (
                                <input type={f.type === 'number' ? 'number' : 'text'}
                                  value={val} onChange={(e: any) => setVal(e.target.value)}
                                  required={f.required}
                                  placeholder={f.placeholder || ''}
                                  className="w-full bg-[#0a0a0a] border border-white/[0.07] rounded-xl p-3 text-sm focus:border-[#ff4d00] outline-none" />
                              )}
                            </div>
                          );
                        })}
                        {/* Condizione dal config AI */}
                        <div>
                          <label className="text-[10px] font-bold text-gray-500 uppercase tracking-widest block mb-2">Condizione</label>
                          <select value={condition} onChange={(e: any) => setCondition(e.target.value)}
                            className="w-full bg-[#0a0a0a] border border-white/[0.07] rounded-xl p-3 text-sm focus:border-[#ff4d00] outline-none">
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
                      <label className="text-[10px] font-bold text-gray-500 uppercase tracking-widest block mb-2">Brand</label>
                      <input type="text" required value={brand}
                        onChange={(e: any) => setBrand(e.target.value)}
                        placeholder={category === 'Scarpe' ? 'Nike' : category === 'Vestiti' ? 'Supreme' : 'Louis Vuitton'}
                        className="w-full bg-[#0a0a0a] border border-white/[0.07] rounded-xl p-3 text-sm focus:border-[#ff4d00] outline-none" />
                    </div>
                    <div>
                      <label className="text-[10px] font-bold text-gray-500 uppercase tracking-widest block mb-2">Modello</label>
                      <input type="text" required value={name}
                        onChange={(e: any) => setName(e.target.value)}
                        placeholder={category === 'Scarpe' ? 'Air Jordan 1 Chicago' : category === 'Vestiti' ? 'Box Logo Hoodie' : 'Neverfull MM'}
                        className="w-full bg-[#0a0a0a] border border-white/[0.07] rounded-xl p-3 text-sm focus:border-[#ff4d00] outline-none" />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      {/* Taglia — sempre input libero con suggerimenti datalist */}
                      <label className="text-[10px] font-bold text-gray-500 uppercase tracking-widest block mb-2">
                        {category === 'Scarpe' ? 'Taglia (EU)' : category === 'Vestiti' ? 'Taglia' : 'Dimensione / Taglia'}
                      </label>
                      <input
                        list={`size-suggestions-${category}`}
                        value={size}
                        onChange={(e: any) => setSize(e.target.value)}
                        placeholder={category === 'Scarpe' ? 'es. 42, 42.5, US 9' : category === 'Vestiti' ? 'es. M, L, XL' : 'es. MM, 30cm, Small'}
                        className="w-full bg-[#0a0a0a] border border-white/[0.07] rounded-xl p-3 text-sm focus:border-[#ff4d00] outline-none"
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
                      <label className="text-[10px] font-bold text-gray-500 uppercase tracking-widest block mb-2">Condizione</label>
                      <select value={condition} onChange={(e: any) => setCondition(e.target.value)}
                        className="w-full bg-[#0a0a0a] border border-white/[0.07] rounded-xl p-3 text-sm focus:border-[#ff4d00] outline-none">
                        <option value="DS">DS (Nuovo)</option>
                        <option value="VNDS">VNDS (Quasi nuovo)</option>
                        <option value="Used">Used (Usato)</option>
                        <option value="Worn">Worn (Molto usato)</option>
                      </select>
                    </div>
                  </div>
                  {/* Campi dinamici dalla CategoryTemplate (JSONB) */}
                  {activeTemplate && activeTemplate.fields?.length > 0 && (
                    <div className="border-t border-white/[0.07] pt-4">
                      <p className="text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-3">Dettagli Categoria</p>
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
                  <label className="text-[10px] font-bold text-gray-500 uppercase tracking-widest block mb-2">Prezzo Acquisto €</label>
                  <input type="number" step="0.01" required value={price}
                    onChange={(e: any) => setPrice(e.target.value)}
                    className="w-full bg-[#0a0a0a] border border-white/[0.07] rounded-xl p-3 text-sm focus:border-[#ff4d00] outline-none" />
                </div>
                <div>
                  <label className="text-[10px] font-bold text-gray-500 uppercase tracking-widest block mb-2">Quantità</label>
                  <input type="number" min="1" required value={quantity}
                    onChange={(e: any) => setQuantity(e.target.value)}
                    className="w-full bg-[#0a0a0a] border border-white/[0.07] rounded-xl p-3 text-sm focus:border-[#ff4d00] outline-none" />
                </div>
              </div>
              
              {/* Quote del team */}
              {(() => {
                const currentTeam = teamData.find((t: any) => t.warehouseName.replace('Magazzino ', '') === category);
                if (!currentTeam || currentTeam.members.length <= 1) return null;
                return (
                  <div className="border-t border-white/[0.07] pt-4">
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-2">
                        <Users size={14} className="text-blue-400" />
                        <span className="text-sm font-bold">Quote del Team</span>
                      </div>
                      {!isSharedPurchase ? (
                        <button type="button"
                          onClick={() => setIsSharedPurchase(true)}
                          className="text-xs text-white hover:text-[#ff6a2a] font-bold transition-colors">
                          Cambia percentuali
                        </button>
                      ) : (
                        <button type="button"
                          onClick={() => { setIsSharedPurchase(false); setProductShares([]); }}
                          className="text-xs text-gray-500 hover:text-white font-bold transition-colors">
                          Ripristina default
                        </button>
                      )}
                    </div>

                    {!isSharedPurchase ? (
                      <div className="space-y-2">
                        {currentTeam.members.map((m: any) => (
                          <div key={m.userId} className="flex items-center gap-3 bg-[#0a0a0a] p-3 rounded-xl">
                            <span className="font-bold text-sm flex-1">{m.name}</span>
                            <span className="text-gray-400 text-sm font-bold w-12 text-right">{m.percentage}%</span>
                          </div>
                        ))}
                        <p className="text-[10px] text-gray-600 mt-1">Quote default del team — modifica in Impostazioni</p>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {productShares.map((s: any, i: number) => (
                          <div key={s.userId} className="flex items-center gap-3 bg-[#0a0a0a] p-3 rounded-xl">
                            <span className="font-bold text-sm flex-1">{s.name}</span>
                            <input type="number" min="0" max="100" value={s.percentage}
                              onChange={(e: any) => {
                                const newShares = [...productShares];
                                newShares[i].percentage = e.target.value;
                                setProductShares(newShares);
                              }}
                              className="w-20 bg-[#0f0f0f] border border-white/[0.05] rounded-lg px-3 py-1.5 text-sm text-right" />
                            <span className="text-gray-500 text-xs">%</span>
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
                className="w-full bg-[#ff4d00] hover:bg-[#ff6a2a] py-3 rounded-xl font-bold transition-colors disabled:opacity-50 flex items-center justify-center">
                {isSaving ? <Loader2 className="animate-spin" size={20} /> : 'Salva Prodotto'}
              </button>
            </form>
          </div>
        </div>
      )}
      
      {/* ========== MODALE: VENDI ========== */}
      {sellModalOpen && productToSell && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
          <div className="bg-[#0f0f0f] border-t sm:border border-white/[0.07] rounded-t-3xl sm:rounded-3xl w-full max-w-md max-h-[92vh] overflow-y-auto">
            <div className="flex justify-center pt-3 pb-1 sm:hidden"><div className="w-10 h-1 bg-gray-700 rounded-full" /></div>
            <div className="sticky top-0 bg-[#0f0f0f] border-b border-white/[0.05] p-5 flex items-center justify-between">
              <h2 className="text-xl font-semibold">Registra Vendita</h2>
              <button onClick={() => setSellModalOpen(false)}
                className="p-2 hover:bg-white/5 rounded-lg transition-colors">
                <X size={20} />
              </button>
            </div>
            
            <form onSubmit={confirmSell} className="p-5 space-y-4">
              <p className="text-sm text-gray-400">{productToSell.name}</p>
              
              
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] font-bold text-gray-500 uppercase tracking-widest block mb-2">Quantità</label>
                  <input type="number" min="1" max={productToSell.maxQty}
                    value={sellQuantity} onChange={(e: any) => setSellQuantity(e.target.value)}
                    className="w-full bg-[#0a0a0a] border border-white/[0.07] rounded-xl p-3 text-sm focus:border-[#ff4d00] outline-none" />
                  <p className="text-[10px] text-gray-500 mt-1">Max disponibile: {productToSell.maxQty}</p>
                </div>
                <div>
                  <label className="text-[10px] font-bold text-gray-500 uppercase tracking-widest block mb-2">Prezzo Totale €</label>
                  <input type="number" step="0.01" required value={sellPrice}
                    onChange={(e: any) => setSellPrice(e.target.value)}
                    className="w-full bg-[#0a0a0a] border border-white/[0.07] rounded-xl p-3 text-sm focus:border-[#ff4d00] outline-none" />
                </div>
              </div>
              
              <div>
                <label className="text-[10px] font-bold text-gray-500 uppercase tracking-widest block mb-2">Piattaforma</label>
                <select value={sellPlatform} onChange={(e: any) => setSellPlatform(e.target.value)}
                  className="w-full bg-[#0a0a0a] border border-white/[0.07] rounded-xl p-3 text-sm focus:border-[#ff4d00] outline-none">
                  <option value="Vinted">Vinted</option>
                  <option value="Subito">Subito</option>
                  <option value="StockX">StockX (12% fee)</option>
                  <option value="eBay">eBay</option>
                  <option value="Privato">Privato</option>
                </select>
              </div>
              
              <div>
                <label className="text-[10px] font-bold text-gray-500 uppercase tracking-widest block mb-2">Metodo Pagamento</label>
                <select value={sellPaymentMethod} onChange={(e: any) => setSellPaymentMethod(e.target.value)}
                  className="w-full bg-[#0a0a0a] border border-white/[0.07] rounded-xl p-3 text-sm focus:border-[#ff4d00] outline-none">
                  <option>Nessuna Fee (Contanti/Bonifico)</option>
                  <option>PayPal Beni e Servizi</option>
                </select>
              </div>
              
              <div className="bg-[#0a0a0a] p-3 rounded-xl space-y-1.5">
                <div className="flex justify-between text-xs">
                  <span className="text-gray-500">Fees calcolate</span>
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
                      <div className="flex justify-between text-xs border-t border-white/[0.07] pt-1.5">
                        <span className="text-gray-500">Profitto atteso</span>
                        <span className={`font-bold ${profit >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                          {profit >= 0 ? '+' : ''}{profit.toFixed(2)}€
                        </span>
                      </div>
                      <div className="flex justify-between text-xs">
                        <span className="text-gray-500">Margine</span>
                        <span className={`font-bold ${margin >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                          {margin >= 0 ? '+' : ''}{margin.toFixed(1)}%
                        </span>
                      </div>
                    </>
                  );
                })()}
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
          <div className="bg-[#0f0f0f] border-t sm:border border-white/[0.07] rounded-t-3xl sm:rounded-3xl w-full max-w-md max-h-[92vh] overflow-y-auto">
            <div className="flex justify-center pt-3 pb-1 sm:hidden"><div className="w-10 h-1 bg-gray-700 rounded-full" /></div>
            <div className="sticky top-0 bg-[#0f0f0f] border-b border-white/[0.05] p-5 flex items-center justify-between">
              <h2 className="text-xl font-semibold">Modifica Prodotto</h2>
              <button onClick={() => setEditModalOpen(false)}
                className="p-2 hover:bg-white/5 rounded-lg transition-colors">
                <X size={20} />
              </button>
            </div>
            
            <form onSubmit={handleSaveEdit} className="p-5 space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] font-bold text-gray-500 uppercase tracking-widest block mb-2">Brand</label>
                  <input type="text" required value={editBrand}
                    onChange={(e: any) => setEditBrand(e.target.value)}
                    className="w-full bg-[#0a0a0a] border border-white/[0.07] rounded-xl p-3 text-sm focus:border-[#ff4d00] outline-none" />
                </div>
                <div>
                  <label className="text-[10px] font-bold text-gray-500 uppercase tracking-widest block mb-2">Nome</label>
                  <input type="text" required value={editName}
                    onChange={(e: any) => setEditName(e.target.value)}
                    className="w-full bg-[#0a0a0a] border border-white/[0.07] rounded-xl p-3 text-sm focus:border-[#ff4d00] outline-none" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] font-bold text-gray-500 uppercase tracking-widest block mb-2">Taglia</label>
                  <input type="text" value={editSize}
                    onChange={(e: any) => setEditSize(e.target.value)}
                    className="w-full bg-[#0a0a0a] border border-white/[0.07] rounded-xl p-3 text-sm focus:border-[#ff4d00] outline-none" />
                </div>
                <div>
                  <label className="text-[10px] font-bold text-gray-500 uppercase tracking-widest block mb-2">Condizione</label>
                  <input type="text" value={editCondition}
                    onChange={(e: any) => setEditCondition(e.target.value)}
                    className="w-full bg-[#0a0a0a] border border-white/[0.07] rounded-xl p-3 text-sm focus:border-[#ff4d00] outline-none" />
                </div>
              </div>
              <div>
                <label className="text-[10px] font-bold text-gray-500 uppercase tracking-widest block mb-2">Prezzo Acquisto €</label>
                <input type="number" step="0.01" required value={editPrice}
                  onChange={(e: any) => setEditPrice(e.target.value)}
                  className="w-full bg-[#0a0a0a] border border-white/[0.07] rounded-xl p-3 text-sm focus:border-[#ff4d00] outline-none" />
              </div>

              {/* Foto prodotto nel modale modifica */}
              <div className="border-t border-white/[0.07] pt-4">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <Camera size={14} className="text-purple-400" />
                    <span className="text-sm font-bold">Foto</span>
                  </div>
                  <span className="text-[10px] text-gray-500">{editPhotos.length}/5</span>
                </div>
                <div className="grid grid-cols-5 gap-2">
                  {editPhotos.map((photo, i) => (
                    <div key={i} className="relative aspect-square rounded-xl overflow-hidden bg-[#0a0a0a] border border-white/[0.07]">
                      <img src={photo} alt={`foto ${i + 1}`} className="w-full h-full object-cover" />
                      <button type="button" onClick={() => removePhoto(i, true)}
                        className="absolute top-1 right-1 w-5 h-5 bg-black/70 rounded-full flex items-center justify-center hover:bg-red-600 transition-colors">
                        <X size={10} />
                      </button>
                    </div>
                  ))}
                  {editPhotos.length < 5 && (
                    <label className="aspect-square rounded-xl border-2 border-dashed border-gray-700 hover:border-purple-500 flex flex-col items-center justify-center cursor-pointer transition-colors">
                      <input type="file" accept="image/*" multiple className="hidden"
                        onChange={(e: any) => handlePhotoAdd(e, true)} />
                      <Camera size={16} className="text-gray-500 mb-0.5" />
                      <span className="text-[9px] text-gray-500">Aggiungi</span>
                    </label>
                  )}
                </div>
              </div>

              {/* Quote del team nel modale di modifica */}
              {(() => {
                const currentTeam = teamData.find((t: any) => t.warehouseName.replace('Magazzino ', '') === productToEdit?.category);
                if (!currentTeam || currentTeam.members.length <= 1) return null;
                return (
                  <div className="border-t border-white/[0.07] pt-4">
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
                          className="text-xs text-white hover:text-[#ff6a2a] font-bold transition-colors">
                          Cambia percentuali
                        </button>
                      ) : (
                        <button type="button"
                          onClick={() => { setIsEditShared(false); setEditShares([]); }}
                          className="text-xs text-gray-500 hover:text-white font-bold transition-colors">
                          Ripristina default
                        </button>
                      )}
                    </div>
                    {!isEditShared ? (
                      <div className="space-y-2">
                        {currentTeam.members.map((m: any) => (
                          <div key={m.userId} className="flex items-center gap-3 bg-[#0a0a0a] p-3 rounded-xl">
                            <span className="font-bold text-sm flex-1">{m.name}</span>
                            <span className="text-gray-400 text-sm font-bold w-12 text-right">{m.percentage}%</span>
                          </div>
                        ))}
                        <p className="text-[10px] text-gray-600 mt-1">Quote default del team — modifica in Impostazioni</p>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {editShares.map((s: any, i: number) => (
                          <div key={s.userId} className="flex items-center gap-3 bg-[#0a0a0a] p-3 rounded-xl">
                            <span className="font-bold text-sm flex-1">{s.name}</span>
                            <input type="number" min="0" max="100" value={s.percentage}
                              onChange={(e: any) => {
                                const ns = [...editShares];
                                ns[i].percentage = e.target.value;
                                setEditShares(ns);
                              }}
                              className="w-20 bg-[#0f0f0f] border border-white/[0.05] rounded-lg px-3 py-1.5 text-sm text-right" />
                            <span className="text-gray-500 text-xs">%</span>
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
                  className="flex-1 bg-[#ff4d00] hover:bg-[#ff6a2a] py-3 rounded-xl font-bold transition-colors disabled:opacity-50 flex items-center justify-center">
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
          <div className="bg-[#0f0f0f] border border-white/[0.05] rounded-3xl w-full max-w-md max-h-[90vh] overflow-y-auto">
            <div className="border-b border-white/[0.07] p-5 flex items-center justify-between">
              <h2 className="text-xl font-semibold flex items-center gap-2">
                <Shield className="text-white" size={20} /> Attiva 2FA
              </h2>
              <button onClick={() => { setTwoFaSetupOpen(false); setTwoFaBackupCodes(null); setTwoFaCode(''); }}
                className="p-2 hover:bg-white/5 rounded-lg transition-colors">
                <X size={20} />
              </button>
            </div>
            
            <div className="p-5 space-y-4">
              {!twoFaBackupCodes ? (
                <>
                  <div className="space-y-2 text-sm text-gray-400">
                    <p>1. Scarica un'app come <span className="text-white font-bold">Google Authenticator</span> o <span className="text-white font-bold">Authy</span></p>
                    <p>2. Scansiona il QR qui sotto</p>
                    <p>3. Inserisci il codice generato dall'app</p>
                  </div>
                  
                  {twoFaQR && (
                    <div className="bg-white p-4 rounded-2xl flex items-center justify-center">
                      <img src={twoFaQR} alt="QR 2FA" className="w-48 h-48" />
                    </div>
                  )}
                  
                  <div>
                    <label className="text-[10px] font-bold text-gray-500 uppercase tracking-widest block mb-2">Codice dall'app</label>
                    <input type="text" inputMode="numeric" value={twoFaCode}
                      onChange={(e: any) => setTwoFaCode(e.target.value)}
                      placeholder="000000" maxLength={6}
                      className="w-full bg-[#0a0a0a] border border-white/[0.07] rounded-xl p-3 text-center font-mono text-2xl tracking-widest focus:border-[#ff4d00] outline-none" />
                  </div>
                  
                  <button onClick={handle2FAVerify} disabled={twoFaLoading || twoFaCode.length !== 6}
                    className="w-full bg-[#ff4d00] hover:bg-[#ff6a2a] py-3 rounded-xl font-bold transition-colors disabled:opacity-50 flex items-center justify-center">
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
                  
                  <div className="bg-[#0a0a0a] border border-white/[0.07] rounded-xl p-4">
                    <p className="text-xs font-bold text-gray-500 mb-3 uppercase tracking-widest">Codici di Backup</p>
                    <div className="grid grid-cols-2 gap-2 font-mono text-sm">
                      {twoFaBackupCodes.map((c: string, i: number) => (
                        <div key={i} className="bg-[#0f0f0f] p-2 rounded text-center">{c}</div>
                      ))}
                    </div>
                    <button onClick={() => {
                      navigator.clipboard.writeText(twoFaBackupCodes.join('\n'));
                      showToast('Codici copiati!');
                    }}
                      className="mt-3 w-full bg-white/5 hover:bg-white/8 py-2 rounded-lg text-xs font-bold transition-colors flex items-center justify-center gap-2">
                      <Copy size={12} /> Copia tutti i codici
                    </button>
                  </div>
                  
                  <p className="text-xs text-yellow-400 bg-yellow-500/10 p-3 rounded-xl">
                    ⚠️ Ogni codice è usabile UNA SOLA VOLTA. Stampali o salvali in un password manager.
                  </p>
                  
                  <button onClick={() => { setTwoFaSetupOpen(false); setTwoFaBackupCodes(null); setTwoFaCode(''); }}
                    className="w-full bg-[#ff4d00] hover:bg-[#ff6a2a] py-3 rounded-xl font-bold transition-colors">
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
          <div className="bg-[#0f0f0f] border-t sm:border border-white/[0.07] rounded-t-3xl sm:rounded-3xl w-full max-w-md p-6">
            <div className="flex justify-center mb-4 sm:hidden"><div className="w-10 h-1 bg-gray-700 rounded-full" /></div>
            <div className="flex items-center gap-2 mb-5">
              <Shield className="text-red-400" size={20} />
              <h3 className="text-lg font-semibold">Disabilita 2FA</h3>
            </div>
            <div className="space-y-4">
              <div>
                <label className="text-[10px] font-bold text-gray-500 uppercase tracking-widest block mb-2">Password account</label>
                <input type="password" value={twoFaDisablePwd}
                  onChange={e => setTwoFaDisablePwd(e.target.value)}
                  placeholder="••••••••"
                  className="w-full bg-[#0a0a0a] border border-white/[0.07] rounded-xl p-3 text-white outline-none focus:border-red-500" />
              </div>
              <div>
                <label className="text-[10px] font-bold text-gray-500 uppercase tracking-widest block mb-2">Codice dall'app 2FA</label>
                <input type="text" inputMode="numeric" value={twoFaDisableOtp}
                  onChange={e => setTwoFaDisableOtp(e.target.value)}
                  maxLength={6} placeholder="000000"
                  className="w-full bg-[#0a0a0a] border border-white/[0.07] rounded-xl p-3 text-white font-mono text-center text-2xl tracking-widest outline-none focus:border-red-500" />
              </div>
              <button onClick={confirm2FADisable}
                disabled={!twoFaDisablePwd || twoFaDisableOtp.length < 6}
                className="w-full bg-red-600 hover:bg-red-500 disabled:opacity-40 py-3 rounded-xl font-bold text-sm transition-colors">
                Conferma disabilitazione
              </button>
              <button onClick={() => setTwoFaDisableOpen(false)}
                className="w-full bg-white/5 hover:bg-white/8 py-3 rounded-xl font-bold text-sm transition-colors">
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
            selectedGroupKeys.size > 0 ? 'border-[#ff4d00]/50' : 'border-gray-700'
          }`}>
            <button onClick={selectAllGroups}
              className="text-xs text-gray-500 hover:text-white font-bold transition-colors shrink-0 px-2">
              Tutti
            </button>
            <div className="flex-1 text-center">
              <span className="text-sm font-bold">
                {selectedGroupKeys.size > 0
                  ? `${getBulkSelectedIds().length} pezzi selezionati`
                  : 'Tocca le card per selezionare'}
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
          <div className="bg-[#0f0f0f] border-t sm:border border-white/[0.07] rounded-t-3xl sm:rounded-3xl w-full max-w-md p-6">
            <div className="flex justify-center mb-4 sm:hidden"><div className="w-10 h-1 bg-gray-700 rounded-full" /></div>
            <h2 className="text-xl font-semibold mb-1">Vendi in Blocco</h2>
            <p className="text-xs text-gray-500 mb-5">
              {getBulkSelectedIds().length} prodotti — stessa piattaforma e stesso prezzo unitario per tutti
            </p>
            <form onSubmit={handleBulkSell} className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] font-bold text-gray-500 uppercase tracking-widest block mb-2">Prezzo unitario €</label>
                  <input type="number" step="0.01" required value={bulkSellPrice}
                    onChange={e => setBulkSellPrice(e.target.value)}
                    className="w-full bg-[#0a0a0a] border border-white/[0.07] rounded-xl p-3 text-sm focus:border-[#ff4d00] outline-none" />
                </div>
                <div>
                  <label className="text-[10px] font-bold text-gray-500 uppercase tracking-widest block mb-2">Fees unitarie €</label>
                  <input type="number" step="0.01" value={bulkSellFees}
                    onChange={e => setBulkSellFees(e.target.value)}
                    className="w-full bg-[#0a0a0a] border border-white/[0.07] rounded-xl p-3 text-sm focus:border-[#ff4d00] outline-none" />
                </div>
              </div>
              <div>
                <label className="text-[10px] font-bold text-gray-500 uppercase tracking-widest block mb-2">Piattaforma</label>
                <select value={bulkSellPlatform} onChange={e => setBulkSellPlatform(e.target.value)}
                  className="w-full bg-[#0a0a0a] border border-white/[0.07] rounded-xl p-3 text-sm focus:border-[#ff4d00] outline-none">
                  <option>Vinted</option><option>Subito</option><option>StockX</option>
                  <option>eBay</option><option>Privato</option>
                </select>
              </div>
              <div className="flex gap-3 pt-1">
                <button type="button" onClick={() => setBulkSellOpen(false)}
                  className="flex-1 bg-white/5 hover:bg-white/8 py-3 rounded-xl font-bold text-sm transition-colors">
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
          <div className="bg-[#0f0f0f] border-t sm:border border-white/[0.07] rounded-t-3xl sm:rounded-3xl w-full max-w-sm p-6">
            <div className="flex justify-center mb-4 sm:hidden"><div className="w-10 h-1 bg-gray-700 rounded-full" /></div>
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-red-500/20 flex items-center justify-center shrink-0">
                <Trash2 className="text-red-400" size={20} />
              </div>
              <div>
                <h3 className="font-semibold text-base">Elimina {getBulkSelectedIds().length} prodotti</h3>
                <p className="text-xs text-gray-500">Azione irreversibile</p>
              </div>
            </div>
            <div className="flex gap-3">
              <button onClick={() => setBulkDeleteConfirmOpen(false)}
                className="flex-1 bg-white/5 hover:bg-white/8 py-3 rounded-xl font-bold text-sm transition-colors">
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
          <div className="bg-[#0f0f0f] border-t sm:border border-white/[0.07] rounded-t-3xl sm:rounded-3xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex justify-center pt-3 pb-1 sm:hidden"><div className="w-10 h-1 bg-gray-700 rounded-full" /></div>
            <div className="sticky top-0 bg-[#0f0f0f] border-b border-white/[0.05] p-5 flex items-center justify-between z-10">
              <h2 className="text-xl font-semibold flex items-center gap-2">
                <Download size={20} className="text-white" /> Importa da Excel
              </h2>
              <button onClick={() => { setImportOpen(false); setImportRows([]); setImportErrors([]); }}
                className="p-2 hover:bg-white/5 rounded-lg transition-colors"><X size={20} /></button>
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
                <label className="text-[10px] font-bold text-gray-500 uppercase tracking-widest flex-1">
                  Reparto di default <span className="text-gray-600">(per righe senza colonna Categoria)</span>
                </label>
                <select value={importCategory} onChange={e => setImportCategory(e.target.value)}
                  className="bg-[#0a0a0a] border border-white/[0.07] rounded-lg px-3 py-2 text-sm focus:border-[#ff4d00] outline-none">
                  {userCategories.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>

              {importRows.length > 0 && (
                <>
                  <p className="text-sm font-bold">
                    <span className="text-white">{importRows.length}</span> righe trovate
                    {importRows.filter(r => !r.brand || !r.name || !r.price).length > 0 && (
                      <span className="text-red-400 ml-2 text-xs">
                        ({importRows.filter(r => !r.brand || !r.name || !r.price).length} con errori — verranno saltate)
                      </span>
                    )}
                  </p>
                  <div className="overflow-x-auto rounded-xl border border-white/[0.07]">
                    <table className="w-full text-xs">
                      <thead className="bg-[#0a0a0a] border-b border-white/[0.07]">
                        <tr>
                          {['Brand','Nome','Taglia','Cond.','Prezzo','Categoria'].map(h => (
                            <th key={h} className="px-3 py-2 text-left text-gray-500 font-bold">{h}</th>
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
                              <td className="px-3 py-2 text-gray-400">{r.size || '—'}</td>
                              <td className="px-3 py-2 text-gray-400">{r.condition || 'DS'}</td>
                              <td className="px-3 py-2">{r.price > 0 ? `€${r.price}` : <span className="text-red-400">⚠ {String(r.price)}</span>}</td>
                              <td className="px-3 py-2 text-gray-400">{r.category || <span className="text-blue-400">{importCategory}</span>}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                    {importRows.length > 12 && (
                      <p className="p-3 text-xs text-gray-500 text-center">...e altri {importRows.length - 12} prodotti</p>
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
                  className="flex-1 bg-white/5 hover:bg-white/8 py-3 rounded-xl font-bold text-sm transition-colors">
                  Annulla
                </button>
                <button onClick={confirmImport} disabled={isImporting || importRows.length === 0}
                  className="flex-1 bg-[#ff4d00] hover:bg-[#ff6a2a] disabled:opacity-50 py-3 rounded-xl font-bold text-sm transition-colors flex items-center justify-center gap-2">
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
          <div className="bg-[#0f0f0f] border-t sm:border border-white/[0.07] rounded-t-3xl sm:rounded-3xl w-full max-w-md">
            <div className="flex justify-center pt-3 pb-1 sm:hidden"><div className="w-10 h-1 bg-gray-700 rounded-full" /></div>
            <div className="p-5 border-b border-white/[0.05] flex items-center justify-between">
              <div>
                <h2 className="font-semibold text-base flex items-center gap-2">
                  <Layers size={16} className="text-gray-400" /> Crea Lotto
                </h2>
                <p className="text-[11px] text-gray-600 mt-0.5">Divide il costo totale tra tutti gli articoli</p>
              </div>
              <button onClick={() => setLotOpen(false)} className="p-2 hover:bg-white/[0.05] rounded-xl transition-colors">
                <X size={18} className="text-gray-400" />
              </button>
            </div>
            <form onSubmit={handleCreateLot} className="p-5 space-y-4">

              {/* Reparto */}
              <div>
                <label className="text-[10px] font-semibold text-gray-500 uppercase tracking-[0.1em] block mb-2">Reparto</label>
                <div className="grid grid-cols-2 gap-2">
                  {userCategories.map(cat => (
                    <button key={cat} type="button" onClick={() => setLotCategory(cat)}
                      className={`p-2.5 rounded-xl border text-sm font-semibold transition-colors flex items-center gap-2 ${
                        lotCategory === cat ? 'bg-white/[0.06] border-white/[0.15] text-white' : 'bg-[#0a0a0a] border-white/[0.06] text-gray-500'
                      }`}>
                      <span>{getCategoryIcon(cat)}</span> {cat}
                    </button>
                  ))}
                </div>
              </div>

              {/* Nome lotto */}
              <div>
                <label className="text-[10px] font-semibold text-gray-500 uppercase tracking-[0.1em] block mb-2">Nome Lotto</label>
                <input required value={lotName} onChange={e => setLotName(e.target.value)}
                  placeholder="Es: Bundle Pokemon Giugno, Lotto Scarpe Verano..."
                  className="w-full bg-[#0a0a0a] border border-white/[0.07] rounded-xl p-3 text-sm text-white placeholder-gray-600 focus:border-white/[0.2] outline-none" />
              </div>

              {/* Prezzo totale + numero pezzi */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] font-semibold text-gray-500 uppercase tracking-[0.1em] block mb-2">Prezzo Totale €</label>
                  <input required type="number" min="0.01" step="0.01" value={lotTotal} onChange={e => setLotTotal(e.target.value)}
                    placeholder="300"
                    className="w-full bg-[#0a0a0a] border border-white/[0.07] rounded-xl p-3 text-sm text-white placeholder-gray-600 focus:border-white/[0.2] outline-none" />
                </div>
                <div>
                  <label className="text-[10px] font-semibold text-gray-500 uppercase tracking-[0.1em] block mb-2">N° Articoli</label>
                  <input required type="number" min="2" max="200" step="1" value={lotQty} onChange={e => setLotQty(e.target.value)}
                    placeholder="10"
                    className="w-full bg-[#0a0a0a] border border-white/[0.07] rounded-xl p-3 text-sm text-white placeholder-gray-600 focus:border-white/[0.2] outline-none" />
                </div>
              </div>

              {/* Preview costo per articolo */}
              {lotTotal && lotQty && parseFloat(lotTotal) > 0 && parseInt(lotQty) >= 2 && (
                <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-3 flex items-center justify-between">
                  <span className="text-[12px] text-gray-500">Costo per articolo</span>
                  <span className="font-semibold text-white text-sm">
                    {(parseFloat(lotTotal) / parseInt(lotQty)).toFixed(2)}€
                  </span>
                </div>
              )}

              {/* Brand (opzionale) */}
              <div>
                <label className="text-[10px] font-semibold text-gray-500 uppercase tracking-[0.1em] block mb-2">Brand <span className="text-gray-700 normal-case font-normal">(opzionale)</span></label>
                <input value={lotBrand} onChange={e => setLotBrand(e.target.value)}
                  placeholder="Es: Pokémon, Nike, Rolex..."
                  className="w-full bg-[#0a0a0a] border border-white/[0.07] rounded-xl p-3 text-sm text-white placeholder-gray-600 focus:border-white/[0.2] outline-none" />
              </div>

              {/* Note */}
              <div>
                <label className="text-[10px] font-semibold text-gray-500 uppercase tracking-[0.1em] block mb-2">Note <span className="text-gray-700 normal-case font-normal">(opzionale)</span></label>
                <input value={lotNotes} onChange={e => setLotNotes(e.target.value)}
                  placeholder="Es: acquistato da privato, condizioni miste..."
                  className="w-full bg-[#0a0a0a] border border-white/[0.07] rounded-xl p-3 text-sm text-white placeholder-gray-600 focus:border-white/[0.2] outline-none" />
              </div>

              <div className="flex gap-2 pt-1">
                <button type="button" onClick={() => setLotOpen(false)}
                  className="flex-1 py-3 rounded-xl border border-white/[0.07] text-sm text-gray-400 hover:text-white transition-colors">
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
          <div className="bg-[#0f0f0f] border-t sm:border border-white/[0.07] rounded-t-3xl sm:rounded-3xl w-full max-w-md">
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
                    <p className="text-[11px] text-gray-500">Questa azione è permanente e irreversibile</p>
                  </div>
                </div>
                <div className="bg-red-500/[0.06] border border-red-500/[0.15] rounded-xl p-4 mb-5 space-y-1.5">
                  {['Tutti i tuoi prodotti e dati di vendita', 'Le foto dei prodotti', 'La tua cronologia e audit log', 'L\'accesso a tutti i magazzini', 'Il tuo account e le credenziali'].map(item => (
                    <div key={item} className="flex items-start gap-2 text-[12px] text-red-300/70">
                      <span className="text-red-500 mt-0.5 shrink-0">×</span> {item}
                    </div>
                  ))}
                </div>
                <p className="text-[11px] text-gray-600 mb-5">I tuoi soci non verranno eliminati. I prodotti condivisi resteranno visibili al team.</p>
                <div className="flex gap-2">
                  <button onClick={() => setDeleteAccountStep(0)}
                    className="flex-1 py-3 rounded-xl border border-white/[0.07] text-sm text-gray-400 hover:text-white transition-colors">
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
                <p className="text-[12px] text-gray-500 mb-4">Scrivi la tua email per confermare l'eliminazione</p>
                <p className="text-xs text-gray-600 bg-white/[0.03] border border-white/[0.05] rounded-xl p-3 mb-4 font-mono">{user?.email}</p>
                <input
                  value={deleteEmailConfirm}
                  onChange={e => setDeleteEmailConfirm(e.target.value)}
                  placeholder="Scrivi qui la tua email"
                  className="w-full bg-[#0a0a0a] border border-white/[0.07] rounded-xl p-3 text-sm focus:border-red-500/40 outline-none mb-4"
                  autoFocus
                />
                <div className="flex gap-2">
                  <button onClick={() => setDeleteAccountStep(1)}
                    className="flex-1 py-3 rounded-xl border border-white/[0.07] text-sm text-gray-400 transition-colors">
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
                <p className="text-[12px] text-gray-500 mb-4">Per sicurezza conferma la tua password attuale</p>
                <input
                  type="password"
                  value={deletePasswordConfirm}
                  onChange={e => setDeletePasswordConfirm(e.target.value)}
                  placeholder="Password attuale"
                  className="w-full bg-[#0a0a0a] border border-white/[0.07] rounded-xl p-3 text-sm focus:border-red-500/40 outline-none mb-4"
                  autoFocus
                />
                <div className="flex gap-2">
                  <button onClick={() => setDeleteAccountStep(2)}
                    className="flex-1 py-3 rounded-xl border border-white/[0.07] text-sm text-gray-400 transition-colors">
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
                <p className="text-[12px] text-gray-500 text-center mb-5">Una volta eliminato non potrai recuperare nulla</p>
                <label className="flex items-start gap-3 cursor-pointer mb-5 p-3 bg-red-500/[0.05] border border-red-500/[0.12] rounded-xl">
                  <input type="checkbox" checked={deleteCheckbox} onChange={e => setDeleteCheckbox(e.target.checked)}
                    className="mt-0.5 shrink-0 w-4 h-4 accent-red-500" />
                  <span className="text-[12px] text-gray-400 leading-relaxed">
                    Capisco che questa azione è permanente e che perderò tutti i miei dati, prodotti e accessi senza possibilità di recupero.
                  </span>
                </label>
                <div className="flex gap-2">
                  <button onClick={() => { setDeleteAccountStep(0); setDeleteEmailConfirm(''); setDeletePasswordConfirm(''); setDeleteCheckbox(false); }}
                    className="flex-1 py-3 rounded-xl border border-white/[0.07] text-sm text-gray-400 transition-colors">
                    Annulla
                  </button>
                  <button onClick={handleDeleteAccount}
                    disabled={!deleteCheckbox || isDeletingAccount}
                    className="flex-1 py-3 rounded-xl bg-red-600 text-white text-sm font-semibold disabled:opacity-40 hover:bg-red-700 transition-colors">
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
          <div className="bg-[#0f0f0f] border border-white/[0.08] lg:rounded-2xl p-5 shadow-2xl border-t lg:border">
            <div className="flex items-start gap-3 mb-4">
              <div className="text-lg shrink-0">🍪</div>
              <div>
                <p className="text-sm font-semibold text-white mb-1">Informativa Cookie</p>
                <p className="text-[12px] text-gray-500 leading-relaxed">
                  Usiamo solo cookie <span className="text-gray-300">strettamente necessari</span> per l'autenticazione e il funzionamento dell'app. Nessun cookie di marketing o profilazione.{' '}
                  <button onClick={() => setPrivacyOpen(true)} className="text-white underline underline-offset-2 hover:no-underline">
                    Privacy Policy
                  </button>
                </p>
              </div>
            </div>
            <div className="flex gap-2">
              <button onClick={() => setPrivacyOpen(true)}
                className="flex-1 py-2 rounded-xl border border-white/[0.07] text-xs text-gray-400 hover:text-white transition-colors">
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

      {/* ========== MODALE: PRIVACY POLICY ========== */}
      {privacyOpen && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-end sm:items-center justify-center z-[110] p-0 sm:p-4">
          <div className="bg-[#0f0f0f] border-t sm:border border-white/[0.07] rounded-t-3xl sm:rounded-3xl w-full max-w-2xl max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between p-5 border-b border-white/[0.05] shrink-0">
              <div>
                <h2 className="font-semibold text-base">Privacy Policy & Cookie</h2>
                <p className="text-[11px] text-gray-500 mt-0.5">Ultimo aggiornamento: {new Date().toLocaleDateString('it-IT', { year: 'numeric', month: 'long' })}</p>
              </div>
              <button onClick={() => setPrivacyOpen(false)} className="p-2 hover:bg-white/[0.05] rounded-xl transition-colors">
                <X size={18} className="text-gray-400" />
              </button>
            </div>
            <div className="overflow-y-auto p-5 space-y-5 text-[13px] text-gray-400 leading-relaxed">

              <section>
                <h3 className="text-white font-semibold text-sm mb-2">1. Titolare del Trattamento</h3>
                <p>Il titolare del trattamento dei dati personali è l'operatore dell'account HQ. Per qualsiasi richiesta relativa ai dati personali, contatta il responsabile della piattaforma.</p>
              </section>

              <section>
                <h3 className="text-white font-semibold text-sm mb-2">2. Dati Raccolti</h3>
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
                      <span className="text-gray-600 mt-0.5">—</span>
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </section>

              <section>
                <h3 className="text-white font-semibold text-sm mb-2">3. Finalità del Trattamento</h3>
                <p>I dati sono trattati esclusivamente per:</p>
                <ul className="space-y-1 mt-2 list-none">
                  {[
                    'Fornitura del servizio di gestione magazzino',
                    'Autenticazione e sicurezza dell\'account',
                    'Funzionalità team e condivisione dati tra soci',
                    'Prevenzione di accessi non autorizzati',
                  ].map(item => (
                    <li key={item} className="flex items-start gap-2">
                      <span className="text-gray-600 mt-0.5">—</span>
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </section>

              <section>
                <h3 className="text-white font-semibold text-sm mb-2">4. Cookie Utilizzati</h3>
                <p className="mb-3">HQ utilizza <span className="text-white">esclusivamente cookie tecnici strettamente necessari</span>, non richiesti dal consenso ai sensi dell'art. 122 D.Lgs. 196/2003 e delle Linee Guida Garante.</p>
                <div className="bg-white/[0.03] border border-white/[0.05] rounded-xl overflow-hidden">
                  <div className="grid grid-cols-3 text-[11px] font-semibold text-gray-500 p-3 border-b border-white/[0.05] uppercase tracking-wider">
                    <span>Nome</span><span>Durata</span><span>Scopo</span>
                  </div>
                  {[
                    ['access_token', '15 minuti', 'Autenticazione sessione'],
                    ['refresh_token', '7 giorni', 'Rinnovo sessione automatico'],
                  ].map(([name, duration, purpose]) => (
                    <div key={name} className="grid grid-cols-3 text-[12px] p-3 border-b border-white/[0.03] last:border-0">
                      <span className="text-white font-mono">{name}</span>
                      <span>{duration}</span>
                      <span>{purpose}</span>
                    </div>
                  ))}
                </div>
                <p className="mt-3 text-[12px]">Nessun cookie di profilazione, marketing, analisi o terze parti è utilizzato.</p>
              </section>

              <section>
                <h3 className="text-white font-semibold text-sm mb-2">5. Base Giuridica</h3>
                <p>Il trattamento si basa sull'esecuzione del contratto di servizio (art. 6.1.b GDPR) e sul legittimo interesse alla sicurezza della piattaforma (art. 6.1.f GDPR).</p>
              </section>

              <section>
                <h3 className="text-white font-semibold text-sm mb-2">6. Conservazione dei Dati</h3>
                <p>I dati dell'account sono conservati per tutta la durata del rapporto contrattuale. I log di sicurezza sono conservati per 90 giorni. Dopo la cancellazione dell'account, i dati vengono eliminati entro 30 giorni.</p>
              </section>

              <section>
                <h3 className="text-white font-semibold text-sm mb-2">7. Diritti dell'Interessato</h3>
                <p>Ai sensi del GDPR (artt. 15-22) hai il diritto di: accedere ai tuoi dati, rettificarli, richiederne la cancellazione, opporti al trattamento, richiedere la portabilità. Per esercitare i tuoi diritti, contatta il titolare del trattamento.</p>
              </section>

              <section>
                <h3 className="text-white font-semibold text-sm mb-2">8. Sicurezza</h3>
                <p>I dati sono protetti con crittografia AES-256, password hashate con bcrypt, autenticazione a due fattori (2FA), comunicazioni cifrate HTTPS, e token JWT con rotazione automatica.</p>
              </section>

              <section>
                <h3 className="text-white font-semibold text-sm mb-2">9. Comunicazioni Email</h3>
                <p>Previo consenso facoltativo espresso in fase di registrazione, HQ potrà inviare all'indirizzo email fornito comunicazioni relative ad aggiornamenti del servizio, nuove funzionalità e novità della piattaforma. Il consenso è revocabile in qualsiasi momento accedendo alle <span className="text-white">Impostazioni → Profilo</span> dell'app, senza pregiudizio per la liceità dei trattamenti effettuati prima della revoca. Il mancato consenso non pregiudica l'accesso al servizio.</p>
              </section>

              <section>
                <h3 className="text-white font-semibold text-sm mb-2">10. Modifiche alla Privacy Policy</h3>
                <p>Questa policy può essere aggiornata. Le modifiche sostanziali saranno comunicate tramite notifica in-app.</p>
              </section>

            </div>
            <div className="p-5 border-t border-white/[0.05] shrink-0">
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
          <div className="bg-[#0f0f0f] border-t sm:border border-white/[0.07] rounded-t-3xl sm:rounded-3xl w-full max-w-md">
            <div className="flex justify-center pt-3 pb-1 sm:hidden"><div className="w-10 h-1 bg-gray-700 rounded-full" /></div>
            <div className="p-5">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <StickyNote size={16} className="text-gray-400" />
                  <div>
                    <h3 className="font-semibold text-sm">{notesModalProduct.brand} {notesModalProduct.name}</h3>
                    <p className="text-[11px] text-gray-600">{notesModalProduct.size} · Note operative</p>
                  </div>
                </div>
                <button onClick={() => setNotesModalProduct(null)} className="p-1.5 hover:bg-white/[0.05] rounded-lg transition-colors">
                  <X size={16} className="text-gray-400" />
                </button>
              </div>
              <textarea
                value={notesInput}
                onChange={e => setNotesInput(e.target.value)}
                placeholder="Es: cinturino usurato, scatola mancante, graffio sul fondello, acquistato da privato..."
                className="w-full bg-[#0a0a0a] border border-white/[0.07] rounded-xl p-3.5 text-sm text-white placeholder-gray-600 focus:border-white/[0.15] outline-none resize-none"
                rows={4}
                autoFocus
              />
              <p className="text-[10px] text-gray-600 mt-1.5 mb-4">{notesInput.length}/500 caratteri</p>
              <div className="flex gap-2">
                <button onClick={() => setNotesModalProduct(null)}
                  className="flex-1 py-2.5 rounded-xl border border-white/[0.07] text-sm text-gray-400 hover:text-white transition-colors">
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
          <div className="bg-[#0f0f0f] border-t sm:border border-white/[0.07] rounded-t-3xl sm:rounded-3xl w-full max-w-sm p-6">
            <div className="flex justify-center mb-4 sm:hidden"><div className="w-10 h-1 bg-gray-700 rounded-full" /></div>
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-red-500/20 flex items-center justify-center">
                <Trash2 className="text-red-400" size={20} />
              </div>
              <div>
                <h3 className="font-semibold text-base">Elimina prodotto</h3>
                <p className="text-xs text-gray-500">Questa azione è irreversibile</p>
              </div>
            </div>
            <p className="text-sm text-gray-400 mb-6">
              Stai eliminando <span className="text-white font-bold">{productToDelete.brand} {productToDelete.name}</span>
              {productToDelete.quantity > 1 && ` (${productToDelete.quantity} pezzi)`}.
            </p>
            <div className="flex gap-3">
              <button onClick={() => setDeleteConfirmOpen(false)}
                className="flex-1 bg-white/5 hover:bg-white/8 py-3 rounded-xl font-bold text-sm transition-colors">
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
          <div className="bg-[#0f0f0f] border-t sm:border border-white/[0.07] rounded-t-3xl sm:rounded-3xl w-full max-w-sm p-6">
            <div className="flex justify-center mb-4 sm:hidden"><div className="w-10 h-1 bg-gray-700 rounded-full" /></div>
            <div className="flex items-center gap-3 mb-5">
              <Lock className="text-white" size={22} />
              <h3 className="font-semibold text-base">Cambia Password</h3>
            </div>
            <form onSubmit={handleChangePassword} className="space-y-4">
              <div>
                <label className="text-[10px] font-bold text-gray-500 uppercase tracking-widest block mb-2">Password attuale</label>
                <input type="password" required value={changePwdCurrent}
                  onChange={e => setChangePwdCurrent(e.target.value)}
                  placeholder="••••••••"
                  className="w-full bg-[#0a0a0a] border border-white/[0.07] rounded-xl p-3 text-white outline-none focus:border-[#ff4d00]" />
              </div>
              <div>
                <label className="text-[10px] font-bold text-gray-500 uppercase tracking-widest block mb-2">Nuova password</label>
                <input type="password" required value={changePwdNew}
                  onChange={e => setChangePwdNew(e.target.value)}
                  placeholder="••••••••"
                  className="w-full bg-[#0a0a0a] border border-white/[0.07] rounded-xl p-3 text-white outline-none focus:border-[#ff4d00]" />
                <p className="text-[10px] text-gray-500 mt-1">Min. 10 caratteri, maiuscola, numero e carattere speciale.</p>
              </div>
              <div>
                <label className="text-[10px] font-bold text-gray-500 uppercase tracking-widest block mb-2">Conferma nuova password</label>
                <input type="password" required value={changePwdConfirm}
                  onChange={e => setChangePwdConfirm(e.target.value)}
                  placeholder="••••••••"
                  className={`w-full bg-[#0a0a0a] border rounded-xl p-3 text-white outline-none focus:border-[#ff4d00] ${
                    changePwdConfirm && changePwdNew !== changePwdConfirm ? 'border-red-500' : 'border-white/[0.07]'
                  }`} />
              </div>
              <div className="flex gap-3 pt-2">
                <button type="button" onClick={() => { setChangePwdOpen(false); setChangePwdCurrent(''); setChangePwdNew(''); setChangePwdConfirm(''); }}
                  className="flex-1 bg-white/5 hover:bg-white/8 py-3 rounded-xl font-bold text-sm transition-colors">
                  Annulla
                </button>
                <button type="submit" disabled={changePwdLoading || (!!changePwdConfirm && changePwdNew !== changePwdConfirm)}
                  className="flex-1 bg-[#ff4d00] hover:bg-[#ff6a2a] disabled:opacity-50 py-3 rounded-xl font-bold text-sm transition-colors flex items-center justify-center">
                  {changePwdLoading ? <Loader2 className="animate-spin" size={16} /> : 'Salva'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ========== MODALE: TRACKING SPEDIZIONE ========== */}
      {trackingModalOpen && trackingProduct && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-end sm:items-center justify-center z-[60] p-0 sm:p-4">
          <div className="bg-[#0f0f0f] border-t sm:border border-white/[0.07] rounded-t-3xl sm:rounded-3xl w-full max-w-md p-6 max-h-[90vh] overflow-y-auto">
            <div className="flex justify-center mb-4 sm:hidden"><div className="w-10 h-1 bg-gray-700 rounded-full" /></div>
            <div className="flex items-center justify-between mb-5">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-blue-500/20 flex items-center justify-center">
                  <Truck className="text-blue-400" size={20} />
                </div>
                <div>
                  <h3 className="font-semibold text-base">Tracking Spedizione</h3>
                  <p className="text-xs text-gray-500">{trackingProduct.brand} {trackingProduct.name}</p>
                </div>
              </div>
              <button onClick={() => setTrackingModalOpen(false)}>
                <X size={20} className="text-gray-500 hover:text-white" />
              </button>
            </div>

            {/* Stato corrente */}
            {trackingProduct.trackingCode && (
              <div className={`mb-5 p-4 rounded-2xl border flex items-center justify-between gap-3 ${
                trackingProduct.trackingStatus === 'DELIVERED' ? 'border-green-800 bg-green-900/20' :
                trackingProduct.trackingStatus === 'OUT_FOR_DELIVERY' ? 'border-orange-800 bg-orange-900/20' :
                trackingProduct.trackingStatus === 'IN_TRANSIT' ? 'border-blue-800 bg-blue-900/20' :
                trackingProduct.trackingStatus === 'EXCEPTION' ? 'border-red-800 bg-red-900/20' :
                'border-white/[0.07] bg-white/5/30'
              }`}>
                <div className="min-w-0">
                  <p className="text-[10px] font-bold text-gray-500 uppercase tracking-widest">Stato attuale</p>
                  <p className="font-bold text-sm mt-0.5">
                    {trackingProduct.trackingStatus === 'IN_TRANSIT' ? '🚚 In transito' :
                     trackingProduct.trackingStatus === 'OUT_FOR_DELIVERY' ? '📦 In consegna oggi' :
                     trackingProduct.trackingStatus === 'DELIVERED' ? '✅ Consegnato' :
                     trackingProduct.trackingStatus === 'EXCEPTION' ? '⚠️ Eccezione' :
                     '⏳ In attesa'}
                  </p>
                  <p className="text-[10px] text-gray-500 mt-0.5 truncate">{trackingProduct.trackingCarrier} • {trackingProduct.trackingCode}</p>
                </div>
                <button onClick={handleRefreshTracking} disabled={isRefreshingTracking}
                  className="flex items-center gap-1.5 text-xs text-blue-400 hover:text-blue-300 font-bold bg-blue-900/30 px-3 py-2 rounded-xl disabled:opacity-50 shrink-0 transition-colors">
                  {isRefreshingTracking ? <Loader2 className="animate-spin" size={12} /> : <Truck size={12} />} Aggiorna
                </button>
              </div>
            )}

            {/* Storico eventi */}
            {trackingDetail?.history?.length > 0 && (
              <div className="mb-5">
                <p className="text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-3">Storico eventi</p>
                <div className="space-y-0 max-h-44 overflow-y-auto pr-1">
                  {(trackingDetail.history as any[]).map((ev: any, i: number) => (
                    <div key={i} className="flex gap-3 text-xs">
                      <div className="flex flex-col items-center pt-1">
                        <div className={`w-2 h-2 rounded-full shrink-0 ${i === 0 ? 'bg-blue-400' : 'bg-gray-700'}`} />
                        {i < trackingDetail.history.length - 1 && <div className="w-px flex-1 bg-white/5 my-1 min-h-[12px]" />}
                      </div>
                      <div className="pb-3">
                        <p className="text-white font-medium">{ev.description || '—'}</p>
                        {ev.location && <p className="text-gray-500">{ev.location}</p>}
                        {ev.date && <p className="text-gray-600 text-[10px]">{ev.date}</p>}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Form aggiungi/modifica tracking */}
            <div className="space-y-3 mb-5">
              <div>
                <label className="text-[10px] font-bold text-gray-500 uppercase tracking-widest block mb-2">Codice Tracking</label>
                <input type="text" value={trackingInput}
                  onChange={e => setTrackingInput(e.target.value.toUpperCase())}
                  placeholder="ES: BRT123456789IT"
                  className="w-full bg-[#0a0a0a] border border-white/[0.07] rounded-xl p-3 text-white outline-none focus:border-blue-500 font-mono text-sm uppercase"
                />
              </div>
              <div>
                <label className="text-[10px] font-bold text-gray-500 uppercase tracking-widest block mb-2">Vettore</label>
                <select value={trackingCarrierSel} onChange={e => setTrackingCarrierSel(e.target.value)}
                  className="w-full bg-[#0a0a0a] border border-white/[0.07] rounded-xl p-3 text-white outline-none focus:border-blue-500">
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
                className="flex-1 bg-white/5 hover:bg-white/8 py-3 rounded-xl font-bold text-sm transition-colors">
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
        // Stato locale al panel
        const [editQuoteWarehouse, setEditQuoteWarehouse] = React.useState<string | null>(null);
        const [editQuoteValues, setEditQuoteValues] = React.useState<Record<string, string>>({});
        const [kickConfirm, setKickConfirm] = React.useState<string | null>(null);
        const [isRegenerating, setIsRegenerating] = React.useState<string | null>(null);

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
              className="bg-[#0e0e0e] border-t lg:border-t-0 lg:border-l border-white/[0.07] w-full lg:w-[460px] max-h-[92vh] lg:h-full overflow-y-auto rounded-t-3xl lg:rounded-none animate-slide-up lg:animate-slide-right"
              onClick={e => e.stopPropagation()}>

              {/* Header sticky */}
              <div className="sticky top-0 bg-[#0e0e0e]/95 backdrop-blur-xl border-b border-white/[0.05] p-5 flex items-center justify-between z-10">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-2xl bg-purple-500/15 border border-purple-500/20 flex items-center justify-center">
                    <Users className="text-purple-400" size={18} />
                  </div>
                  <div>
                    <h2 className="font-semibold text-base leading-none">Il Tuo Team</h2>
                    <p className="text-[10px] text-gray-600 mt-0.5">{totalSoci} {totalSoci === 1 ? 'socio' : 'soci'} · {teamData.length} {teamData.length === 1 ? 'reparto' : 'reparti'}</p>
                  </div>
                </div>
                <button onClick={() => setTeamPanelOpen(false)} className="p-2 hover:bg-white/5 rounded-xl transition-colors">
                  <X size={19} className="text-gray-400" />
                </button>
              </div>

              {/* Stats rapide globali */}
              <div className="grid grid-cols-4 gap-2 p-4 border-b border-white/[0.05]">
                {[
                  { label: 'Soci', value: totalSoci, color: 'text-purple-400' },
                  { label: 'In Stock', value: totalStock, color: 'text-white' },
                  { label: 'Venduti', value: totalSoldCount, color: 'text-blue-400' },
                  { label: 'Profitto', value: (totalProfit >= 0 ? '+' : '') + totalProfit.toFixed(0) + '€', color: totalProfit >= 0 ? 'text-emerald-400' : 'text-red-400' },
                ].map(s => (
                  <div key={s.label} className="bg-[#0a0a0a] rounded-xl p-2.5 text-center">
                    <p className={`text-sm font-bold num ${s.color}`}>{s.value}</p>
                    <p className="text-[9px] text-gray-600 mt-0.5 uppercase tracking-wider">{s.label}</p>
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
                    <section key={team.warehouseId} className="bg-[#080808] rounded-2xl border border-white/[0.05] overflow-hidden">

                      {/* Reparto header */}
                      <div className="p-4 border-b border-white/[0.05]">
                        <div className="flex items-center justify-between mb-3">
                          <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-xl bg-[#111] border border-white/[0.05] flex items-center justify-center text-xl shrink-0">
                              {getCategoryIcon(cat)}
                            </div>
                            <div>
                              <p className="font-bold">{cat}</p>
                              <p className="text-[10px] text-gray-600">{team.members.length} soci · {teamStock.length} stock · {teamSold.length} vendite</p>
                            </div>
                          </div>
                          <div className="text-right">
                            <p className={`font-semibold num ${teamProfit > 0 ? 'text-emerald-400' : teamProfit < 0 ? 'text-red-400' : 'text-gray-600'}`}>
                              {teamProfit > 0 ? '+' : ''}{teamProfit.toFixed(0)}€
                            </p>
                            <p className="text-[10px] text-gray-600 mt-0.5">{teamRevenue.toFixed(0)}€ ricavi · {sellThrough}% sell-through</p>
                          </div>
                        </div>

                        {/* Mini progress sell-through */}
                        <div className="h-1 bg-white/[0.04] rounded-full overflow-hidden">
                          <div className="h-full bg-gradient-to-r from-[#ff4d00] to-orange-400 rounded-full transition-all" style={{ width: `${sellThrough}%` }} />
                        </div>
                      </div>

                      {/* Membri */}
                      <div className="divide-y divide-white/[0.04]">
                        {memberProfits.map((m: any, idx: number) => {
                          const medals = ['🥇', '🥈', '🥉'];
                          const isMe = m.userId === user!.id;
                          const canKick = isOwnerHere && !isMe && m.role !== 'OWNER';
                          return (
                            <div key={m.membershipId}>
                              <div className={`flex items-center gap-3 p-3.5 transition-colors ${isMe ? 'bg-[#ff4d00]/[0.04]' : 'hover:bg-white/[0.02]'}`}>
                                {/* Rank medal o avatar */}
                                <div className="relative shrink-0">
                                  <div className="w-9 h-9 rounded-full bg-gradient-to-br from-purple-500 to-blue-600 flex items-center justify-center font-black text-xs shadow-sm">
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
                                    {isMe && <span className="text-[8px] bg-[#ff4d00]/20 text-white px-1.5 py-0.5 rounded-full font-semibold">TU</span>}
                                    <span className={`text-[8px] px-1.5 py-0.5 rounded-full font-semibold ${m.role === 'OWNER' ? 'bg-[#ff4d00]/15 text-white/80' : 'bg-white/5 text-gray-500'}`}>
                                      {m.role === 'OWNER' ? 'Owner' : 'Socio'}
                                    </span>
                                  </div>
                                  {/* Contribuzione */}
                                  <div className="flex items-center gap-2 mt-0.5">
                                    <span className="text-[10px] text-gray-600">{m.productsAdded ?? 0} aggiunti · {m.productsSold ?? 0} venduti</span>
                                  </div>
                                </div>

                                {/* Destra: % e profitto */}
                                <div className="flex items-center gap-2 shrink-0">
                                  {isEditing ? (
                                    <input
                                      type="number" min="0" max="100" step="1"
                                      value={editQuoteValues[m.membershipId] ?? m.percentage}
                                      onChange={e => setEditQuoteValues(prev => ({ ...prev, [m.membershipId]: e.target.value }))}
                                      className="w-14 bg-[#0a0a0a] border border-white/[0.1] rounded-lg px-2 py-1 text-xs text-center text-white outline-none focus:border-[#ff4d00]"
                                    />
                                  ) : (
                                    <span className="text-[10px] text-gray-500 font-semibold bg-white/[0.04] px-2 py-1 rounded-lg">{m.percentage}%</span>
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
                                    <button onClick={() => setKickConfirm(null)} className="text-[11px] text-gray-500 hover:text-white px-2 py-1 rounded-lg hover:bg-white/5">Annulla</button>
                                    <button onClick={() => kickMember(m.membershipId)} className="text-[11px] text-red-300 hover:text-red-200 bg-red-500/20 hover:bg-red-500/30 px-3 py-1 rounded-lg font-bold">Rimuovi</button>
                                  </div>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>

                      {/* Footer reparto */}
                      <div className="p-4 border-t border-white/[0.05] space-y-3">

                        {/* Pareggio conti */}
                        {teamProfit !== 0 && (
                          <div className="bg-[#0a0a0a] rounded-xl p-3">
                            <div className="flex items-center gap-1.5 mb-2.5">
                              <DollarSign size={11} className="text-emerald-500" />
                              <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Pareggio conti</p>
                              <span className="ml-auto text-[10px] text-gray-600 num">{teamProfit >= 0 ? '+' : ''}{teamProfit.toFixed(0)}€ totali</span>
                            </div>
                            <div className="space-y-1.5">
                              {settleAmounts.map((m: any) => (
                                <div key={m.membershipId} className="flex items-center justify-between">
                                  <div className="flex items-center gap-1.5">
                                    <div className="w-4 h-4 rounded-full bg-gradient-to-br from-purple-500 to-blue-600 flex items-center justify-center font-black text-[7px]">
                                      {m.name[0]?.toUpperCase()}
                                    </div>
                                    <span className="text-xs text-gray-400">{m.name}</span>
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
                                <span className="text-gray-600">
                                  Totale: {team.members.reduce((s: number, m: any) => s + (Number(editQuoteValues[m.membershipId] ?? m.percentage) || 0), 0)}%
                                  {Math.round(team.members.reduce((s: number, m: any) => s + (Number(editQuoteValues[m.membershipId] ?? m.percentage) || 0), 0)) !== 100 && (
                                    <span className="text-red-400 ml-1">· deve essere 100%</span>
                                  )}
                                </span>
                              </div>
                              <div className="flex gap-2">
                                <button onClick={() => { setEditQuoteWarehouse(null); setEditQuoteValues({}); }}
                                  className="flex-1 py-2 text-xs font-bold text-gray-500 hover:text-white bg-white/[0.04] hover:bg-white/[0.07] rounded-xl transition-colors">
                                  Annulla
                                </button>
                                <button onClick={() => saveEditedQuotes(team)} disabled={isSavingTeam}
                                  className="flex-1 py-2 text-xs font-bold text-white bg-[#ff4d00]/80 hover:bg-[#ff4d00] rounded-xl transition-colors disabled:opacity-40">
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
                              className="w-full py-2 text-[11px] font-bold text-gray-500 hover:text-white bg-white/[0.03] hover:bg-white/[0.06] rounded-xl border border-white/[0.05] hover:border-white/[0.1] transition-colors flex items-center justify-center gap-1.5">
                              <Edit size={11} /> Modifica Quote
                            </button>
                          )
                        )}

                        {/* Sezione invito */}
                        {isOwnerHere && team.inviteCode && (
                          <div className="bg-[#0a0a0a] rounded-xl p-3 border border-white/[0.04]">
                            <p className="text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                              <UserPlus size={10} /> Invita un socio
                            </p>
                            <div className="flex gap-2">
                              <div className="flex-1 bg-[#111] border border-white/[0.07] rounded-xl px-3 py-2 flex items-center gap-2 overflow-hidden">
                                <KeyRound size={11} className="text-gray-600 shrink-0" />
                                <span className="font-mono text-xs text-gray-300 truncate">{team.inviteCode}</span>
                              </div>
                              <button
                                onClick={() => { navigator.clipboard.writeText(team.inviteCode); showToast('Codice copiato!'); }}
                                className="px-3 bg-white/[0.06] hover:bg-white/[0.1] border border-white/[0.07] rounded-xl text-gray-400 hover:text-white transition-colors active:scale-95">
                                <Copy size={14} />
                              </button>
                              <button
                                onClick={() => regenerateInvite(team.warehouseId)}
                                disabled={isRegenerating === team.warehouseId}
                                className="px-3 bg-white/[0.06] hover:bg-white/[0.1] border border-white/[0.07] rounded-xl text-gray-400 hover:text-white transition-colors disabled:opacity-40 active:scale-95"
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
                <section className="bg-[#080808] rounded-2xl border border-white/[0.05] p-4">
                  <p className="text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-3 flex items-center gap-1.5">
                    <UserPlus size={10} className="text-blue-400" /> Entra in un Team
                  </p>
                  <form onSubmit={handleJoinWarehouse} className="flex gap-2">
                    <input
                      type="text" value={joinCodeInput} onChange={e => setJoinCodeInput(e.target.value.toUpperCase())}
                      placeholder="Inserisci codice invito"
                      className="flex-1 bg-[#0a0a0a] border border-white/[0.07] rounded-xl px-3 py-2 text-sm text-white placeholder-gray-700 outline-none focus:border-blue-500/50 font-mono"
                    />
                    <button type="submit" disabled={isJoining || !joinCodeInput.trim()}
                      className="px-4 py-2 bg-blue-600/80 hover:bg-blue-600 rounded-xl text-xs font-bold text-white transition-colors disabled:opacity-40 active:scale-95">
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
          <div className="bg-[#0e0e0e] border border-white/[0.07] w-full sm:max-w-lg rounded-t-3xl sm:rounded-3xl max-h-[92vh] overflow-y-auto animate-slide-up"
            onClick={e => e.stopPropagation()}>

            {/* Header */}
            <div className="sticky top-0 bg-[#0e0e0e]/95 backdrop-blur-xl border-b border-white/[0.05] p-5 flex items-center justify-between z-10">
              <div>
                <h2 className="font-semibold flex items-center gap-2"><Package size={16} className="text-orange-400" /> Spedizione</h2>
                <p className="text-[11px] text-gray-600 mt-0.5">{shippingProduct.brand} {shippingProduct.name} · {shippingProduct.size}</p>
              </div>
              <button onClick={() => setShippingProduct(null)} className="p-2 hover:bg-white/5 rounded-xl transition-colors">
                <X size={18} className="text-gray-400" />
              </button>
            </div>

            <div className="p-5 space-y-4">

              {/* STEP: FORM */}
              {shippingStep === 'form' && (<>

                {/* Mittente */}
                <div>
                  <p className="text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-2">Mittente (tu)</p>
                  <div className="grid grid-cols-2 gap-2">
                    {[
                      { key: 'name',    label: 'Nome',     placeholder: 'Mario Rossi',   span: 2 },
                      { key: 'address', label: 'Indirizzo',placeholder: 'Via Roma 1',    span: 2 },
                      { key: 'city',    label: 'Città',    placeholder: 'Milano',        span: 1 },
                      { key: 'zip',     label: 'CAP',      placeholder: '20100',         span: 1 },
                      { key: 'phone',   label: 'Telefono', placeholder: '+393331234567', span: 2 },
                    ].map(f => (
                      <div key={f.key} className={f.span === 2 ? 'col-span-2' : ''}>
                        <label className="text-[10px] text-gray-600 block mb-1">{f.label}</label>
                        <input
                          value={shipFrom[f.key] || ''}
                          onChange={e => setShipFrom((p: any) => ({ ...p, [f.key]: e.target.value }))}
                          placeholder={f.placeholder}
                          className="w-full bg-[#111] border border-white/[0.07] rounded-xl px-3 py-2 text-sm text-white placeholder-gray-700 outline-none focus:border-orange-500/50"
                        />
                      </div>
                    ))}
                  </div>
                </div>

                {/* Destinatario */}
                <div>
                  <p className="text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-2">Destinatario</p>
                  <div className="grid grid-cols-2 gap-2">
                    {[
                      { key: 'name',    label: 'Nome',     placeholder: 'Luca Bianchi',  span: 2 },
                      { key: 'address', label: 'Indirizzo',placeholder: 'Via Milano 5',  span: 2 },
                      { key: 'city',    label: 'Città',    placeholder: 'Roma',          span: 1 },
                      { key: 'zip',     label: 'CAP',      placeholder: '00100',         span: 1 },
                      { key: 'phone',   label: 'Telefono', placeholder: '+393339876543', span: 2 },
                    ].map(f => (
                      <div key={f.key} className={f.span === 2 ? 'col-span-2' : ''}>
                        <label className="text-[10px] text-gray-600 block mb-1">{f.label}</label>
                        <input
                          value={shipTo[f.key as keyof typeof shipTo] || ''}
                          onChange={e => setShipTo(p => ({ ...p, [f.key]: e.target.value }))}
                          placeholder={f.placeholder}
                          className="w-full bg-[#111] border border-white/[0.07] rounded-xl px-3 py-2 text-sm text-white placeholder-gray-700 outline-none focus:border-orange-500/50"
                        />
                      </div>
                    ))}
                  </div>
                </div>

                {/* Pacco preset */}
                <div>
                  <p className="text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-2">Dimensioni pacco</p>
                  <div className="grid grid-cols-4 gap-2">
                    {SHIPPING_PRESETS.map(p => (
                      <button key={p.label} onClick={() => setShipPreset(p)}
                        className={`p-2.5 rounded-xl border text-center transition-all ${
                          shipPreset.label === p.label
                            ? 'bg-orange-500/15 border-orange-500/40 text-white'
                            : 'bg-[#111] border-white/[0.06] text-gray-500 hover:border-white/15'
                        }`}>
                        <p className="text-xs font-bold">{p.label}</p>
                        <p className="text-[9px] text-gray-600 mt-0.5">{p.weight}kg</p>
                      </button>
                    ))}
                  </div>
                  <p className="text-[10px] text-gray-700 mt-1.5">{shipPreset.length}×{shipPreset.width}×{shipPreset.height} cm · {shipPreset.weight} kg</p>
                </div>

                <button onClick={fetchRates} disabled={isLoadingRates}
                  className="w-full py-3.5 bg-orange-600/80 hover:bg-orange-600 disabled:opacity-40 rounded-2xl text-sm font-bold text-white transition-colors flex items-center justify-center gap-2 active:scale-[0.98]">
                  {isLoadingRates ? <><Loader2 size={15} className="animate-spin" /> Cerco tariffe…</> : <><Package size={15} /> Vedi tariffe corrieri</>}
                </button>
              </>)}

              {/* STEP: RATES */}
              {shippingStep === 'rates' && (<>
                <button onClick={() => setShippingStep('form')} className="text-xs text-gray-500 hover:text-white flex items-center gap-1 transition-colors">
                  ← Modifica dati
                </button>
                <div className="space-y-2">
                  {shippingRates.map(r => (
                    <button key={r.id} onClick={() => setSelectedRate(r)}
                      className={`w-full flex items-center justify-between p-3.5 rounded-xl border transition-all text-left ${
                        selectedRate?.id === r.id
                          ? 'bg-orange-500/10 border-orange-500/40'
                          : 'bg-[#111] border-white/[0.06] hover:border-white/15'
                      }`}>
                      <div>
                        <p className="font-bold text-sm text-white">{r.carrier}</p>
                        <p className="text-[11px] text-gray-500">{r.name}{r.transitHours ? ` · ${r.transitHours}h` : ''}</p>
                      </div>
                      <p className={`font-bold text-base num ${selectedRate?.id === r.id ? 'text-orange-400' : 'text-white'}`}>
                        {r.price.toFixed(2)}€
                      </p>
                    </button>
                  ))}
                </div>
                {selectedRate && (
                  <button onClick={bookShipment} disabled={isBooking}
                    className="w-full py-3.5 bg-orange-600/80 hover:bg-orange-600 disabled:opacity-40 rounded-2xl text-sm font-bold text-white transition-colors flex items-center justify-center gap-2 active:scale-[0.98]">
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
                    <p className="font-bold text-white">{shippingRef?.startsWith('HQ-DEMO') ? 'Etichetta demo generata!' : 'Spedizione prenotata!'}</p>
                    {shippingRef && <p className="text-xs text-gray-500 mt-1 font-mono">{shippingRef}</p>}
                    <p className="text-xs text-gray-600 mt-2">
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
                    : <p className="text-xs text-gray-500">L'etichetta sarà disponibile sul sito Packlink.</p>
                  }
                  <button onClick={() => setShippingProduct(null)}
                    className="w-full py-2.5 bg-white/5 hover:bg-white/10 rounded-2xl text-sm text-gray-400 hover:text-white transition-colors">
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
          <div className="bg-[#0e0e0e] border border-white/[0.07] w-full sm:max-w-lg rounded-t-3xl sm:rounded-3xl max-h-[92vh] overflow-y-auto animate-slide-up"
            onClick={e => e.stopPropagation()}>

            {/* Header */}
            <div className="sticky top-0 bg-[#0e0e0e]/95 backdrop-blur-xl border-b border-white/[0.05] p-5 flex items-center justify-between z-10">
              <div>
                <h2 className="font-semibold">Genera Annuncio</h2>
                <p className="text-[11px] text-gray-600 mt-0.5">{listingModalProduct.brand} {listingModalProduct.name} · {listingModalProduct.size}</p>
              </div>
              <button onClick={() => { setListingModalProduct(null); setListingResult(null); }}
                className="p-2 hover:bg-white/5 rounded-xl transition-colors">
                <X size={18} className="text-gray-400" />
              </button>
            </div>

            <div className="p-5 space-y-4">
              {/* Selezione piattaforma */}
              <div>
                <p className="text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-3">Scegli la piattaforma</p>
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
                          ? 'bg-purple-500/15 border-purple-500/40 text-white'
                          : 'bg-[#111] border-white/[0.06] text-gray-500 hover:border-white/[0.15] hover:text-gray-300'
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
                className="w-full py-3.5 bg-purple-600/80 hover:bg-purple-600 disabled:bg-purple-600/30 rounded-2xl text-sm font-bold text-white transition-colors flex items-center justify-center gap-2 active:scale-[0.98]">
                {isGeneratingListing
                  ? <><Loader2 size={16} className="animate-spin" /> Generazione in corso…</>
                  : <><Sparkles size={16} /> Genera con IA</>}
              </button>

              {/* Risultato */}
              {listingResult && (
                <div className="space-y-3">

                  {/* Titolo */}
                  <div className="bg-[#0a0a0a] border border-white/[0.07] rounded-2xl p-4">
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-[10px] font-bold text-gray-500 uppercase tracking-wider">Titolo</p>
                      <button onClick={() => copyToClipboard(listingResult.title, 'title')}
                        className={`flex items-center gap-1 text-[10px] font-bold px-2.5 py-1 rounded-lg transition-all ${
                          copiedField === 'title' ? 'bg-green-500/20 text-green-400' : 'bg-white/[0.06] text-gray-400 hover:text-white'
                        }`}>
                        <Copy size={11} /> {copiedField === 'title' ? 'Copiato!' : 'Copia'}
                      </button>
                    </div>
                    <p className="text-sm font-semibold text-white leading-snug">{listingResult.title}</p>
                    <p className="text-[10px] text-gray-700 mt-1">{listingResult.title.length}/80 caratteri</p>
                  </div>

                  {/* Descrizione */}
                  <div className="bg-[#0a0a0a] border border-white/[0.07] rounded-2xl p-4">
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-[10px] font-bold text-gray-500 uppercase tracking-wider">Descrizione</p>
                      <button onClick={() => copyToClipboard(listingResult.description, 'desc')}
                        className={`flex items-center gap-1 text-[10px] font-bold px-2.5 py-1 rounded-lg transition-all ${
                          copiedField === 'desc' ? 'bg-green-500/20 text-green-400' : 'bg-white/[0.06] text-gray-400 hover:text-white'
                        }`}>
                        <Copy size={11} /> {copiedField === 'desc' ? 'Copiato!' : 'Copia'}
                      </button>
                    </div>
                    <p className="text-sm text-gray-300 leading-relaxed whitespace-pre-line">{listingResult.description}</p>
                  </div>

                  {/* Hashtag (se presenti) */}
                  {listingResult.hashtags?.length > 0 && (
                    <div className="bg-[#0a0a0a] border border-white/[0.07] rounded-2xl p-4">
                      <div className="flex items-center justify-between mb-2">
                        <p className="text-[10px] font-bold text-gray-500 uppercase tracking-wider">Hashtag</p>
                        <button onClick={() => copyToClipboard(listingResult.hashtags.join(' '), 'tags')}
                          className={`flex items-center gap-1 text-[10px] font-bold px-2.5 py-1 rounded-lg transition-all ${
                            copiedField === 'tags' ? 'bg-green-500/20 text-green-400' : 'bg-white/[0.06] text-gray-400 hover:text-white'
                          }`}>
                          <Copy size={11} /> {copiedField === 'tags' ? 'Copiato!' : 'Copia'}
                        </button>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {listingResult.hashtags.map((tag: string) => (
                          <span key={tag} className="text-[11px] bg-purple-500/10 text-purple-400 border border-purple-500/20 px-2 py-0.5 rounded-full">{tag}</span>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Consiglio AI */}
                  {listingResult.tips && (
                    <div className="flex items-start gap-2 px-4 py-3 bg-white/[0.02] border border-white/[0.05] rounded-xl">
                      <Sparkles size={13} className="text-yellow-500 shrink-0 mt-0.5" />
                      <p className="text-[12px] text-gray-400 leading-relaxed">{listingResult.tips}</p>
                    </div>
                  )}

                  {/* CTA — apri piattaforma */}
                  {listingResult.deepLink && (
                    <a href={listingResult.deepLink} target="_blank" rel="noopener noreferrer"
                      className="flex items-center justify-center gap-2 w-full py-3 bg-white/[0.05] hover:bg-white/[0.09] border border-white/[0.08] rounded-2xl text-sm font-bold text-white transition-colors active:scale-[0.98]">
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
                        : 'bg-purple-600/70 hover:bg-purple-600 text-white'
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
          <X size={13} className="shrink-0 text-white/30" />
        </div>
      )}
    </div>
  );
}
