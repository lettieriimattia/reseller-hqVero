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
import { sendTelegram, sendTelegramTo, webhookSecret, isAdminChat } from '../services/telegram';
import { runAssistant, executeTool, MUTATING_TOOLS } from './assistant';
import { isGroqConfigured } from '../services/ai.service';
import { setMaintenance, isMaintenanceOn } from '../services/maintenance-flag';
import { logger } from '../utils/logger';

// Comandi OPERATIVI d'emergenza (manutenzione sito) — riconosciuti prima dell'agente IA.
async function handleOpsCommand(chatId: string, text: string): Promise<boolean> {
  const t = text.toLowerCase().trim();
  if (/^(\/)?(manutenzione|maintenance|manutenzione sito)\b/.test(t) || /(metti|vai) in manutenzione/.test(t) || /(togli|esci|riattiva).*manutenzione/.test(t) || /sito (giu|offline|online|su)/.test(t)) {
    const on = /\bon\b|attiva|metti|giu|giù|offline|blocca|chiudi/.test(t) && !/\boff\b|disattiva|togli|riattiva|online|su\b|riapri/.test(t);
    await setMaintenance(on);
    await sendTelegramTo(chatId, on
      ? '🔒 <b>Sito in MANUTENZIONE.</b> Gli utenti vedono la schermata di manutenzione. Scrivi "manutenzione off" per riaprire.'
      : '✅ <b>Sito ONLINE.</b> Manutenzione disattivata.');
    return true;
  }
  if (/^(\/)?(stato|status)\b/.test(t)) {
    await sendTelegramTo(chatId, isMaintenanceOn() ? '🔒 Sito in manutenzione.' : '🟢 Sito online e operativo.');
    return true;
  }
  return false;
}

const router = Router();

// Azione PROPOSTA in attesa di conferma, per chat (flusso "proponi → conferma → esegui").
const pendingByChat = new Map<string, { name: string; args: any; userId: string; at: number }>();
const CONFIRM_RE = /^\s*(ok|okay|s[iì]+|conferma|confermo|vai|procedi|fai(?:lo)?|yes|ye|👍|✅)\b/i;
const CANCEL_RE = /^\s*(no|annulla|lascia|stop|cancella|nulla)\b/i;

// Account HQ condiviso su cui operano gli agenti Telegram (email in env, altrimenti primo OWNER).
async function resolveOwnerUserId(): Promise<string | null> {
  const email = (process.env.TELEGRAM_OWNER_EMAIL || '').trim().toLowerCase();
  if (email) { const u = await prisma.user.findUnique({ where: { email } }).catch(() => null); if (u) return u.id; }
  const m = await prisma.membership.findFirst({ where: { role: 'OWNER' }, orderBy: { createdAt: 'asc' } }).catch(() => null);
  return m?.userId || null;
}

// Gestisce un COMANDO all'agente (messaggio normale dell'admin, non una risposta a un cliente).
async function handleAgentCommand(chatId: string, text: string): Promise<void> {
  // Comandi operativi d'emergenza (manutenzione/stato): gestiti PRIMA dell'IA.
  if (await handleOpsCommand(chatId, text)) return;
  if (!isGroqConfigured()) { await sendTelegramTo(chatId, '🤖 Assistente non disponibile (IA non configurata).'); return; }
  const userId = await resolveOwnerUserId();
  if (!userId) { await sendTelegramTo(chatId, '⚠️ Nessun account HQ collegato. Imposta TELEGRAM_OWNER_EMAIL.'); return; }

  // 1) C'è un'azione in sospeso per questa chat? Gestisci conferma / annullo.
  const pending = pendingByChat.get(chatId);
  if (pending && Date.now() - pending.at < 10 * 60_000) {
    if (CONFIRM_RE.test(text)) {
      pendingByChat.delete(chatId);
      try {
        const result: any = await executeTool(pending.name, pending.args, { userId });
        await sendTelegramTo(chatId, result?.error ? `❌ ${result.error}` : `✅ Fatto.`);
      } catch { await sendTelegramTo(chatId, '❌ Errore nell\'eseguire l\'azione.'); }
      return;
    }
    if (CANCEL_RE.test(text)) { pendingByChat.delete(chatId); await sendTelegramTo(chatId, '↩️ Annullato.'); return; }
    // altrimenti: nuovo comando → sovrascrive quello in sospeso (prosegue sotto)
    pendingByChat.delete(chatId);
  }

  // 2) Esegui l'assistente: le azioni che MODIFICANO vengono PROPOSTE (non eseguite).
  let proposed: { name: string; args: any } | null = null;
  const intercept = (name: string, args: any) => {
    if (MUTATING_TOOLS.has(name)) { proposed = { name, args }; return { proposta: true, azione: name, nota: 'Azione NON ancora eseguita: riassumi in una frase cosa stai per fare e chiedi conferma.' }; }
    return undefined; // le letture (cerca/valuta/riepilogo) girano normalmente
  };
  try {
    const out = await runAssistant([{ role: 'user', content: text.slice(0, 2000) }], userId, intercept);
    let reply = (out.reply || 'Ok.').slice(0, 3500);
    if (proposed) { pendingByChat.set(chatId, { ...(proposed as any), userId, at: Date.now() }); reply += '\n\n👉 Rispondi <b>OK</b> per confermare, o <b>No</b> per annullare.'; }
    await sendTelegramTo(chatId, reply);
  } catch (e: any) {
    logger.warn('Agente Telegram errore', { err: e?.message });
    await sendTelegramTo(chatId, '❌ Errore assistente.');
  }
}

router.post('/webhook', async (req: Request, res: Response) => {
  // Verifica che la chiamata venga davvero da Telegram (secret impostato in setWebhook).
  if ((req.headers['x-telegram-bot-api-secret-token'] || '') !== webhookSecret()) {
    return res.status(403).end();
  }
  res.status(200).end(); // rispondi SUBITO (Telegram ritenta se non riceve 200)

  try {
    const msg = req.body?.message;
    if (!msg || !msg.text) return;
    const chatId = String(msg.chat?.id ?? '');
    if (!isAdminChat(chatId)) return;                                 // solo dalle chat autorizzate (tu/socio)
    const text = msg.text.toString().trim();

    // Se c'è un'azione in sospeso per questa chat, il messaggio è la conferma/annullo (anche se
    // inviato col tasto Reply): gestiscilo come comando agente, non come risposta a un cliente.
    if (pendingByChat.has(chatId)) { await handleAgentCommand(chatId, text); return; }

    // COMANDO all'agente: messaggio normale (NON una risposta a un cliente).
    if (!msg.reply_to_message) {
      if (/^\/start\b/i.test(text)) { await sendTelegramTo(chatId, '👋 Sono l\'agente HQVault. Scrivimi cosa fare (es. "quante Jordan 4 ho", "vendi le Dunk a 180", "ricordami di spedire a Marco"). Le azioni che modificano te le propongo prima e le eseguo solo se rispondi OK.'); return; }
      if (text.startsWith('/')) return; // altri comandi bot: ignora
      await handleAgentCommand(chatId, text);
      return;
    }

    // RISPOSTA a un cliente (feedback/supporto → email).
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
