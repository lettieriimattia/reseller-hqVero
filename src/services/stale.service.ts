// src/services/stale.service.ts
// Rileva prodotti fermi in magazzino oltre la soglia, e genera notifiche di riepilogo
// con suggerimento di sconto basato su quanto tempo sono fermi.

import { PrismaClient } from '@prisma/client';
import { prisma } from "../lib/prisma";
import { notify } from './notification.service';
import { logger } from '../utils/logger';


export interface StaleProduct {
  id: string;
  brand: string;
  name: string;
  size: string;
  category: string;
  purchasePrice: number;
  marketPriceAvg?: number | null;
  daysInStock: number;
  suggestedDiscount: number; // percentuale 0-30
  suggestedPrice: number;
}

/**
 * Calcola la percentuale di sconto suggerita in base ai giorni di giacenza.
 * Logica:
 *  - tra soglia e soglia+30 giorni: 5%
 *  - tra soglia+30 e soglia+60: 10%
 *  - tra soglia+60 e soglia+90: 15%
 *  - oltre soglia+90: 20%
 */
function suggestDiscount(daysOverThreshold: number): number {
  if (daysOverThreshold < 30) return 5;
  if (daysOverThreshold < 60) return 10;
  if (daysOverThreshold < 90) return 15;
  return 20;
}

/**
 * Ritorna tutti i prodotti dell'utente fermi da più di `thresholdDays` giorni.
 */
export async function getStaleProducts(
  userId: string,
  thresholdDays: number
): Promise<StaleProduct[]> {
  const cutoff = new Date(Date.now() - thresholdDays * 24 * 60 * 60 * 1000);
  
  // Trova i warehouse di cui l'utente è membro
  const memberships = await prisma.membership.findMany({
    where: { userId },
    include: { warehouse: { include: { members: true } } },
  });
  
  const stale: StaleProduct[] = [];
  
  for (const m of memberships) {
    const categoryName = m.warehouse.name.replace('Magazzino ', '');
    const memberIds = m.warehouse.members.map(wm => wm.userId);
    
    const products = await prisma.product.findMany({
      where: {
        category: categoryName,
        userId: { in: memberIds },
        status: 'IN STOCK',
        createdAt: { lt: cutoff },
      },
    });
    
    for (const p of products) {
      const daysInStock = Math.floor(
        (Date.now() - p.createdAt.getTime()) / (24 * 60 * 60 * 1000)
      );
      const daysOver = daysInStock - thresholdDays;
      const discount = suggestDiscount(daysOver);
      
      // Calcolo prezzo consigliato:
      // 1. se ho un marketPriceAvg dall'IA → applico lo sconto su quello
      // 2. altrimenti applico un markup standard sul prezzo d'acquisto e poi lo sconto
      const basePrice = p.marketPriceAvg && p.marketPriceAvg > 0
        ? p.marketPriceAvg
        : p.purchasePrice * 1.3; // markup base 30%
      
      const suggestedPrice = Math.round(basePrice * (1 - discount / 100));
      
      stale.push({
        id: p.id,
        brand: p.brand,
        name: p.name,
        size: p.size,
        category: p.category,
        purchasePrice: p.purchasePrice,
        marketPriceAvg: p.marketPriceAvg,
        daysInStock,
        suggestedDiscount: discount,
        suggestedPrice,
      });
    }
  }
  
  // Ordino dal più fermo al meno fermo
  return stale.sort((a, b) => b.daysInStock - a.daysInStock);
}

/**
 * Crea una notifica di RIEPILOGO se ci sono prodotti fermi.
 * Evita di creare più notifiche al giorno usando un check ad-hoc.
 */
export async function checkAndNotifyStale(
  userId: string,
  thresholdDays: number
): Promise<{ created: boolean; staleCount: number; products: StaleProduct[] }> {
  const stale = await getStaleProducts(userId, thresholdDays);
  
  if (stale.length === 0) {
    return { created: false, staleCount: 0, products: [] };
  }
  
  // Controllo se ho già notificato l'utente nelle ultime 24h per non spammare
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const recent = await prisma.notification.findFirst({
    where: {
      userId,
      type: 'PRICE_ALERT',
      title: { contains: 'Prodotti fermi' },
      createdAt: { gt: yesterday },
    },
  });
  
  if (recent) {
    return { created: false, staleCount: stale.length, products: stale };
  }
  
  // Costruisco il messaggio di riepilogo
  const topProduct = stale[0];
  const message = stale.length === 1
    ? `${topProduct.brand} ${topProduct.name} è in magazzino da ${topProduct.daysInStock} giorni. Suggerimento: applica -${topProduct.suggestedDiscount}% (prezzo a €${topProduct.suggestedPrice}).`
    : `Hai ${stale.length} prodotti fermi da oltre ${thresholdDays} giorni. Il più vecchio è ${topProduct.brand} ${topProduct.name} (${topProduct.daysInStock}g). Suggerimento medio di sconto: -${Math.round(stale.reduce((s, x) => s + x.suggestedDiscount, 0) / stale.length)}%.`;
  
  await notify({
    userId,
    type: 'PRICE_ALERT',
    title: `⏰ Prodotti fermi (${stale.length})`,
    message,
    link: '/magazzino',
  });
  
  logger.info(`Notifica stale creata per utente ${userId}`, { staleCount: stale.length });
  
  return { created: true, staleCount: stale.length, products: stale };
}
