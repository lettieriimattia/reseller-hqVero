// src/services/brickeconomy.service.ts
// Valutazione LEGO tramite BrickEconomy — il sito dei VALORI DI MERCATO dei set (nuovo/usato).
// A differenza di BrickLink NON richiede lo stato di "venditore": basta una chiave API.
//   GET https://www.brickeconomy.com/api/v1/set/{numero}?currency=EUR   header: x-apikey: <chiave>
// Restituisce current_value_new / current_value_used (+ range), crescita, prezzo di listino, ecc.
// Env su Render:  BRICKECONOMY_API_KEY   (opz. BRICKECONOMY_BASE_URL per override)

import { logger } from '../utils/logger';

const KEY = (process.env.BRICKECONOMY_API_KEY || '').trim();
const BASE = (process.env.BRICKECONOMY_BASE_URL || 'https://www.brickeconomy.com/api/v1').replace(/\/$/, '');

export function isBrickEconomyConfigured(): boolean { return !!KEY; }

// "10300" / "lego 10300 modular" / "75192-1" → "10300" (BrickEconomy accetta con o senza variante).
function normalizeSetNo(q: string): string | null {
  const m = String(q || '').match(/\b(\d{3,7})(-\d+)?\b/);
  if (!m) return null;
  return m[2] ? `${m[1]}${m[2]}` : m[1];
}

// Estrae un numero da vari formati: 123.45, "€123", "123,45", { value: 123 }, ecc.
function num(raw: any): number | null {
  if (raw == null) return null;
  if (typeof raw === 'number') return isFinite(raw) && raw > 0 ? raw : null;
  if (typeof raw === 'object') return num(raw.value ?? raw.amount ?? raw.price ?? null);
  const s = String(raw).replace(/[^\d.,]/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.');
  const n = parseFloat(s);
  return isFinite(n) && n > 0 ? n : null;
}

async function fetchSet(setNo: string): Promise<any | null> {
  const url = `${BASE}/set/${encodeURIComponent(setNo)}?currency=EUR`;
  try {
    const r = await fetch(url, { headers: { 'x-apikey': KEY, 'Accept': 'application/json' } });
    if (!r.ok) { logger.error('BrickEconomy API error', { status: r.status, setNo }); return { __error: `HTTP ${r.status}` }; }
    return await r.json();
  } catch (err: any) { logger.error('Errore BrickEconomy fetch', { err: err?.message, setNo }); return null; }
}

// I campi possono stare a root o annidati (data/set): cerchiamo il primo che contiene i valori.
function pickData(j: any): any {
  if (!j || typeof j !== 'object') return {};
  for (const node of [j, j.data, j.set, j.result, j?.data?.set]) {
    if (node && (node.current_value_new != null || node.current_value_used != null || node.name != null)) return node;
  }
  return j.data || j.set || j;
}

export interface BrickEconomyValuation {
  value: number | null; currency: string; source: string; sample: number; itemName?: string; low?: number | null;
}

export async function getBrickEconomyValue(opts: { query: string; condition?: string }): Promise<BrickEconomyValuation | null> {
  if (!isBrickEconomyConfigured()) return null;
  const setNo = normalizeSetNo(opts.query);
  if (!setNo) return null;
  const j = await fetchSet(setNo);
  if (!j || j.__error) return null;
  const d = pickData(j);
  const wantUsed = /usa|used/i.test(opts.condition || '');
  const vNew = num(d.current_value_new);
  const vUsed = num(d.current_value_used);
  const value = wantUsed ? (vUsed ?? vNew) : (vNew ?? vUsed);
  if (value == null) return { value: null, currency: 'EUR', source: 'BrickEconomy (nessun valore)', sample: 0 };
  const usedFinal = wantUsed ? (vUsed != null) : (vNew == null && vUsed != null);
  return {
    value: Math.round(value),
    currency: 'EUR',
    source: `BrickEconomy · valore ${usedFinal ? 'usato' : 'nuovo'}`,
    sample: 1,
    itemName: d.name || d.set_name || `Set ${setNo}`,
    low: num(d.current_value_used_low) ?? undefined,
  };
}

// DEBUG: risposta grezza (chiavi + valori chiave) per aggiustare il parsing quando c'è la chiave.
export async function getBrickEconomyRaw(query: string): Promise<any> {
  const configured = isBrickEconomyConfigured();
  if (!configured) return { configured, error: 'BRICKECONOMY_API_KEY mancante' };
  const setNo = normalizeSetNo(query);
  if (!setNo) return { configured, error: 'numero set non riconosciuto' };
  const j = await fetchSet(setNo);
  if (!j) return { configured, setNo, error: 'nessuna risposta' };
  if (j.__error) return { configured, setNo, error: j.__error };
  const d = pickData(j);
  return {
    configured, setNo,
    topKeys: Object.keys(j || {}),
    dataKeys: d && d !== j ? Object.keys(d) : undefined,
    current_value_new: d?.current_value_new, current_value_used: d?.current_value_used, name: d?.name,
  };
}
