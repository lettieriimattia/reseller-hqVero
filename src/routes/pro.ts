// src/routes/pro.ts — funzioni premium, ciascuna protetta dal piano (requireFeature).
//  - GET  /api/pro/repricing         riprezzamento stock fermo        (feature: repricing)
//  - POST /api/pro/offer             assistente trattative/offerte     (feature: offer_assistant)
//  - PUT  /api/pro/channels/:id      tracker pubblicazione multi-canale (feature: crossposting)
import { Router, Response } from 'express';
import { PrismaClient, Product } from '@prisma/client';
import { authenticate, AuthRequest } from '../middleware/auth';
import { requireFeature } from '../middleware/plan';
import { getStaleProducts } from '../services/stale.service';
import { assessOffer } from '../services/ai.service';
import { logger } from '../utils/logger';

const router = Router();
const prisma = new PrismaClient();
router.use(authenticate);

// Carica un prodotto verificando che l'utente sia membro del suo warehouse.
async function loadAuthorizedProduct(userId: string, productId: string): Promise<{ status: number; product: Product | null }> {
  const product = await prisma.product.findFirst({ where: { id: productId, deletedAt: null } });
  if (!product) return { status: 404, product: null };
  const memberships = await prisma.membership.findMany({ where: { userId }, select: { warehouseId: true } });
  const ids = memberships.map(m => m.warehouseId);
  if (!product.warehouseId || !ids.includes(product.warehouseId)) return { status: 403, product: null };
  return { status: 200, product };
}

// ── Feature 1: riprezzamento stock fermo ──────────────────────────────
router.get('/repricing', requireFeature('repricing'), async (req: AuthRequest, res: Response) => {
  try {
    const days = Math.max(1, Math.min(365, parseInt((req.query.days as string) || '30') || 30));
    const products = await getStaleProducts(req.user!.userId, days);
    res.json({ thresholdDays: days, count: products.length, products });
  } catch (err: any) {
    logger.error('Errore /pro/repricing', { err: err.message });
    res.status(500).json({ error: 'Errore riprezzamento' });
  }
});

// ── Feature 2: assistente trattative ──────────────────────────────────
router.post('/offer', requireFeature('offer_assistant'), async (req: AuthRequest, res: Response) => {
  try {
    const { productId, offer, minMarginPct, platform } = req.body || {};
    const offerNum = Number(offer);
    if (!productId || !Number.isFinite(offerNum) || offerNum <= 0) {
      return res.status(400).json({ error: 'productId e offerta validi obbligatori.' });
    }
    const { product, status } = await loadAuthorizedProduct(req.user!.userId, productId.toString());
    if (status === 404) return res.status(404).json({ error: 'Prodotto non trovato.' });
    if (status === 403) return res.status(403).json({ error: 'Non sei membro di questo reparto.' });

    const result = await assessOffer({
      brand: product!.brand, name: product!.name, size: product!.size, condition: product!.condition,
      purchasePrice: product!.purchasePrice,
      marketPriceAvg: product!.marketPriceAvg,
      listPrice: product!.salePrice ?? product!.marketPriceAvg ?? null,
      offer: offerNum,
      minMarginPct: Number.isFinite(Number(minMarginPct)) ? Number(minMarginPct) : undefined,
      platform: platform ? platform.toString() : undefined,
    });
    res.json(result);
  } catch (err: any) {
    logger.error('Errore /pro/offer', { err: err.message });
    res.status(500).json({ error: 'Errore valutazione offerta' });
  }
});

// ── Feature 3: tracker multi-canale ───────────────────────────────────
const VALID_CHANNEL_STATUS = ['listed', 'sold', 'removed'];
router.put('/channels/:id', requireFeature('crossposting'), async (req: AuthRequest, res: Response) => {
  try {
    const { product, status } = await loadAuthorizedProduct(req.user!.userId, req.params.id);
    if (status === 404) return res.status(404).json({ error: 'Prodotto non trovato.' });
    if (status === 403) return res.status(403).json({ error: 'Non sei membro di questo reparto.' });

    const raw = Array.isArray(req.body?.channels) ? req.body.channels : [];
    // Normalizza e valida: platform (string) + status (enum) + url? (string)
    const channels = raw
      .filter((c: any) => c && typeof c.platform === 'string' && c.platform.trim())
      .slice(0, 12)
      .map((c: any) => ({
        platform: c.platform.toString().slice(0, 40),
        status: VALID_CHANNEL_STATUS.includes(c.status) ? c.status : 'listed',
        url: c.url ? c.url.toString().slice(0, 300) : undefined,
      }));

    await prisma.product.update({
      where: { id: product!.id },
      data: { salesChannels: channels.length ? JSON.stringify(channels) : null },
    });
    res.json({ ok: true, channels });
  } catch (err: any) {
    logger.error('Errore /pro/channels', { err: err.message });
    res.status(500).json({ error: 'Errore salvataggio canali' });
  }
});

export default router;
