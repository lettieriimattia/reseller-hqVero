// src/routes/ai.ts
// Endpoint IA: scan, stima prezzi, legit check.

import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { aiLimiter } from '../middleware/rateLimit';
import { validate, aiScanSchema, priceEstimateSchema } from '../middleware/validate';
import { scanProduct, estimateMarketPrice, checkAuthenticity, generateListing, ListingPlatform } from '../services/ai.service';
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
    const result = await scanProduct(imageBase64, category);
    
    await audit({ 
      action: 'AI_SCAN', userId: req.user!.userId, req,
      metadata: { category, confidence: result.confidence }
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
// POST /api/ai/authenticity - legit check
// ==========================================
router.post('/authenticity', validate(aiScanSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { imageBase64, category } = req.body;
    const result = await checkAuthenticity(imageBase64, category);
    
    await audit({ 
      action: 'AI_SCAN', userId: req.user!.userId, req,
      metadata: { type: 'legit_check', category, score: result.score, verdict: result.verdict }
    });
    
    res.json(result);
  } catch (err: any) {
    logger.error('Errore /ai/authenticity', { err: err.message });
    res.status(500).json({ error: 'Errore legit check' });
  }
});

// ==========================================
// POST /api/ai/full-scan - tutto insieme
// ==========================================
router.post('/full-scan', validate(aiScanSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { imageBase64, category } = req.body;
    
    // Step 1: riconoscimento
    const scan = await scanProduct(imageBase64, category);
    
    // Step 2: solo legit check (stima prezzo rimossa — inaccurata)
    let authenticity: any = null;

    if (scan.brand && scan.model && scan.confidence !== 'LOW' && category !== 'Pokemon') {
      const authResult = await checkAuthenticity(imageBase64, category).catch(() => null);
      authenticity = authResult;
    }

    await audit({
      action: 'AI_SCAN', userId: req.user!.userId, req,
      metadata: { type: 'full_scan', category, confidence: scan.confidence }
    });

    res.json({ scan, price: null, authenticity });
  } catch (err: any) {
    logger.error('Errore /ai/full-scan', { err: err.message });
    res.status(500).json({ error: err.message || 'Errore scansione completa' });
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
