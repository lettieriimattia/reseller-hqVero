// src/routes/notifications.ts
// Notifiche in-app + visualizzazione audit log (per OWNER).

import { Router, Response } from 'express';
import { authenticate, AuthRequest, authorizeWarehouseOwner } from '../middleware/auth';
import { apiLimiter } from '../middleware/rateLimit';
import { 
  getNotifications, markAsRead, markAllRead, getUnreadCount 
} from '../services/notification.service';
import { getAuditLogsForWarehouse } from '../services/audit.service';
import { getStaleProducts, checkAndNotifyStale } from '../services/stale.service';
import { logger } from '../utils/logger';

const router = Router();

router.use(authenticate);
router.use(apiLimiter);

// ==========================================
// GET /notifications
// ==========================================
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const unreadOnly = req.query.unread === 'true';
    const notifications = await getNotifications(req.user!.userId, unreadOnly);
    const unreadCount = await getUnreadCount(req.user!.userId);
    res.json({ notifications, unreadCount });
  } catch (err: any) {
    logger.error('Errore GET /notifications', { err: err.message });
    res.status(500).json({ error: 'Errore notifiche' });
  }
});

// ==========================================
// POST /notifications/:id/read
// ==========================================
router.post('/:id/read', async (req: AuthRequest, res: Response) => {
  try {
    await markAsRead(req.user!.userId, req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Errore' });
  }
});

// ==========================================
// POST /notifications/read-all
// ==========================================
router.post('/read-all', async (req: AuthRequest, res: Response) => {
  try {
    await markAllRead(req.user!.userId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Errore' });
  }
});

// ==========================================
// GET /audit/:warehouseId - audit log del team (storico modifiche)
// Riservato a OWNER
// ==========================================
router.get('/audit/:warehouseId', async (req: AuthRequest, res: Response) => {
  try {
    const isOwner = await authorizeWarehouseOwner(req.user!.userId, req.params.warehouseId);
    if (!isOwner) return res.status(403).json({ error: 'Solo i fondatori possono vedere lo storico.' });
    
    const logs = await getAuditLogsForWarehouse(req.params.warehouseId, 100);
    res.json(logs);
  } catch (err: any) {
    logger.error('Errore GET /audit', { err: err.message });
    res.status(500).json({ error: 'Errore audit log' });
  }
});

// ==========================================
// GET /stale?days=60 - elenco prodotti fermi
// Usato dal frontend per mostrare quali prodotti sono fermi
// ==========================================
router.get('/stale', async (req: AuthRequest, res: Response) => {
  try {
    const days = Math.max(1, Math.min(365, parseInt(req.query.days as string) || 60));
    const stale = await getStaleProducts(req.user!.userId, days);
    
    // Genera (o aggiorna) anche la notifica di riepilogo se opportuno
    await checkAndNotifyStale(req.user!.userId, days);
    
    res.json({ thresholdDays: days, count: stale.length, products: stale });
  } catch (err: any) {
    logger.error('Errore GET /stale', { err: err.message });
    res.status(500).json({ error: 'Errore controllo prodotti fermi' });
  }
});

export default router;
