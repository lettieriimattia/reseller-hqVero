// SmartLotModal — "Lotto smart (IA)": fotografi lo stock in blocco, l'IA riconosce ogni
// articolo (marca/modello/taglia/valore), confermi/correggi, metti UN costo totale → l'app
// lo divide (equo o pesato sul valore di mercato) e inserisce tutti i pezzi nel lotto.
import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X, Camera, Loader2, Trash2, Plus, Wand2, Check } from 'lucide-react';

type ApiCall = <T = any>(path: string, opts?: RequestInit) => Promise<{ ok: boolean; data: T; status: number }>;

interface LotItem {
  id: string; photo: string | null;
  brand: string; name: string; size: string; category: string; condition: string;
  marketValue: number; scanning: boolean;
}

interface Props {
  apiCall: ApiCall;
  showToast: (m: string, t?: 'ok' | 'err' | 'warn') => void;
  onDone: () => void;
  onClose: () => void;
  warehouses: { id: string; name: string; parentId?: string | null }[];
  baseWarehouseId?: string;
  categories: string[];
}

// Comprime una foto lato client (canvas) → base64 jpeg leggero, così il DB resta piccolo.
function compress(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const max = 900;
        let { width, height } = img;
        if (width > height && width > max) { height = (height * max) / width; width = max; }
        else if (height >= width && height > max) { width = (width * max) / height; height = max; }
        const c = document.createElement('canvas');
        c.width = width; c.height = height;
        const ctx = c.getContext('2d');
        if (!ctx) return reject(new Error('canvas'));
        ctx.drawImage(img, 0, 0, width, height);
        resolve(c.toDataURL('image/jpeg', 0.72));
      };
      img.onerror = reject;
      img.src = reader.result as string;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export default function SmartLotModal({ apiCall, showToast, onDone, onClose, warehouses, baseWarehouseId, categories }: Props) {
  const [items, setItems] = useState<LotItem[]>([]);
  const [lotName, setLotName] = useState('');
  const [totalCost, setTotalCost] = useState('');
  const [splitMode, setSplitMode] = useState<'equal' | 'weighted'>('equal');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const cardsRef = useRef<HTMLInputElement>(null);

  // Foto con PIÙ carte (es. pagina di raccoglitore): l'IA le riconosce tutte → aggiunge ogni
  // carta come voce, con foto ufficiale dal catalogo Pokémon. Costo poi diviso fra le carte.
  const onCardsPhoto = async (files: FileList | null) => {
    if (!files || !files[0]) return;
    let photo: string | null = null;
    try { photo = await compress(files[0]); } catch { return; }
    const tmpId = Math.random().toString(36).slice(2);
    setItems(prev => [...prev, { id: tmpId, photo, brand: 'Pokémon', name: 'Riconosco le carte…', size: '-', category: 'Carte', condition: 'N/D', marketValue: 0, scanning: true }]);
    try {
      const { ok, data } = await apiCall<any>('/api/ai/scan-cards', { method: 'POST', body: JSON.stringify({ imageBase64: photo }) });
      const cards = (ok && Array.isArray(data?.cards)) ? data.cards : [];
      setItems(prev => {
        const without = prev.filter(it => it.id !== tmpId);
        const added: LotItem[] = cards.map((c: any) => ({
          id: Math.random().toString(36).slice(2),
          photo: c.image || null,
          brand: 'Pokémon',
          name: [c.name, c.number].filter(Boolean).join(' '),
          size: '-', category: 'Carte', condition: 'N/D',
          marketValue: 0, scanning: false,
        }));
        return [...without, ...added];
      });
      if (!cards.length) showToast('Nessuna carta riconosciuta nella foto', 'warn');
      else showToast(`${cards.length} carte riconosciute`, 'ok');
    } catch {
      setItems(prev => prev.filter(it => it.id !== tmpId));
      showToast('Errore riconoscimento carte', 'err');
    }
    if (cardsRef.current) cardsRef.current.value = '';
  };

  // ESC chiude (coerente col resto dell'app).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const upd = (id: string, patch: Partial<LotItem>) =>
    setItems(prev => prev.map(it => (it.id === id ? { ...it, ...patch } : it)));
  const remove = (id: string) => setItems(prev => prev.filter(it => it.id !== id));

  const onFiles = async (files: FileList | null) => {
    if (!files) return;
    const arr = Array.from(files).slice(0, 50);
    for (const f of arr) {
      const id = Math.random().toString(36).slice(2);
      let photo: string | null = null;
      try { photo = await compress(f); } catch { /* foto non leggibile: salto */ continue; }
      setItems(prev => [...prev, { id, photo, brand: '', name: '', size: '-', category: '', condition: 'N/D', marketValue: 0, scanning: true }]);
      // Riconoscimento IA in background (non blocca: puoi aggiungere altre foto intanto).
      (async () => {
        try {
          const { ok, data } = await apiCall<any>('/api/ai/full-scan', {
            method: 'POST',
            body: JSON.stringify({ imageBase64: photo, existingCategories: categories }),
          });
          const s = (ok && data?.scan) ? data.scan : {};
          const d = s.details || {};
          const mv = Number(s.marketPriceAvg ?? s.estimatedValue ?? d.estimatedValue ?? d.value ?? 0) || 0;
          upd(id, {
            scanning: false,
            brand: (s.brand || '').toString(),
            name: (s.model || d.type || d.colorway || '').toString(),
            size: (d.size || s.size || '-').toString(),
            category: (s.detectedCategory || 'Generico').toString(),
            condition: (d.condition || 'N/D').toString(),
            marketValue: mv,
          });
        } catch {
          upd(id, { scanning: false });
        }
      })();
    }
    if (fileRef.current) fileRef.current.value = '';
  };

  const total = parseFloat(totalCost) || 0;
  const anyScanning = items.some(i => i.scanning);
  const weights = items.map(i => Math.max(i.marketValue, 0));
  const wsum = weights.reduce((a, b) => a + b, 0);
  const useWeighted = splitMode === 'weighted' && wsum > 0;
  const costFor = (idx: number) => {
    if (total <= 0 || items.length === 0) return 0;
    return useWeighted ? (total * weights[idx]) / wsum : total / items.length;
  };

  const create = async () => {
    if (!lotName.trim()) { showToast('Dai un nome al lotto', 'warn'); return; }
    if (items.length < 1) { showToast('Aggiungi almeno una foto', 'warn'); return; }
    setBusy(true);
    const { ok, data } = await apiCall<any>('/products/lot-smart', {
      method: 'POST',
      body: JSON.stringify({
        lotName: lotName.trim(), totalPrice: total, splitMode,
        warehouseId: baseWarehouseId || warehouses[0]?.id,
        items: items.map(it => ({
          category: it.category, brand: it.brand, name: it.name, size: it.size,
          condition: it.condition, photo: it.photo, marketValue: it.marketValue,
        })),
      }),
    });
    setBusy(false);
    if (!ok) { showToast(data?.error || 'Errore creazione lotto', 'err'); return; }
    showToast(`✅ Lotto "${lotName.trim()}" creato: ${data.created} pezzi`, 'ok');
    onDone();
    onClose();
  };

  return createPortal(
    <div className="fixed inset-0 z-[60] bg-black/80 backdrop-blur-sm flex flex-col sm:items-center sm:justify-center sm:p-4" onClick={() => { if (!busy) onClose(); }}>
      <div className="relative flex flex-col bg-[var(--surface)] w-full h-full sm:h-auto sm:max-h-[90vh] sm:max-w-lg sm:rounded-3xl border border-[var(--border-2)] overflow-hidden" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border)] shrink-0" style={{ paddingTop: 'calc(env(safe-area-inset-top, 0px) + 16px)' }}>
          <div className="flex items-center gap-2.5">
            <span className="w-9 h-9 rounded-xl bg-[#6b54c6]/15 text-[#6b54c6] flex items-center justify-center"><Wand2 size={18} /></span>
            <div className="leading-tight">
              <h3 className="font-extrabold text-[var(--text)]">Lotto smart</h3>
              <p className="text-[11px] text-[var(--text-soft)]">Fotografa lo stock, l'IA lo riconosce</p>
            </div>
          </div>
          <button onClick={() => { if (!busy) onClose(); }} className="p-1.5 rounded-full text-[var(--text-faint)] hover:text-[var(--text)] hover:bg-white/5"><X size={22} /></button>
        </div>

        {/* Corpo scrollabile */}
        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-3">
          {/* Nome lotto */}
          <input value={lotName} onChange={e => setLotName(e.target.value)} placeholder="Nome del lotto (es. Stock Vinted 12/06)"
            className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl px-3.5 py-3 text-sm outline-none focus:border-[#6b54c6]" />

          {/* Lista item riconosciuti */}
          {items.length === 0 && (
            <div className="text-center text-sm text-[var(--text-soft)] py-8 leading-relaxed">
              Aggiungi le foto degli articoli (anche tante insieme).<br />
              <span className="text-[var(--text-faint)]">L'IA riconosce marca, modello, taglia e valore di ciascuno.</span>
            </div>
          )}
          {items.map((it, idx) => (
            <div key={it.id} className="flex gap-3 p-2.5 rounded-2xl bg-[var(--surface-2)] border border-[var(--border)]">
              <div className="w-16 h-16 rounded-xl bg-white overflow-hidden shrink-0 flex items-center justify-center">
                {it.photo ? <img src={it.photo} alt="" className="w-full h-full object-contain" /> : null}
              </div>
              <div className="flex-1 min-w-0 space-y-1.5">
                {it.scanning ? (
                  <div className="flex items-center gap-2 text-xs text-[#6b54c6] py-2"><Loader2 size={14} className="animate-spin" /> Riconoscimento…</div>
                ) : (
                  <>
                    <div className="flex gap-1.5">
                      <input value={it.brand} onChange={e => upd(it.id, { brand: e.target.value })} placeholder="Marca"
                        className="w-1/3 bg-[var(--surface)] border border-[var(--border-2)] rounded-lg px-2 py-1.5 text-xs outline-none focus:border-[#6b54c6]" />
                      <input value={it.name} onChange={e => upd(it.id, { name: e.target.value })} placeholder="Modello"
                        className="flex-1 min-w-0 bg-[var(--surface)] border border-[var(--border-2)] rounded-lg px-2 py-1.5 text-xs outline-none focus:border-[#6b54c6]" />
                    </div>
                    <div className="flex gap-1.5 items-center">
                      <input value={it.size} onChange={e => upd(it.id, { size: e.target.value })} placeholder="Taglia"
                        className="w-16 bg-[var(--surface)] border border-[var(--border-2)] rounded-lg px-2 py-1.5 text-xs outline-none focus:border-[#6b54c6]" />
                      <input value={it.category} onChange={e => upd(it.id, { category: e.target.value })} placeholder="Reparto"
                        className="flex-1 min-w-0 bg-[var(--surface)] border border-[var(--border-2)] rounded-lg px-2 py-1.5 text-xs outline-none focus:border-[#6b54c6]" />
                      <span className="text-[11px] text-[var(--text-soft)] shrink-0 num">
                        {it.marketValue > 0 ? `~${it.marketValue}€` : ''}
                      </span>
                    </div>
                  </>
                )}
              </div>
              <div className="flex flex-col items-end justify-between shrink-0">
                <button onClick={() => remove(it.id)} className="p-1 text-red-400/80 hover:text-red-400"><Trash2 size={15} /></button>
                {total > 0 && !it.scanning && <span className="text-xs font-bold text-[var(--teal)] num">{costFor(idx).toFixed(2)}€</span>}
              </div>
            </div>
          ))}

          {/* Aggiungi foto */}
          <input ref={fileRef} type="file" accept="image/*" capture="environment" multiple className="hidden" onChange={e => onFiles(e.target.files)} />
          <input ref={cardsRef} type="file" accept="image/*" className="hidden" onChange={e => onCardsPhoto(e.target.files)} />
          <button onClick={() => fileRef.current?.click()}
            className="w-full py-3 rounded-2xl border border-dashed border-[#6b54c6]/40 text-[#6b54c6] font-bold text-sm flex items-center justify-center gap-2 hover:bg-[#6b54c6]/10">
            <Camera size={17} /> {items.length ? 'Aggiungi altre foto' : 'Scatta / scegli foto (1 per prodotto)'}
          </button>
          <button onClick={() => cardsRef.current?.click()}
            className="w-full py-3 rounded-2xl border border-dashed border-teal-500/40 text-teal-400 font-bold text-sm flex items-center justify-center gap-2 hover:bg-teal-500/10">
            <Wand2 size={17} /> Più carte da una foto (IA)
          </button>
        </div>

        {/* Footer: costo totale + split + crea */}
        <div className="shrink-0 border-t border-[var(--border)] px-5 py-4 space-y-3" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 16px)' }}>
          <div className="flex items-center gap-2">
            <div className="flex-1">
              <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest">Costo totale lotto</label>
              <div className="flex items-center bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl px-3 mt-1 focus-within:border-[#6b54c6]">
                <input type="number" step="0.01" value={totalCost} onChange={e => setTotalCost(e.target.value)} placeholder="0"
                  className="flex-1 bg-transparent py-2.5 text-sm outline-none num" />
                <span className="text-[var(--text-soft)]">€</span>
              </div>
            </div>
            <div className="flex rounded-xl bg-[var(--surface-2)] border border-[var(--border-2)] p-1 mt-5">
              <button onClick={() => setSplitMode('equal')} className={`px-2.5 py-1.5 rounded-lg text-[11px] font-bold transition-colors ${splitMode === 'equal' ? 'bg-[#6b54c6] text-white' : 'text-[var(--text-soft)]'}`}>Equo</button>
              <button onClick={() => setSplitMode('weighted')} className={`px-2.5 py-1.5 rounded-lg text-[11px] font-bold transition-colors ${splitMode === 'weighted' ? 'bg-[#6b54c6] text-white' : 'text-[var(--text-soft)]'}`}>Pesato</button>
            </div>
          </div>
          {splitMode === 'weighted' && wsum === 0 && (
            <p className="text-[11px] text-[var(--text-faint)]">Nessun valore di mercato rilevato → divido in parti uguali.</p>
          )}
          <button onClick={create} disabled={busy || anyScanning || items.length === 0 || !lotName.trim()}
            className="w-full py-3.5 rounded-2xl bg-[#6b54c6] hover:bg-[#5d44b0] text-white font-bold flex items-center justify-center gap-2 transition-colors disabled:opacity-40">
            {busy ? <Loader2 size={18} className="animate-spin" /> : <Check size={18} />}
            {busy ? 'Creo il lotto…' : anyScanning ? 'Attendo il riconoscimento…' : `Crea lotto (${items.length} pezzi)`}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
