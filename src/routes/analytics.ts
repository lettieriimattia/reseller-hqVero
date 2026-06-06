// src/routes/analytics.ts
// Pilastro 5: Financial Analytics — solo OWNER.
// ROI, capitale immobilizzato, margine netto, sell-through per categoria,
// dead-stock alerts, tempo medio di vendita.

import { Router, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { authenticate, AuthRequest } from '../middleware/auth';
import { requireOwner } from '../middleware/rbac';
import { logger } from '../utils/logger';

const router = Router();
const prisma = new PrismaClient();

router.use(authenticate, requireOwner);

// ==========================================
// GET /analytics/dashboard
// Metriche aggregate per tutti i warehouse di cui l'utente è OWNER.
// ==========================================
router.get('/dashboard', async (req: AuthRequest, res: Response) => {
  try {
    const memberships = await prisma.membership.findMany({
      where: { userId: req.user!.userId, role: 'OWNER' },
    });
    const warehouseIds = memberships.map(m => m.warehouseId);
    if (warehouseIds.length === 0) return res.json(emptyDashboard());

    // Fetch unico — tutto in memoria, calcoliamo in JS (evita N+1 e raw SQL dialect issues)
    const products = await prisma.product.findMany({
      where: {
        warehouseId: { in: warehouseIds },
        deletedAt: null,
      },
      select: {
        id: true,
        category: true,
        status: true,
        purchasePrice: true,
        salePrice: true,
        fees: true,
        createdAt: true,
        soldAt: true,
      },
    });

    const sold     = products.filter(p => p.status === 'VENDUTO');
    const inStock  = products.filter(p => p.status === 'IN STOCK');
    const reserved = products.filter(p => p.status === 'RESERVED');

    // ---- Metriche globali ----
    const totalInvested  = sold.reduce((s, p) => s + p.purchasePrice, 0);
    const totalRevenue   = sold.reduce((s, p) => s + (p.salePrice ?? 0), 0);
    const totalFees      = sold.reduce((s, p) => s + (p.fees ?? 0), 0);
    const netProfit      = totalRevenue - totalInvested - totalFees;
    const roi            = totalInvested > 0 ? (netProfit / totalInvested) * 100 : 0;
    const capitalImmobilizzato =
      inStock.reduce((s, p)  => s + p.purchasePrice, 0) +
      reserved.reduce((s, p) => s + p.purchasePrice, 0);

    // Tempo medio di vendita (giorni)
    const daysArr = sold
      .filter(p => p.soldAt)
      .map(p => (p.soldAt!.getTime() - p.createdAt.getTime()) / 86_400_000);
    const avgDaysToSell = daysArr.length
      ? daysArr.reduce((s, d) => s + d, 0) / daysArr.length
      : 0;

    // Dead-stock: IN STOCK da più di 60 giorni
    const now = Date.now();
    const DEAD_STOCK_DAYS = 60;
    const deadStockItems = inStock.filter(
      p => now - p.createdAt.getTime() > DEAD_STOCK_DAYS * 86_400_000
    );

    // ---- Sell-through + metriche per categoria ----
    type CatStats = {
      total: number; sold: number; capital: number;
      profit: number; daysToSell: number[];
    };
    const catMap: Record<string, CatStats> = {};

    for (const p of products) {
      if (!catMap[p.category]) {
        catMap[p.category] = { total: 0, sold: 0, capital: 0, profit: 0, daysToSell: [] };
      }
      const c = catMap[p.category];
      c.total++;

      if (p.status === 'VENDUTO') {
        c.sold++;
        c.profit += (p.salePrice ?? 0) - p.purchasePrice - (p.fees ?? 0);
        if (p.soldAt) c.daysToSell.push((p.soldAt.getTime() - p.createdAt.getTime()) / 86_400_000);
      } else if (p.status === 'IN STOCK' || p.status === 'RESERVED') {
        c.capital += p.purchasePrice;
      }
    }

    const byCategory = Object.entries(catMap)
      .map(([category, s]) => ({
        category,
        total: s.total,
        sold: s.sold,
        inStock: s.total - s.sold,
        sellThroughRate: s.total > 0 ? Math.round((s.sold / s.total) * 10000) / 100 : 0,
        capitalImmobilizzato: round2(s.capital),
        netProfit: round2(s.profit),
        roi: s.capital + s.profit > 0
          ? round2((s.profit / (s.capital + Math.max(s.profit, 0))) * 100)
          : 0,
        avgDaysToSell: s.daysToSell.length
          ? Math.round(s.daysToSell.reduce((a, b) => a + b, 0) / s.daysToSell.length)
          : null,
        deadStock: inStock.filter(
          p => p.category === category && now - p.createdAt.getTime() > DEAD_STOCK_DAYS * 86_400_000
        ).length,
      }))
      .sort((a, b) => b.total - a.total);

    res.json({
      overview: {
        totalProducts: products.length,
        totalSold: sold.length,
        totalInStock: inStock.length,
        totalReserved: reserved.length,
        roi: round2(roi),
        netProfit: round2(netProfit),
        totalRevenue: round2(totalRevenue),
        totalInvested: round2(totalInvested),
        totalFees: round2(totalFees),
        capitalImmobilizzato: round2(capitalImmobilizzato),
        avgDaysToSell: Math.round(avgDaysToSell * 10) / 10,
        deadStockCount: deadStockItems.length,
        deadStockCapital: round2(deadStockItems.reduce((s, p) => s + p.purchasePrice, 0)),
      },
      byCategory,
    });
  } catch (err: any) {
    logger.error('GET /analytics/dashboard error', { err: err.message });
    res.status(500).json({ error: 'Errore dashboard analytics' });
  }
});

// ==========================================
// GET /analytics/inventory-log/:productId
// Storico mutazioni di un singolo prodotto (OWNER only).
// ==========================================
router.get('/inventory-log/:productId', async (req: AuthRequest, res: Response) => {
  try {
    const logs = await prisma.inventoryLog.findMany({
      where: { productId: req.params.productId },
      include: { user: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    res.json(logs);
  } catch (err: any) {
    res.status(500).json({ error: 'Errore storico prodotto' });
  }
});

// ==========================================
// GET /analytics/dead-stock
// Lista prodotti IN STOCK fermi da più di N giorni (default 60).
// ==========================================
router.get('/dead-stock', async (req: AuthRequest, res: Response) => {
  try {
    const memberships = await prisma.membership.findMany({
      where: { userId: req.user!.userId, role: 'OWNER' },
    });
    const warehouseIds = memberships.map(m => m.warehouseId);
    const days = Math.min(Number(req.query.days) || 60, 365);
    const threshold = new Date(Date.now() - days * 86_400_000);

    const products = await prisma.product.findMany({
      where: {
        warehouseId: { in: warehouseIds },
        status: 'IN STOCK',
        deletedAt: null,
        createdAt: { lt: threshold },
      },
      orderBy: { createdAt: 'asc' },
    });

    res.json({
      thresholdDays: days,
      count: products.length,
      capitalImmobilizzato: round2(products.reduce((s, p) => s + p.purchasePrice, 0)),
      products,
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Errore dead-stock' });
  }
});

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

function emptyDashboard() {
  return {
    overview: {
      totalProducts: 0, totalSold: 0, totalInStock: 0, totalReserved: 0,
      roi: 0, netProfit: 0, totalRevenue: 0, totalInvested: 0, totalFees: 0,
      capitalImmobilizzato: 0, avgDaysToSell: 0, deadStockCount: 0, deadStockCapital: 0,
    },
    byCategory: [],
  };
}

export default router;
