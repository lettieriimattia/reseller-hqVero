// src/services/notification.service.ts
// Gestione notifiche in-app per il team.

import { PrismaClient } from '@prisma/client';
import { prisma } from "../lib/prisma";
import { logger } from '../utils/logger';
import { sendPushToUser } from './push.service';


export type NotificationType = 'SALE' | 'NEW_MEMBER' | 'PRICE_ALERT' | 'AI_INSIGHT' | 'SECURITY' | 'PRODUCT_ADDED' | 'OFFER' | 'MESSAGE' | 'DISPUTE';

// Categorie attivabili/disattivabili dall'utente (Impostazioni → Notifiche).
export type NotifCategory = 'offers' | 'messages' | 'sales' | 'shipping' | 'disputes' | 'team' | 'insights';
export const NOTIF_CATEGORIES: NotifCategory[] = ['offers', 'messages', 'sales', 'shipping', 'disputes', 'team', 'insights'];

// Mappa tipo → categoria. 'SECURITY' non è mappata: le notifiche di sicurezza arrivano sempre.
const TYPE_CATEGORY: Partial<Record<NotificationType, NotifCategory>> = {
  OFFER: 'offers',
  MESSAGE: 'messages',
  SALE: 'sales',
  DISPUTE: 'disputes',
  NEW_MEMBER: 'team',
  PRODUCT_ADDED: 'team',
  PRICE_ALERT: 'insights',
  AI_INSIGHT: 'insights',
};

// Default: tutte attive.
export function defaultNotifPrefs(): Record<NotifCategory, boolean> {
  return { offers: true, messages: true, sales: true, shipping: true, disputes: true, team: true, insights: true };
}

// L'utente vuole il PUSH per questo tipo? (in-app si crea sempre; il push rispetta le preferenze)
async function pushAllowed(userId: string, type: NotificationType): Promise<boolean> {
  if (type === 'SECURITY') return true; // sicurezza sempre
  const cat = TYPE_CATEGORY[type];
  if (!cat) return true;
  try {
    const u = await prisma.user.findUnique({ where: { id: userId }, select: { notifPrefs: true } });
    if (!u?.notifPrefs) return true; // default: attivo
    const prefs = JSON.parse(u.notifPrefs);
    return prefs[cat] !== false;
  } catch { return true; }
}

interface NotifyInput {
  userId: string;
  type: NotificationType;
  title: string;
  message: string;
  link?: string;
}

export async function notify(input: NotifyInput) {
  try {
    const n = await prisma.notification.create({ data: input });
    // Push al dispositivo (best-effort, non blocca) — solo se l'utente lo vuole per questa categoria.
    pushAllowed(input.userId, input.type).then(ok => {
      if (ok) sendPushToUser(input.userId, { title: input.title, body: input.message, url: input.link }).catch(() => {});
    }).catch(() => {});
    return n;
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
    // Push a ogni membro (best-effort) — rispetta le preferenze notifiche.
    memberships.forEach(m => pushAllowed(m.userId, rest.type).then(ok => {
      if (ok) sendPushToUser(m.userId, { title: rest.title, body: rest.message, url: rest.link }).catch(() => {});
    }).catch(() => {}));
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
    teamMembers.forEach(m => sendPushToUser(m.userId, { title: rest.title, body: rest.message, url: rest.link }).catch(() => {}));
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
