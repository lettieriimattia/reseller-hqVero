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
import { stripe, isStripeConfigured, appBase } from '../lib/stripe';
import { fulfillProductOrder } from '../services/order.service';
import { logger } from '../utils/logger';

const router = Router();

export { isStripeConfigured };

// ==========================================
// PORTAFOGLIO VENDITORE — saldo + riscossione (KYC solo al primo prelievo).
// ==========================================

// Saldo: importi sbloccati (consegna confermata) pronti da riscuotere + quanto è ancora in attesa.
router.get('/payout/balance', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const uid = req.user!.userId;
    // Pronti da riscuotere: VENDUTO pagato in-app, consegna confermata, non ancora prelevato.
    const ready = await prisma.product.findMany({
      where: { userId: uid, status: 'VENDUTO', paidSessionId: { not: null }, deliveredConfirmedAt: { not: null }, withdrawnAt: null, deletedAt: null },
      select: { id: true, brand: true, name: true, heldAmount: true },
    });
    // In attesa: pagati ma consegna non ancora confermata dal compratore.
    const pendingItems = await prisma.product.findMany({
      where: { userId: uid, status: 'PAGATO', deletedAt: null },
      select: { id: true, brand: true, name: true, heldAmount: true },
    });
    const sum = (arr: any[]) => Math.round(arr.reduce((a, p) => a + (p.heldAmount || 0), 0) * 100) / 100;
    res.json({
      available: sum(ready),
      pending: sum(pendingItems),
      readyItems: ready.map(p => ({ id: p.id, name: `${p.brand} ${p.name}`, amount: p.heldAmount || 0 })),
      pendingItems: pendingItems.map(p => ({ id: p.id, name: `${p.brand} ${p.name}`, amount: p.heldAmount || 0 })),
    });
  } catch (err: any) {
    logger.error('Errore /billing/payout/balance', { err: err.message });
    res.status(500).json({ error: 'Errore saldo' });
  }
});

// Riscossione: se il conto non è ancora verificato → onboarding minimo (IBAN). Altrimenti
// trasferisce gli importi pronti al conto del venditore (bonifico automatico) e li segna riscossi.
router.post('/payout/withdraw', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const s = stripe();
    if (!s) return res.status(400).json({ error: 'Pagamenti non configurati' });
    const user = await prisma.user.findUnique({ where: { id: req.user!.userId } });
    if (!user) return res.status(404).json({ error: 'Utente non trovato' });

    const ready = await prisma.product.findMany({
      where: { userId: user.id, status: 'VENDUTO', paidSessionId: { not: null }, deliveredConfirmedAt: { not: null }, withdrawnAt: null, deletedAt: null },
      select: { id: true, heldAmount: true },
    });
    const total = Math.round(ready.reduce((a, p) => a + (p.heldAmount || 0), 0) * 100) / 100;
    if (total <= 0) return res.status(400).json({ error: 'Non hai ancora importi da riscuotere.' });

    // Serve il conto verificato per il bonifico. Se non lo è → onboarding (chiede solo il minimo).
    let accountId = user.stripeAccountId;
    let chargesEnabled = user.stripeChargesEnabled;
    if (accountId) {
      try {
        const acct = await s.accounts.retrieve(accountId);
        chargesEnabled = !!acct.payouts_enabled;
        if (chargesEnabled !== user.stripeChargesEnabled) {
          await prisma.user.update({ where: { id: user.id }, data: { stripeChargesEnabled: chargesEnabled } }).catch(() => {});
        }
      } catch { /* ignora */ }
    }
    if (!accountId || !chargesEnabled) {
      if (!accountId) {
        const account = await s.accounts.create({
          type: 'express', email: user.email,
          capabilities: { transfers: { requested: true } },
          business_type: 'individual', metadata: { userId: user.id },
        });
        accountId = account.id;
        await prisma.user.update({ where: { id: user.id }, data: { stripeAccountId: accountId } });
      }
      const base = appBase(req);
      const link = await s.accountLinks.create({
        account: accountId,
        refresh_url: `${base}/?connect=refresh`,
        return_url: `${base}/?connect=done`,
        type: 'account_onboarding',
        collection_options: { fields: 'currently_due', future_requirements: 'omit' },
      });
      return res.json({ needsOnboarding: true, url: link.url });
    }

    // Conto pronto: trasferisci gli importi e segna riscosso.
    const transfer = await s.transfers.create({
      amount: Math.round(total * 100), currency: 'eur', destination: accountId,
      metadata: { userId: user.id, kind: 'payout' },
    });
    await prisma.product.updateMany({
      where: { id: { in: ready.map(p => p.id) } },
      data: { withdrawnAt: new Date() },
    });
    res.json({ withdrawn: total, count: ready.length, transferId: transfer.id });
  } catch (err: any) {
    logger.error('Errore /billing/payout/withdraw', { err: err.message });
    res.status(500).json({ error: 'Errore riscossione' });
  }
});

// ==========================================
// STRIPE CONNECT — il venditore collega il suo conto per incassare i pagamenti.
// Flusso: onboard → Stripe (hosted, verifica identità/IBAN) → ritorno → status.
// ==========================================

// Avvia/continua l'onboarding del venditore. Crea l'account Express se non esiste
// e restituisce un Account Link (URL ospitato da Stripe).
router.post('/connect/onboard', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const s = stripe();
    if (!s) return res.status(400).json({ error: 'Pagamenti non configurati' });
    const user = await prisma.user.findUnique({ where: { id: req.user!.userId } });
    if (!user) return res.status(404).json({ error: 'Utente non trovato' });

    let accountId = user.stripeAccountId;
    if (!accountId) {
      const account = await s.accounts.create({
        type: 'express',
        email: user.email,
        // Solo "transfers": per i destination charge al venditore basta questa capability,
        // così l'onboarding è MOLTO più corto (niente requisiti di card_payments).
        capabilities: { transfers: { requested: true } },
        business_type: 'individual',
        metadata: { userId: user.id },
      });
      accountId = account.id;
      await prisma.user.update({ where: { id: user.id }, data: { stripeAccountId: accountId } });
    }

    const base = appBase(req);
    const link = await s.accountLinks.create({
      account: accountId,
      refresh_url: `${base}/?connect=refresh`,
      return_url: `${base}/?connect=done`,
      type: 'account_onboarding',
      // Chiedi SOLO ciò che è strettamente necessario ora; il resto viene rimandato.
      collection_options: { fields: 'currently_due', future_requirements: 'omit' },
    });
    res.json({ url: link.url });
  } catch (err: any) {
    logger.error('Errore /billing/connect/onboard', { err: err.message });
    res.status(500).json({ error: 'Errore collegamento conto' });
  }
});

// Stato del conto venditore: connesso + abilitato a incassare.
router.get('/connect/status', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const s = stripe();
    if (!s) return res.json({ configured: false, connected: false, chargesEnabled: false });
    const user = await prisma.user.findUnique({ where: { id: req.user!.userId } });
    if (!user?.stripeAccountId) return res.json({ configured: true, connected: false, chargesEnabled: false });
    const acct = await s.accounts.retrieve(user.stripeAccountId);
    const chargesEnabled = !!acct.charges_enabled && !!acct.payouts_enabled;
    if (chargesEnabled !== user.stripeChargesEnabled) {
      await prisma.user.update({ where: { id: user.id }, data: { stripeChargesEnabled: chargesEnabled } }).catch(() => {});
    }
    res.json({ configured: true, connected: true, chargesEnabled, detailsSubmitted: !!acct.details_submitted });
  } catch (err: any) {
    logger.error('Errore /billing/connect/status', { err: err.message });
    res.json({ configured: true, connected: false, chargesEnabled: false });
  }
});

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
      success_url: `${base}/?upgraded=${planId}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${base}/?upgrade_cancel=1`,
      allow_promotion_codes: true,
    });
    res.json({ url: session.url });
  } catch (err: any) {
    logger.error('Errore /billing/checkout', { err: err.message });
    res.status(500).json({ error: 'Errore avvio pagamento' });
  }
});

// RETE DI SICUREZZA: verifica diretta al ritorno dal pagamento.
// Se il webhook non è configurato o fallisce, l'app chiama qui col session_id e
// noi controlliamo su Stripe se il pagamento è andato → aggiorniamo il piano.
router.post('/verify', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const s = stripe();
    if (!s) return res.status(400).json({ error: 'Pagamenti non configurati' });
    const sessionId = (req.body?.sessionId || '').toString();
    if (!sessionId) return res.status(400).json({ error: 'sessionId mancante' });

    const session = await s.checkout.sessions.retrieve(sessionId);
    const paid = session?.payment_status === 'paid' || session?.status === 'complete';

    // CASO acquisto prodotto (Connect): evade l'ordine se il compratore è chi chiama.
    if (session?.metadata?.kind === 'product') {
      if (session.metadata.buyerId && session.metadata.buyerId !== req.user!.userId) {
        return res.status(403).json({ error: 'Sessione non tua' });
      }
      if (paid) {
        const r = await fulfillProductOrder({
          productId: session.metadata.productId,
          buyerId: req.user!.userId,
          sessionId: session.id,
        });
        return res.json({ updated: r.ok, kind: 'product', conversationId: r.conversationId || null });
      }
      return res.json({ updated: false, kind: 'product' });
    }

    // CASO abbonamento.
    const ownerId = session?.client_reference_id || session?.metadata?.userId;
    if (ownerId && ownerId !== req.user!.userId) return res.status(403).json({ error: 'Sessione non tua' });
    const planId = session?.metadata?.planId;
    if (paid && isPlanId(planId) && planId !== 'free') {
      await prisma.user.update({ where: { id: req.user!.userId }, data: { plan: planId } }).catch(() => {});
      if (session.customer) {
        await prisma.setting.upsert({
          where: { key: `stripeCustomer:${req.user!.userId}` },
          create: { key: `stripeCustomer:${req.user!.userId}`, value: session.customer.toString() },
          update: { value: session.customer.toString() },
        }).catch(() => {});
      }
      return res.json({ updated: true, plan: planId });
    }
    res.json({ updated: false, plan: null });
  } catch (err: any) {
    logger.error('Errore /billing/verify', { err: err.message });
    res.status(500).json({ error: 'Errore verifica pagamento' });
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
      // Acquisto prodotto (Connect) oppure abbonamento.
      if (obj.metadata?.kind === 'product') {
        await fulfillProductOrder({
          productId: obj.metadata?.productId,
          buyerId: obj.metadata?.buyerId,
          sessionId: obj.id,
        }).catch((e: any) => logger.error('webhook fulfill prodotto', { err: e.message }));
      } else {
        const userId = obj.client_reference_id || obj.metadata?.userId;
        const planId = obj.metadata?.planId;
        await setPlan(userId, planId, obj.customer);
      }
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
