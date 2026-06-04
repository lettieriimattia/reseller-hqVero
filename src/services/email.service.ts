// src/services/email.service.ts
// Invio email via Brevo API (HTTP — funziona su Railway, no dominio richiesto)

import { logger } from '../utils/logger';

const BREVO_API = 'https://api.brevo.com/v3/smtp/email';
const FROM_EMAIL = process.env.EMAIL_FROM || 'noreply.hq.app@gmail.com';

export async function sendEmail(opts: {
  to: string;
  subject: string;
  text?: string;
  html?: string;
}): Promise<{ ok: boolean; error?: string }> {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) {
    return { ok: false, error: 'Email non configurata (BREVO_API_KEY mancante).' };
  }
  try {
    const res = await fetch(BREVO_API, {
      method: 'POST',
      headers: {
        'api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sender: { name: 'noreply • HQ', email: FROM_EMAIL },
        to: [{ email: opts.to }],
        subject: opts.subject,
        htmlContent: opts.html,
        textContent: opts.text,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as any;
      const msg = err?.message || `HTTP ${res.status}`;
      logger.error('Errore invio email Brevo', { msg });
      return { ok: false, error: msg };
    }

    logger.info('Email inviata', { to: opts.to, subject: opts.subject });
    return { ok: true };
  } catch (err: any) {
    logger.error('Errore invio email', { err: err.message });
    return { ok: false, error: err.message };
  }
}
