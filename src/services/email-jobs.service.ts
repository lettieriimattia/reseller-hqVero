// src/services/email-jobs.service.ts
// Job email automatiche: prodotti fermi (ogni 2 settimane) + tracking consegnato

import cron from 'node-cron';
import { PrismaClient } from '@prisma/client';
import { prisma } from "../lib/prisma";
import { sendEmail } from './email.service';
import { logger } from '../utils/logger';


// ==========================================
// TEMPLATE EMAIL
// ==========================================

function emailWrapper(content: string): string {
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Inter',sans-serif;background:#111;color:#fff;padding:0;margin:0;">
    <div style="max-width:520px;margin:0 auto;padding:32px 24px;">
      <div style="margin-bottom:28px;">
        <span style="font-size:28px;font-weight:900;letter-spacing:-1px;">H<span style="opacity:0.3">Q</span></span>
      </div>
      ${content}
      <div style="margin-top:40px;padding-top:20px;border-top:1px solid #222;">
        <p style="color:#444;font-size:11px;margin:0;">noreply • HQ — Gestionale per rivenditori</p>
        <p style="color:#333;font-size:11px;margin:4px 0 0;">Puoi disattivare queste notifiche dalle Impostazioni dell'app.</p>
      </div>
    </div>
  </div>`;
}

function staleProductsTemplate(userName: string, products: any[], thresholdDays: number): string {
  const rows = products.map(p => {
    const days = Math.floor((Date.now() - new Date(p.createdAt).getTime()) / (1000 * 60 * 60 * 24));
    return `<tr>
      <td style="padding:10px 0;border-bottom:1px solid #1a1a1a;">
        <span style="font-weight:600;color:#fff;">${p.brand} ${p.name}</span>
        <span style="color:#666;font-size:12px;margin-left:8px;">${p.size}</span>
      </td>
      <td style="padding:10px 0;border-bottom:1px solid #1a1a1a;text-align:right;">
        <span style="color:#ff4d00;font-weight:700;font-size:13px;">€${p.purchasePrice.toFixed(2)}</span>
      </td>
      <td style="padding:10px 0;border-bottom:1px solid #1a1a1a;text-align:right;">
        <span style="color:#888;font-size:12px;">${days} giorni</span>
      </td>
    </tr>`;
  }).join('');

  const content = `
    <h2 style="font-size:20px;font-weight:700;margin:0 0 6px;letter-spacing:-0.5px;">Prodotti fermi in magazzino</h2>
    <p style="color:#666;font-size:14px;margin:0 0 28px;">Ciao ${userName}, hai ${products.length} prodott${products.length === 1 ? 'o' : 'i'} in stock da più di ${thresholdDays} giorni.</p>
    <table style="width:100%;border-collapse:collapse;">
      <thead>
        <tr>
          <th style="text-align:left;font-size:10px;color:#555;text-transform:uppercase;letter-spacing:1px;padding-bottom:8px;">Prodotto</th>
          <th style="text-align:right;font-size:10px;color:#555;text-transform:uppercase;letter-spacing:1px;padding-bottom:8px;">Costo</th>
          <th style="text-align:right;font-size:10px;color:#555;text-transform:uppercase;letter-spacing:1px;padding-bottom:8px;">Giorni</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <div style="margin-top:24px;padding:16px;background:#1a0800;border:1px solid #ff4d0030;border-radius:12px;">
      <p style="color:#ff4d00;font-size:13px;margin:0;font-weight:600;">Considera uno sconto o un cambio di piattaforma per velocizzare la vendita.</p>
    </div>`;

  return emailWrapper(content);
}

function deliveredTemplate(userName: string, product: any): string {
  const content = `
    <h2 style="font-size:20px;font-weight:700;margin:0 0 6px;letter-spacing:-0.5px;">Spedizione consegnata</h2>
    <p style="color:#666;font-size:14px;margin:0 0 28px;">Ciao ${userName}, il tuo pacco è arrivato a destinazione.</p>
    <div style="background:#0f0f0f;border:1px solid #222;border-radius:14px;padding:20px;">
      <p style="font-size:18px;font-weight:700;margin:0 0 4px;">${product.brand} ${product.name}</p>
      <p style="color:#666;font-size:13px;margin:0 0 16px;">${product.size} · ${product.category}</p>
      <div style="display:flex;gap:16px;">
        <div>
          <p style="color:#555;font-size:10px;text-transform:uppercase;letter-spacing:1px;margin:0 0 2px;">Codice tracking</p>
          <p style="color:#fff;font-size:13px;font-family:monospace;margin:0;">${product.trackingCode}</p>
        </div>
        <div>
          <p style="color:#555;font-size:10px;text-transform:uppercase;letter-spacing:1px;margin:0 0 2px;">Corriere</p>
          <p style="color:#fff;font-size:13px;margin:0;">${product.trackingCarrier || 'Auto'}</p>
        </div>
      </div>
    </div>
    <div style="margin-top:20px;padding:14px;background:#001a0a;border:1px solid #00ff5520;border-radius:12px;">
      <p style="color:#4caf50;font-size:13px;margin:0;font-weight:600;">Apri HQ per completare la vendita con prezzo e piattaforma.</p>
    </div>`;

  return emailWrapper(content);
}

// ==========================================
// JOB: EMAIL PRODOTTI FERMI — ogni 2 settimane
// ==========================================
const DEFAULT_STALE_DAYS = 60;

async function runStaleProductsEmail() {
  logger.info('Job: avvio email prodotti fermi');
  try {
    const users = await prisma.user.findMany({
      where: { marketingConsent: true },
      include: { products: { where: { status: 'IN STOCK' } } },
    });

    let sent = 0;
    for (const user of users) {
      const stale = user.products.filter(p => {
        const days = (Date.now() - new Date(p.createdAt).getTime()) / (1000 * 60 * 60 * 24);
        return days >= DEFAULT_STALE_DAYS;
      });
      if (stale.length === 0) continue;

      const result = await sendEmail({
        to: user.email,
        subject: `HQ — ${stale.length} prodott${stale.length === 1 ? 'o fermo' : 'i fermi'} in magazzino`,
        html: staleProductsTemplate(user.name, stale, DEFAULT_STALE_DAYS),
        text: `Ciao ${user.name}, hai ${stale.length} prodotti in stock da più di ${DEFAULT_STALE_DAYS} giorni. Apri HQ per gestirli.`,
      });
      if (result.ok) sent++;
    }
    logger.info(`Job prodotti fermi completato: ${sent} email inviate`);
  } catch (err: any) {
    logger.error('Errore job prodotti fermi', { err: err.message });
  }
}

// ==========================================
// EMAIL SINGOLA: TRACKING CONSEGNATO
// (chiamata da tracking.service.ts)
// ==========================================
export async function sendDeliveredEmail(productId: string) {
  try {
    const product = await prisma.product.findUnique({
      where: { id: productId },
      include: { user: true },
    });
    if (!product || !product.user) return;

    await sendEmail({
      to: product.user.email,
      subject: `HQ — Spedizione consegnata: ${product.brand} ${product.name}`,
      html: deliveredTemplate(product.user.name, product),
      text: `Ciao ${product.user.name}, il tuo pacco ${product.brand} ${product.name} (${product.trackingCode}) è stato consegnato. Apri HQ per completare la vendita.`,
    });
    logger.info('Email consegna inviata', { productId, to: product.user.email });
  } catch (err: any) {
    logger.error('Errore email consegna', { err: err.message });
  }
}

// ==========================================
// AVVIA I JOB (chiamato da server.ts)
// ==========================================
export function startEmailJobs() {
  // Ogni 2 settimane — lunedì mattina alle 9:00
  // Cron: 0 9 * * 1 ogni lunedì, ma vogliamo ogni 2 settimane
  // Usiamo un contatore settimane in memoria (semplice ed efficace)
  let weekCount = 0;
  cron.schedule('0 9 * * 1', async () => {
    weekCount++;
    if (weekCount % 2 === 0) {
      await runStaleProductsEmail();
    }
  });

  logger.info('Email jobs avviati (prodotti fermi ogni 2 settimane)');
}
