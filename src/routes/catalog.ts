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
import { logger } from '../utils/logger';

const router = Router();
router.use(authenticate, apiLimiter);

// Gate BETA: solo admin per ora.
function adminOnly(req: AuthRequest, res: Response, next: any) {
  if (!isAdminEmail(req.user?.email)) return res.status(403).json({ error: 'Funzione in beta (solo admin).' });
  next();
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

// Normalizza il productType StockX in una categoria semplice per il filtro.
function normType(pt?: string | null): string | null {
  const s = (pt || '').toLowerCase();
  if (!s) return null;
  if (/sneaker|shoe|footwear/.test(s)) return 'sneakers';
  if (/apparel|cloth|shirt|hoodie|jacket|tee|pant|short/.test(s)) return 'apparel';
  if (/accessor|hat|cap|bag|sock/.test(s)) return 'accessories';
  return s;
}

function dedupKey(c: { sku?: string | null; stockxProductId?: string | null; title: string }): string {
  return (c.sku || c.stockxProductId || c.title || '')
    .toString().toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 120);
}

interface CatalogResult {
  key: string; brand: string; name: string; sku: string | null;
  image: string | null; productType: string | null;
}

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

    // 2) StockX per integrare (e popolare la cache per le prossime ricerche)
    if (isStockXConfigured()) {
      const sneakersOnly = type === 'sneakers';
      const cands = await searchStockXCandidates(q, { sneakersOnly, limit: 12 }).catch(() => []);
      for (const c of cands) {
        const key = dedupKey({ sku: c.styleId, stockxProductId: c.productId, title: c.title });
        if (!key || byKey.has(key)) continue;
        const { brand, name } = splitBrandName(c.title);
        const pt = normType(c.productType);
        const result: CatalogResult = { key, brand, name, sku: c.styleId || null, image: c.image || null, productType: pt };
        byKey.set(key, result);
        // Upsert in cache (solo link, niente Cloudinary). Best-effort: non bloccare la ricerca.
        prisma.catalogItem.upsert({
          where: { key },
          create: { key, brand, name, sku: c.styleId || null, productType: pt, image: c.image || null, stockxProductId: c.productId || null },
          update: { image: c.image || null, name, brand },
        }).catch(() => {});
      }
    }

    res.json(Array.from(byKey.values()).slice(0, 20));
  } catch (e: any) {
    logger.error('GET /catalog/search', { err: e.message });
    res.status(500).json({ error: 'Errore ricerca catalogo' });
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
