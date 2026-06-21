// src/services/tracking.service.ts
// Integrazione 17track API per tracking spedizioni.
// API Key gratuita (100 track/mese): https://api.17track.net
// Imposta TRACKING_17TRACK_KEY nel .env

import { PrismaClient } from '@prisma/client';
import { prisma } from "../lib/prisma";
import { logger } from '../utils/logger';
import { notifyWarehouseMembers } from './notification.service';
import { sendDeliveredEmail } from './email-jobs.service';
import { AUTO_RELEASE_DAYS } from './dispute.service';


const SEVENTEEN_TRACK_KEY = process.env.TRACKING_17TRACK_KEY || '';
const API_BASE = 'https://api.17track.net/track/v2';

// Mappa carrier → codice 17track (0 = auto-detect)
export const CARRIERS: Record<string, { id: number; label: string }> = {
  'Auto':              { id: 0,      label: 'Auto-detect' },
  'BRT':               { id: 100006, label: 'BRT/Bartolini' },
  'GLS':               { id: 100156, label: 'GLS' },
  'Poste Italiane':    { id: 100001, label: 'Poste Italiane' },
  'SDA':               { id: 100035, label: 'SDA' },
  'DHL':               { id: 100002, label: 'DHL' },
  'UPS':               { id: 100003, label: 'UPS' },
  'FedEx':             { id: 100004, label: 'FedEx' },
  'TNT':               { id: 100011, label: 'TNT' },
  'Amazon Logistics':  { id: 100199, label: 'Amazon Logistics' },
  'Nexive':            { id: 100082, label: 'Nexive' },
};

// Mappa codice status 17track → status interno
const STATUS_MAP: Record<number, string> = {
  0:  'PENDING',
  10: 'IN_TRANSIT',
  20: 'EXCEPTION',
  30: 'IN_TRANSIT',   // Pickup
  35: 'EXCEPTION',    // Undelivered
  40: 'DELIVERED',
  50: 'EXCEPTION',    // Alert
};

export interface TrackingEvent {
  date: string;
  location: string;
  description: string;
}

export interface TrackingInfo {
  status: string;
  lastUpdate: string;
  history: TrackingEvent[];
  carrier?: string;
  estimatedDelivery?: string;
}

// ==========================================
// REGISTRA UN TRACKING SU 17TRACK
// ==========================================
async function register17Track(trackingCode: string, carrierKey: string): Promise<boolean> {
  if (!SEVENTEEN_TRACK_KEY) return false;

  const carrierId = CARRIERS[carrierKey]?.id ?? 0;
  try {
    const res = await fetch(`${API_BASE}/register`, {
      method: 'POST',
      headers: {
        '17token': SEVENTEEN_TRACK_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([{ number: trackingCode, carrier: carrierId }]),
    });
    const data = await res.json() as any;
    return data?.code === 0;
  } catch (err) {
    logger.error('17track register error', { err, trackingCode });
    return false;
  }
}

// ==========================================
// OTTIENI STATO TRACKING DA 17TRACK
// ==========================================
async function fetch17TrackStatus(trackingCode: string): Promise<TrackingInfo | null> {
  if (!SEVENTEEN_TRACK_KEY) return null;

  try {
    const res = await fetch(`${API_BASE}/gettrackinglist`, {
      method: 'POST',
      headers: {
        '17token': SEVENTEEN_TRACK_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([{ number: trackingCode }]),
    });
    const data = await res.json() as any;

    if (data?.code !== 0) return null;
    const item = data?.data?.accepted?.[0];
    if (!item) return null;

    const statusCode: number = item.track?.e ?? 0;
    const status = STATUS_MAP[statusCode] ?? 'PENDING';

    const rawEvents: any[] = item.track?.z ?? [];
    const history: TrackingEvent[] = rawEvents.map((ev: any) => ({
      date: ev.a || '',
      location: ev.c || '',
      description: ev.z || '',
    })).reverse();

    return {
      status,
      lastUpdate: new Date().toISOString(),
      history,
      carrier: item.track?.w_name,
      estimatedDelivery: item.track?.b,
    };
  } catch (err) {
    logger.error('17track fetch error', { err, trackingCode });
    return null;
  }
}

// ==========================================
// AGGIUNGI TRACKING A UN PRODOTTO
// ==========================================
export async function addTracking(productId: string, trackingCode: string, carrier: string, direction: 'INBOUND' | 'OUTBOUND' = 'OUTBOUND'): Promise<{ success: boolean; error?: string }> {
  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (!product) return { success: false, error: 'Prodotto non trovato' };
  // Nessun blocco per stato: INBOUND si usa su prodotti in stock (acquisto in arrivo),
  // OUTBOUND su prodotti venduti (spedizione al compratore). Entrambi validi.

  // Registra su 17track (non bloccante se fallisce — mostriamo comunque il tracking)
  await register17Track(trackingCode, carrier);

  await prisma.product.update({
    where: { id: productId },
    data: {
      trackingCode,
      trackingCarrier: carrier,
      trackingDirection: direction,
      trackingStatus: 'PENDING',
      trackingHistory: JSON.stringify([]),
      trackingUpdatedAt: new Date(),
    },
  });

  return { success: true };
}

// ==========================================
// AGGIORNA STATO TRACKING DI UN PRODOTTO
// ==========================================
export async function refreshTracking(productId: string): Promise<TrackingInfo | null> {
  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (!product?.trackingCode) return null;

  const info = await fetch17TrackStatus(product.trackingCode);

  if (info) {
    await prisma.product.update({
      where: { id: productId },
      data: {
        trackingStatus: info.status,
        trackingHistory: JSON.stringify(info.history),
        trackingUpdatedAt: new Date(),
      },
    });

    // Consegnato → applica gli effetti in base al senso della spedizione.
    if (info.status === 'DELIVERED') await applyDeliveredEffects(product);
  }

  return info;
}

// ==========================================
// EFFETTI DELLA CONSEGNA (condivisi tra polling API e stato manuale)
//  - INBOUND (acquisto): notifica "arrivato in magazzino", resta IN STOCK
//  - OUTBOUND (vendita): segna come venduto (dati da completare) + notifica + email
// ==========================================
async function applyDeliveredEffects(product: any): Promise<void> {
  if (product.trackingDirection === 'INBOUND') {
    if (product.warehouseId) {
      await notifyWarehouseMembers({
        warehouseId: product.warehouseId,
        excludeUserId: '',
        type: 'NEW_MEMBER',
        title: '📦 Pacco arrivato in magazzino',
        message: `${product.brand} ${product.name} è arrivato. Ora è disponibile in stock.`,
      });
    }
    logger.info('Pacco INBOUND consegnato in magazzino', { productId: product.id });
  } else if (product.status === 'PAGATO') {
    // Articolo pagato in-app (escrow marketplace): la consegna la CONFERMA il compratore
    // in chat (sblocca i fondi). Qui avviamo la finestra di auto-conferma: se entro
    // AUTO_RELEASE_DAYS il compratore non conferma né contesta, i fondi si sbloccano da soli.
    if (!product.deliveredAt) {
      const now = new Date();
      await prisma.product.update({
        where: { id: product.id },
        data: { deliveredAt: now, autoReleaseAt: new Date(now.getTime() + AUTO_RELEASE_DAYS * 86400000) },
      }).catch(() => {});
    }
    logger.info('Tracking consegnato su articolo PAGATO: avviata finestra auto-conferma', { productId: product.id });
  } else if (product.status !== 'VENDUTO') {
    await prisma.product.update({
      where: { id: product.id },
      data: { status: 'VENDUTO', soldAt: new Date(), salePrice: 0, fees: 0 },
    });
    if (product.warehouseId) {
      await notifyWarehouseMembers({
        warehouseId: product.warehouseId,
        excludeUserId: '',
        type: 'SALE',
        title: '📦 Spedizione consegnata!',
        message: `${product.brand} ${product.name} è stato consegnato. Completa la vendita con prezzo e piattaforma.`,
      });
    }
    sendDeliveredEmail(product.id).catch(() => {});
    logger.info('Prodotto auto-segnato come venduto dopo consegna', { productId: product.id });
  }
}

// ==========================================
// STATO MANUALE (senza API esterna): l'utente segna lo stato a mano.
// ==========================================
const VALID_STATUSES = ['PENDING', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'EXCEPTION', 'RETURNED'];
export async function setTrackingStatusManual(productId: string, status: string): Promise<{ success: boolean; error?: string }> {
  if (!VALID_STATUSES.includes(status)) return { success: false, error: 'Stato non valido' };
  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (!product) return { success: false, error: 'Prodotto non trovato' };
  await prisma.product.update({
    where: { id: productId },
    data: { trackingStatus: status, trackingUpdatedAt: new Date() },
  });
  if (status === 'DELIVERED') await applyDeliveredEffects(product);
  return { success: true };
}

// ==========================================
// RIMUOVI TRACKING DA UN PRODOTTO
// ==========================================
export async function removeTracking(productId: string): Promise<void> {
  await prisma.product.update({
    where: { id: productId },
    data: {
      trackingCode: null,
      trackingCarrier: null,
      trackingStatus: null,
      trackingHistory: null,
      trackingUpdatedAt: null,
    },
  });
}

// ==========================================
// POLLING AUTOMATICO (chiamato ogni 2 ore dal server)
// ==========================================
export async function pollAllActiveTrackings(): Promise<void> {
  const activeProducts = await prisma.product.findMany({
    where: {
      trackingCode: { not: null },
      trackingStatus: { in: ['PENDING', 'IN_TRANSIT', 'OUT_FOR_DELIVERY'] },
      status: { not: 'VENDUTO' },
    },
  });

  if (activeProducts.length === 0) return;
  logger.info(`Polling tracking per ${activeProducts.length} prodotti...`);

  for (const product of activeProducts) {
    try {
      await refreshTracking(product.id);
      // Pausa tra richieste per rispettare rate limit
      await new Promise(r => setTimeout(r, 500));
    } catch (err) {
      logger.error('Errore polling tracking', { productId: product.id, err });
    }
  }

  logger.info('Polling tracking completato');
}
