// src/services/telegram.ts
// Invio messaggi Telegram condiviso (report giornaliero + notifiche supporto, ecc.).
// ENV: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID.

import { logger } from '../utils/logger';

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT = process.env.TELEGRAM_CHAT_ID || '';

export function isTelegramConfigured(): boolean {
  return !!(TG_TOKEN && TG_CHAT);
}

export async function sendTelegram(text: string): Promise<boolean> {
  if (!isTelegramConfigured()) {
    logger.warn('Telegram NON configurato (TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID mancanti su Render) → fallback email');
    return false;
  }
  try {
    const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    // ATTENZIONE: Telegram torna HTTP 200 ANCHE quando rifiuta (es. "chat not found",
    // "bot was blocked"): il vero esito è nel campo body.ok. Va controllato quello.
    const data: any = await r.json().catch(() => ({}));
    if (!r.ok || !data?.ok) {
      logger.warn('Telegram invio fallito', { status: r.status, errorCode: data?.error_code, desc: data?.description });
      return false;
    }
    return true;
  } catch (e: any) { logger.warn('Telegram errore di rete', { err: e.message }); return false; }
}
