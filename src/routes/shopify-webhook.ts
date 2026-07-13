// src/routes/shopify-webhook.ts
// Riceve gli ordini creati su Shopify (sito o POS in negozio) e marca VENDUTO il pezzo
// corrispondente in ResellerHQ, così il magazzino resta allineato anche per le vendite che
// NON passano da qui. Direzione opposta a inventorySync.service.ts (RHQ→Shopify).
//
// Sicurezza: niente authenticate (lo chiama Shopify). Verifica la firma HMAC sul body RAW
// col Client secret salvato per lo store (individuato dall'header X-Shopify-Shop-Domain).
// DEVE essere montato con express.raw PRIMA di express.json() in server.ts (come /billing/webhook).

import { Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { decrypt } from '../utils/security';
import { verifyShopifyWebhookHmac, ShopifyOrderWebhookPayload } from '../services/shopify.service';
import { notifyWarehouseMembers } from '../services/notification.service';
import { logger } from '../utils/logger';

export async function shopifyOrderWebhookHandler(req: Request, res: Response) {
  const shopDomain = String(req.headers['x-shopify-shop-domain'] || '').trim().toLowerCase();
  const hmacHeader = req.headers['x-shopify-hmac-sha256'] as string | undefined;
  const rawBody = req.body as Buffer; // express.raw()
  if (!shopDomain || !Buffer.isBuffer(rawBody)) return res.status(400).send('bad request');

  const wh = await prisma.warehouse.findFirst({ where: { shopifyDomain: shopDomain } }).catch(() => null);
  if (!wh?.shopifyWebhookSecret) return res.status(404).send('shop not linked');

  let secret: string;
  try { secret = decrypt(wh.shopifyWebhookSecret); } catch { return res.status(500).send('error'); }
  if (!verifyShopifyWebhookHmac(rawBody, hmacHeader, secret)) {
    logger.warn('Shopify webhook: firma HMAC non valida', { shopDomain });
    return res.status(401).send('invalid signature');
  }

  let order: ShopifyOrderWebhookPayload;
  try { order = JSON.parse(rawBody.toString('utf8')); }
  catch { return res.status(400).send('bad json'); }

  // Idempotenza: Shopify può reinviare lo stesso webhook più volte.
  const dedupKey = `shopify_order_${shopDomain}_${order.id}`;
  const already = await prisma.setting.findUnique({ where: { key: dedupKey } }).catch(() => null);
  if (already) return res.json({ received: true, duplicate: true });
  await prisma.setting.upsert({ where: { key: dedupKey }, create: { key: dedupKey, value: '1' }, update: { value: '1' } }).catch(() => {});

  const customer = [order.customer?.first_name, order.customer?.last_name].filter(Boolean).join(' ').trim() || order.email || null;
  let matched = 0;

  try {
    for (const item of order.line_items || []) {
      if (!item.variant_id) continue;
      const qty = Math.max(1, Math.min(item.quantity || 1, 20));
      const unitPrice = (parseFloat(item.price || '0') || 0);
      for (let i = 0; i < qty; i++) {
        const product = await prisma.product.findFirst({
          where: { warehouseId: wh.id, shopifyVariantId: String(item.variant_id), status: 'IN STOCK', deletedAt: null },
          orderBy: { createdAt: 'asc' },
        });
        if (!product) break; // niente più pezzi disponibili per questa variante: nulla da segnare
        await prisma.product.update({
          where: { id: product.id },
          data: { status: 'VENDUTO', soldAt: new Date(), salePrice: unitPrice, platform: 'Shopify', customer },
        });
        matched++;
      }
    }
    if (matched > 0) {
      await notifyWarehouseMembers({
        warehouseId: wh.id,
        type: 'SALE',
        title: '🛍️ Venduto su Shopify',
        message: `${matched} pezzo/i venduti sul sito/negozio Shopify (ordine #${order.id}) — aggiornati automaticamente qui.`,
      }).catch(() => {});
    }
    logger.info('Shopify webhook ordine processato', { shopDomain, orderId: order.id, matched });
  } catch (err: any) {
    logger.error('Shopify webhook: errore elaborazione ordine', { shopDomain, orderId: order.id, err: err.message });
  }

  res.json({ received: true, matched });
}
