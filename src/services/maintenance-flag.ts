// src/services/maintenance-flag.ts
// Flag "manutenzione" a RUNTIME (accendibile/spegnibile da Telegram senza redeploy).
// Persistito su Setting (key 'maintenance') così sopravvive ai riavvii. In OR con la env
// MAINTENANCE_MODE=1 (che resta valida per la manutenzione pianificata via deploy).

import { prisma } from '../lib/prisma';
import { logger } from '../utils/logger';

let runtimeOn = false;

export async function initMaintenanceFlag(): Promise<void> {
  try {
    const s = await prisma.setting.findUnique({ where: { key: 'maintenance' } });
    runtimeOn = s?.value === '1';
    if (runtimeOn) logger.warn('⚠️ Manutenzione ATTIVA (flag runtime da DB)');
  } catch (e: any) { logger.warn('initMaintenanceFlag', { err: e.message }); }
}

// ON se: env MAINTENANCE_MODE=1 OPPURE flag runtime attivo.
export function isMaintenanceOn(): boolean {
  return process.env.MAINTENANCE_MODE === '1' || runtimeOn;
}

export async function setMaintenance(on: boolean): Promise<void> {
  runtimeOn = on;
  await prisma.setting.upsert({
    where: { key: 'maintenance' },
    create: { key: 'maintenance', value: on ? '1' : '0' },
    update: { value: on ? '1' : '0' },
  }).catch((e: any) => logger.warn('setMaintenance', { err: e.message }));
  logger.warn(`Manutenzione ${on ? 'ATTIVATA' : 'DISATTIVATA'} (runtime)`);
}
