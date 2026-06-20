// src/middleware/plan.ts
// Gating per piano: blocca una rotta se il piano dell'utente non include la feature.
import { Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { prisma } from "../lib/prisma";
import { AuthRequest } from './auth';
import { Feature, hasFeature, minPlanFor, getPlan, PLAN_ORDER, PLANS } from '../config/plans';


export function requireFeature(feature: Feature) {
  return async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const user = await prisma.user.findUnique({
        where: { id: req.user!.userId },
        select: { plan: true },
      });
      if (hasFeature(user?.plan, feature)) return next();
      const need = minPlanFor(feature);
      return res.status(402).json({
        error: 'Funzione disponibile in un piano superiore.',
        feature,
        requiredPlan: need?.id || null,
        requiredPlanName: need?.name || null,
        upgrade: true,
      });
    } catch {
      return res.status(500).json({ error: 'Errore verifica piano' });
    }
  };
}

// Primo piano (in ordine) il cui limite prodotti basta a contenere `count`.
function nextPlanForProducts(count: number) {
  for (const id of PLAN_ORDER) {
    const max = PLANS[id].maxProducts;
    if (max === null || count <= max) return PLANS[id];
  }
  return PLANS.business;
}

// Verifica il limite prodotti del piano PRIMA di crearne di nuovi.
// `adding` = quanti pezzi sto per creare (1 per il singolo, N per il lotto).
// Ritorna null se ok, oppure un payload d'errore (da usare con res.status(402).json(...)).
export async function checkProductQuota(userId: string, adding: number): Promise<any | null> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { plan: true } });
  const plan = getPlan(user?.plan);
  if (plan.maxProducts === null) return null; // illimitato
  const current = await prisma.product.count({ where: { userId, deletedAt: null } });
  if (current + adding <= plan.maxProducts) return null;
  const need = nextPlanForProducts(current + adding);
  return {
    error: `Hai raggiunto il limite di ${plan.maxProducts} prodotti del piano ${plan.name}.`,
    limit: plan.maxProducts,
    current,
    adding,
    requiredPlan: need.id,
    requiredPlanName: need.name,
    upgrade: true,
  };
}

// Verifica il limite di membri del team del piano PRIMA di aggiungere un socio.
export async function checkTeamQuota(ownerUserId: string, warehouseId: string): Promise<any | null> {
  const user = await prisma.user.findUnique({ where: { id: ownerUserId }, select: { plan: true } });
  const plan = getPlan(user?.plan);
  if (plan.maxTeamMembers === null) return null; // illimitato
  const current = await prisma.membership.count({ where: { warehouseId } });
  if (current + 1 <= plan.maxTeamMembers) return null;
  const need = (() => {
    for (const id of PLAN_ORDER) {
      const max = PLANS[id].maxTeamMembers;
      if (max === null || current + 1 <= max) return PLANS[id];
    }
    return PLANS.business;
  })();
  return {
    error: `Il piano ${plan.name} consente max ${plan.maxTeamMembers} persone per magazzino.`,
    limit: plan.maxTeamMembers,
    current,
    requiredPlan: need.id,
    requiredPlanName: need.name,
    upgrade: true,
  };
}
