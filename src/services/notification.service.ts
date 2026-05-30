// src/services/notification.service.ts
// Gestione notifiche in-app per il team.

import { PrismaClient } from '@prisma/client';
import { logger } from '../utils/logger';

const prisma = new PrismaClient();

export type NotificationType = 'SALE' | 'NEW_MEMBER' | 'PRICE_ALERT' | 'AI_INSIGHT' | 'SECURITY' | 'PRODUCT_ADDED';

interface NotifyInput {
  userId: string;
  type: NotificationType;
  title: string;
  message: string;
  link?: string;
}

export async function notify(input: NotifyInput) {
  try {
    return await prisma.notification.create({ data: input });
  } catch (err) {
    logger.error('Errore creazione notifica', { err, input });
    return null;
  }
}

// Notifica tutti i membri di un warehouse (escludendo opzionalmente uno)
export async function notifyWarehouseMembers(params: {
  warehouseId: string;
  excludeUserId?: string;
  type: NotificationType;
  title: string;
  message: string;
  link?: string;
}) {
  const { warehouseId, excludeUserId, ...rest } = params;
  
  try {
    const memberships = await prisma.membership.findMany({
      where: {
        warehouseId,
        ...(excludeUserId && { userId: { not: excludeUserId } }),
      },
      select: { userId: true },
    });
    
    await prisma.notification.createMany({
      data: memberships.map(m => ({
        userId: m.userId,
        ...rest,
      })),
    });
  } catch (err) {
    logger.error('Errore broadcast notifiche', { err, warehouseId });
  }
}

// Notifica tutti i membri del team con cui un utente condivide warehouse
export async function notifyTeam(params: {
  fromUserId: string;
  type: NotificationType;
  title: string;
  message: string;
  link?: string;
}) {
  const { fromUserId, ...rest } = params;
  
  try {
    // Trova tutti i warehouse di cui l'utente fa parte
    const myMemberships = await prisma.membership.findMany({
      where: { userId: fromUserId },
      select: { warehouseId: true },
    });
    const warehouseIds = myMemberships.map(m => m.warehouseId);
    
    // Trova tutti gli altri membri di quei warehouse
    const teamMembers = await prisma.membership.findMany({
      where: {
        warehouseId: { in: warehouseIds },
        userId: { not: fromUserId },
      },
      select: { userId: true },
      distinct: ['userId'],
    });
    
    await prisma.notification.createMany({
      data: teamMembers.map(m => ({
        userId: m.userId,
        ...rest,
      })),
    });
  } catch (err) {
    logger.error('Errore notifica team', { err, fromUserId });
  }
}

export async function getNotifications(userId: string, unreadOnly = false) {
  return prisma.notification.findMany({
    where: { userId, ...(unreadOnly && { read: false }) },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
}

export async function markAsRead(userId: string, notificationId: string) {
  return prisma.notification.updateMany({
    where: { id: notificationId, userId },
    data: { read: true },
  });
}

export async function markAllRead(userId: string) {
  return prisma.notification.updateMany({
    where: { userId, read: false },
    data: { read: true },
  });
}

export async function getUnreadCount(userId: string): Promise<number> {
  return prisma.notification.count({ where: { userId, read: false } });
}
