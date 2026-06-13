// src/routes/tracking.ts
// Gestione tracking spedizioni prodotti.

import { Router, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { authenticate, AuthRequest, canAccessProduct } from '../middleware/auth';
import { apiLimiter } from '../middleware/rateLimit';
import { addTracking, refreshTracking, removeTracking, setTrackingStatusManual, CARRIERS } from '../services/tracking.service';
import { logger } from '../utils/logger';

const router = Router();
const prisma = new PrismaClient();

router.use(authenticate);
router.use(apiLimiter);

// ==========================================
// GET /tracking/carriers — lista vettori supportati
// ==========================================
router.get('/carriers', (_req, res: Response) => {
  const list = Object.entries(CARRIERS).map(([key, val]) => ({
    key,
    label: val.label,
  }));
  res.json(list);
});

// ==========================================
// POST /tracking/:productId — aggiungi tracking
// ==========================================
router.post('/:productId', async (req: AuthRequest, res: Response) => {
  try {
    const { trackingCode, carrier, direction } = req.body;

    if (!trackingCode || typeof trackingCode !== 'string' || trackingCode.trim().length < 4) {
      return res.status(400).json({ error: 'Codice tracking non valido' });
    }
    if (!carrier || !CARRIERS[carrier]) {
      return res.status(400).json({ error: 'Vettore non valido' });
    }

    const { allowed } = await canAccessProduct(req.user!.userId, req.params.productId);
    if (!allowed) return res.status(403).json({ error: 'Non hai accesso a questo prodotto.' });

    const dir = direction === 'INBOUND' ? 'INBOUND' : 'OUTBOUND';
    const result = await addTracking(req.params.productId, trackingCode.trim().toUpperCase(), carrier, dir);

    if (!result.success) return res.status(400).json({ error: result.error });

    res.json({ success: true });
  } catch (err: any) {
    logger.error('Errore POST /tracking/:productId', { err: err.message });
    res.status(500).json({ error: 'Errore salvataggio tracking' });
  }
});

// ==========================================
// POST /tracking/:productId/refresh — aggiorna stato
// ==========================================
router.post('/:productId/refresh', async (req: AuthRequest, res: Response) => {
  try {
    const { allowed } = await canAccessProduct(req.user!.userId, req.params.productId);
    if (!allowed) return res.status(403).json({ error: 'Non hai accesso a questo prodotto.' });

    const info = await refreshTracking(req.params.productId);

    if (!info) {
      // Nessuna API key o prodotto senza tracking — restituiamo dati dal DB
      const product = await prisma.product.findUnique({ where: { id: req.params.productId } });
      if (!product?.trackingCode) {
        return res.status(404).json({ error: 'Nessun tracking configurato per questo prodotto' });
      }
      return res.json({
        status: product.trackingStatus || 'PENDING',
        lastUpdate: product.trackingUpdatedAt?.toISOString() || null,
        history: product.trackingHistory ? JSON.parse(product.trackingHistory) : [],
        noApiKey: true,
      });
    }

    res.json(info);
  } catch (err: any) {
    logger.error('Errore POST /tracking/:productId/refresh', { err: err.message });
    res.status(500).json({ error: 'Errore aggiornamento tracking' });
  }
});

// ==========================================
// POST /tracking/:productId/status — imposta lo stato a mano (senza API esterna)
// ==========================================
router.post('/:productId/status', async (req: AuthRequest, res: Response) => {
  try {
    const { status } = req.body || {};
    const { allowed } = await canAccessProduct(req.user!.userId, req.params.productId);
    if (!allowed) return res.status(403).json({ error: 'Non hai accesso a questo prodotto.' });

    const result = await setTrackingStatusManual(req.params.productId, (status || '').toString());
    if (!result.success) return res.status(400).json({ error: result.error });
    res.json({ success: true });
  } catch (err: any) {
    logger.error('Errore POST /tracking/:productId/status', { err: err.message });
    res.status(500).json({ error: 'Errore aggiornamento stato' });
  }
});

// ==========================================
// GET /tracking/:productId — ottieni stato corrente
// ==========================================
router.get('/:productId', async (req: AuthRequest, res: Response) => {
  try {
    const { allowed, product } = await canAccessProduct(req.user!.userId, req.params.productId);
    if (!allowed) return res.status(403).json({ error: 'Non hai accesso a questo prodotto.' });

    if (!product.trackingCode) {
      return res.status(404).json({ error: 'Nessun tracking per questo prodotto' });
    }

    res.json({
      trackingCode: product.trackingCode,
      carrier: product.trackingCarrier,
      status: product.trackingStatus || 'PENDING',
      lastUpdate: product.trackingUpdatedAt?.toISOString() || null,
      history: product.trackingHistory ? JSON.parse(product.trackingHistory) : [],
    });
  } catch (err: any) {
    logger.error('Errore GET /tracking/:productId', { err: err.message });
    res.status(500).json({ error: 'Errore lettura tracking' });
  }
});

// ==========================================
// DELETE /tracking/:productId — rimuovi tracking
// ==========================================
router.delete('/:productId', async (req: AuthRequest, res: Response) => {
  try {
    const { allowed } = await canAccessProduct(req.user!.userId, req.params.productId);
    if (!allowed) return res.status(403).json({ error: 'Non hai accesso a questo prodotto.' });

    await removeTracking(req.params.productId);
    res.json({ success: true });
  } catch (err: any) {
    logger.error('Errore DELETE /tracking/:productId', { err: err.message });
    res.status(500).json({ error: 'Errore rimozione tracking' });
  }
});

export default router;
