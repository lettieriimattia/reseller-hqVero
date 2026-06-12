// src/routes/ai.ts
// Endpoint IA: scan prodotto, generatore annunci.

import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { aiLimiter } from '../middleware/rateLimit';
import { validate, aiScanSchema, priceEstimateSchema } from '../middleware/validate';
import { scanProduct, scanProductAuto, estimateMarketPrice, generateListing, ListingPlatform } from '../services/ai.service';
import { getMarketValuation } from '../services/price.service';
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
import { audit } from '../services/audit.service';
import { logger } from '../utils/logger';

const router = Router();

router.use(authenticate);
router.use(aiLimiter);

// ==========================================
// POST /api/ai/scan - scan unificato
// ==========================================
router.post('/scan', validate(aiScanSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { imageBase64, category } = req.body;
    // Senza categoria → modalità automatica: l'IA rileva l'oggetto dalla foto
    const result = category
      ? await scanProduct(imageBase64, category)
      : await scanProductAuto(imageBase64);

    await audit({
      action: 'AI_SCAN', userId: req.user!.userId, req,
      metadata: { category: category || result.detectedCategory || 'auto', auto: !category, confidence: result.confidence }
    });

    res.json(result);
  } catch (err: any) {
    logger.error('Errore /ai/scan', { err: err.message });
    res.status(500).json({ error: err.message || 'Errore scan IA' });
  }
});

// ==========================================
// POST /api/ai/price - stima prezzo di mercato
// ==========================================
router.post('/price', validate(priceEstimateSchema), async (req: AuthRequest, res: Response) => {
  try {
    const result = await estimateMarketPrice(req.body);
    res.json(result);
  } catch (err: any) {
    logger.error('Errore /ai/price', { err: err.message });
    res.status(500).json({ error: 'Errore stima prezzo' });
  }
});

// ==========================================
// POST /api/ai/market-value - valutazione di mercato da query (sourcing, senza prodotto salvato)
// ==========================================
router.post('/market-value', async (req: AuthRequest, res: Response) => {
  try {
    const { query, size } = req.body || {};
    const q = (query ?? '').toString().trim();
    if (q.length < 2) return res.status(400).json({ error: 'Inserisci brand e modello.' });
    const valuation = await getMarketValuation({ query: q, size: size ? size.toString() : undefined });
    res.json(valuation);
  } catch (err: any) {
    logger.error('Errore /ai/market-value', { err: err.message });
    res.status(500).json({ error: 'Errore valutazione' });
  }
});

// ==========================================
// POST /api/ai/full-scan - scan riconoscimento prodotto
// ==========================================
router.post('/full-scan', validate(aiScanSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { imageBase64, category } = req.body;
    const scan = category
      ? await scanProduct(imageBase64, category)
      : await scanProductAuto(imageBase64);

    await audit({
      action: 'AI_SCAN', userId: req.user!.userId, req,
      metadata: { type: 'full_scan', category: category || scan.detectedCategory || 'auto', auto: !category, confidence: scan.confidence }
    });

    res.json({ scan, price: null, authenticity: null });
  } catch (err: any) {
    logger.error('Errore /ai/full-scan', { err: err.message });
    res.status(500).json({ error: err.message || 'Errore scansione' });
  }
});

// ==========================================
// POST /api/ai/generate-listing — genera annuncio per piattaforma
// ==========================================
router.post('/generate-listing', async (req: AuthRequest, res: Response) => {
  try {
    const { productId, platform } = req.body;
    const validPlatforms: ListingPlatform[] = ['vinted', 'ebay', 'depop', 'wallapop', 'subito'];
    if (!productId || !validPlatforms.includes(platform)) {
      return res.status(400).json({ error: 'productId e platform obbligatori' });
    }

    const product = await prisma.product.findFirst({
      where: { id: productId, deletedAt: null },
    });
    if (!product) return res.status(404).json({ error: 'Prodotto non trovato' });

    let attributes: Record<string, any> | undefined;
    try {
      if (product.attributes && typeof product.attributes === 'object') {
        attributes = product.attributes as Record<string, any>;
      }
    } catch {}

    const listing = await generateListing({
      category: product.category,
      brand: product.brand,
      name: product.name,
      size: product.size,
      condition: product.condition,
      purchasePrice: product.purchasePrice,
      marketPriceMin: product.marketPriceMin ?? undefined,
      marketPriceMax: product.marketPriceMax ?? undefined,
      marketPriceAvg: product.marketPriceAvg ?? undefined,
      notes: product.notes ?? undefined,
      attributes,
      platform,
    });

    res.json(listing);
  } catch (err: any) {
    logger.error('Errore /ai/generate-listing', { err: err.message });
    res.status(500).json({ error: err.message || 'Errore generazione annuncio' });
  }
});

export default router;
