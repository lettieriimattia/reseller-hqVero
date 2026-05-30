// src/routes/products.ts
// Gestione prodotti con autorizzazione warehouse.

import { Router, Response } from 'express';
import { PrismaClient } from '@prisma/client';

import { authenticate, AuthRequest, canAccessProduct } from '../middleware/auth';
import { apiLimiter } from '../middleware/rateLimit';
import { validate, createProductSchema, editProductSchema, sellProductSchema } from '../middleware/validate';
import { audit } from '../services/audit.service';
import { notifyWarehouseMembers } from '../services/notification.service';
import { logger } from '../utils/logger';

const router = Router();
const prisma = new PrismaClient();

router.use(authenticate);
router.use(apiLimiter);

// ==========================================
// GET /products - lista prodotti accessibili
// ==========================================
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const currentUser = await prisma.user.findUnique({
      where: { id: req.user!.userId },
      include: { 
        memberships: { include: { warehouse: { include: { members: true } } } }
      },
    });
    
    if (!currentUser?.memberships?.length) return res.json([]);
    
    const teamProducts: any[] = [];
    for (const m of currentUser.memberships) {
      const categoryName = m.warehouse.name.replace('Magazzino ', '');
      const memberIds = m.warehouse.members.map(wm => wm.userId);
      
      const products = await prisma.product.findMany({
        where: {
          category: categoryName,
          userId: { in: memberIds },
        },
      });
      teamProducts.push(...products);
    }
    
    // Dedup
    const uniqueMap = new Map();
    for (const p of teamProducts) uniqueMap.set(p.id, p);
    const unique = Array.from(uniqueMap.values()).sort((a, b) => 
      (a.createdAt > b.createdAt ? -1 : 1)
    );
    
    res.json(unique);
  } catch (err: any) {
    logger.error('Errore GET /products', { err: err.message });
    res.status(500).json({ error: 'Errore database' });
  }
});

// ==========================================
// POST /products - crea prodotto
// ==========================================
router.post('/', validate(createProductSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { category, brand, name, size, condition, price, customShares, photos,
      marketPriceMin, marketPriceMax, marketPriceAvg, authenticityScore, notes } = req.body;

    // Trova il warehouse corretto per la categoria di cui l'utente è membro
    const myMembership = await prisma.membership.findFirst({
      where: {
        userId: req.user!.userId,
        warehouse: { name: `Magazzino ${category}` },
      },
      include: { warehouse: true },
    });

    if (!myMembership) {
      await audit({ action: 'UNAUTHORIZED_ACCESS', userId: req.user!.userId, req,
        metadata: { resource: 'product_create', category } });
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
        warehouseId: myMembership.warehouseId,
        customShares: parsedShares,
        photos: parsedPhotos,
        marketPriceMin, marketPriceMax, marketPriceAvg, authenticityScore,
        notes: notes || null,
      },
    });
    
    await audit({ 
      action: 'PRODUCT_CREATE', userId: req.user!.userId, req,
      resource: newProduct.id,
      metadata: { brand, name, price }
    });
    
    // Notifica al team
    await notifyWarehouseMembers({
      warehouseId: myMembership.warehouseId,
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
// PUT /products/:id - registra vendita
// ==========================================
router.put('/:id', validate(sellProductSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { allowed, product } = await canAccessProduct(req.user!.userId, req.params.id);
    if (!allowed) {
      await audit({ action: 'UNAUTHORIZED_ACCESS', userId: req.user!.userId, req,
        resource: req.params.id, metadata: { type: 'product_sell' } });
      return res.status(403).json({ error: 'Non hai accesso a questo prodotto.' });
    }
    
    if (product.status === 'VENDUTO') {
      return res.status(400).json({ error: 'Prodotto già venduto.' });
    }
    
    const { salePrice, platform, fees } = req.body;
    const updated = await prisma.product.update({
      where: { id: req.params.id },
      data: {
        salePrice, platform, fees,
        status: 'VENDUTO', soldAt: new Date(),
      },
    });
    
    await audit({ 
      action: 'PRODUCT_SELL', userId: req.user!.userId, req,
      resource: updated.id,
      metadata: { salePrice, platform, profit: salePrice - product.purchasePrice - fees }
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
    logger.error('Errore PUT /products/:id', { err: err.message });
    res.status(500).json({ error: 'Errore vendita' });
  }
});

// ==========================================
// PUT /products/:id/edit - modifica
// ==========================================
router.put('/:id/edit', validate(editProductSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { allowed, product } = await canAccessProduct(req.user!.userId, req.params.id);
    if (!allowed) {
      await audit({ action: 'UNAUTHORIZED_ACCESS', userId: req.user!.userId, req,
        resource: req.params.id, metadata: { type: 'product_edit' } });
      return res.status(403).json({ error: 'Non hai accesso a questo prodotto.' });
    }
    
    const { category, brand, name, size, condition, purchasePrice, customShares, photos, notes } = req.body;

    const parsedShares = customShares && Array.isArray(customShares) && customShares.length > 0
      ? JSON.stringify(customShares.map((s: any) => ({ ...s, percentage: Number(s.percentage) || 0 })))
      : null;

    const parsedPhotos = photos && Array.isArray(photos) && photos.length > 0
      ? JSON.stringify(photos)
      : null;

    const p = await prisma.product.update({
      where: { id: req.params.id },
      data: { category, brand, name, size, condition, purchasePrice, customShares: parsedShares, photos: parsedPhotos, notes: notes !== undefined ? (notes || null) : undefined },
    });
    
    await audit({
      action: 'PRODUCT_EDIT', userId: req.user!.userId, req,
      resource: p.id, metadata: { changes: { brand, name, purchasePrice } }
    });
    
    res.json(p);
  } catch (err: any) {
    logger.error('Errore PUT /products/:id/edit', { err: err.message });
    res.status(500).json({ error: 'Errore modifica' });
  }
});

// ==========================================
// PATCH /products/:id/notes - aggiorna solo le note
// ==========================================
router.patch('/:id/notes', async (req: AuthRequest, res: Response) => {
  try {
    const { allowed } = await canAccessProduct(req.user!.userId, req.params.id);
    if (!allowed) return res.status(403).json({ error: 'Non hai accesso a questo prodotto.' });
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
// DELETE /products/:id
// ==========================================
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { allowed, product } = await canAccessProduct(req.user!.userId, req.params.id);
    if (!allowed) return res.status(403).json({ error: 'Non hai accesso a questo prodotto.' });
    
    await prisma.product.delete({ where: { id: req.params.id } });
    await audit({ 
      action: 'PRODUCT_DELETE', userId: req.user!.userId, req,
      resource: req.params.id, metadata: { brand: product.brand, name: product.name }
    });
    
    res.json({ success: true });
  } catch (err: any) {
    logger.error('Errore DELETE /products/:id', { err: err.message });
    res.status(500).json({ error: 'Errore eliminazione' });
  }
});

export default router;
