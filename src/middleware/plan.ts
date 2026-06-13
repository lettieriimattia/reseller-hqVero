// src/middleware/plan.ts
// Gating per piano: blocca una rotta se il piano dell'utente non include la feature.
import { Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { AuthRequest } from './auth';
import { Feature, hasFeature, minPlanFor } from '../config/plans';

const prisma = new PrismaClient();

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
