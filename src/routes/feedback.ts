// src/routes/feedback.ts
// Aiuto & Assistenza: l'utente invia una richiesta -> salvata nel DB (model Feedback)
// così l'admin la vede nel pannello e può rispondere (la risposta arriva via email).
// In più notifichiamo l'admin via email (best-effort) di una nuova richiesta.

import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { aiLimiter } from '../middleware/rateLimit';
import { sendTelegram } from '../services/telegram';
import { logger } from '../utils/logger';
import { PrismaClient } from '@prisma/client';
import { prisma } from "../lib/prisma";

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

    // Notifica all'admin SOLO via Telegram. Rispondendo a QUESTO messaggio su Telegram, la
    // risposta viene inviata via email al cliente (vedi telegram-webhook.ts). La richiesta
    // resta comunque salvata nel pannello admin (Feedback).
    sendTelegram(`📨 <b>Nuova richiesta · ${kind}</b>\nDa: ${userName || ''} ✉️ ${userEmail}\n\n${msg.slice(0, 1500)}\n\n↩️ <i>Rispondi a questo messaggio per inviare la risposta via email al cliente.</i>`).catch(() => {});

    logger.info('Feedback ricevuto', { from: userEmail, kind });
    res.json({ ok: true });
  } catch (err: any) {
    logger.error('Errore /api/feedback', { err: err.message });
    res.status(500).json({ error: 'Errore invio. Riprova.' });
  }
});

export default router;
