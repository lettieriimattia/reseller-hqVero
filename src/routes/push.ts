// src/routes/push.ts — sottoscrizione notifiche push (Web Push)
import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { getVapidPublicKey, saveSubscription, removeSubscription } from '../services/push.service';

const router = Router();
router.use(authenticate);

// Chiave pubblica VAPID (serve al browser per sottoscriversi)
router.get('/vapid-public', (_req: AuthRequest, res: Response) => {
  res.json({ key: getVapidPublicKey() });
});

// Salva la subscription del dispositivo corrente
router.post('/subscribe', async (req: AuthRequest, res: Response) => {
  try {
    await saveSubscription(req.user!.userId, req.body?.subscription || req.body);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Errore subscribe' });
  }
});

// Rimuove la subscription (disattiva le notifiche su questo dispositivo)
router.post('/unsubscribe', async (req: AuthRequest, res: Response) => {
  try {
    await removeSubscription(req.body?.endpoint);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Errore unsubscribe' });
  }
});

export default router;
