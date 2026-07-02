// src/services/maintenance.ts
// Manutenzione DB periodica (domenica notte). NON tocca la logica dell'app: pulisce solo
// dati "usa e getta" per tenere il database leggero e veloce.
//  - Catalogo (CatalogItem): è solo CACHE → tiene i più usati/recenti, elimina l'eccesso.
//  - Log (AuditLog, InventoryLog): retention (default 12 mesi).
// Tutto difensivo: ogni errore è isolato, non blocca nulla.

import cron from 'node-cron';
import { prisma } from '../lib/prisma';
import { logger } from '../utils/logger';

const CATALOG_KEEP = Math.max(Number(process.env.CATALOG_KEEP || 6000), 500);
const LOG_RETENTION_DAYS = Math.max(Number(process.env.LOG_RETENTION_DAYS || 365), 60);

// Tiene i CATALOG_KEEP item più usati/recenti, elimina il resto (la cache si ricostruisce da sola).
async function pruneCatalog(): Promise<{ deleted: number; kept: number }> {
  const total = await prisma.catalogItem.count();
  if (total <= CATALOG_KEEP) return { deleted: 0, kept: total };
  const toDelete = await prisma.catalogItem.findMany({
    orderBy: [{ useCount: 'asc' }, { updatedAt: 'asc' }],
    take: total - CATALOG_KEEP,
    select: { id: true },
  });
  if (!toDelete.length) return { deleted: 0, kept: total };
  const r = await prisma.catalogItem.deleteMany({ where: { id: { in: toDelete.map(d => d.id) } } });
  return { deleted: r.count, kept: total - r.count };
}

// Retention log: elimina audit/inventory log più vecchi di LOG_RETENTION_DAYS.
async function pruneLogs(): Promise<{ audit: number; inventory: number }> {
  const cutoff = new Date(Date.now() - LOG_RETENTION_DAYS * 86400000);
  const audit = await prisma.auditLog.deleteMany({ where: { createdAt: { lt: cutoff } } }).catch(() => ({ count: 0 }));
  const inventory = await prisma.inventoryLog.deleteMany({ where: { createdAt: { lt: cutoff } } }).catch(() => ({ count: 0 }));
  return { audit: audit.count, inventory: inventory.count };
}

export async function runMaintenance(): Promise<void> {
  try {
    const catalog = await pruneCatalog().catch((e: any) => { logger.warn('pruneCatalog', { err: e.message }); return { deleted: 0, kept: -1 }; });
    const logs = await pruneLogs().catch((e: any) => { logger.warn('pruneLogs', { err: e.message }); return { audit: 0, inventory: 0 }; });
    logger.info('🧹 Manutenzione DB eseguita', { catalog, logs, retentionDays: LOG_RETENTION_DAYS });
  } catch (e: any) {
    logger.warn('Manutenzione DB errore', { err: e.message });
  }
}

export function startMaintenance(): void {
  // Domenica 04:00 Europe/Rome (bassa attività → zero impatto sull'uso).
  cron.schedule('0 4 * * 0', () => { void runMaintenance(); }, { timezone: 'Europe/Rome' });
  logger.info('🧹 Manutenzione DB schedulata (domenica 04:00 Europe/Rome)');
  if (process.env.RUN_MAINTENANCE_NOW === '1') void runMaintenance();
}
