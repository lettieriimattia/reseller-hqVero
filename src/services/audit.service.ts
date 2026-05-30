// src/services/audit.service.ts
// Tracciamento azioni sensibili. Scrive sia su DB (per UI) che su logger (per ops).

import { PrismaClient } from '@prisma/client';
import { Request } from 'express';
import { logger } from '../utils/logger';

const prisma = new PrismaClient();

export type AuditAction =
  | 'LOGIN_SUCCESS'
  | 'LOGIN_FAIL'
  | 'LOGOUT'
  | 'REGISTER'
  | 'TOKEN_REFRESH'
  | '2FA_ENABLE'
  | '2FA_DISABLE'
  | '2FA_VERIFY'
  | 'PASSWORD_CHANGE'
  | 'PRODUCT_CREATE'
  | 'PRODUCT_EDIT'
  | 'PRODUCT_DELETE'
  | 'PRODUCT_SELL'
  | 'WAREHOUSE_CREATE'
  | 'WAREHOUSE_JOIN'
  | 'TEAM_PERCENTAGE_UPDATE'
  | 'AI_SCAN'
  | 'SECURITY_LOCK'
  | 'UNAUTHORIZED_ACCESS';

export async function audit(params: {
  action: AuditAction;
  userId?: string | null;
  resource?: string;
  metadata?: Record<string, any>;
  req?: Request;
  success?: boolean;
}) {
  const { action, userId, resource, metadata, req, success = true } = params;
  
  try {
    await prisma.auditLog.create({
      data: {
        action,
        userId: userId || null,
        resource: resource || null,
        metadata: metadata ? JSON.stringify(metadata) : null,
        ipAddress: req?.ip || null,
        userAgent: req?.headers['user-agent']?.slice(0, 500) || null,
        success,
      },
    });
  } catch (err) {
    // Non far crashare la richiesta se l'audit fallisce
    logger.error('Audit log fallito', { action, userId, err });
  }
  
  // Log strutturato anche su Winston (utile per allarmi)
  logger.info(`AUDIT: ${action}`, {
    userId, resource, success,
    ip: req?.ip,
  });
}

// Recupera audit log per un warehouse (per la feature "storico modifiche")
export async function getAuditLogsForWarehouse(warehouseId: string, limit = 50) {
  // Otteniamo gli userId membri del warehouse
  const memberships = await prisma.membership.findMany({
    where: { warehouseId },
    select: { userId: true },
  });
  const userIds = memberships.map(m => m.userId);
  
  return prisma.auditLog.findMany({
    where: {
      userId: { in: userIds },
      action: { in: ['PRODUCT_CREATE', 'PRODUCT_EDIT', 'PRODUCT_SELL', 'WAREHOUSE_CREATE', 'TEAM_PERCENTAGE_UPDATE'] },
    },
    include: {
      user: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
}
