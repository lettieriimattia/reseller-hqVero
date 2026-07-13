// src/services/inventorySync.service.ts
// Aggancio centrale Shopify Fase 2 (direzione RHQ → Shopify): quando un pezzo passa a VENDUTO
// dentro ResellerHQ ed è collegato a una variante Shopify (importata con shopifyVariantId/
// shopifyInventoryItemId), scala di 1 la giacenza sullo store. Chiamata fire-and-forget da
// TUTTI i punti che segnano un Product VENDUTO (vedi products.ts, chat.ts, dispute.service.ts,
// tracking.service.ts, assistant.ts) — non deve mai bloccare o far fallire la vendita stessa.
import { prisma } from '../lib/prisma';
import { decrypt } from '../utils/security';
import { adjustShopifyInventory } from './shopify.service';
import { notifyWarehouseMembers } from './notification.service';
import { logger } from '../utils/logger';

export async function onProductSold(productId: string): Promise<void> {
  const product = await prisma.product.findUnique({ where: { id: productId } }).catch(() => null);
  if (!product?.warehouseId || !product.shopifyInventoryItemId) return; // non collegato a Shopify

  const wh = await prisma.warehouse.findUnique({ where: { id: product.warehouseId } }).catch(() => null);
  if (!wh?.shopifyDomain || !wh.shopifyToken || !wh.shopifyLocationId) return; // store disconnesso

  try {
    const token = decrypt(wh.shopifyToken);
    await adjustShopifyInventory(wh.shopifyDomain, token, product.shopifyInventoryItemId, wh.shopifyLocationId, -1);
    logger.info('Shopify: giacenza scalata dopo vendita', { productId, shop: wh.shopifyDomain });
  } catch (err: any) {
    logger.warn('Shopify: sync giacenza fallita dopo vendita', { productId, err: err.message });
    // La vendita in RHQ resta valida: avvisiamo solo il team che Shopify potrebbe essere
    // disallineato, così lo corregge a mano prima che qualcuno lo ricompri sul sito.
    await notifyWarehouseMembers({
      warehouseId: product.warehouseId,
      type: 'SALE',
      title: '⚠️ Sync Shopify fallita',
      message: `${product.brand} ${product.name}: venduto qui ma la giacenza su Shopify NON è stata aggiornata. Correggila a mano.`,
    }).catch(() => {});
  }
}
