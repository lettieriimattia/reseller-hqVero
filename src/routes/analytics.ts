// src/routes/analytics.ts
// Pilastro 5: Financial Analytics — solo OWNER.
// ROI, capitale immobilizzato, margine netto, sell-through per categoria,
// dead-stock alerts, tempo medio di vendita.

import { Router, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { prisma } from "../lib/prisma";
import { authenticate, AuthRequest } from '../middleware/auth';
import { requireOwner } from '../middleware/rbac';
import { requireFeature } from '../middleware/plan';
import { logger } from '../utils/logger';

const router = Router();

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
    // Costi extra (sacchetti, spedizioni, materiali…): entrano nell'utile netto.
    const expenses       = await prisma.expense.findMany({ where: { warehouseId: { in: warehouseIds } }, select: { amount: true } });
    const totalExpenses  = expenses.reduce((s, e) => s + (e.amount || 0), 0);
    const netProfit      = totalRevenue - totalInvested - totalFees - totalExpenses;
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
        totalExpenses: round2(totalExpenses),
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

// Helper: gli warehouseId di cui l'utente è OWNER
async function ownerWarehouseIds(userId: string): Promise<string[]> {
  const ms = await prisma.membership.findMany({ where: { userId, role: 'OWNER' }, select: { warehouseId: true } });
  return ms.map(m => m.warehouseId);
}

// Magazzini di cui l'utente fa parte (anche come socio): per i costi extra di una partnership
// anche un socio può inserire spese sul magazzino condiviso.
async function memberWarehouseIds(userId: string): Promise<string[]> {
  const ms = await prisma.membership.findMany({ where: { userId }, select: { warehouseId: true } });
  return ms.map(m => m.warehouseId);
}

// ==========================================
// COSTI EXTRA (Expense) — sacchetti, spedizioni, materiali, ecc. (OWNER only)
// ==========================================
router.get('/expenses', requireFeature('accounting'), async (req: AuthRequest, res: Response) => {
  try {
    const ids = await memberWarehouseIds(req.user!.userId);
    const where: any = { warehouseId: { in: ids } };
    if (req.query.warehouseId && ids.includes(String(req.query.warehouseId))) where.warehouseId = String(req.query.warehouseId);
    const expenses = await prisma.expense.findMany({ where, orderBy: { date: 'desc' } });
    res.json(expenses);
  } catch (err: any) {
    logger.error('GET /analytics/expenses', { err: err.message });
    res.status(500).json({ error: 'Errore costi extra' });
  }
});

router.post('/expenses', requireFeature('accounting'), async (req: AuthRequest, res: Response) => {
  try {
    const { warehouseId, amount, description, category, date } = req.body || {};
    const amt = Number(amount);
    if (!warehouseId || !description?.trim() || isNaN(amt) || amt <= 0) {
      return res.status(400).json({ error: 'warehouseId, importo (>0) e descrizione obbligatori' });
    }
    const ids = await memberWarehouseIds(req.user!.userId);
    if (!ids.includes(warehouseId)) return res.status(403).json({ error: 'Magazzino non valido' });
    const expense = await prisma.expense.create({
      data: {
        warehouseId, userId: req.user!.userId,
        amount: Math.round(amt * 100) / 100,
        description: description.trim().slice(0, 200),
        category: (category || 'Altro').toString().slice(0, 50),
        date: date ? new Date(date) : new Date(),
      },
    });
    res.json(expense);
  } catch (err: any) {
    logger.error('POST /analytics/expenses', { err: err.message });
    res.status(500).json({ error: 'Errore creazione costo' });
  }
});

router.delete('/expenses/:id', requireFeature('accounting'), async (req: AuthRequest, res: Response) => {
  try {
    const exp = await prisma.expense.findUnique({ where: { id: req.params.id } });
    if (!exp) return res.status(404).json({ error: 'Non trovato' });
    const ids = await memberWarehouseIds(req.user!.userId);
    if (!ids.includes(exp.warehouseId)) return res.status(403).json({ error: 'Non autorizzato' });
    await prisma.expense.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: 'Errore eliminazione' });
  }
});

// ==========================================
// EXPORT CSV per il commercialista — vendite + costi extra (OWNER only)
// GET /analytics/export.csv?warehouseId=...  (warehouseId opzionale)
// ==========================================
router.get('/export.csv', requireFeature('accounting'), async (req: AuthRequest, res: Response) => {
  try {
    const ids = await ownerWarehouseIds(req.user!.userId);
    let scope = ids;
    if (req.query.warehouseId && ids.includes(String(req.query.warehouseId))) scope = [String(req.query.warehouseId)];
    if (scope.length === 0) return res.status(400).send('Nessun magazzino');

    const [sold, expenses] = await Promise.all([
      prisma.product.findMany({
        where: { warehouseId: { in: scope }, status: 'VENDUTO', deletedAt: null },
        select: { brand: true, name: true, category: true, purchasePrice: true, salePrice: true, fees: true, platform: true, soldAt: true, createdAt: true },
        orderBy: { soldAt: 'desc' },
      }),
      prisma.expense.findMany({ where: { warehouseId: { in: scope } }, orderBy: { date: 'desc' } }),
    ]);

    const esc = (v: any) => {
      let s = (v ?? '').toString();
      // ANTI CSV-INJECTION: se la cella inizia con = + - @ (o tab/CR), la neutralizziamo con un
      // apice iniziale, così Excel/Sheets non la interpreta come formula/comando.
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
      s = s.replace(/"/g, '""');
      return `"${s}"`;
    };
    const d = (x?: Date | null) => (x ? new Date(x).toISOString().slice(0, 10) : '');
    const n = (x: any) => (Math.round((Number(x) || 0) * 100) / 100).toFixed(2);

    const rows: string[] = [];
    rows.push(['Data', 'Tipo', 'Categoria', 'Articolo/Descrizione', 'Piattaforma', 'Ricavo', 'Costo acquisto', 'Fee', 'Costo extra', 'Utile'].join(','));

    for (const p of sold) {
      const utile = (p.salePrice || 0) - p.purchasePrice - (p.fees || 0);
      rows.push([
        esc(d(p.soldAt || p.createdAt)), esc('Vendita'), esc(p.category), esc(`${p.brand} ${p.name}`), esc(p.platform || ''),
        n(p.salePrice), n(p.purchasePrice), n(p.fees), n(0), n(utile),
      ].join(','));
    }
    for (const e of expenses) {
      rows.push([
        esc(d(e.date)), esc('Costo extra'), esc(e.category || ''), esc(e.description), esc(''),
        n(0), n(0), n(0), n(e.amount), n(-e.amount),
      ].join(','));
    }

    const csv = '﻿' + rows.join('\r\n'); // BOM per Excel
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="resellerhq-commercialista-${d(new Date())}.csv"`);
    res.send(csv);
  } catch (err: any) {
    logger.error('GET /analytics/export.csv', { err: err.message });
    res.status(500).send('Errore export');
  }
});

export default router;
