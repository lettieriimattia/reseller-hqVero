// src/services/push.service.ts
// Web Push (notifiche al dispositivo, anche ad app chiusa).
// Le chiavi VAPID vengono generate al primo avvio e salvate nel DB (Setting):
// nessuna variabile d'ambiente da configurare.

import webpush from 'web-push';
import { PrismaClient } from '@prisma/client';
import { logger } from '../utils/logger';

const prisma = new PrismaClient();

let vapidPublic = '';
let initialized = false;

export async function initPush(): Promise<void> {
  if (initialized) return;
  try {
    let pub = await prisma.setting.findUnique({ where: { key: 'vapidPublic' } });
    let priv = await prisma.setting.findUnique({ where: { key: 'vapidPrivate' } });
    if (!pub || !priv) {
      const keys = webpush.generateVAPIDKeys();
      await prisma.setting.upsert({ where: { key: 'vapidPublic' }, create: { key: 'vapidPublic', value: keys.publicKey }, update: { value: keys.publicKey } });
      await prisma.setting.upsert({ where: { key: 'vapidPrivate' }, create: { key: 'vapidPrivate', value: keys.privateKey }, update: { value: keys.privateKey } });
      pub = { key: 'vapidPublic', value: keys.publicKey };
      priv = { key: 'vapidPrivate', value: keys.privateKey };
      logger.info('Chiavi VAPID generate e salvate');
    }
    vapidPublic = pub.value;
    const subject = process.env.VAPID_SUBJECT || 'mailto:noreply.hq.app@gmail.com';
    webpush.setVapidDetails(subject, pub.value, priv.value);
    initialized = true;
    logger.info('Web Push inizializzato');
  } catch (err: any) {
    logger.error('initPush fallita', { err: err.message });
  }
}

export function getVapidPublicKey(): string {
  return vapidPublic;
}

export async function saveSubscription(userId: string, sub: any): Promise<void> {
  const endpoint = sub?.endpoint;
  const p256dh = sub?.keys?.p256dh;
  const auth = sub?.keys?.auth;
  if (!endpoint || !p256dh || !auth) return;
  await prisma.pushSubscription.upsert({
    where: { endpoint },
    create: { userId, endpoint, p256dh, auth },
    update: { userId, p256dh, auth },
  }).catch(err => logger.error('saveSubscription', { err: err.message }));
}

export async function removeSubscription(endpoint: string): Promise<void> {
  if (!endpoint) return;
  await prisma.pushSubscription.deleteMany({ where: { endpoint } }).catch(() => {});
}

// Invia una push a tutti i dispositivi di un utente. Pulisce le subscription scadute.
export async function sendPushToUser(userId: string, payload: { title: string; body: string; url?: string }): Promise<void> {
  if (!initialized) return;
  const subs = await prisma.pushSubscription.findMany({ where: { userId } }).catch(() => []);
  if (!subs.length) return;
  const data = JSON.stringify(payload);
  await Promise.all(subs.map(async s => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, data);
    } catch (err: any) {
      if (err?.statusCode === 404 || err?.statusCode === 410) {
        await prisma.pushSubscription.delete({ where: { id: s.id } }).catch(() => {});
      } else {
        logger.warn('Invio push fallito', { status: err?.statusCode });
      }
    }
  }));
}
