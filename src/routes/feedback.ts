// src/routes/feedback.ts
// Aiuto & Assistenza: l'utente invia una richiesta -> salvata nel DB (model Feedback)
// così l'admin la vede nel pannello e può rispondere (la risposta arriva via email).
// In più notifichiamo l'admin via email (best-effort) di una nuova richiesta.

import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { aiLimiter } from '../middleware/rateLimit';
import { sendEmail } from '../services/email.service';
import { logger } from '../utils/logger';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
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
    const userEmail = req.user?.email || 'sconosciuto';
    const userId = req.user?.userId || null;

    let userName: string | null = null;
    if (userId) {
      const u = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } }).catch(() => null);
      userName = u?.name ?? null;
    }

    await prisma.feedback.create({
      data: { userId, userEmail, userName, type: kind, message: msg, status: 'nuova' },
    });

    // Notifica all'admin (best-effort, non blocca la risposta)
    const adminEmail = process.env.ADMIN_EMAIL || 'noreply.hq.app@gmail.com';
    sendEmail({
      to: adminEmail,
      subject: `[HQ · nuova richiesta · ${kind}] da ${userEmail}`,
      text: `Tipo: ${kind}\nDa: ${userName || ''} <${userEmail}>\n\n${msg}`,
    }).catch(() => {});

    logger.info('Feedback ricevuto', { from: userEmail, kind });
    res.json({ ok: true });
  } catch (err: any) {
    logger.error('Errore /api/feedback', { err: err.message });
    res.status(500).json({ error: 'Errore invio. Riprova.' });
  }
});

export default router;
