// src/routes/billing.ts
// Abbonamenti Stripe per i piani (Starter/Pro/Business).
// Flusso: l'utente sceglie un piano → Stripe Checkout (mode subscription) → paga →
// il webhook attiva il piano sull'account. Niente carte gestite da noi.
//
// Env richieste su Render: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET.

import { Router, Response, Request } from 'express';
import { prisma } from '../lib/prisma';
import { authenticate, AuthRequest } from '../middleware/auth';
import { getPlan, isPlanId, PLAN_ORDER } from '../config/plans';
import { logger } from '../utils/logger';

// require: il pacchetto porta i suoi tipi, ma evitiamo problemi se non installato in locale.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Stripe = require('stripe');

const router = Router();

function stripe(): any | null {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  return new Stripe(key);
}

export function isStripeConfigured(): boolean {
  return !!process.env.STRIPE_SECRET_KEY;
}

function appBase(req: Request): string {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, '');
  const proto = (req.headers['x-forwarded-proto'] || 'https').toString().split(',')[0];
  const host = (req.headers['x-forwarded-host'] || req.headers.host || 'resellerhq.onrender.com').toString();
  return `${proto}://${host}`;
}

// Avvio checkout abbonamento per un piano.
router.post('/checkout', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const s = stripe();
    if (!s) return res.status(400).json({ error: 'Pagamenti non configurati' });
    const planId = (req.body?.planId || '').toString();
    if (!isPlanId(planId) || planId === 'free') return res.status(400).json({ error: 'Piano non valido' });
    const plan = getPlan(planId);

    const user = await prisma.user.findUnique({ where: { id: req.user!.userId } });
    if (!user) return res.status(404).json({ error: 'Utente non trovato' });

    const base = appBase(req);
    const session = await s.checkout.sessions.create({
      mode: 'subscription',
      client_reference_id: user.id,
      customer_email: user.email,
      line_items: [{
        quantity: 1,
        price_data: {
          currency: 'eur',
          product_data: { name: `ResellerHQ ${plan.name}` },
          unit_amount: Math.round(plan.priceMonthly * 100),
          recurring: { interval: 'month' },
        },
      }],
      metadata: { userId: user.id, planId },
      subscription_data: { metadata: { userId: user.id, planId } },
      success_url: `${base}/?upgraded=${planId}`,
      cancel_url: `${base}/?upgrade_cancel=1`,
      allow_promotion_codes: true,
    });
    res.json({ url: session.url });
  } catch (err: any) {
    logger.error('Errore /billing/checkout', { err: err.message });
    res.status(500).json({ error: 'Errore avvio pagamento' });
  }
});

// Portale Stripe per gestire/disdire l'abbonamento.
router.post('/portal', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const s = stripe();
    if (!s) return res.status(400).json({ error: 'Pagamenti non configurati' });
    const user = await prisma.user.findUnique({ where: { id: req.user!.userId } });
    const setting = await prisma.setting.findUnique({ where: { key: `stripeCustomer:${user!.id}` } }).catch(() => null);
    if (!setting?.value) return res.status(400).json({ error: 'Nessun abbonamento attivo' });
    const portal = await s.billingPortal.sessions.create({
      customer: setting.value,
      return_url: appBase(req),
    });
    res.json({ url: portal.url });
  } catch (err: any) {
    logger.error('Errore /billing/portal', { err: err.message });
    res.status(500).json({ error: 'Errore portale' });
  }
});

// Webhook Stripe: aggiorna il piano dell'utente. Richiede il RAW body (montato in server.ts).
export async function stripeWebhookHandler(req: Request, res: Response) {
  const s = stripe();
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!s || !secret) return res.status(400).send('not configured');
  let event: any;
  try {
    event = s.webhooks.constructEvent((req as any).body, req.headers['stripe-signature'], secret);
  } catch (err: any) {
    logger.error('Stripe webhook firma non valida', { err: err.message });
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    const obj = event.data?.object || {};
    const setPlan = async (userId: string, planId: string, customerId?: string) => {
      if (!userId || !isPlanId(planId)) return;
      await prisma.user.update({ where: { id: userId }, data: { plan: planId } }).catch(() => {});
      if (customerId) {
        await prisma.setting.upsert({
          where: { key: `stripeCustomer:${userId}` },
          create: { key: `stripeCustomer:${userId}`, value: customerId },
          update: { value: customerId },
        }).catch(() => {});
      }
    };

    if (event.type === 'checkout.session.completed') {
      const userId = obj.client_reference_id || obj.metadata?.userId;
      const planId = obj.metadata?.planId;
      await setPlan(userId, planId, obj.customer);
    } else if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.created') {
      const userId = obj.metadata?.userId;
      const planId = obj.metadata?.planId;
      // Se l'abbonamento è attivo applica il piano; se scaduto/insoluto torna free.
      const active = ['active', 'trialing'].includes(obj.status);
      if (userId) await setPlan(userId, active ? (planId || 'free') : 'free', obj.customer);
    } else if (event.type === 'customer.subscription.deleted') {
      const userId = obj.metadata?.userId;
      if (userId) await setPlan(userId, 'free', obj.customer);
    }
    res.json({ received: true });
  } catch (err: any) {
    logger.error('Errore gestione webhook Stripe', { err: err.message });
    res.status(500).send('error');
  }
}

void PLAN_ORDER;
export default router;
