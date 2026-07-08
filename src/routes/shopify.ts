// src/routes/shopify.ts
// Integrazione Shopify — Fase 1 (SOLA LETTURA): collega lo store e importa il catalogo.
// Solo l'OWNER del magazzino può collegare/importare. Token cifrato a riposo.

import { Router, Response } from 'express';
import { prisma } from '../lib/prisma';
import { authenticate, AuthRequest } from '../middleware/auth';
import { requireFeature } from '../middleware/plan';
import { encrypt, decrypt } from '../utils/security';
import { audit } from '../services/audit.service';
import { logger } from '../utils/logger';
import { verifyShopify, fetchAllShopifyProducts, normalizeShopDomain } from '../services/shopify.service';

const router = Router();
router.use(authenticate);

const MAX_UNITS_PER_VARIANT = 10; // per non esplodere su varianti con giacenze anomale
const MAX_TOTAL = 3000;           // tetto di sicurezza per un import

// Verifica che l'utente sia OWNER del magazzino indicato.
async function requireOwner(userId: string, warehouseId: string) {
  const m = await prisma.membership.findFirst({ where: { userId, warehouseId } });
  if (!m) throw Object.assign(new Error('Non sei membro di questo magazzino.'), { status: 403 });
  if (m.role !== 'OWNER') throw Object.assign(new Error('Solo il titolare del magazzino può collegare Shopify.'), { status: 403 });
  return m;
}

// GET /api/shopify/status?warehouseId=... → stato connessione (senza esporre il token).
router.get('/status', async (req: AuthRequest, res: Response) => {
  try {
    const warehouseId = String(req.query.warehouseId || '');
    if (!warehouseId) return res.status(400).json({ error: 'warehouseId mancante.' });
    await requireOwner(req.user!.userId, warehouseId);
    const wh = await prisma.warehouse.findUnique({ where: { id: warehouseId } });
    res.json({
      connected: !!wh?.shopifyToken,
      domain: wh?.shopifyDomain || null,
      shopName: wh?.shopifyShopName || null,
      lastSync: wh?.shopifyLastSync || null,
    });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || 'Errore' });
  }
});

// POST /api/shopify/connect { warehouseId, domain, token } → valida e salva (token cifrato).
router.post('/connect', requireFeature('shopify'), async (req: AuthRequest, res: Response) => {
  try {
    const { warehouseId, domain, token } = req.body || {};
    if (!warehouseId || !domain || !token) return res.status(400).json({ error: 'Dominio e token sono richiesti.' });
    await requireOwner(req.user!.userId, warehouseId);
    const info = await verifyShopify(String(domain), String(token)); // lancia se non valido
    await prisma.warehouse.update({
      where: { id: warehouseId },
      data: {
        shopifyDomain: info.domain,
        shopifyToken: encrypt(String(token)),
        shopifyShopName: info.name,
      },
    });
    await audit({ action: 'PROFILE_UPDATE', userId: req.user!.userId, req, resource: warehouseId, metadata: { shopify: 'connect', shop: info.name } });
    res.json({ connected: true, shopName: info.name, domain: info.domain });
  } catch (err: any) {
    logger.error('Shopify connect', { err: err.message });
    res.status(err.status || 500).json({ error: err.message || 'Errore connessione Shopify' });
  }
});

// POST /api/shopify/disconnect { warehouseId }
router.post('/disconnect', async (req: AuthRequest, res: Response) => {
  try {
    const { warehouseId } = req.body || {};
    if (!warehouseId) return res.status(400).json({ error: 'warehouseId mancante.' });
    await requireOwner(req.user!.userId, warehouseId);
    await prisma.warehouse.update({
      where: { id: warehouseId },
      data: { shopifyDomain: null, shopifyToken: null, shopifyShopName: null, shopifyLastSync: null },
    });
    res.json({ connected: false });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || 'Errore' });
  }
});

// Sceglie il valore della TAGLIA dalle opzioni della variante (option name ~ size/taglia).
function pickSize(product: any, variant: any): string {
  const opts: any[] = product.options || [];
  const sizeIdx = opts.findIndex((o: any) => /size|taglia|misura/i.test(o?.name || ''));
  if (sizeIdx >= 0) {
    const v = variant[`option${opts[sizeIdx].position}`];
    if (v && String(v).trim()) return String(v).trim();
  }
  const t = (variant.title || '').trim();
  return t && t.toLowerCase() !== 'default title' ? t : '—';
}

// POST /api/shopify/import { warehouseId } → importa i prodotti attivi come pezzi in stock.
router.post('/import', requireFeature('shopify'), async (req: AuthRequest, res: Response) => {
  try {
    const { warehouseId } = req.body || {};
    if (!warehouseId) return res.status(400).json({ error: 'warehouseId mancante.' });
    await requireOwner(req.user!.userId, warehouseId);
    const wh = await prisma.warehouse.findUnique({ where: { id: warehouseId } });
    if (!wh?.shopifyToken || !wh.shopifyDomain) return res.status(400).json({ error: 'Shopify non collegato per questo magazzino.' });

    const token = decrypt(wh.shopifyToken);
    const products = await fetchAllShopifyProducts(wh.shopifyDomain, token, MAX_TOTAL);

    // Dedup leggera: evita di re-importare (sku|size) già presenti in questo magazzino.
    const existing = await prisma.product.findMany({
      where: { warehouseId, deletedAt: null },
      select: { sku: true, size: true },
    });
    const seen = new Set(existing.map(e => `${(e.sku || '').toLowerCase()}|${e.size}`));

    const toCreate: any[] = [];
    let skippedDup = 0;
    outer:
    for (const p of products) {
      const brand = (p.vendor || '').trim() || (p.title || '').trim().split(/\s+/)[0] || 'Brand';
      const name = (p.title || '').trim() || 'Articolo';
      const category = (p.product_type || '').trim() || 'Streetwear';
      const photo = p.image?.src || p.images?.[0]?.src || null;
      for (const v of p.variants || []) {
        const size = pickSize(p, v);
        const sku = (v.sku || '').trim() || null;
        const key = `${(sku || '').toLowerCase()}|${size}`;
        if (sku && seen.has(key)) { skippedDup++; continue; }
        const retail = parseFloat(String(v.price || '0').replace(',', '.')) || 0;
        const qty = Math.max(0, Math.min(v.inventory_quantity || 0, MAX_UNITS_PER_VARIANT));
        for (let i = 0; i < qty; i++) {
          if (toCreate.length >= MAX_TOTAL) break outer;
          toCreate.push({
            category, brand, name, size,
            condition: 'DS',
            // Shopify espone il prezzo di VENDITA (non il costo): lo mettiamo come publicPrice
            // e come purchasePrice provvisorio (il negozio potrà correggere il costo).
            purchasePrice: retail,
            publicPrice: retail || null,
            sku,
            photos: photo ? JSON.stringify([photo]) : null,
            status: 'IN STOCK',
            notes: 'Importato da Shopify',
            userId: req.user!.userId,
            warehouseId,
          });
        }
        if (sku) seen.add(key);
      }
    }

    if (toCreate.length > 0) {
      await prisma.product.createMany({ data: toCreate });
    }
    await prisma.warehouse.update({ where: { id: warehouseId }, data: { shopifyLastSync: new Date() } });
    await audit({ action: 'PRODUCT_CREATE', userId: req.user!.userId, req, resource: warehouseId, metadata: { shopifyImport: toCreate.length } });

    res.json({ imported: toCreate.length, productsScanned: products.length, skippedDuplicates: skippedDup, capped: toCreate.length >= MAX_TOTAL });
  } catch (err: any) {
    logger.error('Shopify import', { err: err.message });
    res.status(err.status || 500).json({ error: err.message || 'Errore import Shopify' });
  }
});

export default router;
