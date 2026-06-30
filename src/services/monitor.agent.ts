// src/services/monitor.agent.ts
// AGENTE IA "report giornaliero": una volta al giorno legge i numeri chiave dal DB
// (iscrizioni, attività in-app, vendite/business), li fa commentare a Groq con un insight
// e te li manda. Canale: Telegram se configurato, altrimenti email (Brevo).
//
// Gira UNA volta al giorno (cron) → una sola query → NON tiene sveglio Neon (zero impatto costi).
// Si attiva da solo solo se c'è una destinazione configurata (TELEGRAM_* o MONITOR_REPORT_EMAIL).
//
// ENV:
//   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID   → invio su Telegram (consigliato)
//   MONITOR_REPORT_EMAIL                    → invio via email (fallback se niente Telegram)
//   MONITOR_HOUR (default 8)                → ora locale (Europe/Rome) di invio
//   RUN_MONITOR_NOW=1                       → invia subito un report all'avvio (per testare)

import cron from 'node-cron';
import { prisma } from '../lib/prisma';
import { sendEmail } from './email.service';
import { groqAssistantChat, isGroqConfigured } from './ai.service';
import { logger } from '../utils/logger';

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT = process.env.TELEGRAM_CHAT_ID || '';
const REPORT_EMAIL = process.env.MONITOR_REPORT_EMAIL || '';

function telegramConfigured() { return !!(TG_TOKEN && TG_CHAT); }
function destinationConfigured() { return telegramConfigured() || !!REPORT_EMAIL; }

async function sendTelegram(text: string): Promise<boolean> {
  if (!telegramConfigured()) return false;
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

interface Stats {
  newUsers24h: number; newUsersPrev: number; totalUsers: number; payingUsers: number;
  activeUsers24h: number; productsAdded24h: number; sold24h: number; revenue24h: number;
}

async function gatherStats(): Promise<Stats> {
  const now = Date.now();
  const since24 = new Date(now - 86400000);
  const prev48 = new Date(now - 2 * 86400000);

  const [newUsers24h, newUsersPrev, totalUsers, payingUsers, activeRows, productsAdded24h, soldRows] = await Promise.all([
    prisma.user.count({ where: { createdAt: { gte: since24 } } }),
    prisma.user.count({ where: { createdAt: { gte: prev48, lt: since24 } } }),
    prisma.user.count(),
    prisma.user.count({ where: { plan: { not: 'free' } } }),
    prisma.product.groupBy({ by: ['userId'], where: { updatedAt: { gte: since24 } } }),
    prisma.product.count({ where: { createdAt: { gte: since24 }, deletedAt: null } }),
    prisma.product.findMany({ where: { status: 'VENDUTO', soldAt: { gte: since24 } }, select: { salePrice: true } }),
  ]);

  const revenue24h = soldRows.reduce((s, p) => s + (p.salePrice || 0), 0);
  return {
    newUsers24h, newUsersPrev, totalUsers, payingUsers,
    activeUsers24h: activeRows.length, productsAdded24h, sold24h: soldRows.length, revenue24h,
  };
}

// Commento "intelligente" generato da Groq: 2-3 frasi con insight + 1 suggerimento. Best-effort.
async function aiInsight(s: Stats): Promise<string> {
  if (!isGroqConfigured()) return '';
  try {
    const trend = s.newUsersPrev > 0 ? `${Math.round(((s.newUsers24h - s.newUsersPrev) / s.newUsersPrev) * 100)}%` : 'n/d';
    const msg = await groqAssistantChat({
      messages: [
        { role: 'system', content: 'Sei un analista di crescita per una SaaS di gestione reseller. Dati i numeri delle ultime 24h, scrivi 2-3 frasi in italiano: l\'insight chiave + UN suggerimento pratico. Tono diretto, niente elenchi, niente fronzoli, max 60 parole.' },
        { role: 'user', content: `Nuovi iscritti 24h: ${s.newUsers24h} (ieri ${s.newUsersPrev}, variazione ${trend}). Utenti totali: ${s.totalUsers}. Paganti: ${s.payingUsers}. Utenti attivi 24h: ${s.activeUsers24h}. Prodotti aggiunti 24h: ${s.productsAdded24h}. Vendite registrate 24h: ${s.sold24h} per ${s.revenue24h.toFixed(0)}€.` },
      ],
      temperature: 0.5, maxTokens: 220,
    });
    return (msg?.content || '').toString().trim();
  } catch (e: any) { logger.warn('AI insight non disponibile', { err: e.message }); return ''; }
}

function trendArrow(cur: number, prev: number): string {
  if (prev === 0) return cur > 0 ? '🟢' : '⚪';
  if (cur > prev) return '🟢'; if (cur < prev) return '🔴'; return '⚪';
}

async function buildReport(): Promise<{ subject: string; tg: string; html: string }> {
  const s = await gatherStats();
  const insight = await aiInsight(s);
  const day = new Date().toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' });

  const tg =
`📊 <b>HQVault — Report giornaliero</b>
<i>${day}</i>

👥 <b>Iscrizioni</b>
• Nuovi (24h): <b>${s.newUsers24h}</b> ${trendArrow(s.newUsers24h, s.newUsersPrev)} (ieri ${s.newUsersPrev})
• Totali: <b>${s.totalUsers}</b> · Paganti: <b>${s.payingUsers}</b>

⚡ <b>Attività in-app (24h)</b>
• Utenti attivi: <b>${s.activeUsers24h}</b>
• Prodotti aggiunti: <b>${s.productsAdded24h}</b>

💰 <b>Vendite (24h)</b>
• Vendite registrate: <b>${s.sold24h}</b> · Ricavi: <b>${s.revenue24h.toFixed(0)}€</b>${insight ? `\n\n🧠 <b>Insight</b>\n${insight}` : ''}`;

  const html =
`<div style="font-family:-apple-system,BlinkMacSystemFont,'Inter',sans-serif;background:#0a0b0c;color:#e8eaec;padding:28px 22px;max-width:560px;margin:0 auto;border-radius:16px;">
  <h2 style="margin:0 0 2px;font-size:20px;">📊 HQVault — Report giornaliero</h2>
  <p style="color:#7a828a;font-size:13px;margin:0 0 22px;text-transform:capitalize;">${day}</p>
  <h3 style="font-size:13px;color:#1fa89f;margin:0 0 8px;text-transform:uppercase;letter-spacing:.06em;">👥 Iscrizioni</h3>
  <p style="margin:0 0 18px;font-size:14px;line-height:1.7;">Nuovi (24h): <b>${s.newUsers24h}</b> ${trendArrow(s.newUsers24h, s.newUsersPrev)} (ieri ${s.newUsersPrev})<br>Totali: <b>${s.totalUsers}</b> · Paganti: <b>${s.payingUsers}</b></p>
  <h3 style="font-size:13px;color:#1fa89f;margin:0 0 8px;text-transform:uppercase;letter-spacing:.06em;">⚡ Attività in-app (24h)</h3>
  <p style="margin:0 0 18px;font-size:14px;line-height:1.7;">Utenti attivi: <b>${s.activeUsers24h}</b><br>Prodotti aggiunti: <b>${s.productsAdded24h}</b></p>
  <h3 style="font-size:13px;color:#1fa89f;margin:0 0 8px;text-transform:uppercase;letter-spacing:.06em;">💰 Vendite (24h)</h3>
  <p style="margin:0 0 18px;font-size:14px;line-height:1.7;">Vendite registrate: <b>${s.sold24h}</b> · Ricavi: <b>${s.revenue24h.toFixed(0)}€</b></p>
  ${insight ? `<div style="margin-top:8px;padding:14px 16px;background:#0f1b1a;border:1px solid #1fa89f33;border-radius:12px;"><p style="color:#34c2b8;font-size:13px;margin:0;">🧠 ${insight}</p></div>` : ''}
</div>`;

  return { subject: `📊 HQVault — Report: +${s.newUsers24h} iscritti, ${s.sold24h} vendite (24h)`, tg, html };
}

export async function runDailyReport(): Promise<void> {
  try {
    const { subject, tg, html } = await buildReport();
    let sent = false;
    if (telegramConfigured()) sent = await sendTelegram(tg);
    if (!sent && REPORT_EMAIL) {
      const r = await sendEmail({ to: REPORT_EMAIL, subject, html, text: tg.replace(/<[^>]+>/g, '') });
      sent = r.ok;
    }
    logger.info(`Report giornaliero ${sent ? 'inviato' : 'NON inviato (destinazione non configurata?)'}`);
  } catch (e: any) {
    logger.error('Errore report giornaliero', { err: e.message });
  }
}

export function startMonitorAgent(): void {
  if (!destinationConfigured()) {
    logger.info('📊 Agente report giornaliero IN ATTESA: imposta TELEGRAM_BOT_TOKEN+TELEGRAM_CHAT_ID (o MONITOR_REPORT_EMAIL) per attivarlo.');
    return;
  }
  const hour = Math.min(Math.max(Number(process.env.MONITOR_HOUR || 8), 0), 23);
  cron.schedule(`0 ${hour} * * *`, () => { void runDailyReport(); }, { timezone: 'Europe/Rome' });
  logger.info(`📊 Agente report giornaliero attivo (ogni giorno alle ${hour}:00, ${telegramConfigured() ? 'Telegram' : 'email'}).`);
  if (process.env.RUN_MONITOR_NOW === '1') setTimeout(() => { void runDailyReport(); }, 8000);
}
