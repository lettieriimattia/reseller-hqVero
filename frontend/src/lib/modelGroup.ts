// Raggruppamento dei nomi prodotto sotto il loro MODELLO ("Yeezy Boost 350 V2 Bone" → "Yeezy 350").
// 1) Regole fisse (gratis, istantanee) per i modelli più comuni.
// 2) Ciò che le regole non riconoscono è "incerto": lo chiede UNA volta al server (/ai/model-groups),
//    che salva il risultato nel database; qui lo teniamo anche in localStorage per non richiederlo più.

export interface ModelGroup { model: string; brand: string; confident: boolean }

export const strip = (s: string) => (s || '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[’'`"()[\]]/g, ' ').replace(/[^a-z0-9+\s.-]/g, ' ')
  .replace(/\s+/g, ' ').trim();
export const title = (s: string) => s.split(' ').filter(Boolean).map(w => (/^\d/.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1))).join(' ');

// Marchi che si raggruppano per MARCHIO (modelli con nomi poco standard).
const BRAND_ONLY = ['rick owens', 'drkshdw', 'chrome hearts', 'maison margiela', 'raf simons', 'comme des garcons', 'vivienne westwood',
  'corteiz', 'broken planet', 'hellstar', 'sp5der', 'trapstar', 'fear of god', 'essentials', 'gallery dept', 'denim tears', 'stone island',
  'moncler', 'canada goose', 'arcteryx', 'palm angels', 'off-white', 'off white', 'amiri', 'represent'];
const BRAND_ALIAS: Record<string, string> = {
  'air jordan': 'Jordan', 'jordan': 'Jordan', 'nike sb': 'Nike', 'nike': 'Nike', 'adidas originals': 'adidas', 'adidas': 'adidas',
  'yeezy': 'adidas', 'new balance': 'New Balance', 'nb': 'New Balance', 'drkshdw': 'Rick Owens', 'rick owens': 'Rick Owens',
  'asics': 'ASICS', 'off white': 'Off-White', 'off-white': 'Off-White', 'stussy': 'Stüssy', 'the north face': 'The North Face', 'tnf': 'The North Face',
};
// Parole che non identificano il modello (colori, condizioni, taglie, parole di riempimento).
const NOISE = new Set(('retro og sp qs se prm premium low mid high v2 v1 x the and with by edition limited new nuovo nuove usato usata ds deadstock ' +
  'white black bone red blue green grey gray pink cream sail panda bred chicago university royal triple beige brown navy olive orange purple yellow ' +
  'bianco nero rosso blu verde grigio rosa marrone giallo taglia size eu us uk xs s m l xl xxl xxxl').split(' '));

export function normalizeBrand(brand: string, name = ''): string {
  const b = strip(brand);
  if (BRAND_ALIAS[b]) return BRAND_ALIAS[b];
  const n = strip(name);
  for (const k of Object.keys(BRAND_ALIAS)) if (!b && n.startsWith(k + ' ')) return BRAND_ALIAS[k];
  return b ? (brand || '').trim().replace(/^./, c => c.toUpperCase()) : '—'; // accenti conservati (Pokémon, Stüssy)
}

// Regole: [espressione sul testo "marca nome" ripulito, modello risultante]
type Rule = [RegExp, (m: RegExpMatchArray) => string];
const RULES: Rule[] = [
  [/\byeezy\b.*?\bfoam\b/, () => 'Yeezy Foam Runner'],
  [/\byeezy\b.*?\bslide\b/, () => 'Yeezy Slide'],
  [/\byeezy\b(?:\s+boost)?\s*(350|380|450|500|700|750)\b/, m => `Yeezy ${m[1]}`],
  [/\b(?:air\s+)?jordan\s*1\b(?:\s+(?:retro|og))*\s*(low|mid|high)?\b/, m => `Jordan 1${m[1] ? ' ' + title(m[1]) : ''}`],
  [/\b(?:air\s+)?jordan\s*(\d{1,2})\b/, m => `Jordan ${Number(m[1])}`],
  [/\baj\s?(\d{1,2})\b/, m => `Jordan ${Number(m[1])}`],
  [/\bdunk\s*(low|high|mid)\b/, m => `Dunk ${title(m[1])}`],
  [/\bdunk\b/, () => 'Dunk'],
  [/\b(air force 1|af1|af 1)\b/, () => 'Air Force 1'],
  [/\bair max\s*(\d{1,4}|plus|tn|dn)\b/, m => `Air Max ${title(m[1])}`],
  [/\bvomero\s*(\d+)?/, m => `Vomero${m[1] ? ' ' + m[1] : ''}`],
  [/\b(?:new balance|nb)\b.*?\b(\d{3,4}r?)\b/, m => `New Balance ${m[1].toUpperCase()}`],
  [/\b(samba|gazelle|campus|spezial|superstar|stan smith|forum|handball spezial|sl 72|taekwondo)\b/, m => `adidas ${title(m[1])}`],
  [/\bgel[\s-]?(\d{3,4}|kayano|nyc|lyte|quantum|nimbus)\b/, m => `ASICS Gel-${title(m[1])}`],
  [/\bxt[\s-]?(\d)\b/, m => `Salomon XT-${m[1]}`],
  [/\b(box logo|bogo)\b/, () => 'Supreme Box Logo'],
  [/\b(submariner|daytona|datejust|gmt[\s-]?master|explorer|oyster perpetual)\b/, m => `Rolex ${title(m[1].replace(/\s+/g, '-'))}`],
  [/\b(royal oak)\b/, () => 'AP Royal Oak'],
  [/\b(nautilus)\b/, () => 'Patek Nautilus'],
];

export function groupFor(brand: string, name: string): ModelGroup {
  const b = normalizeBrand(brand, name);
  const full = strip(`${brand} ${name}`);
  for (const bo of BRAND_ONLY) if (full.includes(bo)) return { model: BRAND_ALIAS[bo] || title(bo), brand: BRAND_ALIAS[bo] || title(bo), confident: true };
  for (const [re, fn] of RULES) {
    const m = full.match(re);
    // Le Jordan stanno sotto il brand Jordan, comunque sia scritta la marca (Nike / Air Jordan / Jordan).
    if (m) { const model = fn(m); return { model, brand: model.startsWith('Jordan') ? 'Jordan' : b, confident: true }; }
  }
  // Nessuna regola: marca + prime 2 parole significative del nome (senza taglie/colori). Incerto → IA.
  const brandWords = new Set(strip(brand).split(' '));
  const words = strip(name).split(' ').filter(w => w && !NOISE.has(w) && !brandWords.has(w) && !/^\d{2}([.,]5)?$/.test(w));
  const core = words.slice(0, 2).join(' ');
  return { model: title(`${b !== '—' ? b + ' ' : ''}${core}`.trim()) || title(name) || '—', brand: b, confident: false };
}

// ---------- Nomi incerti: IA una volta, poi memoria ----------
const LS_KEY = 'hq-model-groups-v1';
export const aiKey = (brand: string, name: string) => `${(brand || '').trim().toLowerCase()}|${(name || '').trim().toLowerCase()}`;
export function readAiCache(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}') || {}; } catch { return {}; }
}
function writeAiCache(c: Record<string, string>) { try { localStorage.setItem(LS_KEY, JSON.stringify(c)); } catch { /* ok */ } }

const attempted = new Set<string>();
type ApiCall = <T = any>(path: string, opts?: RequestInit) => Promise<{ ok: boolean; data: T; status: number }>;
// Chiede al server SOLO i nomi incerti non ancora in memoria (max 60 per volta). Silenzioso se non disponibile.
export async function resolveUncertain(items: { brand: string; name: string }[], apiCall: ApiCall): Promise<Record<string, string>> {
  const cache = readAiCache();
  const todo = [...new Map(items.filter(x => !(aiKey(x.brand, x.name) in cache) && !attempted.has(aiKey(x.brand, x.name))).map(x => [aiKey(x.brand, x.name), x])).values()].slice(0, 60);
  if (todo.length === 0) return cache;
  todo.forEach(x => attempted.add(aiKey(x.brand, x.name))); // una sola richiesta per nome in questa sessione
  try {
    const { ok, data } = await apiCall<{ groups: Record<string, string> }>('/ai/model-groups', { method: 'POST', body: JSON.stringify({ items: todo }) });
    if (ok && data?.groups) { Object.assign(cache, data.groups); writeAiCache(cache); }
  } catch { /* server vecchio o IA assente: restano le regole */ }
  return cache;
}
