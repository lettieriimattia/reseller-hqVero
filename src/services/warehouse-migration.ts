// ==========================================================================
// Migrazione: da "magazzino = reparto/categoria" a "magazzino = partnership".
// NON DISTRUTTIVA: non cancella MAI prodotti (li sposta in "Il mio magazzino").
// Idempotente: rilanciabile senza danni. Usata sia dallo script CLI
// (scripts/migrate-warehouses-to-partners.ts) sia dall'avvio del server
// (guardata da env RUN_WAREHOUSE_MIGRATION).
// ==========================================================================

import { PrismaClient } from '@prisma/client';
import { generateInviteCode } from '../utils/security';

export const BASE_WAREHOUSE_NAME = 'Il mio magazzino';

export interface MigrationSummary {
  apply: boolean;
  users: number;
  movedProducts: number;
  renamedBase: number;
  createdBase: number;
  deletedEmpty: number;
  flattenedSubs: number;
  createdCategories: number;
}

export async function migrateWarehousesToPartners(
  prisma: PrismaClient,
  apply: boolean,
  log: (...a: any[]) => void = console.log,
): Promise<MigrationSummary> {
  const tag = apply ? '[APPLY]' : '[DRY] ';
  log(`${tag} Migrazione magazzini → partnership`);

  const summary: MigrationSummary = {
    apply, users: 0, movedProducts: 0, renamedBase: 0, createdBase: 0,
    deletedEmpty: 0, flattenedSubs: 0, createdCategories: 0,
  };

  const users = await prisma.user.findMany({
    include: { memberships: { include: { warehouse: { include: { members: true } } } } },
  });
  summary.users = users.length;

  for (const user of users) {
    const ownTop = user.memberships
      .filter(m => m.role === 'OWNER' && !m.warehouse.parentId)
      .map(m => m.warehouse);
    const isSolo = (w: any) => (w.members?.length || 0) <= 1;

    // 1) Scegli o crea il magazzino base "Il mio magazzino"
    let base: any = ownTop.find(w => w.name === BASE_WAREHOUSE_NAME)
      || ownTop.filter(isSolo).sort((a, b) => +new Date(a.createdAt) - +new Date(b.createdAt))[0]
      || null;

    if (!base) {
      log(`${tag} ${user.email}: creo "${BASE_WAREHOUSE_NAME}"`);
      if (apply) {
        base = await prisma.warehouse.create({
          data: {
            name: BASE_WAREHOUSE_NAME,
            inviteCode: generateInviteCode(),
            inviteCodeExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
            members: { create: [{ userId: user.id, role: 'OWNER', percentage: 100 }] },
          },
          include: { members: true },
        });
      }
      summary.createdBase++;
    } else if (base.name !== BASE_WAREHOUSE_NAME) {
      log(`${tag} ${user.email}: rinomino "${base.name}" → "${BASE_WAREHOUSE_NAME}"`);
      if (apply) await prisma.warehouse.update({ where: { id: base.id }, data: { name: BASE_WAREHOUSE_NAME } });
      summary.renamedBase++;
    }

    if (!base) continue; // dry-run senza base creata: salta gli spostamenti

    // 2) Sposta i prodotti dei magazzini SOLO-utente (diversi dal base) nel base
    const soloOthers = ownTop.filter(w => w.id !== base.id && isSolo(w));
    for (const w of soloOthers) {
      const cnt = await prisma.product.count({ where: { warehouseId: w.id } });
      if (cnt > 0) {
        log(`${tag} ${user.email}: sposto ${cnt} prodotti da "${w.name}" → base`);
        if (apply) await prisma.product.updateMany({ where: { warehouseId: w.id }, data: { warehouseId: base.id } });
        summary.movedProducts += cnt;
      }
      log(`${tag} ${user.email}: elimino magazzino vuoto "${w.name}"`);
      if (apply) await prisma.warehouse.delete({ where: { id: w.id } });
      summary.deletedEmpty++;
    }

    // 3) Sotto-magazzini con soci → top-level
    const subsWithPartners = user.memberships
      .filter(m => m.role === 'OWNER' && m.warehouse.parentId && !isSolo(m.warehouse))
      .map(m => m.warehouse);
    for (const sub of subsWithPartners) {
      log(`${tag} ${user.email}: rendo top-level "${sub.name}"`);
      if (apply) await prisma.warehouse.update({ where: { id: sub.id }, data: { parentId: null } });
      summary.flattenedSubs++;
    }
  }

  // 4) CategoryTemplate per ogni categoria prodotto mancante (campi vuoti)
  const cats = await prisma.product.findMany({ where: { deletedAt: null }, select: { category: true }, distinct: ['category'] });
  const existing = new Set((await prisma.categoryTemplate.findMany({ select: { name: true } })).map(t => t.name.toLowerCase()));
  for (const { category } of cats) {
    if (!category || existing.has(category.toLowerCase())) continue;
    log(`${tag} Creo CategoryTemplate mancante: "${category}"`);
    if (apply) {
      await prisma.categoryTemplate.create({
        data: { name: category, icon: null, fields: JSON.stringify([]), isSystem: false },
      }).catch(() => {/* idempotente */});
    }
    summary.createdCategories++;
  }

  log(`${tag} RIEPILOGO`, JSON.stringify(summary));
  return summary;
}
