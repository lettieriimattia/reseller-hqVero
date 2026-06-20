// src/services/order.service.ts
// Evasione di un acquisto prodotto pagato (Stripe Connect, destination charge).
// Idempotente: se la sessione è già stata evasa non fa nulla.

import { prisma } from '../lib/prisma';
import { addTracking } from './tracking.service';
import { notifyWarehouseMembers } from './notification.service';
import { logger } from './../utils/logger';

void addTracking;

export async function fulfillProductOrder(opts: {
  productId: string;
  buyerId: string;
  sessionId: string;
}): Promise<{ ok: boolean; conversationId?: string }> {
  const { productId, buyerId, sessionId } = opts;
  if (!productId || !buyerId || !sessionId) return { ok: false };

  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (!product || product.deletedAt) return { ok: false };

  // Idempotenza: già evaso con questa sessione (PAGATO in attesa, o già VENDUTO/riscosso).
  if (product.paidSessionId === sessionId) {
    const existing = await prisma.conversation.findUnique({
      where: { productId_buyerId: { productId, buyerId } },
    }).catch(() => null);
    return { ok: true, conversationId: existing?.id };
  }

  // Modello portafoglio: il pagamento è incassato dalla piattaforma e resta IN ATTESA.
  // Lo stato diventa PAGATO (NON venduto): le percentuali tra soci NON si applicano finché
  // il venditore non riscuote. heldAmount = prezzo + spedizione (netto per il venditore).
  const held = (product.publicPrice ?? 0) + (product.shippingCost ?? 0);
  await prisma.product.update({
    where: { id: productId },
    data: {
      status: 'PAGATO',
      platform: 'Marketplace',
      isPublic: false,
      paidSessionId: sessionId,
      buyerUserId: buyerId,
      paidAt: new Date(),
      heldAmount: Math.round(held * 100) / 100,
    },
  });

  // Conversazione compratore↔venditore per concordare la spedizione.
  let conversationId: string | undefined;
  try {
    const convo = await prisma.conversation.upsert({
      where: { productId_buyerId: { productId, buyerId } },
      create: { productId, sellerId: product.userId, buyerId },
      update: {},
    });
    conversationId = convo.id;
    await prisma.message.create({
      data: {
        conversationId: convo.id,
        senderId: buyerId,
        text: `✅ Pagamento completato! Ho acquistato "${product.brand} ${product.name}". In attesa di spedizione.`,
      },
    });
    await prisma.conversation.update({ where: { id: convo.id }, data: { updatedAt: new Date() } });
  } catch (e: any) { logger.error('fulfillProductOrder: conversazione', { err: e.message }); }

  // Notifica il venditore.
  if (product.warehouseId) {
    await notifyWarehouseMembers({
      warehouseId: product.warehouseId,
      excludeUserId: buyerId,
      type: 'SALE',
      title: '💰 Pagato! Da spedire',
      message: `${product.brand} ${product.name} è stato pagato (in attesa di riscossione). Spediscilo e inserisci il tracking; poi riscuoti dal Portafoglio.`,
    }).catch(() => {});
  }

  return { ok: true, conversationId };
}
