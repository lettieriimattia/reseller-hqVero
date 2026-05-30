// src/routes/ai.ts
// Endpoint IA: scan, stima prezzi, legit check.

import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { aiLimiter } from '../middleware/rateLimit';
import { validate, aiScanSchema, priceEstimateSchema } from '../middleware/validate';
import { scanProduct, estimateMarketPrice, checkAuthenticity } from '../services/ai.service';
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
    
    // Step 2 e 3: stima prezzo + legit check in parallelo
    let price: any = null;
    let authenticity: any = null;
    
    if (scan.brand && scan.model && scan.confidence !== 'LOW') {
      const [priceResult, authResult] = await Promise.allSettled([
        estimateMarketPrice({
          category, brand: scan.brand, modelName: scan.model,
        }),
        category !== 'Pokemon' 
          ? checkAuthenticity(imageBase64, category)
          : Promise.resolve(null),
      ]);
      
      if (priceResult.status === 'fulfilled') price = priceResult.value;
      if (authResult.status === 'fulfilled') authenticity = authResult.value;
    }
    
    await audit({ 
      action: 'AI_SCAN', userId: req.user!.userId, req,
      metadata: { type: 'full_scan', category, confidence: scan.confidence }
    });
    
    res.json({ scan, price, authenticity });
  } catch (err: any) {
    logger.error('Errore /ai/full-scan', { err: err.message });
    res.status(500).json({ error: err.message || 'Errore scansione completa' });
  }
});

export default router;
