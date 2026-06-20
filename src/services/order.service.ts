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

  // Idempotenza: già evaso con questa sessione.
  if (product.paidSessionId === sessionId && product.status === 'VENDUTO') {
    const existing = await prisma.conversation.findUnique({
      where: { productId_buyerId: { productId, buyerId } },
    }).catch(() => null);
    return { ok: true, conversationId: existing?.id };
  }

  // Segna venduto al prezzo pubblico (netto al venditore) e togli dalla vetrina.
  await prisma.product.update({
    where: { id: productId },
    data: {
      status: 'VENDUTO',
      soldAt: new Date(),
      salePrice: product.publicPrice ?? 0,
      platform: 'Marketplace',
      isPublic: false,
      paidSessionId: sessionId,
      buyerUserId: buyerId,
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
      title: '💰 Venduto e pagato!',
      message: `${product.brand} ${product.name} è stato pagato. Spedisci e inserisci il tracking.`,
    }).catch(() => {});
  }

  return { ok: true, conversationId };
}
