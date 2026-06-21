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
  // il venditore non riscuote. heldAmount = prezzo (eventualmente concordato) + spedizione.
  const convo = await prisma.conversation.findUnique({ where: { productId_buyerId: { productId, buyerId } } }).catch(() => null);
  const itemPrice = (convo?.agreedPrice && convo.agreedPrice > 0) ? convo.agreedPrice : (product.publicPrice ?? 0);
  const held = itemPrice + (product.shippingCost ?? 0);
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

  // Copia l'articolo nel magazzino del COMPRATORE con i dati ORIGINALI del venditore
  // (nome, brand, taglia, condizione, categoria, foto): così ha l'oggetto vero in stock,
  // non un nome a caso. Prezzo d'acquisto = quanto ha pagato (prezzo articolo, no spedizione).
  try {
    const already = await prisma.product.findFirst({ where: { buyerUserId: buyerId, sourceProductId: productId, userId: buyerId } }).catch(() => null);
    if (!already) {
      const buyerWh = await prisma.membership.findFirst({
        where: { userId: buyerId, role: 'OWNER', warehouse: { parentId: null } },
        orderBy: { createdAt: 'asc' },
      }) || await prisma.membership.findFirst({ where: { userId: buyerId } });
      if (buyerWh) {
        await prisma.product.create({
          data: {
            userId: buyerId,
            warehouseId: buyerWh.warehouseId,
            category: product.category,
            brand: product.brand,
            name: product.name,
            size: product.size,
            condition: product.condition,
            purchasePrice: itemPrice,
            status: 'IN STOCK',
            photos: product.photos || null,
            sku: product.sku || null,
            attributes: product.attributes || null,
            sourceProductId: productId,
            buyerUserId: buyerId,
            notes: 'Acquistato dal marketplace',
          },
        });
      }
    }
  } catch (e: any) { logger.error('fulfillProductOrder: copia compratore', { err: e.message }); }

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
