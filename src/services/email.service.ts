// src/services/email.service.ts
// Invio email via Gmail SMTP con Nodemailer

import nodemailer from 'nodemailer';
import { logger } from '../utils/logger';

function createTransporter() {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) return null;
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass },
  });
}

export async function sendEmail(opts: {
  to: string;
  subject: string;
  text?: string;
  html?: string;
}): Promise<{ ok: boolean; error?: string }> {
  const transporter = createTransporter();
  if (!transporter) {
    return { ok: false, error: 'Email non configurata (GMAIL_USER / GMAIL_APP_PASSWORD mancanti).' };
  }
  try {
    await transporter.sendMail({
      from: `"noreply • HQ" <${process.env.GMAIL_USER}>`,
      to: opts.to,
      subject: opts.subject,
      text: opts.text,
      html: opts.html,
    });
    logger.info('Email inviata', { to: opts.to, subject: opts.subject });
    return { ok: true };
  } catch (err: any) {
    logger.error('Errore invio email', { err: err.message });
    return { ok: false, error: err.message };
  }
}
