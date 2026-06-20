// src/routes/market.ts
// Marketplace pubblico: vetrina degli articoli resi pubblici, cercabile DA CHIUNQUE
// (GET pubblici, senza login). "Contatta/Prenota" richiede login e apre una chat.

import { Router, Response } from 'express';
import { prisma } from '../lib/prisma';
import { authenticate, AuthRequest } from '../middleware/auth';
import { stripe, isStripeConfigured, appBase } from '../lib/stripe';
import { computeBuyerBreakdown } from '../config/fees';
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
      select: { id: true, brand: true, name: true, category: true, size: true, condition: true, publicPrice: true, shippingCost: true, photos: true, sku: true, attributes: true, status: true, userId: true, user: { select: { name: true } } },
    });
    if (!p) return res.status(404).json({ error: 'Annuncio non trovato' });
    let photos: string[] = [];
    try { photos = p.photos ? JSON.parse(p.photos) : []; } catch { photos = []; }
    // Pagamento in-app disponibile solo se Stripe è attivo e c'è un prezzo pubblico.
    const payEnabled = isStripeConfigured() && p.publicPrice != null && p.publicPrice > 0;
    const breakdown = payEnabled ? computeBuyerBreakdown(p.publicPrice as number, p.shippingCost || 0) : null;
    res.json({
      id: p.id, brand: p.brand, name: p.name, category: p.category, size: p.size, condition: p.condition,
      price: p.publicPrice ?? null, shippingCost: p.shippingCost ?? 0, sku: p.sku || null, photos,
      sellerName: p.user?.name || 'Venditore', sellerId: p.userId, available: p.status === 'IN STOCK',
      payEnabled, breakdown,
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
    // Messaggio iniziale opzionale (es. "Vorrei comprare"). Niente link (anti-truffa).
    const text = (req.body?.message || '').toString().trim().slice(0, 500);
    const linkRe = /(https?:\/\/|www\.|\b[a-z0-9][a-z0-9-]*\.(com|net|org|it|io|co|me|app|shop|store)\b|t\.me\/|wa\.me\/|@[a-z0-9_.]+)/i;
    if (text && !linkRe.test(text)) {
      await prisma.message.create({ data: { conversationId: convo.id, senderId: req.user!.userId, text } });
      await prisma.conversation.update({ where: { id: convo.id }, data: { updatedAt: new Date() } });
    }
    res.json({ conversationId: convo.id });
  } catch (e: any) { logger.error('POST /market/:id/contact', { err: e.message }); res.status(500).json({ error: 'Errore contatto' }); }
});

// AUTH: acquista e paga il prodotto in-app (Stripe Connect → il venditore incassa).
router.post('/:id/buy', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const s = stripe();
    if (!s) return res.status(400).json({ error: 'Pagamenti non attivi' });
    const buyerId = req.user!.userId;
    const product = await prisma.product.findFirst({
      where: { id: req.params.id, isPublic: true, deletedAt: null },
      include: { user: true },
    });
    if (!product) return res.status(404).json({ error: 'Annuncio non disponibile' });
    if (product.userId === buyerId) return res.status(400).json({ error: 'È un tuo articolo.' });
    if (product.status !== 'IN STOCK') return res.status(400).json({ error: 'Articolo non più disponibile.' });
    if (!product.publicPrice || product.publicPrice <= 0) return res.status(400).json({ error: 'Prezzo non valido.' });

    const seller = product.user;
    if (!seller?.stripeAccountId || !seller.stripeChargesEnabled) {
      return res.status(409).json({ error: 'Il venditore non ha ancora attivato gli incassi. Contattalo dalla chat.', sellerNotReady: true });
    }

    const buyer = await prisma.user.findUnique({ where: { id: buyerId } });
    const bd = computeBuyerBreakdown(product.publicPrice, product.shippingCost || 0);
    const base = appBase(req);
    // La nostra fee + la copertura della commissione Stripe le tratteniamo noi;
    // al venditore arriva netto prezzo + spedizione.
    const appFeeCents = Math.round((bd.serviceFee + bd.fees) * 100);

    const session = await s.checkout.sessions.create({
      mode: 'payment',
      customer_email: buyer?.email,
      line_items: [{
        quantity: 1,
        price_data: {
          currency: 'eur',
          product_data: { name: `${product.brand} ${product.name}` },
          unit_amount: Math.round(bd.total * 100),
        },
      }],
      payment_intent_data: {
        application_fee_amount: appFeeCents,
        transfer_data: { destination: seller.stripeAccountId },
      },
      metadata: { kind: 'product', productId: product.id, buyerId },
      success_url: `${base}/?bought=${product.id}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${base}/?buy_cancel=1`,
    });
    res.json({ url: session.url });
  } catch (e: any) { logger.error('POST /market/:id/buy', { err: e.message }); res.status(500).json({ error: 'Errore avvio pagamento' }); }
});

export default router;
