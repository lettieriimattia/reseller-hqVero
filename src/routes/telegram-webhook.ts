// src/routes/telegram-webhook.ts
// Riceve gli update da Telegram. Quando l'ADMIN RISPONDE (reply) a una notifica del bot
// (feedback / supporto), prende l'email del cliente dal messaggio originale e gli invia la
// risposta via EMAIL. Così: cliente → Telegram all'admin; admin risponde su Telegram → email al cliente.
//
// Sicurezza: niente authenticate (lo chiama Telegram). Verifica il secret_token (header) e che
// il mittente sia la chat dell'admin. DEVE essere montato PRIMA di app.use('/', teamRoutes).

import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { sendEmail } from '../services/email.service';
import { sendTelegram, webhookSecret, isAdminChat } from '../services/telegram';
import { logger } from '../utils/logger';

const router = Router();

router.post('/webhook', async (req: Request, res: Response) => {
  // Verifica che la chiamata venga davvero da Telegram (secret impostato in setWebhook).
  if ((req.headers['x-telegram-bot-api-secret-token'] || '') !== webhookSecret()) {
    return res.status(403).end();
  }
  res.status(200).end(); // rispondi SUBITO (Telegram ritenta se non riceve 200)

  try {
    const msg = req.body?.message;
    if (!msg || !msg.text || !msg.reply_to_message) return;          // solo RISPOSTE a un messaggio
    if (!isAdminChat(msg.chat?.id)) return;                           // solo dalle chat autorizzate (tu/socio)

    const original = (msg.reply_to_message.text || '').toString();
    const email = (original.match(/[\w.+-]+@[\w-]+\.[\w.-]+/) || [])[0];
    const replyText = msg.text.toString().trim();
    if (!email) { await sendTelegram('⚠️ Non trovo l\'email del cliente nel messaggio a cui hai risposto.'); return; }
    if (!replyText) return;

    const r = await sendEmail({
      to: email,
      subject: 'Risposta dal supporto HQVault',
      text: `Ciao,\n\n${replyText}\n\n— Il team HQVault`,
      html: `<div style="font-family:-apple-system,system-ui,sans-serif;font-size:15px;line-height:1.6;color:#14181f;max-width:520px;margin:0 auto;padding:24px;">
        <p style="font-weight:800;font-size:18px;margin:0 0 16px;">HQ<span style="color:#0d9488">Vault</span> · Supporto</p>
        <p>Ciao,</p>
        <p>${replyText.replace(/\n/g, '<br>')}</p>
        <p style="color:#6b7480;margin-top:20px;">— Il team HQVault</p>
      </div>`,
    });

    // Segna come "risposta" il ticket più recente di quel cliente (best-effort, per il pannello admin).
    await prisma.feedback.updateMany({
      where: { userEmail: email, status: 'nuova' },
      data: { status: 'risposta', reply: replyText, repliedAt: new Date() },
    }).catch(() => {});

    await sendTelegram(r.ok ? `✅ Risposta inviata via email a <b>${email}</b>` : `❌ Invio email a ${email} fallito`);
  } catch (e: any) {
    logger.error('Errore telegram webhook', { err: e.message });
  }
});

export default router;
