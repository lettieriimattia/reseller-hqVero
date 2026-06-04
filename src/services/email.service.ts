// src/services/email.service.ts
// Invio email via Resend (HTTP API — funziona su Railway)

import { Resend } from 'resend';
import { logger } from '../utils/logger';

function getResend() {
  const key = process.env.RESEND_API_KEY;
  if (!key) return null;
  return new Resend(key);
}

const FROM = process.env.EMAIL_FROM || 'noreply@resend.dev';

export async function sendEmail(opts: {
  to: string;
  subject: string;
  text?: string;
  html?: string;
}): Promise<{ ok: boolean; error?: string }> {
  const resend = getResend();
  if (!resend) {
    return { ok: false, error: 'Email non configurata (RESEND_API_KEY mancante).' };
  }
  try {
    const { error } = await resend.emails.send({
      from: `noreply • HQ <${FROM}>`,
      to: opts.to,
      subject: opts.subject,
      text: opts.text,
      html: opts.html,
    });
    if (error) {
      logger.error('Errore invio email Resend', { error });
      return { ok: false, error: error.message };
    }
    logger.info('Email inviata', { to: opts.to, subject: opts.subject });
    return { ok: true };
  } catch (err: any) {
    logger.error('Errore invio email', { err: err.message });
    return { ok: false, error: err.message };
  }
}
