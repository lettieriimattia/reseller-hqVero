// src/routes/share.ts
// CONDIVISIONE PRODOTTI — l'utente seleziona più prodotti e crea una "vetrina" pubblica con link
// segreto. Il link mostra SOLO quei prodotti e SOLO campi non sensibili (mai prezzo d'acquisto,
// profitto, clienti, fornitori, magazzino). Il resto del magazzino resta privato.

import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { authenticate, AuthRequest } from '../middleware/auth';
import { apiLimiter } from '../middleware/rateLimit';
import { logger } from '../utils/logger';

// ---- Campi SICURI da esporre pubblicamente (whitelist rigida) ----
function firstPhoto(photos: string | null): string | null {
  if (!photos) return null;
  try { const a = JSON.parse(photos); return Array.isArray(a) && a.length ? a[0] : null; } catch { return null; }
}
function safeProduct(p: any) {
  return {
    id: p.id,
    brand: p.brand,
    name: p.name,
    size: p.size,
    condition: p.condition,
    category: p.category,
    photo: firstPhoto(p.photos),
    // prezzo di vendita richiesto (SOLO se pubblicato): mai il prezzo d'acquisto.
    price: p.publicPrice != null ? p.publicPrice : null,
  };
}

// Carica i prodotti di una share (verifica che siano ancora del proprietario e non eliminati/venduti).
async function loadShareProducts(share: any) {
  let ids: string[] = [];
  try { ids = JSON.parse(share.productIds); } catch { ids = []; }
  if (!Array.isArray(ids) || !ids.length) return [];
  const prods = await prisma.product.findMany({
    where: { id: { in: ids }, userId: share.userId, deletedAt: null, status: 'IN STOCK' },
    select: { id: true, brand: true, name: true, size: true, condition: true, category: true, photos: true, publicPrice: true },
  });
  // mantieni l'ordine scelto
  const byId = new Map(prods.map(p => [p.id, p]));
  return ids.map(id => byId.get(id)).filter(Boolean);
}

// ============ ROTTE AUTENTICATE (gestione delle proprie condivisioni) ============
const router = Router();
router.use(authenticate, apiLimiter);

// POST /share  { productIds:[], title?, sellerName?, contact? } → crea la vetrina, ritorna il link.
router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const productIds: string[] = Array.isArray(req.body?.productIds) ? req.body.productIds.filter((x: any) => typeof x === 'string').slice(0, 200) : [];
    if (!productIds.length) return res.status(400).json({ error: 'Seleziona almeno un prodotto.' });
    // Verifica che i prodotti siano DAVVERO dell'utente (no condivisione di roba altrui).
    const owned = await prisma.product.findMany({ where: { id: { in: productIds }, userId: req.user!.userId, deletedAt: null }, select: { id: true } });
    const ownedIds = owned.map(o => o.id);
    if (!ownedIds.length) return res.status(400).json({ error: 'Prodotti non validi.' });
    const share = await prisma.shareList.create({
      data: {
        userId: req.user!.userId,
        title: (req.body?.title || '').toString().slice(0, 120) || null,
        sellerName: (req.body?.sellerName || '').toString().slice(0, 80) || null,
        contact: (req.body?.contact || '').toString().slice(0, 120) || null,
        productIds: JSON.stringify(ownedIds),
      },
    });
    res.json({ token: share.id, url: `/s/${share.id}`, count: ownedIds.length });
  } catch (err: any) {
    logger.error('POST /share', { err: err.message });
    res.status(500).json({ error: 'Errore creazione vetrina' });
  }
});

// GET /share/mine → le proprie vetrine.
router.get('/mine', async (req: AuthRequest, res: Response) => {
  try {
    const rows = await prisma.shareList.findMany({ where: { userId: req.user!.userId }, orderBy: { createdAt: 'desc' }, take: 50 });
    res.json(rows.map(r => {
      let n = 0; try { n = (JSON.parse(r.productIds) || []).length; } catch {}
      return { token: r.id, title: r.title, active: r.active, views: r.views, count: n, createdAt: r.createdAt };
    }));
  } catch (err: any) { logger.error('GET /share/mine', { err: err.message }); res.status(500).json({ error: 'Errore' }); }
});

// DELETE /share/:id → revoca (disattiva) la vetrina.
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const s = await prisma.shareList.findUnique({ where: { id: req.params.id } });
    if (!s || s.userId !== req.user!.userId) return res.status(404).json({ error: 'Non trovata.' });
    await prisma.shareList.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (err: any) { logger.error('DELETE /share/:id', { err: err.message }); res.status(500).json({ error: 'Errore' }); }
});

export default router;

// ============ ROTTA PUBBLICA (JSON) — nessun login, solo campi sicuri ============
export const publicShareRouter = Router();
publicShareRouter.get('/:token', async (req: Request, res: Response) => {
  try {
    const share = await prisma.shareList.findUnique({ where: { id: req.params.token } });
    if (!share || !share.active) return res.status(404).json({ error: 'Vetrina non trovata o disattivata.' });
    const products = await loadShareProducts(share);
    // conteggio visite best-effort (non blocca la risposta)
    prisma.shareList.update({ where: { id: share.id }, data: { views: { increment: 1 } } }).catch(() => {});
    res.json({
      title: share.title || 'Vetrina',
      sellerName: share.sellerName || null,
      contact: share.contact || null,
      count: products.length,
      products: products.map(safeProduct),
    });
  } catch (err: any) {
    logger.error('GET public share', { err: err.message });
    res.status(500).json({ error: 'Errore' });
  }
});
