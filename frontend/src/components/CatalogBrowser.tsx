// CatalogBrowser — schermata "Aggiungi prodotti" stile StockX (BETA, solo admin).
// Cerchi un modello e con un tap sul "+" lo aggiungi SUBITO al magazzino con la foto
// ufficiale (sfondo uniforme). Taglia/prezzo/condizione si mettono dopo dalla Modifica.
// La foto è il LINK diretto StockX (niente Cloudinary): il DB resta piccolissimo.

import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Search, Plus, Loader2, ImageOff, Check, X } from 'lucide-react';

type ApiCall = <T = any>(path: string, opts?: RequestInit) => Promise<{ ok: boolean; data: T; status: number }>;

interface CatalogResult {
  key: string; brand: string; name: string; sku: string | null;
  image: string | null; productType: string | null;
}

interface Props {
  apiCall: ApiCall;
  showToast: (msg: string, type?: 'ok' | 'err' | 'warn') => void;
  categories: string[];
  warehouses: { id: string; name: string; parentId?: string | null }[];
  baseWarehouseId?: string;
  onAdded: () => void;
}

const TYPES = [
  { id: '', label: 'Tutti' },
  { id: 'sneakers', label: 'Sneakers' },
  { id: 'apparel', label: 'Abbigliamento' },
  { id: 'borse', label: 'Borse' },
  { id: 'carte', label: 'Carte' },
  { id: 'accessori', label: 'Accessori' },
  { id: 'elettronica', label: 'Elettronica' },
];

function Thumb({ src, alt }: { src: string | null; alt: string }) {
  const [err, setErr] = useState(false);
  if (!src || err) {
    return (
      <div className="w-14 h-14 rounded-lg bg-[var(--fill)] flex items-center justify-center shrink-0">
        <ImageOff size={18} className="text-[var(--text-faint)]" />
      </div>
    );
  }
  // Le immagini del CDN StockX bloccano le richieste cross-site dal browser: le serviamo
  // dal nostro dominio via proxy (/api/catalog/img). pokemontcg/altri http passano uguale.
  const url = /^https?:\/\//i.test(src) ? `/api/catalog/img?u=${encodeURIComponent(src)}` : src;
  return <img src={url} alt={alt} onError={() => setErr(true)} loading="lazy"
    className="w-14 h-14 rounded-lg object-contain bg-white shrink-0" />;
}

export default function CatalogBrowser({ apiCall, showToast, categories, warehouses, baseWarehouseId, onAdded }: Props) {
  const [query, setQuery] = useState('');
  const [type, setType] = useState('');
  const [results, setResults] = useState<CatalogResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  // Stato per riga: 'adding' (spinner) → 'added' (spunta verde, transitoria)
  const [adding, setAdding] = useState<Record<string, boolean>>({});
  const [addedFlash, setAddedFlash] = useState<Record<string, boolean>>({});
  const [preview, setPreview] = useState<CatalogResult | null>(null); // anteprima ingrandita (tap)
  // Categorie PERSONALIZZATE aggiunte dall'utente (oltre alle 6 ufficiali): il backend per
  // queste cerca i prodotti dal vivo usando il nome come query. Salvate in locale.
  const [customTypes, setCustomTypes] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem('hq_catalog_cats') || '[]'); } catch { return []; }
  });
  // Modale in-app per aggiungere una categoria (niente window.prompt nativo).
  const [catModalOpen, setCatModalOpen] = useState(false);
  const [newCat, setNewCat] = useState('');
  const confirmAddCategory = () => {
    const name = newCat.trim();
    if (!name) return;
    const exists = [...TYPES.map(t => t.label.toLowerCase()), ...customTypes.map(c => c.toLowerCase())].includes(name.toLowerCase());
    if (!exists) {
      const next = [...customTypes, name];
      setCustomTypes(next);
      try { localStorage.setItem('hq_catalog_cats', JSON.stringify(next)); } catch { /* storage pieno: pazienza */ }
    }
    setType(name.toLowerCase());
    setNewCat('');
    setCatModalOpen(false);
  };
  const removeCustomType = (name: string) => {
    const next = customTypes.filter(c => c !== name);
    setCustomTypes(next);
    try { localStorage.setItem('hq_catalog_cats', JSON.stringify(next)); } catch { /* ignora */ }
    if (type === name.toLowerCase()) setType('');
  };

  const debTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reparto di default in base al tipo (sneakers → "Scarpe", abbigliamento → "Vestiti"...).
  const pickCategory = (productType: string | null): string => {
    if (productType === 'sneakers') return categories.find(c => /scarp|sneaker|shoe/i.test(c)) || categories[0] || 'Scarpe';
    if (productType === 'apparel') return categories.find(c => /vest|abbig|cloth|appar|maglia|felpa/i.test(c)) || categories[0] || 'Vestiti';
    if (productType === 'borse') return categories.find(c => /bors|bag|hand/i.test(c)) || categories[0] || 'Borse';
    if (productType === 'carte') return categories.find(c => /cart|pokemon|card|tcg/i.test(c)) || categories[0] || 'Carte';
    if (productType === 'accessori') return categories.find(c => /access/i.test(c)) || categories[0] || 'Accessori';
    if (productType === 'elettronica') return categories.find(c => /elettr|electron|tech/i.test(c)) || categories[0] || 'Elettronica';
    return categories[0] || 'Generico';
  };

  const loadPopular = useCallback(async () => {
    setLoading(true);
    const { ok, data } = await apiCall<CatalogResult[]>(`/api/catalog/popular?type=${encodeURIComponent(type)}`);
    setLoading(false);
    setResults(ok && Array.isArray(data) ? data : []);
  }, [apiCall, type]);

  const runSearch = useCallback(async (q: string, t: string) => {
    if (q.trim().length < 2) { setSearched(false); loadPopular(); return; }
    setLoading(true);
    const { ok, data } = await apiCall<CatalogResult[]>(`/api/catalog/search?q=${encodeURIComponent(q.trim())}&type=${encodeURIComponent(t)}`);
    setLoading(false);
    setSearched(true);
    setResults(ok && Array.isArray(data) ? data : []);
  }, [apiCall, loadPopular]);

  // Carica i popolari all'apertura
  useEffect(() => { loadPopular(); }, [loadPopular]);

  // Debounce sulla digitazione
  useEffect(() => {
    if (debTimer.current) clearTimeout(debTimer.current);
    debTimer.current = setTimeout(() => runSearch(query, type), 450);
    return () => { if (debTimer.current) clearTimeout(debTimer.current); };
  }, [query, type, runSearch]);

  // TAP sul "+": aggiunge SUBITO il prodotto (come StockX). Prezzo/taglia dopo, dalla Modifica.
  const quickAdd = async (item: CatalogResult) => {
    if (adding[item.key]) return;
    // Se sono in una categoria personalizzata, il prodotto va in quel reparto; altrimenti
    // scelgo il reparto in base al tipo del risultato.
    const customLabel = customTypes.find(c => c.toLowerCase() === type);
    const category = customLabel || pickCategory(item.productType);
    setAdding(a => ({ ...a, [item.key]: true }));
    const { ok, data } = await apiCall<any>('/products', {
      method: 'POST',
      body: JSON.stringify({
        category,
        brand: item.brand || '-',
        name: item.name || item.brand || '-',
        sku: item.sku || undefined,
        price: 0,
        warehouseId: baseWarehouseId || warehouses[0]?.id || undefined,
        photos: item.image ? [item.image] : undefined, // LINK StockX: salvato tale e quale
      }),
    });
    setAdding(a => { const n = { ...a }; delete n[item.key]; return n; });
    if (!ok || !data?.id) { showToast(data?.error || 'Errore aggiunta', 'err'); return; }
    apiCall(`/api/catalog/${encodeURIComponent(item.key)}/used`, { method: 'POST' }).catch(() => {});
    showToast(`Aggiunto: ${item.brand} ${item.name}`, 'ok');
    setAddedFlash(f => ({ ...f, [item.key]: true }));
    setTimeout(() => setAddedFlash(f => { const n = { ...f }; delete n[item.key]; return n; }), 1500);
    onAdded();
  };

  return (
    <div className="max-w-2xl mx-auto">
      <div className="mb-4">
        <h1 className="text-xl font-black text-[var(--text)]">Catalogo</h1>
        <p className="text-sm text-[var(--text-soft)]">Tocca <span className="text-[#6b54c6] font-bold">+</span> per aggiungere al magazzino con la foto ufficiale. <span className="text-[#6b54c6] font-semibold">Beta</span></p>
      </div>

      {/* Barra ricerca — FISSA in cima: sticky top-0, lo sfondo copre il notch e l'input
          resta sotto la status bar (niente più "stacco" con buco sopra). */}
      <div className="sticky top-0 z-30 bg-[var(--bg)] pb-2" style={{ paddingTop: 'calc(env(safe-area-inset-top, 0px) + 0.5rem)' }}>
        <div className="flex items-center gap-2 px-4 py-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
          <Search size={18} className="text-[var(--text-faint)]" />
          <input value={query} onChange={e => setQuery(e.target.value)} autoFocus
            placeholder="Cerca... (es. Jordan 4, Palace tee, DV1748-100)"
            className="flex-1 bg-transparent outline-none text-[var(--text)] placeholder:text-[var(--text-faint)]" />
          {loading && <Loader2 size={18} className="text-[#6b54c6] animate-spin" />}
        </div>
        {/* Filtro tipo — scorrevole in orizzontale (7 categorie non ci stanno in larghezza) */}
        <div className="flex gap-2 mt-2 overflow-x-auto flex-nowrap -mx-1 px-1">
          {TYPES.map(tp => (
            <button key={tp.id} onClick={() => setType(tp.id)}
              className={`shrink-0 whitespace-nowrap px-3 py-1.5 rounded-full text-xs font-semibold transition-colors ${
                type === tp.id ? 'bg-[#6b54c6] text-white' : 'bg-[var(--fill)] text-[var(--text-soft)] hover:text-[var(--text)]'
              }`}>{tp.label}</button>
          ))}
          {/* Categorie personalizzate dell'utente (doppio tap per rimuovere) */}
          {customTypes.map(c => (
            <button key={c} onClick={() => setType(c.toLowerCase())} onDoubleClick={() => removeCustomType(c)}
              title="Doppio tap per rimuovere"
              className={`shrink-0 whitespace-nowrap px-3 py-1.5 rounded-full text-xs font-semibold transition-colors ${
                type === c.toLowerCase() ? 'bg-[#6b54c6] text-white' : 'bg-[var(--fill)] text-[var(--text-soft)] hover:text-[var(--text)]'
              }`}>{c}</button>
          ))}
          <button onClick={() => { setNewCat(''); setCatModalOpen(true); }}
            className="shrink-0 whitespace-nowrap px-3 py-1.5 rounded-full text-xs font-bold bg-[var(--fill)] text-[#6b54c6] hover:bg-[#6b54c6]/10 flex items-center gap-1">
            <Plus size={13} /> Categoria
          </button>
        </div>
      </div>

      {/* Risultati */}
      <div className="mt-2 divide-y divide-[var(--border)]">
        {results.map(item => {
          const isAdding = !!adding[item.key];
          const isAdded = !!addedFlash[item.key];
          return (
            <div key={item.key} className="flex items-center gap-3 py-3">
              {/* Tap su foto/nome = anteprima ingrandita */}
              <div role="button" tabIndex={0} onClick={() => setPreview(item)}
                className="flex items-center gap-3 flex-1 min-w-0 text-left cursor-pointer active:opacity-70">
                <Thumb src={item.image} alt={item.name} />
                <div className="min-w-0 flex-1">
                  <p className="font-bold text-[var(--text)] leading-tight">{item.name}</p>
                  <p className="text-xs text-[var(--text-soft)] mt-0.5">{item.sku || '—'}</p>
                  <p className="text-xs text-[var(--text-faint)]">{item.brand}</p>
                </div>
              </div>
              <button onClick={() => quickAdd(item)} disabled={isAdding}
                aria-label="Aggiungi al magazzino"
                className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 transition-colors ${
                  isAdded ? 'bg-green-500/15 text-green-500' : 'text-[#6b54c6] hover:bg-[#6b54c6]/10'
                }`}>
                {isAdding ? <Loader2 size={20} className="animate-spin" /> : isAdded ? <Check size={22} /> : <Plus size={24} />}
              </button>
            </div>
          );
        })}
      </div>

      {!loading && searched && results.length === 0 && (
        <p className="text-center text-sm text-[var(--text-faint)] py-10">Nessun risultato. Prova con lo SKU o il nome del modello.</p>
      )}
      {!loading && !searched && results.length === 0 && (
        <p className="text-center text-sm text-[var(--text-faint)] py-10">Cerca un modello per aggiungerlo al volo.</p>
      )}

      {/* ANTEPRIMA INGRANDITA — via PORTAL su body così copre TUTTO (anche la barra chat
          e la nav, che prima nascondevano il pulsante Aggiungi). X sotto il notch/safe-area. */}
      {preview && createPortal(
        <div className="fixed inset-0 z-[80] bg-black/90 backdrop-blur-md flex flex-col" onClick={() => setPreview(null)}>
          <button onClick={() => setPreview(null)} aria-label="Chiudi"
            className="absolute right-4 z-10 w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center backdrop-blur transition-colors"
            style={{ top: 'calc(env(safe-area-inset-top, 0px) + 12px)' }}>
            <X size={22} />
          </button>
          <div className="flex-1 flex items-center justify-center p-5" onClick={e => e.stopPropagation()}
            style={{ paddingTop: 'calc(env(safe-area-inset-top, 0px) + 64px)' }}>
            {preview.image
              ? <img
                  src={/^https?:\/\//i.test(preview.image) ? `/api/catalog/img?u=${encodeURIComponent(preview.image)}` : preview.image}
                  alt={preview.name}
                  className="max-w-full max-h-[58vh] object-contain rounded-2xl bg-white" />
              : <div className="w-60 h-60 rounded-2xl bg-white/10 flex items-center justify-center"><ImageOff size={40} className="text-white/40" /></div>}
          </div>
          <div className="px-6 pb-[calc(env(safe-area-inset-bottom,0px)+24px)]" onClick={e => e.stopPropagation()}>
            <p className="text-white font-extrabold text-lg leading-tight">{preview.name}</p>
            <p className="text-white/50 text-sm mt-0.5">{preview.brand}{preview.sku ? ' · ' + preview.sku : ''}</p>
            <button onClick={() => { quickAdd(preview); setPreview(null); }}
              className="mt-4 w-full py-3.5 rounded-2xl bg-[#6b54c6] hover:bg-[#5d44b0] text-white font-bold flex items-center justify-center gap-2 transition-colors">
              <Plus size={18} /> Aggiungi al magazzino
            </button>
          </div>
        </div>,
        document.body
      )}

      {/* Modale "Nuova categoria" in-app (sostituisce window.prompt nativo). */}
      {catModalOpen && createPortal(
        <div className="fixed inset-0 z-[85] bg-black/70 backdrop-blur-md flex items-center justify-center p-5"
          onClick={() => setCatModalOpen(false)}>
          <div className="w-full max-w-sm rounded-3xl bg-[var(--surface)] border border-[var(--border-2)] p-5 shadow-2xl"
            onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-2.5 mb-1">
              <span className="w-9 h-9 rounded-xl bg-[#6b54c6]/15 text-[#6b54c6] flex items-center justify-center shrink-0"><Plus size={18} /></span>
              <h3 className="font-extrabold text-[var(--text)] text-lg leading-tight">Nuova categoria</h3>
            </div>
            <p className="text-xs text-[var(--text-soft)] mb-4 pl-0.5">Scrivila e cerco i prodotti giusti dal vivo. Es. <span className="text-[var(--text)] font-semibold">Profumi, Vinili, Orologi</span>.</p>
            <input value={newCat} onChange={e => setNewCat(e.target.value)} autoFocus
              onKeyDown={e => { if (e.key === 'Enter') confirmAddCategory(); if (e.key === 'Escape') setCatModalOpen(false); }}
              placeholder="Nome categoria…"
              className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl px-3.5 py-3 text-sm text-[var(--text)] placeholder:text-[var(--text-faint)] outline-none focus:border-[#6b54c6]" />
            <div className="flex gap-2.5 mt-4">
              <button onClick={() => setCatModalOpen(false)}
                className="flex-1 py-3 rounded-xl bg-[var(--fill)] text-[var(--text-soft)] hover:text-[var(--text)] font-bold text-sm transition-colors">
                Annulla
              </button>
              <button onClick={confirmAddCategory} disabled={!newCat.trim()}
                className="flex-1 py-3 rounded-xl bg-[#6b54c6] hover:bg-[#5d44b0] text-white font-bold text-sm transition-colors disabled:opacity-40">
                Aggiungi
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
