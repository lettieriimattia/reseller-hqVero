// src/middleware/rbac.ts
// Pilastro 5: RBAC granulare.
// OWNER: accesso completo inclusi dati finanziari.
// MEMBER: può vedere e aggiungere prodotti, ma NON vede purchasePrice / ROI.

import { Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { prisma } from "../lib/prisma";
import { AuthRequest } from './auth';


// Middleware: blocca l'accesso se l'utente non è OWNER in nessun warehouse
export async function requireOwner(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const owner = await prisma.membership.findFirst({
      where: { userId: req.user!.userId, role: 'OWNER' },
    });
    if (!owner) return res.status(403).json({ error: 'Accesso riservato agli Owner.' });
    next();
  } catch {
    res.status(500).json({ error: 'Errore autorizzazione' });
  }
}

// Middleware: inietta req.isOwner per il filtraggio dati a valle
export async function resolveRole(req: AuthRequest, _res: Response, next: NextFunction) {
  try {
    const owner = await prisma.membership.findFirst({
      where: { userId: req.user!.userId, role: 'OWNER' },
    });
    (req as any).isOwner = !!owner;
    next();
  } catch {
    (req as any).isOwner = false;
    next();
  }
}

// Helper puro: rimuove i campi finanziari prima di restituire un prodotto ai MEMBER.
// Chiamato esplicitamente nelle route, non come middleware, per mantenere il controllo.
export function stripFinancials<T extends Record<string, any>>(product: T, isOwner: boolean): T {
  if (isOwner) return product;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { purchasePrice, salePrice, fees, marketPriceMin, marketPriceMax, marketPriceAvg, customShares, ...safe } = product;
  return safe as T;
}
