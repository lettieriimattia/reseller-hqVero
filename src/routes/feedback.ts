// src/routes/feedback.ts
// Aiuto & Assistenza: il messaggio dell'utente arriva all'admin via email (Brevo).
// Niente DB: semplice e affidabile (come [[project-adaptive-ai]] -> tutto leggero).

import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { aiLimiter } from '../middleware/rateLimit';
import { sendEmail } from '../services/email.service';
import { logger } from '../utils/logger';

const router = Router();
router.use(authenticate);
router.use(aiLimiter); // riusa un rate-limit esistente per evitare spam

const VALID_TYPES = ['bug', 'idea', 'domanda', 'altro'];

router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const { message, type } = req.body || {};
    const msg = (message ?? '').toString().trim();
    if (msg.length < 3) return res.status(400).json({ error: 'Scrivi un messaggio un po’ più lungo.' });
    if (msg.length > 4000) return res.status(400).json({ error: 'Messaggio troppo lungo (max 4000 caratteri).' });

    const kind = VALID_TYPES.includes(type) ? type : 'altro';
    const adminEmail = process.env.ADMIN_EMAIL || 'noreply.hq.app@gmail.com';
    const userEmail = req.user?.email || 'sconosciuto';
    const userId = req.user?.userId || '-';

    const sent = await sendEmail({
      to: adminEmail,
      subject: `[HQ · ${kind}] da ${userEmail}`,
      text: `Tipo: ${kind}\nDa: ${userEmail}\nUserID: ${userId}\n\n${msg}`,
      html: `<p><b>Tipo:</b> ${kind}</p><p><b>Da:</b> ${userEmail}</p><p><b>UserID:</b> ${userId}</p><hr/><p>${msg.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br/>')}</p>`,
    });

    if (!sent.ok) {
      logger.warn('Feedback non inviato', { err: sent.error });
      return res.status(502).json({ error: 'Invio non riuscito al momento. Riprova più tardi.' });
    }
    logger.info('Feedback ricevuto', { from: userEmail, kind });
    res.json({ ok: true });
  } catch (err: any) {
    logger.error('Errore /api/feedback', { err: err.message });
    res.status(500).json({ error: 'Errore invio. Riprova.' });
  }
});

export default router;
