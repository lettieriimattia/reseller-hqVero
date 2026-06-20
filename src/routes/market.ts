// src/routes/market.ts
// Marketplace pubblico: vetrina degli articoli resi pubblici, cercabile DA CHIUNQUE
// (GET pubblici, senza login). "Contatta/Prenota" richiede login e apre una chat.

import { Router, Response } from 'express';
import { prisma } from '../lib/prisma';
import { authenticate, AuthRequest } from '../middleware/auth';
import { logger } from '../utils/logger';

const router = Router();

function firstPhoto(photos: string | null): string | null {
  if (!photos) return null;
  try { const arr = JSON.parse(photos); return Array.isArray(arr) && arr.length ? arr[0] : null; } catch { return null; }
}

// PUBBLICO: lista annunci pubblici cercabili (no auth). Nessun dato finanziario interno.
router.get('/', async (req, res: Response) => {
  try {
    const q = (req.query.q || '').toString().trim().toLowerCase();
    const category = (req.query.category || '').toString().trim();
    const where: any = { isPublic: true, status: 'IN STOCK', deletedAt: null };
    if (category) where.category = category;
    const items = await prisma.product.findMany({
      where, orderBy: { updatedAt: 'desc' }, take: 300,
      select: { id: true, brand: true, name: true, category: true, size: true, condition: true, publicPrice: true, photos: true, sku: true, attributes: true },
    });
    const filtered = q
      ? items.filter(p => `${p.brand} ${p.name} ${p.sku || ''} ${p.attributes || ''}`.toLowerCase().includes(q))
      : items;
    res.json(filtered.map(p => ({
      id: p.id, brand: p.brand, name: p.name, category: p.category, size: p.size,
      condition: p.condition, price: p.publicPrice ?? null, sku: p.sku || null, photo: firstPhoto(p.photos),
    })));
  } catch (e: any) { logger.error('GET /market', { err: e.message }); res.status(500).json({ error: 'Errore marketplace' }); }
});

// PUBBLICO: categorie disponibili in vetrina (per i filtri).
router.get('/categories', async (_req, res: Response) => {
  try {
    const rows = await prisma.product.findMany({
      where: { isPublic: true, status: 'IN STOCK', deletedAt: null },
      select: { category: true }, distinct: ['category'],
    });
    res.json(rows.map(r => r.category).filter(Boolean));
  } catch { res.json([]); }
});

// PUBBLICO: dettaglio singolo annuncio.
router.get('/:id', async (req, res: Response) => {
  try {
    const p = await prisma.product.findFirst({
      where: { id: req.params.id, isPublic: true, deletedAt: null },
      select: { id: true, brand: true, name: true, category: true, size: true, condition: true, publicPrice: true, photos: true, sku: true, attributes: true, status: true, user: { select: { name: true } } },
    });
    if (!p) return res.status(404).json({ error: 'Annuncio non trovato' });
    let photos: string[] = [];
    try { photos = p.photos ? JSON.parse(p.photos) : []; } catch { photos = []; }
    res.json({
      id: p.id, brand: p.brand, name: p.name, category: p.category, size: p.size, condition: p.condition,
      price: p.publicPrice ?? null, sku: p.sku || null, photos, sellerName: p.user?.name || 'Venditore',
      available: p.status === 'IN STOCK',
    });
  } catch (e: any) { logger.error('GET /market/:id', { err: e.message }); res.status(500).json({ error: 'Errore' }); }
});

// AUTH: contatta/prenota → crea o trova la conversazione con il venditore.
router.post('/:id/contact', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const product = await prisma.product.findFirst({ where: { id: req.params.id, isPublic: true, deletedAt: null } });
    if (!product) return res.status(404).json({ error: 'Annuncio non disponibile' });
    if (product.userId === req.user!.userId) return res.status(400).json({ error: 'È un tuo articolo.' });

    const convo = await prisma.conversation.upsert({
      where: { productId_buyerId: { productId: product.id, buyerId: req.user!.userId } },
      create: { productId: product.id, sellerId: product.userId, buyerId: req.user!.userId },
      update: {},
    });
    res.json({ conversationId: convo.id });
  } catch (e: any) { logger.error('POST /market/:id/contact', { err: e.message }); res.status(500).json({ error: 'Errore contatto' }); }
});

export default router;
