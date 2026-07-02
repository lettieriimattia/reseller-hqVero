// src/services/telegram.ts
// Invio messaggi Telegram condiviso (report giornaliero + notifiche supporto, ecc.).
// ENV: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID.

import crypto from 'crypto';
import { logger } from '../utils/logger';

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
// PIÙ destinatari: TELEGRAM_CHAT_ID può contenere più chat_id separati da virgola (es. tu + socio),
// oppure l'id di un GRUPPO Telegram (id negativo) con dentro tutti. Il messaggio va a ognuno.
const TG_CHATS = (process.env.TELEGRAM_CHAT_ID || '').split(',').map(s => s.trim()).filter(Boolean);

export function getChatIds(): string[] { return TG_CHATS; }
// Il webhook accetta le risposte solo dalle chat autorizzate (tu e/o il socio).
export function isAdminChat(id: string | number | undefined | null): boolean {
  return TG_CHATS.includes(String(id ?? ''));
}

export function isTelegramConfigured(): boolean {
  return !!(TG_TOKEN && TG_CHATS.length > 0);
}

// Segreto del webhook derivato dal token (niente env extra). Telegram lo rimanda nell'header
// X-Telegram-Bot-Api-Secret-Token: così verifichiamo che la chiamata venga davvero da Telegram.
export function webhookSecret(): string {
  return crypto.createHash('sha256').update(TG_TOKEN || 'x').digest('hex').slice(0, 40);
}

// Registra il webhook su Telegram (chiamato all'avvio in produzione). Telegram POSTerà gli
// update su APP_URL/api/telegram/webhook → ci permette di leggere le RISPOSTE dell'admin.
export async function setTelegramWebhook(): Promise<void> {
  if (!isTelegramConfigured()) return;
  const base = (process.env.APP_URL || '').replace(/\/$/, '');
  if (!base) { logger.warn('APP_URL mancante: webhook Telegram non impostato (le risposte da Telegram non funzioneranno)'); return; }
  try {
    const url = `${base}/api/telegram/webhook`;
    const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/setWebhook`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, secret_token: webhookSecret(), allowed_updates: ['message'], drop_pending_updates: true }),
    });
    const d: any = await r.json().catch(() => ({}));
    if (d?.ok) logger.info('Webhook Telegram impostato', { url });
    else logger.warn('Webhook Telegram NON impostato', { desc: d?.description });
  } catch (e: any) { logger.warn('Errore setWebhook Telegram', { err: e.message }); }
}

export async function sendTelegram(text: string): Promise<boolean> {
  if (!isTelegramConfigured()) {
    logger.warn('Telegram NON configurato (TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID mancanti su Render) → fallback email');
    return false;
  }
  // Invia a TUTTI i destinatari configurati. Basta che UNO vada a buon fine per considerarlo ok.
  let anyOk = false;
  for (const chat of TG_CHATS) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true }),
      });
      // ATTENZIONE: Telegram torna HTTP 200 ANCHE quando rifiuta (es. "chat not found",
      // "bot was blocked"): il vero esito è nel campo body.ok. Va controllato quello.
      const data: any = await r.json().catch(() => ({}));
      if (!r.ok || !data?.ok) {
        logger.warn('Telegram invio fallito', { chat, status: r.status, errorCode: data?.error_code, desc: data?.description });
      } else { anyOk = true; }
    } catch (e: any) { logger.warn('Telegram errore di rete', { chat, err: e.message }); }
  }
  return anyOk;
}
