// src/routes/support.ts
// Supporto clienti IA (primo livello) con escalation a UMANO.
// L'utente fa domande sull'app → risponde l'IA (Groq) con la knowledge di HQVault.
// Se l'IA non può risolvere (billing/rimborsi, problema specifico account, bug, o richiesta
// esplicita di un operatore) → ESCALATION: crea un ticket nel sistema Feedback esistente
// (così l'admin lo vede nel pannello e risponde via email) + notifica admin (email + Telegram).

import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { aiLimiter } from '../middleware/rateLimit';
import { prisma } from '../lib/prisma';
import { groqAssistantChat, isGroqConfigured } from '../services/ai.service';
import { sendEmail } from '../services/email.service';
import { sendTelegram } from '../services/telegram';
import { ADMIN_EMAIL } from '../config/admins';
import { logger } from '../utils/logger';

const router = Router();
router.use(authenticate);
router.use(aiLimiter);

const SUPPORT_SYSTEM = `Sei l'assistente del SUPPORTO CLIENTI di HQVault, un'app gestionale per reseller (sneaker, streetwear, borse, carte Pokémon, elettronica). Rispondi in italiano, tono amichevole e diretto, con passi pratici e brevi.

COSA SAI FARE (knowledge HQVault):
- Aggiungere prodotti: dal CATALOGO (cerca il modello e premi "+"), col "+" verde nella barra chat, a voce dicendo "Ehy HQ", oppure importando il tuo Excel (abbini le colonne). Per più pezzi insieme: i LOTTI (inserisci quantità + totale pagato, genera le righe).
- Le FOTO ufficiali si agganciano da sole dal catalogo.
- Vendere: tasto Vendi sul prodotto; puoi aggiungere costi extra (scatola/spedizione) e fare vendite multiple con prezzo totale diviso per N.
- Tracking spedizioni: incolli il codice e segui lo stato.
- Team/soci: i magazzini sono i soci, con divisione automatica di costi, ricavi e profitti.
- Piani: Free (25 prodotti), Starter (150), Pro (2000), Business (illimitato).
- Temi (scuro/chiaro/glass) e impostazioni: in Impostazioni.
- Privacy & consensi: accettati alla registrazione, rileggibili in "Privacy e consensi".
- Assistente vocale "Ehy HQ": si arma dopo un tocco nell'app.

REGOLE:
- Se non sai la risposta, o riguarda PAGAMENTI/RIMBORSI/ABBONAMENTI, un problema SPECIFICO dell'account, un BUG che non puoi risolvere a parole, o l'utente CHIEDE un operatore umano → NON inventare: dai comunque una risposta utile e di' che passi la richiesta a un operatore.
- Alla FINE di OGNI risposta, su una riga separata, scrivi esattamente "ESCALATE: SI" se serve un umano, altrimenti "ESCALATE: NO". Questa riga non la vede l'utente.`;

const HUMAN_KEYWORDS = /(operatore|umano|persona (vera|reale)|assistenza umana|parlare con (qualcuno|un|una)|rimbors|refund|disdire|annullare l'abbonamento|fattura|pagamento non|addebito)/i;

// POST /api/support/chat  { messages: [{role:'user'|'assistant', content}] }
router.post('/chat', async (req: AuthRequest, res: Response) => {
  try {
    const incoming = Array.isArray(req.body?.messages) ? req.body.messages : [];
    const history = incoming
      .filter((m: any) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .slice(-12)
      .map((m: any) => ({ role: m.role, content: m.content.toString().slice(0, 2000) }));
    if (history.length === 0 || history[history.length - 1].role !== 'user') {
      return res.status(400).json({ error: 'Messaggio mancante.' });
    }
    const lastUser = history[history.length - 1].content;

    let reply = 'Al momento non riesco a risponderti, passo la tua richiesta a un operatore.';
    let escalate = HUMAN_KEYWORDS.test(lastUser);

    if (isGroqConfigured()) {
      try {
        const msg = await groqAssistantChat({
          messages: [{ role: 'system', content: SUPPORT_SYSTEM }, ...history],
          temperature: 0.3, maxTokens: 500,
        });
        const raw = (msg?.content || '').toString().trim();
        // Estrai e rimuovi la riga di controllo ESCALATE.
        const m = raw.match(/ESCALATE:\s*(SI|SÌ|YES|NO)/i);
        if (m) escalate = escalate || /si|sÌ|yes/i.test(m[1]);
        reply = raw.replace(/\n?\s*ESCALATE:\s*(SI|SÌ|YES|NO)\s*$/i, '').trim() || reply;
      } catch (e: any) {
        logger.warn('Support AI errore', { err: e.message });
        escalate = true; // se l'IA fallisce, meglio passare all'umano
      }
    } else {
      escalate = true;
    }

    let ticketCreated = false;
    if (escalate) {
      const userEmail = req.user?.email || 'sconosciuto';
      const userId = req.user?.userId || null;
      let userName: string | null = null;
      if (userId) {
        const u = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } }).catch(() => null);
        userName = u?.name ?? null;
      }
      const transcript = history.map((h: any) => `${h.role === 'user' ? 'Utente' : 'IA'}: ${h.content}`).join('\n');
      const fbMessage = `[Supporto IA → operatore]\n\n${transcript}`;
      await prisma.feedback.create({
        data: { userId, userEmail, userName, type: 'domanda', message: fbMessage.slice(0, 4000), status: 'nuova' },
      }).then(() => { ticketCreated = true; }).catch((e) => logger.error('Errore creazione ticket supporto', { err: e.message }));

      // Notifica admin: email (pannello) + Telegram (best-effort).
      sendEmail({
        to: ADMIN_EMAIL,
        subject: `[HQ · SUPPORTO da operatore] ${userEmail}`,
        text: `Richiesta passata dall'IA a un operatore.\nDa: ${userName || ''} <${userEmail}>\n\n${transcript}`,
      }).catch(() => {});
      sendTelegram(`🆘 <b>Supporto: richiesta operatore</b>\nDa: ${userName || ''} (${userEmail})\n\n${lastUser.slice(0, 300)}`).catch(() => {});
    }

    res.json({ reply, escalated: escalate, ticketCreated });
  } catch (err: any) {
    logger.error('Errore /api/support/chat', { err: err.message });
    res.status(500).json({ error: 'Errore supporto. Riprova.' });
  }
});

export default router;
