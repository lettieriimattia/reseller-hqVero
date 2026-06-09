// src/routes/products.ts
// Pilastro 1: Soft delete — mai DELETE fisico dal DB.
// Pilastro 2: Macchina a stati (IN STOCK → RESERVED → VENDUTO → SHIPPED).
//             Transazioni ACID sul sell per prevenire overselling concorrente.
// Pilastro 5: RBAC — MEMBER non vede purchasePrice / dati finanziari.

import { Router, Response } from 'express';
import { PrismaClient, Prisma } from '@prisma/client';
import { authenticate, AuthRequest, canAccessProduct } from '../middleware/auth';
import { resolveRole, stripFinancials } from '../middleware/rbac';
import { apiLimiter } from '../middleware/rateLimit';
import { validate, createProductSchema, editProductSchema, sellProductSchema } from '../middleware/validate';
import { audit } from '../services/audit.service';
import { logInventory } from '../services/inventory-log.service';
import { notifyWarehouseMembers } from '../services/notification.service';
import { logger } from '../utils/logger';

const router = Router();
const prisma = new PrismaClient();

// Timeout reservation (15 minuti)
const RESERVATION_TTL_MS = 15 * 60 * 1000;

router.use(authenticate, resolveRole, apiLimiter);

// ==========================================
// GET /products — lista prodotti accessibili
// MEMBER: campi finanziari rimossi dalla risposta.
// ==========================================
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const currentUser = await prisma.user.findUnique({
      where: { id: req.user!.userId },
      include: {
        memberships: { include: { warehouse: { include: { members: true } } } },
      },
    });

    if (!currentUser?.memberships?.length) return res.json([]);

    const isOwner = (req as any).isOwner as boolean;
    const warehouseIds = currentUser.memberships.map(m => m.warehouseId);

    // Recupera tutti i prodotti dei warehouse a cui appartiene l'utente (senza deletedAt)
    const products = await prisma.product.findMany({
      where: {
        warehouseId: { in: warehouseIds },
        deletedAt: null,
      },
      orderBy: { createdAt: 'desc' },
    });

    const sanitized = products.map(p => stripFinancials(p as any, isOwner));
    res.json(sanitized);
  } catch (err: any) {
    logger.error('Errore GET /products', { err: err.message });
    res.status(500).json({ error: 'Errore database' });
  }
});

// ==========================================
// POST /products/lot — crea lotto (N prodotti da prezzo totale)
// ACID transaction: tutti o nessuno.
// ==========================================
router.post('/lot', async (req: AuthRequest, res: Response) => {
  try {
    const { category, lotName, totalPrice, quantity, brand, size, condition, notes, attributes } = req.body;

    if (!category || !lotName || !totalPrice || !quantity || quantity < 2 || quantity > 200) {
      return res.status(400).json({ error: 'Dati lotto non validi.' });
    }

    const myMembership = await prisma.membership.findFirst({
      where: { userId: req.user!.userId, warehouseId: { not: undefined } },
      include: { warehouse: true },
    });

    // Trova il warehouse corretto per la categoria
    const memberships = await prisma.membership.findMany({
      where: { userId: req.user!.userId },
      include: { warehouse: true },
    });
    const targetMembership = memberships.find(m =>
      m.warehouse.name === `Magazzino ${category}` || m.warehouseId === category
    );
    if (!targetMembership) return res.status(403).json({ error: 'Non sei membro di questo reparto.' });

    const pricePerUnit = Math.round((totalPrice / quantity) * 100) / 100;
    const lotNote = `Lotto: "${lotName}" — ${quantity} pezzi × ${pricePerUnit.toFixed(2)}€`;

    const created = await prisma.$transaction(
      Array.from({ length: quantity }, (_, i) =>
        prisma.product.create({
          data: {
            category,
            brand: brand || lotName,
            name: `${lotName} #${i + 1}`,
            size: size || '-',
            condition: condition || 'N/D',
            purchasePrice: pricePerUnit,
            status: 'IN STOCK',
            userId: req.user!.userId,
            warehouseId: targetMembership.warehouseId,
            notes: notes ? `${lotNote} — ${notes}` : lotNote,
            attributes: attributes || Prisma.JsonNull,
          },
        })
      )
    );

    // Log inventario per ogni item del lotto
    await Promise.all(
      created.map(p =>
        logInventory({
          productId: p.id,
          userId: req.user!.userId,
          action: 'STATUS_CHANGE',
          field: 'status',
          newValue: 'IN STOCK',
          note: `Creato da lotto "${lotName}"`,
        })
      )
    );

    await audit({
      action: 'PRODUCT_CREATE', userId: req.user!.userId, req,
      resource: created[0].id,
      metadata: { lot: lotName, quantity, totalPrice, pricePerUnit },
    });

    await notifyWarehouseMembers({
      warehouseId: targetMembership.warehouseId,
      excludeUserId: req.user!.userId,
      type: 'PRODUCT_ADDED',
      title: `Lotto aggiunto: ${lotName}`,
      message: `${quantity} pezzi da ${pricePerUnit.toFixed(2)}€ cad. (tot. ${totalPrice}€)`,
    });

    res.json({ created: created.length, pricePerUnit, products: created });
  } catch (err: any) {
    logger.error('Errore POST /products/lot', { err: err.message });
    res.status(500).json({ error: 'Errore creazione lotto' });
  }
});

// ==========================================
// POST /products — crea prodotto singolo
// ==========================================
router.post('/', validate(createProductSchema), async (req: AuthRequest, res: Response) => {
  try {
    const {
      category, brand, name, size, condition, price, customShares, photos,
      marketPriceMin, marketPriceMax, marketPriceAvg, authenticityScore, notes,
      attributes,
    } = req.body;

    const memberships = await prisma.membership.findMany({
      where: { userId: req.user!.userId },
      include: { warehouse: true },
    });
    const targetMembership = memberships.find(m =>
      m.warehouse.name === `Magazzino ${category}`
    );
    if (!targetMembership) {
      await audit({
        action: 'UNAUTHORIZED_ACCESS', userId: req.user!.userId, req,
        metadata: { resource: 'product_create', category },
      });
      return res.status(403).json({ error: 'Non sei membro di questo reparto.' });
    }

    const parsedShares = customShares && Array.isArray(customShares) && customShares.length > 0
      ? JSON.stringify(customShares.map((s: any) => ({ ...s, percentage: Number(s.percentage) || 0 })))
      : null;

    const parsedPhotos = photos && Array.isArray(photos) && photos.length > 0
      ? JSON.stringify(photos)
      : null;

    const newProduct = await prisma.product.create({
      data: {
        category, brand, name, size, condition,
        purchasePrice: price,
        status: 'IN STOCK',
        userId: req.user!.userId,
        warehouseId: targetMembership.warehouseId,
        customShares: parsedShares,
        photos: parsedPhotos,
        marketPriceMin, marketPriceMax, marketPriceAvg, authenticityScore,
        notes: notes || null,
        attributes: attributes && typeof attributes === 'object' ? attributes : Prisma.JsonNull,
      },
    });

    await logInventory({
      productId: newProduct.id,
      userId: req.user!.userId,
      action: 'STATUS_CHANGE',
      field: 'status',
      newValue: 'IN STOCK',
    });

    await audit({
      action: 'PRODUCT_CREATE', userId: req.user!.userId, req,
      resource: newProduct.id,
      metadata: { brand, name, price },
    });

    await notifyWarehouseMembers({
      warehouseId: targetMembership.warehouseId,
      excludeUserId: req.user!.userId,
      type: 'PRODUCT_ADDED',
      title: 'Nuovo prodotto in magazzino',
      message: `${brand} ${name} (${size}) aggiunto al reparto ${category}`,
    });

    res.json(newProduct);
  } catch (err: any) {
    logger.error('Errore POST /products', { err: err.message });
    res.status(500).json({ error: 'Errore creazione prodotto' });
  }
});

// ==========================================
// POST /products/:id/reserve — riserva un prodotto (stato RESERVED)
// Pilastro 2: previene overselling concorrente.
// ==========================================
router.post('/:id/reserve', async (req: AuthRequest, res: Response) => {
  try {
    // ACID: select-for-update simulato con transaction + check stato
    const result = await prisma.$transaction(async tx => {
      const product = await tx.product.findFirst({
        where: { id: req.params.id, deletedAt: null },
      });
      if (!product) throw Object.assign(new Error('NOT_FOUND'), { status: 404 });
      if (product.status !== 'IN STOCK') {
        throw Object.assign(new Error('NOT_AVAILABLE'), { status: 409 });
      }
      return tx.product.update({
        where: { id: req.params.id },
        data: {
          status: 'RESERVED',
          reservedBy: req.user!.userId,
          reservedAt: new Date(),
        },
      });
    });

    await logInventory({
      productId: result.id,
      userId: req.user!.userId,
      action: 'RESERVE',
      field: 'status',
      oldValue: 'IN STOCK',
      newValue: 'RESERVED',
    });

    res.json({ success: true, reservedUntil: new Date(Date.now() + RESERVATION_TTL_MS) });
  } catch (err: any) {
    if (err.message === 'NOT_FOUND') return res.status(404).json({ error: 'Prodotto non trovato.' });
    if (err.message === 'NOT_AVAILABLE') return res.status(409).json({ error: 'Prodotto non disponibile (già riservato o venduto).' });
    logger.error('Errore POST /products/:id/reserve', { err: err.message });
    res.status(500).json({ error: 'Errore prenotazione' });
  }
});

// ==========================================
// DELETE /products/:id/reserve — rilascia la reservation
// ==========================================
router.delete('/:id/reserve', async (req: AuthRequest, res: Response) => {
  try {
    const product = await prisma.product.findFirst({
      where: { id: req.params.id, deletedAt: null },
    });
    if (!product) return res.status(404).json({ error: 'Prodotto non trovato.' });
    if (product.status !== 'RESERVED') return res.status(400).json({ error: 'Il prodotto non è riservato.' });

    // Solo chi ha riservato o un OWNER può rilasciare
    const isOwner = (req as any).isOwner as boolean;
    if (!isOwner && product.reservedBy !== req.user!.userId) {
      return res.status(403).json({ error: 'Non puoi rilasciare la reservation altrui.' });
    }

    await prisma.product.update({
      where: { id: req.params.id },
      data: { status: 'IN STOCK', reservedBy: null, reservedAt: null },
    });

    await logInventory({
      productId: req.params.id,
      userId: req.user!.userId,
      action: 'RELEASE',
      field: 'status',
      oldValue: 'RESERVED',
      newValue: 'IN STOCK',
    });

    res.json({ success: true });
  } catch (err: any) {
    logger.error('Errore DELETE /products/:id/reserve', { err: err.message });
    res.status(500).json({ error: 'Errore rilascio reservation' });
  }
});

// ==========================================
// PUT /products/:id — registra vendita
// Pilastro 2: ACID — previene race condition su prodotti RESERVED da altri.
// ==========================================
router.put('/:id', validate(sellProductSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { allowed, product } = await canAccessProduct(req.user!.userId, req.params.id);
    if (!allowed || !product) {
      await audit({
        action: 'UNAUTHORIZED_ACCESS', userId: req.user!.userId, req,
        resource: req.params.id, metadata: { type: 'product_sell' },
      });
      return res.status(403).json({ error: 'Non hai accesso a questo prodotto.' });
    }

    if (product.deletedAt) return res.status(404).json({ error: 'Prodotto non trovato.' });
    if (product.status === 'VENDUTO') return res.status(400).json({ error: 'Prodotto già venduto.' });

    // Se RESERVED da qualcun altro, blocca (OWNER può forzare)
    const isOwner = (req as any).isOwner as boolean;
    if (
      product.status === 'RESERVED' &&
      product.reservedBy !== req.user!.userId &&
      !isOwner
    ) {
      return res.status(409).json({ error: 'Prodotto riservato da un altro utente.' });
    }

    const { salePrice, platform, fees } = req.body;

    // ACID transaction
    const updated = await prisma.$transaction(async tx => {
      const current = await tx.product.findUnique({ where: { id: req.params.id } });
      if (!current || current.status === 'VENDUTO') {
        throw Object.assign(new Error('ALREADY_SOLD'), { status: 409 });
      }
      return tx.product.update({
        where: { id: req.params.id },
        data: {
          salePrice, platform, fees,
          status: 'VENDUTO', soldAt: new Date(),
          reservedBy: null, reservedAt: null,
        },
      });
    });

    await logInventory({
      productId: updated.id,
      userId: req.user!.userId,
      action: 'STATUS_CHANGE',
      field: 'status',
      oldValue: product.status,
      newValue: 'VENDUTO',
      note: `Venduto ${salePrice}€ su ${platform}`,
    });

    await audit({
      action: 'PRODUCT_SELL', userId: req.user!.userId, req,
      resource: updated.id,
      metadata: { salePrice, platform, profit: salePrice - product.purchasePrice - (fees || 0) },
    });

    if (updated.warehouseId) {
      await notifyWarehouseMembers({
        warehouseId: updated.warehouseId,
        excludeUserId: req.user!.userId,
        type: 'SALE',
        title: '💰 Vendita registrata',
        message: `${product.brand} ${product.name} venduto a ${salePrice}€ su ${platform}`,
      });
    }

    res.json(updated);
  } catch (err: any) {
    if (err.message === 'ALREADY_SOLD') return res.status(409).json({ error: 'Prodotto già venduto da un altro utente.' });
    logger.error('Errore PUT /products/:id', { err: err.message });
    res.status(500).json({ error: 'Errore vendita' });
  }
});

// ==========================================
// PUT /products/:id/edit — modifica prodotto
// ==========================================
router.put('/:id/edit', validate(editProductSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { allowed, product } = await canAccessProduct(req.user!.userId, req.params.id);
    if (!allowed || !product) {
      await audit({
        action: 'UNAUTHORIZED_ACCESS', userId: req.user!.userId, req,
        resource: req.params.id, metadata: { type: 'product_edit' },
      });
      return res.status(403).json({ error: 'Non hai accesso a questo prodotto.' });
    }
    if (product.deletedAt) return res.status(404).json({ error: 'Prodotto non trovato.' });

    const { category, brand, name, size, condition, purchasePrice, customShares, photos, notes, attributes } = req.body;

    // Log variazione prezzo d'acquisto (dato sensibile)
    if (purchasePrice !== undefined && purchasePrice !== product.purchasePrice) {
      await logInventory({
        productId: product.id,
        userId: req.user!.userId,
        action: 'PRICE_CHANGE',
        field: 'purchasePrice',
        oldValue: product.purchasePrice,
        newValue: purchasePrice,
      });
    }

    // Log variazione attributi dinamici
    if (attributes !== undefined) {
      await logInventory({
        productId: product.id,
        userId: req.user!.userId,
        action: 'ATTR_CHANGE',
        field: 'attributes',
        note: 'Aggiornamento campi dinamici',
      });
    }

    const parsedShares = customShares && Array.isArray(customShares) && customShares.length > 0
      ? JSON.stringify(customShares.map((s: any) => ({ ...s, percentage: Number(s.percentage) || 0 })))
      : null;

    const parsedPhotos = photos && Array.isArray(photos) && photos.length > 0
      ? JSON.stringify(photos)
      : null;

    const p = await prisma.product.update({
      where: { id: req.params.id },
      data: {
        category, brand, name, size, condition, purchasePrice,
        customShares: parsedShares,
        photos: parsedPhotos,
        notes: notes !== undefined ? (notes || null) : undefined,
        attributes: attributes !== undefined
          ? (attributes && typeof attributes === 'object' ? attributes : Prisma.JsonNull)
          : undefined,
      },
    });

    await audit({
      action: 'PRODUCT_EDIT', userId: req.user!.userId, req,
      resource: p.id, metadata: { changes: { brand, name, purchasePrice } },
    });

    res.json(p);
  } catch (err: any) {
    logger.error('Errore PUT /products/:id/edit', { err: err.message });
    res.status(500).json({ error: 'Errore modifica' });
  }
});

// ==========================================
// PATCH /products/:id/notes — aggiorna solo le note
// ==========================================
router.patch('/:id/notes', async (req: AuthRequest, res: Response) => {
  try {
    const { allowed, product } = await canAccessProduct(req.user!.userId, req.params.id);
    if (!allowed) return res.status(403).json({ error: 'Non hai accesso a questo prodotto.' });
    if (product?.deletedAt) return res.status(404).json({ error: 'Prodotto non trovato.' });

    const { notes } = req.body;
    const p = await prisma.product.update({
      where: { id: req.params.id },
      data: { notes: notes || null },
    });
    res.json({ notes: p.notes });
  } catch (err: any) {
    logger.error('Errore PATCH /products/:id/notes', { err: err.message });
    res.status(500).json({ error: 'Errore salvataggio note' });
  }
});

// ==========================================
// DELETE /products/:id — SOFT DELETE (mai DELETE fisico)
// Pilastro 1: i dati non vengono mai cancellati davvero.
// ==========================================
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { allowed, product } = await canAccessProduct(req.user!.userId, req.params.id);
    if (!allowed || !product) return res.status(403).json({ error: 'Non hai accesso a questo prodotto.' });
    if (product.deletedAt) return res.status(404).json({ error: 'Prodotto già eliminato.' });

    await prisma.product.update({
      where: { id: req.params.id },
      data: { deletedAt: new Date() },
    });

    await logInventory({
      productId: req.params.id,
      userId: req.user!.userId,
      action: 'SOFT_DELETE',
      field: 'deletedAt',
      note: `${product.brand} ${product.name}`,
    });

    await audit({
      action: 'PRODUCT_DELETE', userId: req.user!.userId, req,
      resource: req.params.id,
      metadata: { brand: product.brand, name: product.name, softDelete: true },
    });

    res.json({ success: true });
  } catch (err: any) {
    logger.error('Errore DELETE /products/:id', { err: err.message });
    res.status(500).json({ error: 'Errore eliminazione' });
  }
});

export default router;
