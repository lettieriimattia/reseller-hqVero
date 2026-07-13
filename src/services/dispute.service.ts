// src/services/dispute.service.ts
// Contestazioni / resi e sblocco fondi dell'escrow marketplace.
//
// Modello: dal pagamento al "Consegnato" i soldi sono TRATTENUTI dalla piattaforma
// (separate charge su Stripe, non ancora girati al venditore). Quindi:
//  - rimborso  = semplice refund Stripe del pagamento (totale o parziale)
//  - sblocco   = il prodotto diventa VENDUTO e l'importo entra nel Portafoglio del venditore
//
// Tutte le contestazioni vanno gestite in questa finestra (prima dello sblocco).

import { prisma } from '../lib/prisma';
import { stripe } from '../lib/stripe';
import { notifyWarehouseMembers } from './notification.service';
import { onProductSold } from './inventorySync.service';
import { logger } from '../utils/logger';

// Giorni dopo la consegna oltre i quali i fondi si sbloccano da soli (scelta utente: 5).
export const AUTO_RELEASE_DAYS = 5;
// Rete di sicurezza: se la consegna non viene mai rilevata, sblocco comunque dopo la spedizione.
export const SHIP_FALLBACK_DAYS = 14;

export const DISPUTE_REASONS = ['NOT_AS_DESCRIBED', 'COUNTERFEIT', 'DAMAGED', 'NOT_ARRIVED', 'WRONG_ITEM'] as const;
export type DisputeReason = typeof DISPUTE_REASONS[number];

export function reasonLabel(r?: string | null): string {
  switch (r) {
    case 'NOT_AS_DESCRIBED': return 'Non conforme alla descrizione';
    case 'COUNTERFEIT': return 'Sospetto falso/contraffatto';
    case 'DAMAGED': return 'Arrivato danneggiato';
    case 'NOT_ARRIVED': return 'Mai arrivato';
    case 'WRONG_ITEM': return 'Oggetto sbagliato';
    default: return 'Problema';
  }
}

// Rimborsa (totale o parziale) il pagamento di un prodotto sul conto del compratore.
// amountEur null/0 = rimborso totale di quanto pagato dal compratore.
export async function refundProductPayment(
  product: { id: string; paidSessionId: string | null },
  amountEur?: number,
): Promise<{ ok: boolean; error?: string; refundId?: string }> {
  const s = stripe();
  if (!s) return { ok: false, error: 'Pagamenti non configurati' };
  if (!product.paidSessionId) return { ok: false, error: 'Pagamento non trovato' };
  try {
    const session = await s.checkout.sessions.retrieve(product.paidSessionId);
    const pi = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id;
    if (!pi) return { ok: false, error: 'PaymentIntent non trovato' };
    const refund = await s.refunds.create({
      payment_intent: pi,
      ...(amountEur && amountEur > 0 ? { amount: Math.round(amountEur * 100) } : {}),
      metadata: { productId: product.id, kind: 'dispute_refund' },
    });
    return { ok: true, refundId: refund.id };
  } catch (e: any) {
    logger.error('refundProductPayment', { err: e.message, productId: product.id });
    return { ok: false, error: e.message };
  }
}

// Sblocca i fondi al venditore: il prodotto diventa VENDUTO, l'importo (eventualmente
// ridotto da un rimborso parziale) entra nel Portafoglio pronto da riscuotere.
export async function releaseHold(productId: string, opts?: { partialRefund?: number; auto?: boolean }) {
  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (!product || product.status !== 'PAGATO') return { ok: false };
  const partial = Math.max(0, opts?.partialRefund || 0);
  const gross = (product.heldAmount ?? product.publicPrice ?? 0) - (product.shippingCost ?? 0);
  const salePrice = Math.max(0, Math.round((gross - partial) * 100) / 100);
  const newHeld = Math.max(0, Math.round(((product.heldAmount ?? 0) - partial) * 100) / 100);
  await prisma.product.update({
    where: { id: productId },
    data: {
      status: 'VENDUTO',
      soldAt: new Date(),
      salePrice,
      heldAmount: newHeld,
      deliveredConfirmedAt: new Date(),
      // A disputa chiusa eliminiamo le foto prova dal DB (privacy + spazio): teniamo solo motivo/nota.
      ...(partial > 0 ? { refundedAmount: partial, refundedAt: new Date(), disputeStatus: 'RESOLVED_PARTIAL', disputeResolvedAt: new Date(), disputePhotos: null } : {}),
    },
  });
  if (product.warehouseId) {
    await notifyWarehouseMembers({
      warehouseId: product.warehouseId, excludeUserId: '',
      type: 'SALE',
      title: opts?.auto ? '✅ Fondi sbloccati (auto-conferma)' : '✅ Fondi sbloccati',
      message: `${product.brand} ${product.name}: ${partial > 0 ? 'rimborso parziale applicato, ' : ''}importo disponibile nel Portafoglio.`,
    }).catch(() => {});
  }
  onProductSold(productId).catch(() => {});
  return { ok: true };
}

// Rimette il prodotto del venditore "invenduto" dopo un rimborso totale e rimuove la
// copia nel magazzino del compratore (che ha riavuto i soldi / restituisce l'oggetto).
export async function reverseSaleAfterRefund(productId: string, refundEur: number) {
  await prisma.product.update({
    where: { id: productId },
    data: {
      status: 'IN STOCK',
      disputeStatus: 'RESOLVED_REFUND',
      disputeResolvedAt: new Date(),
      disputePhotos: null, // foto prova eliminate a verdetto chiuso (privacy + spazio)
      refundedAmount: refundEur,
      refundedAt: new Date(),
      heldAmount: null,
      deliveredConfirmedAt: null,
      autoReleaseAt: null,
      buyerUserId: null,
      paidAt: null,
      toShip: false,
    },
  });
  // Rimuovi la copia nel magazzino del compratore (soft delete).
  await prisma.product.updateMany({
    where: { sourceProductId: productId, deletedAt: null },
    data: { deletedAt: new Date() },
  }).catch(() => {});
}

// SWEEP (cron): sblocca i fondi degli articoli la cui finestra è scaduta e senza contestazioni.
export async function releaseExpiredHolds(): Promise<number> {
  const now = new Date();
  const due = await prisma.product.findMany({
    where: {
      status: 'PAGATO',
      disputeStatus: null,
      autoReleaseAt: { not: null, lte: now },
      deletedAt: null,
    },
    select: { id: true },
  });
  let n = 0;
  for (const p of due) {
    const r = await releaseHold(p.id, { auto: true }).catch(() => ({ ok: false }));
    if (r.ok) n++;
  }
  if (n > 0) logger.info('Auto-sblocco fondi escrow', { count: n });
  return n;
}
