// Unioni di modelli decise dall'UTENTE ("unisci Yeezy 350, Yeezy 700 e Yeezy Slide sotto Yeezy").
// - Frasi semplici: capite qui, senza IA (gratis, immediato).
// - Frasi libere / errori di battitura: POST /ai/model-merge (l'IA sceglie SOLO tra i nomi passati).
// - Salvate nel browser e sull'account (GET/PUT /ai/model-merges) → valgono su tutti i dispositivi.
import { strip, title } from './modelGroup';

export type Merges = Record<string, string>; // "modello di partenza" (ripulito) → "modello di destinazione"
type ApiCall = <T = any>(path: string, opts?: RequestInit) => Promise<{ ok: boolean; data: T; status: number }>;
const LS_KEY = 'hq-model-merges-v1';

export function readMerges(): Merges {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}') || {}; } catch { return {}; }
}
function writeLocal(m: Merges) { try { localStorage.setItem(LS_KEY, JSON.stringify(m)); } catch { /* ok */ } }

// Segue le unioni a catena (A→B, B→C ⇒ A→C), con un limite contro i giri infiniti.
export function applyMerges(model: string, m: Merges): string {
  let cur = model;
  for (let i = 0; i < 6; i++) { const next = m[strip(cur)]; if (!next || strip(next) === strip(cur)) break; cur = next; }
  return cur;
}

export async function loadServerMerges(apiCall: ApiCall): Promise<Merges | null> {
  try {
    const { ok, data } = await apiCall<{ merges: Merges }>('/api/ai/model-merges');
    if (ok && data?.merges && typeof data.merges === 'object') { writeLocal(data.merges); return data.merges; }
  } catch { /* server vecchio: restano quelle del browser */ }
  return null;
}
export async function saveMerges(m: Merges, apiCall: ApiCall) {
  writeLocal(m);
  try { await apiCall('/api/ai/model-merges', { method: 'PUT', body: JSON.stringify({ merges: m }) }); } catch { /* ok: resta nel browser */ }
}

export type MergeGroup = { from: string[]; to: string };

// Capisce da sola le frasi semplici:
//   "unisci Yeezy 350, Yeezy 700 e Yeezy Slide sotto Yeezy"   "raggruppa tutte le yeezy"
//   "metti insieme jordan 1 low e jordan 1 high come Jordan 1" "unisci dunk low e dunk high"
export function parseMergeInstruction(text: string, names: string[]): MergeGroup | null {
  const m = text.trim().match(/^(?:unisci|unire|raggruppa|accorpa|metti insieme|mettimi insieme|uniscimi)\s+(.+?)(?:\s+(?:sotto|come|nel gruppo|con (?:il )?nome|chiamandol[aeio]?|in un(?:o|a)? (?:solo|unic[oa]) (?:gruppo )?(?:chiamat[oa])?|in)\s+["'“«]?(.+?)["'”»]?)?\s*[.!]?$/i);
  if (!m) return null;
  const what = m[1];
  let to = m[2]?.trim() || '';
  const clean = names.map(n => ({ n, s: strip(n) }));
  let from: string[] = [];
  const all = what.match(/^tutt[eiao]\s+(?:le|gli|i|la|il|lo)?\s*(.+)$/i);
  if (all) {
    const key = strip(all[1]).replace(/s$/, '');
    from = clean.filter(c => c.s.includes(key)).map(c => c.n);
    if (!to) to = title(key);
  } else {
    const parts = what.split(/\s*(?:,|\s+e\s+|\s+ed\s+|\s+and\s+|&|\+)\s*/i).map(p => strip(p).replace(/^(?:le|gli|i|la|il|lo|l|the)\s+/, '')).filter(Boolean);
    for (const p of parts) {
      const exact = clean.find(c => c.s === p);
      if (exact) { from.push(exact.n); continue; }
      const partial = p.length >= 3 ? clean.filter(c => c.s.includes(p)) : [];
      if (partial.length === 0) return null; // una parte non riconosciuta → meglio chiedere all'IA
      from.push(...partial.map(c => c.n));
    }
  }
  from = [...new Set(from)];
  if (from.length === 0 || (from.length === 1 && !to)) return null;
  if (!to) {
    // Nome comune: le parole iniziali uguali in tutti (es. "Dunk Low" + "Dunk High" → "Dunk").
    const words = from.map(f => f.split(' '));
    const common: string[] = [];
    for (let i = 0; i < words[0].length && words.every(w => w[i] && strip(w[i]) === strip(words[0][i])); i++) common.push(words[0][i]);
    to = common.join(' ') || from[0];
  }
  const target = clean.find(c => c.s === strip(to))?.n || title(strip(to)) || to;
  return { from, to: target };
}

export async function askAiMerge(text: string, names: string[], apiCall: ApiCall): Promise<MergeGroup[] | null> {
  try {
    const { ok, data } = await apiCall<{ groups: MergeGroup[] }>('/api/ai/model-merge', { method: 'POST', body: JSON.stringify({ instruction: text, names }) });
    if (!ok) return null; // server non ancora aggiornato
    return Array.isArray(data?.groups) ? data.groups : [];
  } catch { return null; }
}

export function addMerges(m: Merges, groups: MergeGroup[]): Merges {
  const next = { ...m };
  groups.forEach(g => g.from.forEach(f => { if (strip(f) !== strip(g.to)) next[strip(f)] = g.to; }));
  return next;
}
export function removeTarget(m: Merges, to: string): Merges {
  const next: Merges = {};
  Object.entries(m).forEach(([k, v]) => { if (strip(v) !== strip(to)) next[k] = v; });
  return next;
}
