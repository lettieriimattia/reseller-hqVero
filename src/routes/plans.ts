// src/routes/plans.ts — catalogo piani e piano corrente dell'utente.
import { Router, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { prisma } from "../lib/prisma";
import { authenticate, AuthRequest } from '../middleware/auth';
import { PLANS, PLAN_ORDER, getPlan, BETA_FEATURES, Feature } from '../config/plans';
import { isAdminEmail } from '../config/admins';

const router = Router();
router.use(authenticate);

// Catalogo completo (per la pagina prezzi)
router.get('/', (_req: AuthRequest, res: Response) => {
  res.json({ plans: PLAN_ORDER.map(id => PLANS[id]) });
});

// Piano corrente dell'utente + diritti
router.get('/me', async (req: AuthRequest, res: Response) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user!.userId },
    select: { plan: true, email: true },
  }).catch(() => null);
  const plan = getPlan(user?.plan);
  const admin = isAdminEmail(user?.email);
  // Admin = beta tester: vede TUTTE le feature (anche quelle in beta) per testarle.
  // Utente normale: le feature del suo piano MENO quelle ancora in beta.
  const allFeatures = Array.from(new Set(PLAN_ORDER.flatMap(id => PLANS[id].features))) as Feature[];
  const features = admin ? allFeatures : plan.features.filter(f => !BETA_FEATURES.has(f));
  res.json({ plan: plan.id, name: plan.name, features, isAdmin: admin, limits: { maxProducts: plan.maxProducts, maxTeamMembers: plan.maxTeamMembers } });
});

export default router;
