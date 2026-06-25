// CatalogBrowser — schermata "Aggiungi prodotti" stile StockX (BETA, solo admin).
// L'utente cerca un modello, lo trova col catalogo StockX (foto ufficiale, sfondo
// uniforme) e lo aggiunge al magazzino mettendo solo taglia/prezzo/condizione.
// La foto è il LINK diretto StockX (niente Cloudinary): il backend lo salva tale e quale.

import { useState, useEffect, useRef, useCallback } from 'react';
import { Search, Plus, X, Loader2, ImageOff } from 'lucide-react';

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
];

const CONDITIONS = ['Nuovo', 'Nuovo con difetti', 'Usato ottimo', 'Usato buono', 'Usato'];

function Thumb({ src, alt }: { src: string | null; alt: string }) {
  const [err, setErr] = useState(false);
  if (!src || err) {
    return (
      <div className="w-14 h-14 rounded-lg bg-[var(--fill)] flex items-center justify-center shrink-0">
        <ImageOff size={18} className="text-[var(--text-faint)]" />
      </div>
    );
  }
  return <img src={src} alt={alt} onError={() => setErr(true)} loading="lazy"
    className="w-14 h-14 rounded-lg object-contain bg-white shrink-0" />;
}

export default function CatalogBrowser({ apiCall, showToast, categories, warehouses, baseWarehouseId, onAdded }: Props) {
  const [query, setQuery] = useState('');
  const [type, setType] = useState('');
  const [results, setResults] = useState<CatalogResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);

  // Item selezionato per l'aggiunta (apre il pannello con taglia/prezzo/condizione)
  const [sel, setSel] = useState<CatalogResult | null>(null);
  const [size, setSize] = useState('');
  const [price, setPrice] = useState('');
  const [condition, setCondition] = useState(CONDITIONS[0]);
  const [category, setCategory] = useState(categories[0] || '');
  const [warehouseId, setWarehouseId] = useState(baseWarehouseId || '');
  const [saving, setSaving] = useState(false);

  const debTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const runSearch = useCallback(async (q: string, t: string) => {
    if (q.trim().length < 2) { setResults([]); setSearched(false); return; }
    setLoading(true);
    const { ok, data } = await apiCall<CatalogResult[]>(`/catalog/search?q=${encodeURIComponent(q.trim())}&type=${encodeURIComponent(t)}`);
    setLoading(false);
    setSearched(true);
    setResults(ok && Array.isArray(data) ? data : []);
  }, [apiCall]);

  // Debounce sulla digitazione
  useEffect(() => {
    if (debTimer.current) clearTimeout(debTimer.current);
    debTimer.current = setTimeout(() => runSearch(query, type), 450);
    return () => { if (debTimer.current) clearTimeout(debTimer.current); };
  }, [query, type, runSearch]);

  const openAdd = (item: CatalogResult) => {
    setSel(item);
    setSize(''); setPrice(''); setCondition(CONDITIONS[0]);
    setCategory(item.productType === 'sneakers' ? (categories.find(c => /scarp|sneaker/i.test(c)) || categories[0] || '') : (categories[0] || ''));
    setWarehouseId(baseWarehouseId || warehouses[0]?.id || '');
  };

  const save = async () => {
    if (!sel) return;
    if (!category) { showToast('Scegli un reparto', 'warn'); return; }
    setSaving(true);
    const { ok, data } = await apiCall<any>('/products', {
      method: 'POST',
      body: JSON.stringify({
        category,
        brand: sel.brand || '-',
        name: sel.name || sel.brand || '-',
        sku: sel.sku || undefined,
        size: size.trim() || undefined,
        condition,
        price: parseFloat(price) || 0,
        warehouseId: warehouseId || undefined,
        photos: sel.image ? [sel.image] : undefined, // LINK StockX: il backend NON lo ricarica su Cloudinary
      }),
    });
    setSaving(false);
    if (!ok || !data?.id) { showToast(data?.error || 'Errore aggiunta prodotto', 'err'); return; }
    apiCall(`/catalog/${encodeURIComponent(sel.key)}/used`, { method: 'POST' }).catch(() => {});
    showToast(`Aggiunto: ${sel.brand} ${sel.name}`, 'ok');
    setSel(null);
    onAdded();
  };

  return (
    <div className="max-w-2xl mx-auto">
      <div className="mb-4">
        <h1 className="text-xl font-black text-[var(--text)]">Catalogo</h1>
        <p className="text-sm text-[var(--text-soft)]">Cerca un modello e aggiungilo con la foto ufficiale. <span className="text-[#8b5cf6] font-semibold">Beta · solo admin</span></p>
      </div>

      {/* Barra ricerca */}
      <div className="sticky top-0 z-10 bg-[var(--bg)] pb-2">
        <div className="flex items-center gap-2 px-4 py-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
          <Search size={18} className="text-[var(--text-faint)]" />
          <input value={query} onChange={e => setQuery(e.target.value)} autoFocus
            placeholder="Cerca... (es. Jordan 4, Palace tee, DV1748-100)"
            className="flex-1 bg-transparent outline-none text-[var(--text)] placeholder:text-[var(--text-faint)]" />
          {loading && <Loader2 size={18} className="text-[#8b5cf6] animate-spin" />}
        </div>
        {/* Filtro tipo */}
        <div className="flex gap-2 mt-2">
          {TYPES.map(tp => (
            <button key={tp.id} onClick={() => setType(tp.id)}
              className={`px-3 py-1.5 rounded-full text-xs font-semibold transition-colors ${
                type === tp.id ? 'bg-[#8b5cf6] text-white' : 'bg-[var(--fill)] text-[var(--text-soft)] hover:text-[var(--text)]'
              }`}>{tp.label}</button>
          ))}
        </div>
      </div>

      {/* Risultati */}
      <div className="mt-2 divide-y divide-[var(--border)]">
        {results.map(item => (
          <div key={item.key} className="flex items-center gap-3 py-3">
            <Thumb src={item.image} alt={item.name} />
            <div className="min-w-0 flex-1">
              <p className="font-bold text-[var(--text)] leading-tight truncate">{item.name}</p>
              <p className="text-xs text-[var(--text-soft)] mt-0.5">{item.sku || '—'}</p>
              <p className="text-xs text-[var(--text-faint)]">{item.brand}</p>
            </div>
            <button onClick={() => openAdd(item)}
              className="w-9 h-9 rounded-full flex items-center justify-center text-[#8b5cf6] hover:bg-[#8b5cf6]/10 transition-colors shrink-0">
              <Plus size={22} />
            </button>
          </div>
        ))}
      </div>

      {!loading && searched && results.length === 0 && (
        <p className="text-center text-sm text-[var(--text-faint)] py-10">Nessun risultato. Prova con lo SKU o il nome del modello.</p>
      )}
      {!searched && !loading && (
        <p className="text-center text-sm text-[var(--text-faint)] py-10">Inizia a digitare per cercare nel catalogo.</p>
      )}

      {/* Pannello aggiunta */}
      {sel && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-0 sm:p-4" onClick={() => !saving && setSel(null)}>
          <div className="w-full sm:max-w-md bg-[var(--surface)] rounded-t-3xl sm:rounded-3xl border border-[var(--border)] p-5" onClick={e => e.stopPropagation()}>
            <div className="flex items-start justify-between mb-4">
              <div className="flex items-center gap-3 min-w-0">
                <Thumb src={sel.image} alt={sel.name} />
                <div className="min-w-0">
                  <p className="font-bold text-[var(--text)] truncate">{sel.name}</p>
                  <p className="text-xs text-[var(--text-soft)]">{sel.brand} · {sel.sku || '—'}</p>
                </div>
              </div>
              <button onClick={() => !saving && setSel(null)} className="text-[var(--text-faint)] hover:text-[var(--text)] p-1"><X size={20} /></button>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <label className="text-xs font-semibold text-[var(--text-soft)] col-span-2">Reparto
                <select value={category} onChange={e => setCategory(e.target.value)}
                  className="mt-1 w-full px-3 py-2 rounded-xl bg-[var(--fill)] border border-[var(--border)] text-[var(--text)] text-sm font-normal">
                  {categories.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </label>
              <label className="text-xs font-semibold text-[var(--text-soft)]">Taglia
                <input value={size} onChange={e => setSize(e.target.value)} placeholder="es. 42 / M"
                  className="mt-1 w-full px-3 py-2 rounded-xl bg-[var(--fill)] border border-[var(--border)] text-[var(--text)] text-sm font-normal" />
              </label>
              <label className="text-xs font-semibold text-[var(--text-soft)]">Prezzo d'acquisto €
                <input value={price} onChange={e => setPrice(e.target.value)} inputMode="decimal" placeholder="0"
                  className="mt-1 w-full px-3 py-2 rounded-xl bg-[var(--fill)] border border-[var(--border)] text-[var(--text)] text-sm font-normal" />
              </label>
              <label className="text-xs font-semibold text-[var(--text-soft)]">Condizione
                <select value={condition} onChange={e => setCondition(e.target.value)}
                  className="mt-1 w-full px-3 py-2 rounded-xl bg-[var(--fill)] border border-[var(--border)] text-[var(--text)] text-sm font-normal">
                  {CONDITIONS.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </label>
              {warehouses.length > 1 && (
                <label className="text-xs font-semibold text-[var(--text-soft)]">Magazzino
                  <select value={warehouseId} onChange={e => setWarehouseId(e.target.value)}
                    className="mt-1 w-full px-3 py-2 rounded-xl bg-[var(--fill)] border border-[var(--border)] text-[var(--text)] text-sm font-normal">
                    {warehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
                  </select>
                </label>
              )}
            </div>

            <button onClick={save} disabled={saving}
              className="mt-5 w-full py-3 rounded-2xl bg-[#8b5cf6] text-white font-bold flex items-center justify-center gap-2 disabled:opacity-60">
              {saving ? <Loader2 size={18} className="animate-spin" /> : <Plus size={18} />}
              Aggiungi al magazzino
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
