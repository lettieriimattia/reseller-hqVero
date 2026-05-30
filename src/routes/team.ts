// src/routes/team.ts
// Gestione team, quote, warehouse.

import { Router, Response } from 'express';
import { PrismaClient } from '@prisma/client';

import { authenticate, AuthRequest, authorizeWarehouseAccess, authorizeWarehouseOwner } from '../middleware/auth';
import { apiLimiter } from '../middleware/rateLimit';
import { validate, teamPercentageSchema, joinWarehouseSchema, createWarehouseSchema } from '../middleware/validate';
import { generateInviteCode } from '../utils/security';
import { audit } from '../services/audit.service';
import { notifyWarehouseMembers, notifyTeam } from '../services/notification.service';
import { logger } from '../utils/logger';

const router = Router();
const prisma = new PrismaClient();

router.use(authenticate);
router.use(apiLimiter);

// ==========================================
// GET /team - lista team per ogni warehouse
// ==========================================
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.userId },
      include: {
        memberships: {
          include: {
            warehouse: {
              include: { members: { include: { user: true } } },
            },
          },
        },
      },
    });
    
    const teamData = user?.memberships?.map((m: any) => ({
      warehouseName: m.warehouse.name,
      warehouseId: m.warehouse.id,
      myRole: m.role,
      members: m.warehouse.members.map((wm: any) => ({
        membershipId: wm.id,
        userId: wm.user.id,
        name: wm.user.name,
        role: wm.role,
        percentage: wm.percentage,
      })),
    })) || [];
    
    res.json(teamData);
  } catch (err: any) {
    logger.error('Errore GET /team', { err: err.message });
    res.status(500).json({ error: 'Errore recupero team' });
  }
});

// ==========================================
// PUT /team/percentage - aggiorna quote
// Solo OWNER può modificare le quote del proprio warehouse
// ==========================================
router.put('/percentage', validate(teamPercentageSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { warehouseId, updates } = req.body;
    
    const isMember = await prisma.membership.findFirst({
      where: { userId: req.user!.userId, warehouseId },
    });
    if (!isMember) {
      await audit({ action: 'UNAUTHORIZED_ACCESS', userId: req.user!.userId, req,
        resource: warehouseId, metadata: { type: 'team_percentage_update' } });
      return res.status(403).json({ error: 'Non sei membro di questo team.' });
    }
    
    // Verifica somma = 100
    const total = updates.reduce((s: number, u: any) => s + u.percentage, 0);
    if (Math.round(total) !== 100) {
      return res.status(400).json({ error: 'Le percentuali devono sommare a 100.' });
    }
    
    // Verifica che tutti gli userId siano membri del warehouse
    const memberships = await prisma.membership.findMany({ where: { warehouseId } });
    const memberIds = new Set(memberships.map(m => m.userId));
    for (const u of updates) {
      if (!memberIds.has(u.userId)) {
        return res.status(400).json({ error: 'Utente non valido nel team.' });
      }
    }
    
    // Aggiorna in transazione
    await prisma.$transaction(
      updates.map((u: any) =>
        prisma.membership.update({
          where: { id: u.membershipId },
          data: { percentage: u.percentage },
        })
      )
    );
    
    await audit({ action: 'TEAM_PERCENTAGE_UPDATE', userId: req.user!.userId, req,
      resource: warehouseId, metadata: { updates } });
    
    await notifyWarehouseMembers({
      warehouseId,
      excludeUserId: req.user!.userId,
      type: 'NEW_MEMBER',
      title: 'Quote aggiornate',
      message: 'Le quote societarie del tuo team sono state aggiornate',
    });
    
    res.json({ success: true });
  } catch (err: any) {
    logger.error('Errore PUT /team/percentage', { err: err.message });
    res.status(500).json({ error: 'Errore salvataggio quote' });
  }
});

// ==========================================
// POST /warehouses/join - entra in team con codice
// ==========================================
router.post('/warehouses/join', validate(joinWarehouseSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { inviteCode } = req.body;
    
    const warehouse = await prisma.warehouse.findUnique({ where: { inviteCode } });
    if (!warehouse) return res.status(400).json({ error: 'Codice invito non valido' });
    
    if (warehouse.inviteCodeExpiresAt && warehouse.inviteCodeExpiresAt < new Date()) {
      return res.status(400).json({ error: 'Codice invito scaduto.' });
    }
    
    const ownerMembership = await prisma.membership.findFirst({
      where: { warehouseId: warehouse.id, role: 'OWNER' },
      include: { user: true },
    });
    if (!ownerMembership) return res.status(400).json({ error: 'Errore: Team senza proprietario.' });
    
    if (ownerMembership.userId === req.user!.userId) {
      return res.status(400).json({ error: 'Sei tu stesso il fondatore di questo team!' });
    }

    // Controlla se già membro di questo specifico warehouse
    const alreadyMember = await prisma.membership.findFirst({
      where: { userId: req.user!.userId, warehouseId: warehouse.id },
    });
    if (alreadyMember) {
      return res.status(400).json({ error: 'Sei già membro di questo reparto.' });
    }

    // Aggiunge SOLO al warehouse del codice usato, non a tutti
    await prisma.membership.create({
      data: {
        userId: req.user!.userId,
        warehouseId: warehouse.id,
        role: 'MEMBER',
        percentage: 0,
      },
    });
    
    await audit({ action: 'WAREHOUSE_JOIN', userId: req.user!.userId, req,
      resource: warehouse.id, metadata: { ownerName: ownerMembership.user.name } });
    
    // Notifica al team
    await notifyTeam({
      fromUserId: req.user!.userId,
      type: 'NEW_MEMBER',
      title: 'Nuovo membro nel team',
      message: `${req.user!.email} si è unito al team.`,
    });
    
    const updated = await prisma.user.findUnique({
      where: { id: req.user!.userId },
      include: { memberships: { include: { warehouse: true } } },
    });
    
    res.json({
      message: `Sei entrato nel team di ${ownerMembership.user.name}!`,
      user: {
        id: updated!.id, name: updated!.name, email: updated!.email,
        twoFactorEnabled: updated!.twoFactorEnabled,
        warehouses: updated!.memberships.map((m: any) => ({
          id: m.warehouse.id, name: m.warehouse.name,
          role: m.role,
          inviteCode: m.role === 'OWNER' ? m.warehouse.inviteCode : null,
          percentage: m.percentage,
        })),
      },
    });
  } catch (err: any) {
    logger.error('Errore POST /warehouses/join', { err: err.message });
    res.status(500).json({ error: 'Errore ingresso magazzino' });
  }
});

// ==========================================
// POST /warehouses - crea nuovo reparto
// ==========================================
router.post('/warehouses', validate(createWarehouseSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { name } = req.body;
    
    // Solo gli OWNER possono creare nuovi reparti
    const isOwner = await prisma.membership.findFirst({
      where: { userId: req.user!.userId, role: 'OWNER' },
    });

    if (!isOwner) {
      return res.status(403).json({ error: 'Solo i fondatori possono creare nuovi reparti.' });
    }

    // Il nuovo reparto parte solo col fondatore — ogni reparto ha i propri soci via codice invito
    const newWarehouse = await prisma.warehouse.create({
      data: {
        name: `Magazzino ${name}`,
        inviteCode: generateInviteCode(),
        inviteCodeExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        members: {
          create: [
            { userId: req.user!.userId, role: 'OWNER', percentage: 100 },
          ],
        },
      },
    });
    
    await audit({ action: 'WAREHOUSE_CREATE', userId: req.user!.userId, req,
      resource: newWarehouse.id, metadata: { name } });
    
    await notifyTeam({
      fromUserId: req.user!.userId,
      type: 'PRODUCT_ADDED',
      title: 'Nuovo reparto creato',
      message: `Reparto "${name}" aggiunto al team`,
    });
    
    const updated = await prisma.user.findUnique({
      where: { id: req.user!.userId },
      include: { memberships: { include: { warehouse: true } } },
    });
    
    res.json({
      message: 'Reparto aggiunto per tutto il Team!',
      user: {
        id: updated!.id, name: updated!.name, email: updated!.email,
        twoFactorEnabled: updated!.twoFactorEnabled,
        warehouses: updated!.memberships.map((m: any) => ({
          id: m.warehouse.id, name: m.warehouse.name, role: m.role,
          inviteCode: m.role === 'OWNER' ? m.warehouse.inviteCode : null,
          percentage: m.percentage,
        })),
      },
    });
  } catch (err: any) {
    logger.error('Errore POST /warehouses', { err: err.message });
    res.status(500).json({ error: 'Errore creazione reparto' });
  }
});

// ==========================================
// POST /warehouses/:id/regenerate-invite
// Rigenera codice invito per uno specifico warehouse
// ==========================================
router.post('/warehouses/:id/regenerate-invite', async (req: AuthRequest, res: Response) => {
  try {
    const isOwner = await authorizeWarehouseOwner(req.user!.userId, req.params.id);
    if (!isOwner) return res.status(403).json({ error: 'Solo il fondatore può rigenerare il codice.' });
    
    const updated = await prisma.warehouse.update({
      where: { id: req.params.id },
      data: {
        inviteCode: generateInviteCode(),
        inviteCodeExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });
    
    res.json({ inviteCode: updated.inviteCode });
  } catch (err: any) {
    logger.error('Errore rigenerazione invite', { err: err.message });
    res.status(500).json({ error: 'Errore' });
  }
});

export default router;
