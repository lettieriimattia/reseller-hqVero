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
router.use(authenticate, apiLimiter);

// Gate BETA: solo admin per ora.
function adminOnly(req: AuthRequest, res: Response, next: any) {
  if (!isAdminEmail(req.user?.email)) return res.status(403).json({ error: 'Funzione in beta (solo admin).' });
  next();
}

// Categorie del catalogo (filtro UI) → product_type StockX/KicksDB per la ricerca.
const TYPE_TO_PRODUCTTYPE: Record<string, string> = {
  sneakers: 'sneakers', apparel: 'apparel', borse: 'handbag',
  accessori: 'accessor', carte: 'trading', elettronica: 'electronic',
};

// Ricerche "seed" per categoria: riempiono il TUO DB (cache) così il catalogo è già pieno.
const SEEDS_BY_TYPE: Record<string, string[]> = {
  sneakers: ['Jordan 1', 'Jordan 4', 'Nike Dunk Low', 'Air Force 1', 'Yeezy 350', 'New Balance 550', 'Adidas Samba', 'Travis Scott'],
  apparel: ['Supreme Box Logo', 'Stussy', 'Nike Tech Fleece', 'Essentials Hoodie', 'Corteiz', 'Palace', 'The North Face', 'Stone Island'],
  borse: ['Louis Vuitton', 'Gucci bag', 'Prada bag', 'Goyard', 'Dior bag', 'Chanel bag'],
  accessori: ['Supreme', 'Louis Vuitton wallet', 'Gucci belt', 'New Era cap'],
  carte: ['Charizard', 'Pikachu', 'Umbreon', 'Mewtwo', 'Rayquaza', 'Gengar', 'Eevee', 'Lugia'],
  elettronica: ['PlayStation 5', 'AirPods', 'iPhone', 'Nintendo Switch'],
};

// Categorie servite da una fonte dedicata (non KicksDB/StockX).
function isPokemonType(productType?: string): boolean {
  return !!productType && /carte|trading|pokemon|card/.test(productType.toLowerCase());
}

// Fonte catalogo unificata: carte→pokemontcg.io, resto KicksDB (preferita) → StockX (fallback).
async function providerSearch(query: string, opts: { productType?: string; limit?: number }): Promise<CatalogCandidate[]> {
  if (isPokemonType(opts.productType)) {
    const p = await pokemonSearch(query, opts.limit || 12).catch(() => []);
    return p; // le carte vivono solo su pokemontcg.io
  }
  if (isKicksConfigured()) {
    const k = await kicksSearch(query, { limit: opts.limit, productType: opts.productType }).catch(() => []);
    if (k.length) return k;
  }
  if (isStockXConfigured()) {
    const s = await searchStockXCandidates(query, { sneakersOnly: opts.productType === 'sneakers', limit: opts.limit || 12 }).catch(() => []);
    return s.map(c => ({ title: c.title, brand: null, styleId: c.styleId, productId: c.productId, image: c.image, productType: c.productType }));
  }
  return [];
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
  if (/trading|card|collectib|pokemon|funko/.test(s)) return 'carte';
  if (/electronic|console|gaming|tech/.test(s)) return 'elettronica';
  if (/apparel|cloth|shirt|hoodie|jacket|tee|pant|short|sweat/.test(s)) return 'apparel';
  if (/accessor|hat|cap|belt|wallet|sock|glasses|watch/.test(s)) return 'accessori';
  return s;
}

// Upsert di un candidato nella cache CatalogItem (solo link immagine). Best-effort.
// forceCategory: categoria della SCHEDA in cui stiamo cercando (più affidabile dei
// product_type della fonte). Se assente, deduce dal product_type.
async function upsertCandidate(c: CatalogCandidate, byKey?: Map<string, CatalogResult>, forceCategory?: string): Promise<void> {
  const key = dedupKey({ sku: c.styleId, stockxProductId: c.productId, title: c.title });
  if (!key) return;
  const split = splitBrandName(c.title);
  const brand = c.brand || split.brand;
  const name = c.brand && c.title.toLowerCase().startsWith(c.brand.toLowerCase())
    ? c.title.slice(c.brand.length).trim() || c.title  // evita "Jordan Jordan 1": toglie il brand in testa
    : split.name;
  const pt = forceCategory || normType(c.productType);
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
    const r = await fetch(parsed.toString(), { headers: { Accept: 'image/*', 'User-Agent': 'Mozilla/5.0' } });
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

// GET /api/catalog/search?q=...&type=sneakers|apparel
// 1) cerca nella cache locale  2) integra da StockX  3) salva i nuovi in cache (solo link).
router.get('/search', adminOnly, async (req: AuthRequest, res: Response) => {
  try {
    const q = (req.query.q || '').toString().trim();
    const type = (req.query.type || '').toString().trim().toLowerCase();
    if (q.length < 2) return res.json([]);

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
      orderBy: [{ useCount: 'desc' }, { updatedAt: 'desc' }],
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
    const productType = TYPE_TO_PRODUCTTYPE[type] || undefined;
    if (byKey.size < 5 && (isCatalogConfigured() || isPokemonType(productType))) {
      const cands = await providerSearch(q, { productType, limit: 12 });
      for (const c of cands) await upsertCandidate(c, byKey, type || undefined); // categoria = scheda
    }

    res.json(Array.from(byKey.values()).slice(0, 20));
  } catch (e: any) {
    logger.error('GET /catalog/search', { err: e.message });
    res.status(500).json({ error: 'Errore ricerca catalogo' });
  }
});

const seeding = new Set<string>(); // categorie in seeding ora (evita doppioni concorrenti)

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
      for (const q of SEEDS_BY_TYPE[cat]) {
        const cands = await providerSearch(q, { productType, limit: 8 });
        for (const c of cands) await upsertCandidate(c, undefined, cat); // categoria = scheda del seed
      }
    }
  } finally {
    seeding.delete(type);
  }
}

// GET /api/catalog/popular?type=sneakers|apparel|borse|carte|accessori|elettronica
// Lista di default mostrata appena apri il catalogo (per categoria). Se la cache è scarna,
// la precarica al volo dalla fonte (così non è mai vuota), poi serve sempre dal TUO DB.
router.get('/popular', adminOnly, async (req: AuthRequest, res: Response) => {
  try {
    const type = (req.query.type || '').toString().trim().toLowerCase();
    const order = [{ useCount: 'desc' as const }, { updatedAt: 'desc' as const }];
    const where = type ? { productType: type } : {};
    let items = await prisma.catalogItem.findMany({ where, orderBy: order, take: 30 });
    if (items.length < 12 && isCatalogConfigured()) {
      await seedPopular(type);
      items = await prisma.catalogItem.findMany({ where, orderBy: order, take: 30 });
    }
    res.json(items.map(it => ({
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
router.post('/:key/used', adminOnly, async (req: AuthRequest, res: Response) => {
  try {
    await prisma.catalogItem.update({ where: { key: req.params.key }, data: { useCount: { increment: 1 } } });
  } catch { /* item non in cache: ignora */ }
  res.json({ ok: true });
});

export default router;
