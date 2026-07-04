// src/routes/catalog.ts
// CATALOGO stile StockX ("Aggiungi prodotti"): l'utente cerca un modello e lo aggiunge
// al magazzino con la FOTO UFFICIALE (sfondo uniforme) invece di scattarla.
//
// Foto: salviamo SOLO il LINK StockX (niente Cloudinary, zero storage). La cache locale
// CatalogItem evita di ribussare a StockX a ogni ricerca (hanno limiti di chiamata).
//
// BETA: visibile SOLO agli account admin (beta tester) finché non si decide il gating piani.

import { Router, Response } from 'express';
import { prisma } from '../lib/prisma';
import { authenticate, AuthRequest } from '../middleware/auth';
import { apiLimiter } from '../middleware/rateLimit';
import { isAdminEmail } from '../config/admins';
import { searchStockXCandidates, isStockXConfigured } from '../services/stockx.service';
import { kicksSearch, isKicksConfigured, type CatalogCandidate } from '../services/kicksdb.service';
import { pokemonSearch } from '../services/pokemon.service';
import { logger } from '../utils/logger';

const router = Router();

// ===== ROTTE PUBBLICHE (per la landing page, senza login): vetrina + proxy immagini. =====
router.get('/showcase', async (_req: AuthRequest, res: Response) => {
  try {
    // Mix CASUALE di tutte le categorie (ruota ad ogni caricamento della landing).
    const picked = await prisma.$queryRaw<any[]>`
      SELECT "image","name","brand" FROM "CatalogItem"
      WHERE "image" IS NOT NULL ORDER BY RANDOM() LIMIT 20`;
    res.json(picked.map((i: any) => ({ image: i.image, name: i.name, brand: i.brand })));
  } catch { res.json([]); }
});
router.get('/img-public', async (req: AuthRequest, res: Response) => {
  try {
    const u = (req.query.u || '').toString();
    if (!u) return res.status(400).end();
    let parsed: URL;
    try { parsed = new URL(u); } catch { return res.status(400).end(); }
    const host = parsed.hostname.toLowerCase();
    if (parsed.protocol !== 'https:' || !IMG_HOSTS.some(h => host === h || host.endsWith('.' + h))) return res.status(400).end();
    const r = await fetch(parsed.toString(), { headers: { Accept: 'image/*', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', Referer: 'https://stockx.com/' } });
    if (!r.ok) return res.status(502).end();
    const buf = Buffer.from(await r.arrayBuffer());
    res.setHeader('Content-Type', r.headers.get('content-type') || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
    res.send(buf);
  } catch { res.status(502).end(); }
});

router.use(authenticate, apiLimiter);

// Gate BETA: solo admin per ora.
function adminOnly(req: AuthRequest, res: Response, next: any) {
  if (!isAdminEmail(req.user?.email)) return res.status(403).json({ error: 'Funzione in beta (solo admin).' });
  next();
}

// Categorie del catalogo (filtro UI) → product_type StockX/KicksDB per la ricerca.
const TYPE_TO_PRODUCTTYPE: Record<string, string> = {
  sneakers: 'sneakers', apparel: 'apparel', borse: 'handbag',
  accessori: 'accessor', pokemon: 'trading', elettronica: 'electronic',
};
// Le 6 categorie "ufficiali". Tutto il resto è una categoria PERSONALIZZATA dell'utente
// (scritta nel catalogo): per quelle cerchiamo i prodotti dal vivo usando il nome come query.
const KNOWN_TYPES = new Set(Object.keys(TYPE_TO_PRODUCTTYPE));

// Ricerche "seed" per categoria: riempiono il TUO DB (cache) così il catalogo è già pieno.
// Più query = catalogo più ricco per ogni reparto (ognuna porta ~12 prodotti in cache).
const SEEDS_BY_TYPE: Record<string, string[]> = {
  sneakers: ['Jordan 1', 'Jordan 1 Low', 'Jordan 3', 'Jordan 4', 'Jordan 5', 'Jordan 6', 'Jordan 11', 'Jordan 12',
    'Nike Dunk Low', 'Nike Dunk High', 'Air Force 1', 'Air Max 1', 'Air Max 90', 'Air Max 95', 'Air Max 97',
    'Nike Vapormax', 'Nike Cortez', 'Nike Blazer', 'Yeezy 350', 'Yeezy 500', 'Yeezy 700', 'Yeezy Slide', 'Yeezy Foam',
    'New Balance 550', 'New Balance 530', 'New Balance 2002R', 'New Balance 990', 'New Balance 9060', 'New Balance 1906',
    'Adidas Samba', 'Adidas Gazelle', 'Adidas Campus', 'Adidas Superstar', 'Adidas Spezial', 'Asics Gel', 'Asics Kayano',
    'Salomon XT-6', 'Travis Scott', 'Off-White Nike', 'Nike SB Dunk', 'Vans', 'Converse', 'Puma', 'Onitsuka Tiger',
    'Crocs', 'Timberland', 'UGG', 'Birkenstock', 'Saucony', 'Hoka'],
  apparel: ['Supreme Box Logo', 'Supreme', 'Stussy', 'Nike Tech Fleece', 'Essentials Hoodie', 'Fear of God', 'Corteiz',
    'Palace', 'The North Face', 'Stone Island', 'Trapstar', 'Bape', 'Sp5der', 'Hellstar', 'Denim Tears', 'Carhartt',
    'Arc teryx', 'Moncler', 'Represent', 'Chrome Hearts', 'Kith', 'Aime Leon Dore', 'Gallery Dept', 'Rhude', 'Amiri',
    'Off-White', 'Vlone', 'Anti Social Social Club', 'Cactus Jack', 'Eric Emanuel', 'Syna World', 'Broken Planet',
    'Nike hoodie', 'Adidas hoodie', 'Ralph Lauren', 'Burberry', 'Nike jacket', 'Patagonia', 'Yeezy Gap', 'Drew House'],
  borse: ['Louis Vuitton bag', 'Gucci bag', 'Prada bag', 'Goyard bag', 'Dior bag', 'Chanel bag', 'Celine bag',
    'Bottega Veneta bag', 'Saint Laurent bag', 'Balenciaga bag', 'Telfar bag', 'Hermes bag', 'Fendi bag', 'Loewe bag',
    'Coach bag', 'Miu Miu bag', 'Jacquemus bag', 'Marc Jacobs bag', 'Off-White bag', 'Polene bag', 'Mulberry bag',
    'Louis Vuitton backpack', 'Gucci backpack', 'Prada nylon bag'],
  accessori: ['Gucci belt', 'Louis Vuitton wallet', 'Louis Vuitton belt', 'Hermes belt', 'Ferragamo belt', 'New Era cap',
    'Supreme beanie', 'Cartier glasses', 'Chrome Hearts', 'Gucci wallet', 'Dior wallet', 'Goyard wallet', 'Prada sunglasses',
    'Casio', 'Ray-Ban', 'Oakley', 'Apple Watch band', 'Nike socks', 'Gucci scarf', 'Burberry scarf', 'AirPods case',
    'Louis Vuitton cardholder', 'Gucci cap', 'Stussy cap', 'Carhartt beanie'],
  pokemon: ['Charizard', 'Pikachu', 'Umbreon', 'Mewtwo', 'Rayquaza', 'Gengar', 'Eevee', 'Lugia', 'Mew', 'Snorlax',
    'Blastoise', 'Venusaur', 'Gardevoir', 'Lucario', 'Gyarados', 'Dragonite', 'Sylveon', 'Greninja', 'Espeon', 'Vaporeon',
    'Jolteon', 'Flareon', 'Glaceon', 'Leafeon', 'Tyranitar', 'Garchomp', 'Pidgeot', 'Alakazam', 'Machamp', 'Zard',
    'Giratina', 'Arceus', 'Darkrai', 'Lucario VSTAR', 'Pikachu VMAX', 'Charizard GX', 'Moonbreon'],
  elettronica: ['PlayStation 5', 'PlayStation 5 Pro', 'Xbox Series X', 'Nintendo Switch', 'Nintendo Switch 2', 'AirPods Pro',
    'AirPods Max', 'iPhone 15', 'iPhone 16', 'iPhone 16 Pro', 'Apple Watch', 'iPad', 'iPad Pro', 'MacBook', 'MacBook Pro',
    'Meta Quest', 'Steam Deck', 'GoPro', 'DJI', 'Beats', 'Sony WH-1000XM5', 'PSVR2', 'Asus ROG Ally', 'Garmin'],
};

// Categorie servite da una fonte dedicata (non KicksDB/StockX).
function isPokemonType(productType?: string): boolean {
  return !!productType && /carte|trading|pokemon|card/.test(productType.toLowerCase());
}

// Unisce più liste di candidati DEDUPLICANDO sulla stessa key. Se lo stesso prodotto
// arriva da due fonti e una ha la FOTO e l'altra no, tiene quella CON foto (riempie i buchi
// di KicksDB con StockX). Mantiene l'ordine: la prima fonte (KicksDB) resta prioritaria.
function mergeCands(...lists: CatalogCandidate[][]): CatalogCandidate[] {
  const map = new Map<string, CatalogCandidate>();
  for (const list of lists) {
    for (const c of list) {
      const key = dedupKey({ sku: c.styleId, stockxProductId: c.productId, title: c.title });
      if (!key) continue;
      const cur = map.get(key);
      if (!cur) map.set(key, c);
      else if (!cur.image && c.image) map.set(key, { ...cur, image: c.image }); // riempi la foto mancante
    }
  }
  return Array.from(map.values());
}

// Fonte catalogo unificata: carte→pokemontcg.io. Per il resto DUE FONTI in cascata:
// KicksDB (primaria) → StockX (fallback/integrazione). Se KicksDB non basta (pochi risultati
// CON foto: es. una colorway che loro non hanno o hanno senza immagine), interroghiamo ANCHE
// StockX e UNIAMO i risultati riempiendo le foto mancanti. Così ogni colore trova la sua foto.
async function providerSearch(query: string, opts: { productType?: string; limit?: number }): Promise<CatalogCandidate[]> {
  if (isPokemonType(opts.productType)) {
    const p = await pokemonSearch(query, opts.limit || 12).catch(() => []);
    return p; // le carte vivono solo su pokemontcg.io
  }
  const limit = opts.limit || 12;
  let kicks: CatalogCandidate[] = [];
  if (isKicksConfigured()) {
    kicks = await kicksSearch(query, { limit, productType: opts.productType }).catch(() => []);
  }
  const imaged = kicks.filter(c => c.image).length;
  // KicksDB copre già bene (abbastanza risultati con foto)? usalo da solo (risparmia quota StockX).
  if (imaged >= Math.min(4, limit)) return kicks;
  // Altrimenti chiedo anche a StockX e unisco (StockX riempie foto mancanti / colorway assenti).
  if (isStockXConfigured()) {
    const s = await searchStockXCandidates(query, { sneakersOnly: opts.productType === 'sneakers', limit }).catch(() => []);
    const sMapped: CatalogCandidate[] = s.map(c => ({ title: c.title, brand: null, styleId: c.styleId, productId: c.productId, image: c.image, productType: c.productType }));
    return mergeCands(kicks, sMapped);
  }
  return kicks;
}

export function isCatalogConfigured(): boolean {
  return isKicksConfigured() || isStockXConfigured();
}

// Brand noti per separare brand/nome dal titolo StockX (che è un'unica stringa).
// Match sul più lungo prima ("New Balance" prima di "New"). Fallback: prima parola.
const BRANDS = [
  'Air Jordan', 'Jordan', 'Nike', 'Adidas', 'Yeezy', 'New Balance', 'Asics', 'Puma',
  'Reebok', 'Converse', 'Vans', 'Salomon', 'Crocs', 'Ugg', 'Timberland', 'Palace',
  'Supreme', 'Kith', 'Stussy', 'Stüssy', 'Corteiz', 'Bape', 'A Bathing Ape', 'Off-White',
  'Fear of God', 'Essentials', 'Denim Tears', 'Hellstar', 'Sp5der', 'Trapstar',
  'Louis Vuitton', 'Gucci', 'Prada', 'Dior', 'Balenciaga', 'Moncler', 'Stone Island',
  'The North Face', 'Carhartt', 'Rolex', 'Omega', 'Casio', 'Seiko',
];

function splitBrandName(title: string): { brand: string; name: string } {
  const t = (title || '').trim();
  if (!t) return { brand: '-', name: '-' };
  const lower = t.toLowerCase();
  const found = BRANDS
    .filter(b => lower.startsWith(b.toLowerCase()))
    .sort((a, b) => b.length - a.length)[0];
  if (found) {
    const name = t.slice(found.length).trim() || t;
    return { brand: found, name };
  }
  const sp = t.indexOf(' ');
  if (sp > 0) return { brand: t.slice(0, sp), name: t.slice(sp + 1).trim() };
  return { brand: t, name: t };
}

// Normalizza il product_type StockX/KicksDB nella categoria UI del catalogo.
function normType(pt?: string | null): string | null {
  const s = (pt || '').toLowerCase();
  if (!s) return null;
  if (/sneaker|shoe|footwear/.test(s)) return 'sneakers';
  if (/handbag|\bbag\b|purse|tote/.test(s)) return 'borse';
  if (/trading|card|carte|collectib|pokemon|funko/.test(s)) return 'pokemon';
  if (/electronic|console|gaming|tech/.test(s)) return 'elettronica';
  if (/apparel|cloth|shirt|hoodie|jacket|tee|pant|short|sweat/.test(s)) return 'apparel';
  if (/accessor|hat|cap|belt|wallet|sock|glasses|watch/.test(s)) return 'accessori';
  return s;
}

// Categoria UI robusta da TITOLO + product_type. Il titolo è il segnale più affidabile
// per abbigliamento/accessori/borse (es. "... Tee", "... Belt", "... Bag"), il product_type
// per sneaker/elettronica/carte. Ordine = priorità (belt prima di bag, ecc.).
function inferCategory(title: string, productType?: string | null): string | null {
  const t = (title || '').toLowerCase();
  const pt = (productType || '').toLowerCase();
  const both = pt + ' ' + t;
  // PORTACARTE / wallet / case NON sono carte da gioco: sono accessori (prima della check carte).
  if (/\bholder\b|wallet|portacart|porta ?carte|card ?case|cardholder/.test(t)) return 'accessori';
  if (/trading|collectib|pokemon|funko|graded|\bpsa\b|\btcg\b|booster|\bcard\b/.test(both)) return 'pokemon';
  if (/electronic|console|gaming/.test(pt) || /playstation|\bps5\b|\bxbox\b|nintendo|\bswitch\b|airpods|\biphone\b|macbook|\bipad\b|\bgpu\b/.test(t)) return 'elettronica';
  if (/handbag/.test(pt) || /\bbag\b|\btote\b|backpack|duffle|duffel|\bpurse\b|pouch|satchel|crossbody|keepall|speedy|neverfull|\bclutch\b/.test(t)) return 'borse';
  if (/\bbelt\b|wallet|card ?holder|\bcap\b|\bhat\b|beanie|sunglass|eyewear|\bsocks?\b|scarf|keychain|key ?ring|gloves|necklace|bracelet|earring|\bwatch\b/.test(t)) return 'accessori';
  if (/apparel|cloth/.test(pt) || /\btee\b|t-?shirt|\bshirt\b|hoodie|sweatshirt|crewneck|\bjacket\b|\bcoat\b|\bsweater\b|cardigan|\bvest\b|\bpants?\b|trousers|\bshorts?\b|jersey|\bpolo\b|long ?sleeve|\bjeans\b|tracksuit|joggers|\bparka\b|flannel/.test(t)) return 'apparel';
  if (/sneaker|shoe|footwear/.test(pt)) return 'sneakers';
  // Fallback per TITOLO: modelli sneaker notissimi → 'sneakers' anche se il product_type manca
  // (i risultati StockX senza product_type finivano con categoria nulla → sparivano dalla scheda
  // Sneakers pur comparendo in "Tutti"). Sta DOPO abbigliamento/accessori: "Jordan hoodie" resta apparel.
  if (/\b(air ?jordan|jordan|air ?force|air ?max|\bdunk\b|yeezy|new balance|vapormax|blazer|cortez|samba|gazelle|superstar|campus|spezial|kobe|foamposite|foam|salomon|asics|adizero|ultraboost|\bnmd\b|forum|550|530|990|991|992|993|9060|2002r|1906|327|574|998|990v)\b/.test(t)) return 'sneakers';
  return normType(productType);
}

// Upsert di un candidato nella cache CatalogItem (solo link immagine). Best-effort.
// La categoria viene dal product_type REALE della fonte (es. "Travis Scott" torna sia
// scarpe sia t-shirt: ognuna nella sua categoria). forceCategory è solo un fallback
// quando il product_type manca (es. la query è sotto una scheda specifica).
async function upsertCandidate(c: CatalogCandidate, byKey?: Map<string, CatalogResult>, forceCategory?: string): Promise<void> {
  const key = dedupKey({ sku: c.styleId, stockxProductId: c.productId, title: c.title });
  if (!key) return;
  const split = splitBrandName(c.title);
  const brand = c.brand || split.brand;
  const name = c.brand && c.title.toLowerCase().startsWith(c.brand.toLowerCase())
    ? c.title.slice(c.brand.length).trim() || c.title  // evita "Jordan Jordan 1": toglie il brand in testa
    : split.name;
  const pt = inferCategory(c.title, c.productType) || forceCategory || null;
  if (byKey && !byKey.has(key)) {
    byKey.set(key, { key, brand, name, sku: c.styleId || null, image: c.image || null, productType: pt });
  }
  await prisma.catalogItem.upsert({
    where: { key },
    create: { key, brand, name, sku: c.styleId || null, productType: pt, image: c.image || null, stockxProductId: c.productId || null },
    update: { image: c.image || null, name, brand, productType: pt },
  }).catch(() => {});
}

function dedupKey(c: { sku?: string | null; stockxProductId?: string | null; title: string }): string {
  return (c.sku || c.stockxProductId || c.title || '')
    .toString().toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 120);
}

// Quanto un risultato COMBACIA con la query (parole in comune su brand+nome+sku, COLORE incluso):
// serve a ordinare per pertinenza → cercando "jordan 1 canary" la Canary sta in cima, non una
// Off-White gialla a caso. Bonus se contiene TUTTE le parole della query.
function queryScore(q: string, r: { brand?: string | null; name?: string | null; sku?: string | null }): number {
  const words = q.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 1);
  if (!words.length) return 0;
  const hay = `${r.brand || ''} ${r.name || ''} ${r.sku || ''}`.toLowerCase();
  let s = 0;
  for (const w of words) if (hay.includes(w)) s++;
  if (s === words.length) s += 2; // match completo → in cima
  return s;
}
// Ordina per pertinenza (score desc), poi mette prima quelli CON foto.
function byRelevance(q: string) {
  return (a: CatalogResult, b: CatalogResult) => (queryScore(q, b) - queryScore(q, a)) || ((b.image ? 1 : 0) - (a.image ? 1 : 0));
}

// Mappa un candidato della fonte DIRETTAMENTE in risultato UI (per le categorie personalizzate,
// dove non possiamo affidarci al filtro productType della cache). Dedup sulla key.
function candsToResults(cands: CatalogCandidate[]): CatalogResult[] {
  const seen = new Set<string>();
  const out: CatalogResult[] = [];
  for (const c of cands) {
    const key = dedupKey({ sku: c.styleId, stockxProductId: c.productId, title: c.title });
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const split = splitBrandName(c.title);
    const brand = c.brand || split.brand;
    const name = c.brand && c.title.toLowerCase().startsWith(c.brand.toLowerCase())
      ? (c.title.slice(c.brand.length).trim() || c.title) : split.name;
    out.push({ key, brand, name, sku: c.styleId || null, image: c.image || null, productType: inferCategory(c.title, c.productType) });
  }
  return out;
}

interface CatalogResult {
  key: string; brand: string; name: string; sku: string | null;
  image: string | null; productType: string | null;
}

// Host immagine consentiti per il proxy (evita SSRF: solo CDN cataloghi).
const IMG_HOSTS = ['images.stockx.com', 'images.pokemontcg.io', 'images.goat.com', 'image.goat.com'];

// GET /api/catalog/img?u=<url> — proxy immagini: il CDN StockX blocca le richieste
// cross-site dal browser, quindi le serviamo dal NOSTRO dominio (stesso origine).
// Cache lunga: l'immagine di un modello non cambia. Solo host in allowlist (anti-SSRF).
// Niente adminOnly: le foto prodotto si vedono anche ai soci non-admin nel magazzino.
router.get('/img', async (req: AuthRequest, res: Response) => {
  try {
    const u = (req.query.u || '').toString();
    if (!u) return res.status(400).end();
    let parsed: URL;
    try { parsed = new URL(u); } catch { return res.status(400).end(); }
    const host = parsed.hostname.toLowerCase();
    if (parsed.protocol !== 'https:' || !IMG_HOSTS.some(h => host === h || host.endsWith('.' + h))) {
      return res.status(400).end();
    }
    const r = await fetch(parsed.toString(), {
      headers: { Accept: 'image/*', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', Referer: 'https://stockx.com/' },
    });
    if (!r.ok) return res.status(502).end();
    const buf = Buffer.from(await r.arrayBuffer());
    res.setHeader('Content-Type', r.headers.get('content-type') || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=604800, immutable'); // 7 giorni
    res.send(buf);
  } catch (e: any) {
    logger.warn('GET /catalog/img proxy', { err: e.message });
    res.status(502).end();
  }
});

// GET /api/catalog/_diag?q=Jordan%201 — diagnostica: cosa torna DAVVERO dalla fonte
// (per capire se le immagini arrivano null dalla fonte o se è la cache vecchia).
router.get('/_diag', adminOnly, async (req: AuthRequest, res: Response) => {
  try {
    const q = (req.query.q || 'Jordan 1').toString();
    const cands = await providerSearch(q, { limit: 3 });
    const cached = await prisma.catalogItem.findMany({ take: 3, orderBy: { updatedAt: 'desc' } });
    res.json({
      kicksConfigured: isKicksConfigured(),
      stockxConfigured: isStockXConfigured(),
      live: { count: cands.length, items: cands.map(c => ({ title: c.title, productType: c.productType, inferred: inferCategory(c.title, c.productType), image: c.image, sku: c.styleId })) },
      cacheSample: cached.map(c => ({ title: c.name, image: c.image, productType: c.productType })),
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/catalog/_diagraw?q=Jordan 1 — risposta GREZZA delle fonti: serve a vedere ESATTAMENTE
// dov'è (o se manca) l'URL immagine in KicksDB, e cosa restituisce StockX. Solo admin.
router.get('/_diagraw', adminOnly, async (req: AuthRequest, res: Response) => {
  const q = (req.query.q || 'Jordan 1 Travis Scott').toString();
  const out: any = { query: q };
  // KicksDB grezzo
  try {
    const key = process.env.KICKSDB_API_KEY || '';
    const url = `https://api.kicks.dev/v3/stockx/products?query=${encodeURIComponent(q)}&limit=2`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' } });
    const body: any = await r.json().catch(() => null);
    const arr = Array.isArray(body?.data) ? body.data : (Array.isArray(body?.products) ? body.products : []);
    out.kicks = {
      httpStatus: r.status,
      topLevelKeys: body && typeof body === 'object' ? Object.keys(body) : [],
      count: arr.length,
      firstProductKeys: arr[0] ? Object.keys(arr[0]) : [],
      firstProduct: arr[0] || null,
    };
  } catch (e: any) { out.kicks = { error: e.message }; }
  // StockX (già mappato dal nostro service)
  try {
    const s = await searchStockXCandidates(q, { limit: 3 }).catch((e: any) => { out.stockxErr = e?.message; return []; });
    out.stockx = { count: s.length, items: s.map(c => ({ title: c.title, image: c.image, sku: c.styleId })) };
  } catch (e: any) { out.stockx = { error: e.message }; }
  res.json(out);
});

// GET /api/catalog/_reset — svuota la cache catalogo (CatalogItem). È SOLO una cache:
// si ricostruisce dalla fonte con categorie/immagini corrette. Una tantum dopo i fix.
router.get('/_reset', adminOnly, async (_req: AuthRequest, res: Response) => {
  try {
    const r = await prisma.catalogItem.deleteMany({});
    seededAt.clear();
    res.json({ ok: true, deleted: r.count });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/catalog/search?q=...&type=sneakers|apparel
// 1) cerca nella cache locale  2) integra da StockX  3) salva i nuovi in cache (solo link).
router.get('/search', async (req: AuthRequest, res: Response) => {
  try {
    await ensureCatalogVersion();
    const q = (req.query.q || '').toString().trim();
    const type = (req.query.type || '').toString().trim().toLowerCase();
    if (q.length < 2) return res.json([]);

    // CATEGORIA PERSONALIZZATA (es. l'utente ha aggiunto "Profumi"/"Vinili"): non c'è un
    // productType in cache da filtrare → cerco dal vivo combinando categoria + query e
    // restituisco i candidati senza filtro di categoria.
    if (type && !KNOWN_TYPES.has(type) && (isCatalogConfigured())) {
      // CACHE-FIRST anche per le categorie personalizzate (Profumi/Vinili/…): se ho già abbastanza
      // foto in cache per questa categoria+query, NON chiamo KicksDB → risparmio la quota mensile.
      const cachedC = await prisma.catalogItem.findMany({
        where: { AND: [
          { productType: type },
          { OR: [
            { name: { contains: q, mode: 'insensitive' } },
            { sku: { contains: q, mode: 'insensitive' } },
            { brand: { contains: q, mode: 'insensitive' } },
          ] },
        ] },
        take: 20,
      });
      const cachedRes: CatalogResult[] = cachedC.map(it => ({ key: it.key, brand: it.brand, name: it.name, sku: it.sku, image: it.image, productType: it.productType }));
      if (cachedRes.filter(r => r.image).length >= 5) {
        const wi = cachedRes.filter(r => r.image);
        return res.json((wi.length >= 3 ? wi : cachedRes).sort(byRelevance(q)).slice(0, 20));
      }
      // Cache insufficiente → interrogo la fonte (KicksDB/StockX) e unisco coi cache.
      const cands = await providerSearch(`${type} ${q}`.trim(), { limit: 20 });
      for (const c of cands) await upsertCandidate(c, undefined, type).catch(() => {});
      const merged = new Map<string, CatalogResult>();
      for (const r of [...cachedRes, ...candsToResults(cands)]) {
        const ex = merged.get(r.key);
        if (!ex) merged.set(r.key, r); else if (!ex.image && r.image) merged.set(r.key, { ...ex, image: r.image });
      }
      const all = Array.from(merged.values());
      const withImg = all.filter(r => r.image);
      return res.json((withImg.length >= 3 ? withImg : all).sort(byRelevance(q)).slice(0, 20));
    }

    const byKey = new Map<string, CatalogResult>();

    // 1) Cache locale (match su nome / sku / brand)
    const local = await prisma.catalogItem.findMany({
      where: {
        AND: [
          { OR: [
            { name: { contains: q, mode: 'insensitive' } },
            { sku: { contains: q, mode: 'insensitive' } },
            { brand: { contains: q, mode: 'insensitive' } },
          ] },
          ...(type ? [{ productType: type }] : []),
        ],
      },
      orderBy: [{ createdAt: 'asc' }],
      take: 16,
    });
    for (const it of local) {
      byKey.set(it.key, {
        key: it.key, brand: it.brand, name: it.name, sku: it.sku,
        image: it.image, productType: it.productType,
      });
    }

    // 2) Fonte esterna SOLO se la cache locale non basta (risparmia le richieste mensili:
    //    una volta che un modello è nel TUO DB, non lo richiediamo più).
    // Interroga la fonte se in cache ci sono pochi risultati CON immagine (le righe vecchie
    // senza foto non bastano: meglio chiedere alla fonte che le restituisce con foto).
    const productType = TYPE_TO_PRODUCTTYPE[type] || undefined;
    const localImaged = Array.from(byKey.values()).filter(r => r.image).length;
    if (localImaged < 5 && (isCatalogConfigured() || isPokemonType(productType))) {
      const cands = await providerSearch(q, { productType, limit: 12 });
      for (const c of cands) await upsertCandidate(c, byKey); // categoria dal titolo + product_type
    }

    // STRETTO sulla categoria della scheda (cercando in Sneakers vedo solo sneaker), poi
    // priorità alle righe CON immagine.
    const all = Array.from(byKey.values());
    const inCat = type ? all.filter(r => r.productType === type) : all;
    const withImg = inCat.filter(r => r.image);
    // Ordina per PERTINENZA (colore incluso): "jordan 1 canary" → la Canary in cima, non una gialla a caso.
    res.json((withImg.length >= 3 ? withImg : inCat).sort(byRelevance(q)).slice(0, 20));
  } catch (e: any) {
    logger.error('GET /catalog/search', { err: e.message });
    res.status(500).json({ error: 'Errore ricerca catalogo' });
  }
});

const seeding = new Set<string>(); // categorie in seeding ora (evita doppioni concorrenti)
const seededAt = new Map<string, number>(); // ultimo refresh per categoria (throttle quota)

// Versione della logica di categorizzazione/cache. Quando la cambio (bump qui), la cache
// CatalogItem si svuota DA SOLA al primo accesso dopo il deploy → niente _reset a mano.
const CATALOG_VERSION = '8-photosafe';
let versionChecked = false;
async function ensureCatalogVersion(): Promise<void> {
  if (versionChecked) return;
  versionChecked = true;
  try {
    const s = await prisma.setting.findUnique({ where: { key: 'catalogVersion' } });
    if (s?.value !== CATALOG_VERSION) {
      // PHOTO-SAFE: al cambio versione NON buttiamo le foto (costano quota KicksDB da rifare).
      // Puliamo solo i placeholder SENZA immagine (righe inutili). Le foto restano per sempre.
      const r = await prisma.catalogItem.deleteMany({ where: { image: null } });
      seededAt.clear();
      await prisma.setting.upsert({
        where: { key: 'catalogVersion' },
        create: { key: 'catalogVersion', value: CATALOG_VERSION },
        update: { value: CATALOG_VERSION },
      });
      logger.info('Catalog: puliti solo i placeholder senza foto (le foto restano)', { deleted: r.count, version: CATALOG_VERSION });
    }
  } catch (e: any) {
    logger.warn('ensureCatalogVersion', { err: e.message });
  }
}

// Popola la cache CatalogItem per una categoria (o "tutto") con ricerche popolari. Best-effort.
async function seedPopular(type: string): Promise<void> {
  if (seeding.has(type)) return;
  if (!isCatalogConfigured() && !isPokemonType(TYPE_TO_PRODUCTTYPE[type])) return;
  seeding.add(type);
  try {
    // Categoria specifica, oppure TUTTE (per "Tutti"): ogni gruppo con la sua categoria forzata.
    const cats = type && SEEDS_BY_TYPE[type] ? [type] : Object.keys(SEEDS_BY_TYPE);
    for (const cat of cats) {
      const productType = TYPE_TO_PRODUCTTYPE[cat] || undefined;
      const queries = SEEDS_BY_TYPE[cat];
      // PARALLELO a gruppi di 6: ~48 ricerche in fila erano lente (60s+); così finisce in pochi
      // secondi e riempie tutte le categorie in un colpo (senza martellare troppo la fonte).
      const CHUNK = 6;
      for (let i = 0; i < queries.length; i += CHUNK) {
        await Promise.all(queries.slice(i, i + CHUNK).map(async (q) => {
          const cands = await providerSearch(q, { productType, limit: 12 }).catch(() => []);
          for (const c of cands) await upsertCandidate(c, undefined, cat).catch(() => {}); // categoria = scheda del seed
        }));
      }
    }
  } finally {
    seeding.delete(type);
  }
}

// GET /api/catalog/popular?type=sneakers|apparel|borse|carte|accessori|elettronica
// Lista di default mostrata appena apri il catalogo (per categoria). Se la cache è scarna,
// la precarica al volo dalla fonte (così non è mai vuota), poi serve sempre dal TUO DB.
router.get('/popular', async (req: AuthRequest, res: Response) => {
  try {
    await ensureCatalogVersion();
    const type = (req.query.type || '').toString().trim().toLowerCase();

    // CATEGORIA PERSONALIZZATA: nessun seed/cache per productType → uso il nome categoria
    // come query e cerco i prodotti giusti dal vivo (poi li tengo in cache, best-effort).
    if (type && !KNOWN_TYPES.has(type) && isCatalogConfigured()) {
      // CACHE-FIRST: se la categoria personalizzata ha già abbastanza foto in cache, le servo
      // dal TUO DB senza toccare KicksDB (ad ogni apertura della scheda si risparmia la quota).
      const cachedP = await prisma.catalogItem.findMany({
        where: { productType: type, image: { not: null } },
        orderBy: [{ createdAt: 'asc' }], take: 60,
      });
      if (cachedP.length >= 6) {
        return res.json(cachedP.map(it => ({ key: it.key, brand: it.brand, name: it.name, sku: it.sku, image: it.image, productType: it.productType })));
      }
      const cands = await providerSearch(type, { limit: 30 });
      for (const c of cands) await upsertCandidate(c, undefined, type).catch(() => {});
      const out = candsToResults(cands);
      const withImg = out.filter(r => r.image);
      return res.json((withImg.length >= 6 ? withImg : out).slice(0, 60));
    }

    // Ordine FISSO: per data di inserimento (createdAt non cambia ai re-seed) → il catalogo
    // non si rimescola più ad ogni apertura.
    const order = [{ createdAt: 'asc' as const }];
    const where = type ? { productType: type } : {};
    let items = await prisma.catalogItem.findMany({ where, orderBy: order, take: 90 });
    // Riseminiamo se: pochi item CON foto, OPPURE molti senza immagine (cache vecchia) —
    // ma non più di una volta ogni 15 min per categoria (protegge la quota).
    const imagedCount = items.filter(i => i.image).length;
    const fresh = (seededAt.get(type) || 0) > Date.now() - 15 * 60_000;
    if ((imagedCount < 12 && !fresh) && isCatalogConfigured()) {
      if (imagedCount === 0) {
        // Cache VUOTA (primissima apertura): aspetto il seed così non mostro pagina vuota.
        await seedPopular(type);
        items = await prisma.catalogItem.findMany({ where, orderBy: order, take: 90 });
        if (items.some(i => i.image)) seededAt.set(type, Date.now());
      } else {
        // Cache già popolata: rispondo SUBITO con quello che c'è e completo/aggiorno in BACKGROUND
        // (l'utente non aspetta; alla prossima apertura vede il catalogo completo).
        seededAt.set(type, Date.now());
        void seedPopular(type).catch(() => {});
      }
    }
    // "Tutti" (nessuna categoria) / scroll dashboard: mix CASUALE e BILANCIATO di TUTTE le categorie,
    // che RUOTA ad ogni apertura. Per categoria specifica resta l'ordine fisso.
    if (!type) {
      // Se in cache ci sono POCHE categorie (es. solo sneaker), semina tutte (una volta ogni 15 min).
      const catsHave = await prisma.catalogItem.findMany({ where: { image: { not: null } }, distinct: ['productType'], select: { productType: true } });
      const freshAll = (seededAt.get('') || 0) > Date.now() - 15 * 60_000;
      if (catsHave.length < 4 && !freshAll && isCatalogConfigured()) {
        seededAt.set('', Date.now());
        // Aspetto solo se NON c'è ancora nulla da mostrare; altrimenti completo in background.
        if (catsHave.length === 0) await seedPopular('');
        else void seedPopular('').catch(() => {});
      }
      // Max ~10 per categoria (PARTITION), poi mescola → mix variegato e casuale ogni volta.
      const rnd = await prisma.$queryRaw<any[]>`
        SELECT "key","brand","name","sku","image","productType" FROM (
          SELECT *, ROW_NUMBER() OVER (PARTITION BY "productType" ORDER BY RANDOM()) AS rn
          FROM "CatalogItem" WHERE "image" IS NOT NULL
        ) t WHERE rn <= 10 ORDER BY RANDOM() LIMIT 60`;
      return res.json(rnd.map((r: any) => ({ key: r.key, brand: r.brand, name: r.name, sku: r.sku, image: r.image, productType: r.productType })));
    }
    // PRIORITÀ alle righe CON immagine; se sono poche, mostro comunque il resto (mai pagina vuota).
    const withImg = items.filter(i => i.image);
    const out = (withImg.length >= 8 ? withImg : items).slice(0, 60);
    res.json(out.map(it => ({
      key: it.key, brand: it.brand, name: it.name, sku: it.sku,
      image: it.image, productType: it.productType,
    })));
  } catch (e: any) {
    logger.error('GET /catalog/popular', { err: e.message });
    res.status(500).json({ error: 'Errore catalogo' });
  }
});

// POST /api/catalog/:key/used — incrementa il contatore quando un item viene aggiunto
// (così i modelli più usati salgono in cima). Best-effort.
router.post('/:key/used', async (req: AuthRequest, res: Response) => {
  try {
    await prisma.catalogItem.update({ where: { key: req.params.key }, data: { useCount: { increment: 1 } } });
  } catch { /* item non in cache: ignora */ }
  res.json({ ok: true });
});

export default router;
