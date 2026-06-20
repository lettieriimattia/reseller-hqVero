// src/routes/team.ts
// Gestione team, quote, warehouse.

import { Router, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { prisma } from "../lib/prisma";

import { authenticate, AuthRequest, authorizeWarehouseAccess, authorizeWarehouseOwner } from '../middleware/auth';
import { apiLimiter } from '../middleware/rateLimit';
import { validate, teamPercentageSchema, joinWarehouseSchema, createWarehouseSchema } from '../middleware/validate';
import { generateInviteCode } from '../utils/security';
import { audit } from '../services/audit.service';
import { notifyWarehouseMembers, notifyTeam } from '../services/notification.service';
import { logger } from '../utils/logger';

const router = Router();

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
    
    // Per ogni membro: conta prodotti aggiunti e venduti (contribuzione)
    const allWarehouseIds = user?.memberships?.map((m: any) => m.warehouse.id) || [];
    const productCounts = await prisma.product.groupBy({
      by: ['userId', 'warehouseId', 'status'],
      where: { warehouseId: { in: allWarehouseIds }, deletedAt: null },
      _count: { id: true },
    });

    const countMap: Record<string, { added: number; sold: number }> = {};
    for (const row of productCounts) {
      const key = `${row.userId}__${row.warehouseId}`;
      if (!countMap[key]) countMap[key] = { added: 0, sold: 0 };
      countMap[key].added += row._count.id;
      if (row.status === 'VENDUTO') countMap[key].sold += row._count.id;
    }

    const teamData = user?.memberships?.map((m: any) => ({
      warehouseName: m.warehouse.name,
      warehouseId: m.warehouse.id,
      parentId: m.warehouse.parentId || null,
      category: m.warehouse.category || m.warehouse.name.replace('Magazzino ', ''),
      inviteCode: m.role === 'OWNER' ? m.warehouse.inviteCode : null,
      inviteCodeExpiresAt: m.role === 'OWNER' ? m.warehouse.inviteCodeExpiresAt : null,
      myRole: m.role,
      members: m.warehouse.members.map((wm: any) => {
        const key = `${wm.user.id}__${m.warehouse.id}`;
        return {
          membershipId: wm.id,
          userId: wm.user.id,
          name: wm.user.name,
          role: wm.role,
          percentage: wm.percentage,
          costPercentage: wm.costPercentage ?? 0,
          productsAdded: countMap[key]?.added || 0,
          productsSold: countMap[key]?.sold || 0,
        };
      }),
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
    
    // Aggiorna in transazione (utili + costi se presenti)
    await prisma.$transaction(
      updates.map((u: any) =>
        prisma.membership.update({
          where: { id: u.membershipId },
          data: {
            percentage: u.percentage,
            ...(typeof u.costPercentage === 'number' ? { costPercentage: u.costPercentage } : {}),
          },
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
            aiConfig: m.warehouse.aiConfig || null,
          parentId: m.warehouse.parentId || null, category: m.warehouse.category || null,
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
    const { name, defaultProfitShares } = req.body;
    
    // Solo gli OWNER possono creare nuovi reparti
    const isOwner = await prisma.membership.findFirst({
      where: { userId: req.user!.userId, role: 'OWNER' },
    });

    if (!isOwner) {
      return res.status(403).json({ error: 'Solo i fondatori possono creare nuovi reparti.' });
    }

    // Serializza defaultProfitShares se presente
    const parsedProfitShares = defaultProfitShares && Array.isArray(defaultProfitShares) && defaultProfitShares.length > 0
      ? JSON.stringify(defaultProfitShares.map((s: any) => ({ ...s, percentage: Number(s.percentage) || 0 })))
      : null;

    // Nuovo modello: il magazzino è una partnership a nome libero (es. "Magazzino con Luca").
    // Parte solo col fondatore; i soci entrano via codice invito. Niente più legame con la categoria.
    const newWarehouse = await prisma.warehouse.create({
      data: {
        name: name.trim(),
        inviteCode: generateInviteCode(),
        inviteCodeExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        defaultProfitShares: parsedProfitShares,
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
      title: 'Nuovo magazzino creato',
      message: `Magazzino "${name}" aggiunto`,
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
            aiConfig: m.warehouse.aiConfig || null,
          parentId: m.warehouse.parentId || null, category: m.warehouse.category || null,
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
// POST /warehouses/sub - crea un sotto-magazzino dentro un reparto
// (è un Warehouse a sé: propri soci, %, codice invito, prodotti)
// ==========================================
router.post('/warehouses/sub', async (req: AuthRequest, res: Response) => {
  try {
    const { parentId, name, defaultProfitShares } = req.body || {};
    if (!parentId || !name || typeof name !== 'string' || name.trim().length < 1) {
      return res.status(400).json({ error: 'parentId e nome richiesti.' });
    }
    // Solo l'OWNER del reparto genitore può creare sotto-magazzini
    const parentMembership = await prisma.membership.findFirst({
      where: { userId: req.user!.userId, warehouseId: parentId, role: 'OWNER' },
      include: { warehouse: true },
    });
    if (!parentMembership) return res.status(403).json({ error: 'Solo il fondatore del reparto può creare sotto-magazzini.' });
    const parent = parentMembership.warehouse;
    if (parent.parentId) return res.status(400).json({ error: 'Un sotto-magazzino non può contenere altri sotto-magazzini.' });

    // Serializza defaultProfitShares se presente, altrimenti eredita dal parent
    const parsedProfitShares = defaultProfitShares && Array.isArray(defaultProfitShares) && defaultProfitShares.length > 0
      ? JSON.stringify(defaultProfitShares.map((s: any) => ({ ...s, percentage: Number(s.percentage) || 0 })))
      : parent.defaultProfitShares;

    const repartoCategory = parent.category || parent.name.replace('Magazzino ', '');
    const sub = await prisma.warehouse.create({
      data: {
        name: name.trim(),
        parentId: parent.id,
        category: repartoCategory,
        aiConfig: parent.aiConfig,
        defaultProfitShares: parsedProfitShares,
        inviteCode: generateInviteCode(),
        inviteCodeExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        members: { create: [{ userId: req.user!.userId, role: 'OWNER', percentage: 100 }] },
      },
    });

    await audit({ action: 'WAREHOUSE_CREATE', userId: req.user!.userId, req, resource: sub.id, metadata: { parentId, name: name.trim(), sub: true } });

    const updated = await prisma.user.findUnique({
      where: { id: req.user!.userId },
      include: { memberships: { include: { warehouse: true } } },
    });
    res.json({
      message: 'Sotto-magazzino creato',
      user: {
        id: updated!.id, name: updated!.name, email: updated!.email,
        twoFactorEnabled: updated!.twoFactorEnabled, plan: updated!.plan,
        warehouses: updated!.memberships.map((m: any) => ({
          id: m.warehouse.id, name: m.warehouse.name, role: m.role,
          parentId: m.warehouse.parentId || null,
          category: m.warehouse.category || null,
          inviteCode: m.role === 'OWNER' ? m.warehouse.inviteCode : null,
          aiConfig: m.warehouse.aiConfig || null,
          percentage: m.percentage,
        })),
      },
    });
  } catch (err: any) {
    logger.error('Errore POST /warehouses/sub', { err: err.message });
    res.status(500).json({ error: 'Errore creazione sotto-magazzino' });
  }
});

// ==========================================
// DELETE /team/members/:membershipId — rimuovi un membro dal team (solo OWNER)
// ==========================================
router.delete('/members/:membershipId', async (req: AuthRequest, res: Response) => {
  try {
    const membership = await prisma.membership.findUnique({
      where: { id: req.params.membershipId },
    });
    if (!membership) return res.status(404).json({ error: 'Membro non trovato' });

    const isOwner = await authorizeWarehouseOwner(req.user!.userId, membership.warehouseId);
    if (!isOwner) return res.status(403).json({ error: 'Solo il fondatore può rimuovere membri.' });

    if (membership.userId === req.user!.userId) {
      return res.status(400).json({ error: 'Non puoi rimuovere te stesso. Usa "Elimina Account" nelle impostazioni.' });
    }
    if (membership.role === 'OWNER') {
      return res.status(400).json({ error: 'Non puoi rimuovere un altro Owner.' });
    }

    await prisma.membership.delete({ where: { id: req.params.membershipId } });

    await audit({
      action: 'UNAUTHORIZED_ACCESS', userId: req.user!.userId, req,
      resource: req.params.membershipId,
      metadata: { action: 'kick_member', warehouseId: membership.warehouseId },
    });

    res.json({ success: true });
  } catch (err: any) {
    logger.error('Errore DELETE /team/members/:membershipId', { err: err.message });
    res.status(500).json({ error: 'Errore rimozione membro' });
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

// ==========================================
// DELETE /warehouses/:id — elimina reparto (solo OWNER, non l'ultimo)
// ==========================================
router.delete('/warehouses/:id', async (req: AuthRequest, res: Response) => {
  try {
    const isOwner = await authorizeWarehouseOwner(req.user!.userId, req.params.id);
    if (!isOwner) return res.status(403).json({ error: 'Solo il fondatore può eliminare il reparto.' });

    // Non permettere di eliminare l'unico warehouse
    const userWarehouses = await prisma.membership.findMany({
      where: { userId: req.user!.userId, role: 'OWNER' },
    });
    if (userWarehouses.length <= 1) {
      return res.status(400).json({ error: 'Non puoi eliminare l\'unico reparto. Crea prima un altro reparto.' });
    }

    // Elimina in cascata (membership, products del warehouse via warehouseId)
    await prisma.warehouse.delete({ where: { id: req.params.id } });

    await audit({ action: 'WAREHOUSE_CREATE', userId: req.user!.userId, req,
      resource: req.params.id, metadata: { action: 'delete' } });

    // Ritorna la lista aggiornata
    const updated = await prisma.user.findUnique({
      where: { id: req.user!.userId },
      include: { memberships: { include: { warehouse: true } } },
    });

    res.json({
      success: true,
      user: {
        id: updated!.id, name: updated!.name, email: updated!.email,
        twoFactorEnabled: updated!.twoFactorEnabled,
        warehouses: updated!.memberships.map((m: any) => ({
          id: m.warehouse.id, name: m.warehouse.name, role: m.role,
          inviteCode: m.role === 'OWNER' ? m.warehouse.inviteCode : null,
          aiConfig: m.warehouse.aiConfig || null,
          percentage: m.percentage,
        })),
      },
    });
  } catch (err: any) {
    logger.error('Errore DELETE /warehouses/:id', { err: err.message });
    res.status(500).json({ error: 'Errore eliminazione reparto' });
  }
});

// ==========================================
// PUT /warehouses/:id/profit-shares - aggiorna divisione profitti predefinita del warehouse
// Solo OWNER può modificare
// ==========================================
router.put('/warehouses/:id/profit-shares', async (req: AuthRequest, res: Response) => {
  try {
    const { defaultProfitShares } = req.body;
    
    const isOwner = await prisma.membership.findFirst({
      where: { userId: req.user!.userId, warehouseId: req.params.id, role: 'OWNER' },
    });
    
    if (!isOwner) {
      return res.status(403).json({ error: 'Solo il fondatore può modificare la divisione profitti.' });
    }

    // Valida che le percentuali sommino a 100
    if (defaultProfitShares && Array.isArray(defaultProfitShares)) {
      const total = defaultProfitShares.reduce((s: number, share: any) => s + (Number(share.percentage) || 0), 0);
      if (Math.round(total) !== 100) {
        return res.status(400).json({ error: 'Le percentuali devono sommare a 100.' });
      }
    }

    const parsedProfitShares = defaultProfitShares && Array.isArray(defaultProfitShares) && defaultProfitShares.length > 0
      ? JSON.stringify(defaultProfitShares.map((s: any) => ({ ...s, percentage: Number(s.percentage) || 0 })))
      : null;

    await prisma.warehouse.update({
      where: { id: req.params.id },
      data: { defaultProfitShares: parsedProfitShares },
    });

    await audit({
      action: 'WAREHOUSE_PROFIT_SHARES_UPDATE',
      userId: req.user!.userId,
      req,
      resource: req.params.id,
      metadata: { defaultProfitShares },
    });

    res.json({ success: true });
  } catch (err: any) {
    logger.error('Errore PUT /warehouses/:id/profit-shares', { err: err.message });
    res.status(500).json({ error: 'Errore aggiornamento divisione profitti' });
  }
});

export default router;
