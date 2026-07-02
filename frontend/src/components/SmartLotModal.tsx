// SmartLotModal — Crea un LOTTO a righe: inserisci il numero di pezzi N e quanto hai pagato in
// totale → genera N righe (nome + taglia/codice); il costo si divide a cascata (totale/N). Se
// hai la FOTO di più carte, l'IA le riconosce e RIEMPIE le righe coi nomi (+ foto ufficiale).
import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X, Camera, Loader2, Trash2, Plus, Wand2, Check } from 'lucide-react';

type ApiCall = <T = any>(path: string, opts?: RequestInit) => Promise<{ ok: boolean; data: T; status: number }>;

interface Row { id: string; name: string; size: string; photo: string | null; }

interface Props {
  apiCall: ApiCall;
  showToast: (m: string, t?: 'ok' | 'err' | 'warn') => void;
  onDone: () => void;
  onClose: () => void;
  warehouses: { id: string; name: string; parentId?: string | null }[];
  baseWarehouseId?: string;
  categories: string[];
}

// Comprime una foto lato client (canvas) → base64 jpeg leggero.
function compress(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const max = 1100;
        let { width, height } = img;
        if (width > height && width > max) { height = (height * max) / width; width = max; }
        else if (height >= width && height > max) { width = (width * max) / height; height = max; }
        const c = document.createElement('canvas');
        c.width = width; c.height = height;
        const ctx = c.getContext('2d');
        if (!ctx) return reject(new Error('canvas'));
        ctx.drawImage(img, 0, 0, width, height);
        resolve(c.toDataURL('image/jpeg', 0.74));
      };
      img.onerror = reject;
      img.src = reader.result as string;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

const newRow = (): Row => ({ id: Math.random().toString(36).slice(2), name: '', size: '', photo: null });

export default function SmartLotModal({ apiCall, showToast, onDone, onClose, warehouses, baseWarehouseId, categories }: Props) {
  const [lotName, setLotName] = useState('');
  const [category, setCategory] = useState(categories[0] || 'Generico');
  const [lotWarehouseId, setLotWarehouseId] = useState(baseWarehouseId || warehouses[0]?.id || ''); // magazzino/socio del lotto
  const [qty, setQty] = useState('');
  const [totalCost, setTotalCost] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const cardsRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  // Imposta il numero di pezzi → genera/taglia le righe a cascata.
  const setCount = (nStr: string) => {
    setQty(nStr);
    const n = Math.min(Math.max(parseInt(nStr) || 0, 0), 200);
    setRows(prev => {
      if (n === prev.length) return prev;
      if (n < prev.length) return prev.slice(0, n);
      return [...prev, ...Array.from({ length: n - prev.length }, newRow)];
    });
  };

  const updRow = (id: string, patch: Partial<Row>) => setRows(prev => prev.map(r => (r.id === id ? { ...r, ...patch } : r)));

  // Ricerca foto ufficiale per NOME: al blur / quando cambio il nome (es. l'IA ha sbagliato a
  // leggere la carta), prende il nome che ho scritto, cerca nel catalogo giusto e mette la foto.
  const lookedUpRef = useRef<Record<string, string>>({});
  const typeForCategory = (cat: string): string => {
    const c = (cat || '').toLowerCase();
    if (/pokemon|carte|carta|tcg/.test(c)) return 'pokemon';
    if (/scarp|sneaker|shoe/.test(c)) return 'sneakers';
    if (/vest|abbig|cloth|appar|felp|magl/.test(c)) return 'apparel';
    if (/bors|bag|hand/.test(c)) return 'borse';
    if (/access/.test(c)) return 'accessori';
    if (/elettr|electron|tech/.test(c)) return 'elettronica';
    return '';
  };
  const lookupPhoto = async (id: string, name: string) => {
    const q = (name || '').trim();
    if (q.length < 2 || lookedUpRef.current[id] === q) return; // niente doppioni sullo stesso nome
    lookedUpRef.current[id] = q;
    try {
      const t = typeForCategory(category);
      const { ok, data } = await apiCall<any[]>(`/api/catalog/search?q=${encodeURIComponent(q)}&type=${encodeURIComponent(t)}`);
      const withImg = ok && Array.isArray(data) ? data.filter((d: any) => d?.image) : [];
      if (withImg.length === 0) return;
      // Scegli il risultato che combacia MEGLIO col nome scritto (colore incluso), non il primo:
      // es. "Dior B27 Blue" prende la variante Blue e non la bianca generica.
      const words = q.toLowerCase().split(/\s+/).filter(w => w.length > 1);
      const scoreOf = (d: any) => { const n = `${d.name || ''} ${d.brand || ''}`.toLowerCase(); return words.reduce((s, w) => s + (n.includes(w) ? 1 : 0), 0); };
      withImg.sort((a: any, b: any) => scoreOf(b) - scoreOf(a));
      const hit = withImg[0];
      if (hit?.image) updRow(id, { photo: hit.image });
    } catch { /* noop */ }
  };
  const addRow = () => setRows(prev => { const next = [...prev, newRow()]; setQty(String(next.length)); return next; });
  const removeRow = (id: string) => setRows(prev => { const next = prev.filter(r => r.id !== id); setQty(String(next.length)); return next; });

  // Foto con più prodotti (anche MISTI: scarpe + carte…) → l'IA li riconosce tutti e RIEMPIE le
  // righe (riusa le vuote, aggiunge se servono).
  const onCardsPhoto = async (files: FileList | null) => {
    if (!files || !files[0]) return;
    let photo: string | null = null;
    try { photo = await compress(files[0]); } catch { return; }
    setScanning(true);
    showToast('🔍 Riconosco i prodotti…', 'ok');
    try {
      const { ok, data } = await apiCall<any>('/api/ai/scan-items', { method: 'POST', body: JSON.stringify({ imageBase64: photo }) });
      const items = (ok && Array.isArray(data?.items)) ? data.items : [];
      if (!items.length) { showToast('Nessun prodotto riconosciuto nella foto', 'warn'); setScanning(false); return; }
      setRows(prev => {
        const next = [...prev];
        let idx = 0;
        for (const c of items) {
          const nm = String(c.name || '').trim();
          if (!nm) continue;
          while (idx < next.length && next[idx].name.trim()) idx++; // prossima riga vuota
          if (idx < next.length) { next[idx] = { ...next[idx], name: nm, size: c.number || next[idx].size, photo: c.image || next[idx].photo }; idx++; }
          else { next.push({ id: Math.random().toString(36).slice(2), name: nm, size: c.number || '', photo: c.image || null }); }
        }
        setQty(String(next.length));
        return next;
      });
      showToast(`✅ ${items.length} prodotti inseriti nelle righe`, 'ok');
    } catch { showToast('Errore riconoscimento prodotti', 'err'); }
    setScanning(false);
    if (cardsRef.current) cardsRef.current.value = '';
  };

  const total = parseFloat(totalCost) || 0;
  const filled = rows.filter(r => r.name.trim()).length;
  const perRow = total > 0 && rows.length ? total / rows.length : 0;

  const create = async () => {
    if (!lotName.trim()) { showToast('Dai un nome al lotto', 'warn'); return; }
    const valid = rows.filter(r => r.name.trim());
    if (!valid.length) { showToast('Compila almeno una riga (nome)', 'warn'); return; }
    setBusy(true);
    const { ok, data } = await apiCall<any>('/products/lot-smart', {
      method: 'POST',
      body: JSON.stringify({
        lotName: lotName.trim(), totalPrice: total, splitMode: 'equal',
        warehouseId: lotWarehouseId || baseWarehouseId || warehouses[0]?.id,
        items: valid.map(r => ({ category, brand: '', name: r.name.trim(), size: r.size.trim() || '-', condition: 'N/D', photo: r.photo, marketValue: 0 })),
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
              <h3 className="font-extrabold text-[var(--text)]">Crea lotto</h3>
              <p className="text-[11px] text-[var(--text-soft)]">N pezzi + costo totale → righe a cascata</p>
            </div>
          </div>
          <button onClick={() => { if (!busy) onClose(); }} className="p-1.5 rounded-full text-[var(--text-faint)] hover:text-[var(--text)] hover:bg-white/5"><X size={22} /></button>
        </div>

        {/* Corpo scrollabile */}
        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-3">
          <input value={lotName} onChange={e => setLotName(e.target.value)} placeholder="Nome del lotto (es. Carte amico 12/06)"
            className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl px-3.5 py-3 text-sm outline-none focus:border-[#6b54c6]" />

          {/* Magazzino / socio del lotto (team): scegli dove finiscono i pezzi. */}
          {warehouses.length > 1 && (
            <div>
              <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-1">Magazzino</label>
              <select value={lotWarehouseId} onChange={e => setLotWarehouseId(e.target.value)}
                className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl px-3 py-2.5 text-sm outline-none focus:border-[#6b54c6]">
                {warehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select>
            </div>
          )}

          <div className="grid grid-cols-3 gap-2.5">
            <div>
              <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-1">Reparto</label>
              <select value={category} onChange={e => setCategory(e.target.value)}
                className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl px-2 py-2.5 text-sm outline-none focus:border-[#6b54c6]">
                {(categories.length ? categories : ['Carte']).map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div>
              <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-1">Pezzi (N)</label>
              <input type="number" min={0} max={200} value={qty} onChange={e => setCount(e.target.value)} placeholder="20"
                className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl px-3 py-2.5 text-sm outline-none focus:border-[#6b54c6] num" />
            </div>
            <div>
              <label className="text-[10px] font-bold text-[var(--text-soft)] uppercase tracking-widest block mb-1">Pagato tot. €</label>
              <input type="number" step="0.01" value={totalCost} onChange={e => setTotalCost(e.target.value)} placeholder="105"
                className="w-full bg-[var(--surface-2)] border border-[var(--border-2)] rounded-xl px-3 py-2.5 text-sm outline-none focus:border-[#6b54c6] num" />
            </div>
          </div>
          {total > 0 && rows.length > 0 && (
            <p className="text-xs text-[var(--text-soft)]">= <b className="text-[var(--teal)] num">{perRow.toFixed(2)}€</b> a pezzo ({rows.length} righe)</p>
          )}

          {/* Riempi con foto di più carte (IA) */}
          <input ref={cardsRef} type="file" accept="image/*" className="hidden" onChange={e => onCardsPhoto(e.target.files)} />
          <button onClick={() => cardsRef.current?.click()} disabled={scanning}
            className="w-full py-2.5 rounded-2xl border border-dashed border-teal-500/40 text-teal-400 font-bold text-sm flex items-center justify-center gap-2 hover:bg-teal-500/10 disabled:opacity-50">
            {scanning ? <Loader2 size={16} className="animate-spin" /> : <Camera size={16} />} Foto con più prodotti → riempi le righe (IA)
          </button>

          {/* Righe */}
          {rows.length === 0 && (
            <div className="text-center text-sm text-[var(--text-soft)] py-6 leading-relaxed">
              Inserisci <b className="text-[var(--text)]">N pezzi</b> sopra per generare le righe,<br />
              <span className="text-[var(--text-faint)]">poi compilale a mano o con la foto.</span>
            </div>
          )}
          {rows.map((r, i) => (
            <div key={r.id} className="flex gap-2 items-center">
              <span className="w-6 text-right text-[11px] text-[var(--text-faint)] num shrink-0">{i + 1}</span>
              <div className="w-10 h-10 rounded-lg bg-white overflow-hidden shrink-0 flex items-center justify-center border border-[var(--border)]">
                {r.photo ? <img src={/^https?:\/\//i.test(r.photo) ? `/api/catalog/img?u=${encodeURIComponent(r.photo)}` : r.photo} alt="" className="w-full h-full object-contain" /> : null}
              </div>
              <input value={r.name} onChange={e => updRow(r.id, { name: e.target.value })} onBlur={() => lookupPhoto(r.id, r.name)} placeholder="Nome"
                className="flex-1 min-w-0 bg-[var(--surface-2)] border border-[var(--border-2)] rounded-lg px-2.5 py-2 text-xs outline-none focus:border-[#6b54c6]" />
              <input value={r.size} onChange={e => updRow(r.id, { size: e.target.value })} placeholder="Taglia / codice"
                className="w-24 shrink-0 bg-[var(--surface-2)] border border-[var(--border-2)] rounded-lg px-2 py-2 text-xs outline-none focus:border-[#6b54c6]" />
              <button onClick={() => removeRow(r.id)} className="p-1 text-red-400/80 hover:text-red-400 shrink-0"><Trash2 size={14} /></button>
            </div>
          ))}
          {rows.length > 0 && (
            <button onClick={addRow} className="w-full py-2 rounded-xl border border-dashed border-[var(--border-2)] text-xs font-bold text-[var(--text-soft)] hover:text-[var(--text)] flex items-center justify-center gap-1.5">
              <Plus size={13} /> Aggiungi riga
            </button>
          )}
        </div>

        {/* Footer */}
        <div className="shrink-0 border-t border-[var(--border)] px-5 py-4" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 16px)' }}>
          <button onClick={create} disabled={busy || scanning || filled === 0 || !lotName.trim()}
            className="w-full py-3.5 rounded-2xl bg-[#6b54c6] hover:bg-[#5d44b0] text-white font-bold flex items-center justify-center gap-2 transition-colors disabled:opacity-40">
            {busy ? <Loader2 size={18} className="animate-spin" /> : <Check size={18} />}
            {busy ? 'Creo il lotto…' : `Crea lotto (${filled} pezzi)`}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
