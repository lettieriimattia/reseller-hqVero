// src/routes/admin.ts
// Pannello admin — solo per l'utente con ADMIN_EMAIL

import { Router, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { authenticate, AuthRequest } from '../middleware/auth';
import { logger } from '../utils/logger';

const router = Router();
const prisma = new PrismaClient();

// Middleware: solo admin
function requireAdmin(req: AuthRequest, res: Response, next: any) {
  const adminEmail = process.env.ADMIN_EMAIL || '';
  if (!adminEmail) return res.status(403).json({ error: 'Admin non configurato.' });
  if (req.user?.email?.toLowerCase() !== adminEmail.toLowerCase()) {
    return res.status(403).json({ error: 'Accesso riservato.' });
  }
  next();
}

router.use(authenticate);
router.use(requireAdmin);

// GET /admin/users — lista completa utenti con statistiche
router.get('/users', async (req: AuthRequest, res: Response) => {
  try {
    const users = await prisma.user.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        memberships: { include: { warehouse: true } },
        products: { select: { id: true, status: true, purchasePrice: true, salePrice: true, fees: true } },
        _count: { select: { products: true } },
      },
    });

    const result = users.map(u => {
      const sold = u.products.filter(p => p.status === 'VENDUTO');
      const inStock = u.products.filter(p => p.status === 'IN STOCK');
      const profit = sold.reduce((acc, p) => acc + ((p.salePrice || 0) - p.purchasePrice - (p.fees || 0)), 0);
      const stockValue = inStock.reduce((acc, p) => acc + p.purchasePrice, 0);
      return {
        id: u.id,
        name: u.name,
        email: u.email,
        createdAt: u.createdAt,
        lastLoginAt: u.lastLoginAt,
        twoFactorEnabled: u.twoFactorEnabled,
        warehouses: u.memberships.map(m => ({
          name: m.warehouse.name.replace('Magazzino ', ''),
          role: m.role,
          percentage: m.percentage,
        })),
        stats: {
          totalProducts: u._count.products,
          inStock: inStock.length,
          sold: sold.length,
          profit: Math.round(profit * 100) / 100,
          stockValue: Math.round(stockValue * 100) / 100,
        },
      };
    });

    res.json({ users: result, total: result.length });
  } catch (err: any) {
    logger.error('Errore GET /admin/users', { err: err.message });
    res.status(500).json({ error: 'Errore database' });
  }
});

// DELETE /admin/users/:id — elimina utente (con tutti i suoi dati)
router.delete('/users/:id', async (req: AuthRequest, res: Response) => {
  try {
    if (req.params.id === req.user!.userId) {
      return res.status(400).json({ error: 'Non puoi eliminare te stesso.' });
    }
    await prisma.user.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err: any) {
    logger.error('Errore DELETE /admin/users/:id', { err: err.message });
    res.status(500).json({ error: 'Errore eliminazione' });
  }
});

export default router;
