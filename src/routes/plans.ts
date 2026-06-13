// src/routes/plans.ts — catalogo piani e piano corrente dell'utente.
import { Router, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { authenticate, AuthRequest } from '../middleware/auth';
import { PLANS, PLAN_ORDER, getPlan } from '../config/plans';

const router = Router();
const prisma = new PrismaClient();
router.use(authenticate);

// Catalogo completo (per la pagina prezzi)
router.get('/', (_req: AuthRequest, res: Response) => {
  res.json({ plans: PLAN_ORDER.map(id => PLANS[id]) });
});

// Piano corrente dell'utente + diritti
router.get('/me', async (req: AuthRequest, res: Response) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user!.userId },
    select: { plan: true },
  }).catch(() => null);
  const plan = getPlan(user?.plan);
  res.json({ plan: plan.id, name: plan.name, features: plan.features, limits: { maxProducts: plan.maxProducts, maxTeamMembers: plan.maxTeamMembers } });
});

export default router;
