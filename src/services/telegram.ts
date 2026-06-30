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
  if (!isTelegramConfigured()) return false;
  try {
    const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    if (!r.ok) { logger.warn('Telegram non ok', { status: r.status }); return false; }
    return true;
  } catch (e: any) { logger.warn('Telegram errore', { err: e.message }); return false; }
}
