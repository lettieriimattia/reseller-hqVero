// ==========================================================================
// Migrazione: da "magazzino = reparto/categoria" a "magazzino = partnership".
//
// Cosa fa (NON DISTRUTTIVA — non cancella MAI prodotti):
//   - Per ogni utente sceglie/crea "Il mio magazzino" (il suo magazzino base, da solo).
//   - SPOSTA dentro "Il mio magazzino" tutti i prodotti dei suoi magazzini SOLO-utente
//     (warehouse di cui è OWNER e unico membro), cambiando solo warehouseId.
//   - I magazzini con ALTRI soci (più membri) restano separati (co-proprietà).
//     I sotto-magazzini con soci diventano top-level (parentId = null).
//   - Elimina solo i magazzini SOLO-utente rimasti vuoti (nessun prodotto perso).
//   - Crea un CategoryTemplate (campi vuoti) per ogni categoria prodotto mancante.
//
// USO:
//   Dry-run (default, non scrive nulla):
//     npx tsx scripts/migrate-warehouses-to-partners.ts
//   Applica davvero (FARE PRIMA UN BACKUP NEON):
//     npx tsx scripts/migrate-warehouses-to-partners.ts --apply
//
// Idempotente: rilanciabile senza danni.
// ==========================================================================

import { PrismaClient } from '@prisma/client';
import { generateInviteCode } from '../src/utils/security';

const APPLY = process.argv.includes('--apply');
const prisma = new PrismaClient();
const BASE_NAME = 'Il mio magazzino';

function log(...args: any[]) { console.log(APPLY ? '[APPLY]' : '[DRY] ', ...args); }

async function main() {
  log(`Avvio migrazione magazzini → partnership. Modalità: ${APPLY ? 'APPLICA' : 'DRY-RUN'}`);

  const users = await prisma.user.findMany({
    include: { memberships: { include: { warehouse: { include: { members: true } } } } },
  });
  log(`Utenti: ${users.length}`);

  let movedProducts = 0, deletedWh = 0, renamed = 0, createdBase = 0, flattened = 0;

  for (const user of users) {
    const ownTop = user.memberships
      .filter(m => m.role === 'OWNER' && !m.warehouse.parentId)
      .map(m => m.warehouse);
    const isSolo = (w: any) => (w.members?.length || 0) <= 1;

    // 1) Scegli o crea il magazzino base "Il mio magazzino"
    let base = ownTop.find(w => w.name === BASE_NAME)
      || ownTop.filter(isSolo).sort((a, b) => +new Date(a.createdAt) - +new Date(b.createdAt))[0]
      || null;

    if (!base) {
      // Nessun magazzino solo-utente: creane uno nuovo base.
      log(`  ${user.email}: creo "${BASE_NAME}" (nessun magazzino solo-utente)`);
      if (APPLY) {
        base = await prisma.warehouse.create({
          data: {
            name: BASE_NAME,
            inviteCode: generateInviteCode(),
            inviteCodeExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
            members: { create: [{ userId: user.id, role: 'OWNER', percentage: 100 }] },
          },
          include: { members: true },
        });
      }
      createdBase++;
    } else if (base.name !== BASE_NAME) {
      log(`  ${user.email}: rinomino "${base.name}" → "${BASE_NAME}"`);
      if (APPLY) await prisma.warehouse.update({ where: { id: base.id }, data: { name: BASE_NAME } });
      renamed++;
    }

    if (!base) continue; // dry-run senza base creata

    // 2) Sposta i prodotti dei magazzini SOLO-utente (diversi dal base) dentro il base
    const soloOthers = ownTop.filter(w => w.id !== base!.id && isSolo(w));
    for (const w of soloOthers) {
      const cnt = await prisma.product.count({ where: { warehouseId: w.id } });
      if (cnt > 0) {
        log(`  ${user.email}: sposto ${cnt} prodotti da "${w.name}" → "${BASE_NAME}"`);
        if (APPLY) await prisma.product.updateMany({ where: { warehouseId: w.id }, data: { warehouseId: base.id } });
        movedProducts += cnt;
      }
      // Magazzino solo-utente ora vuoto → eliminabile (nessun prodotto perso)
      log(`  ${user.email}: elimino magazzino vuoto "${w.name}"`);
      if (APPLY) await prisma.warehouse.delete({ where: { id: w.id } });
      deletedWh++;
    }

    // 3) Sotto-magazzini con soci → top-level (parentId = null)
    const subsWithPartners = user.memberships
      .filter(m => m.role === 'OWNER' && m.warehouse.parentId && !isSolo(m.warehouse))
      .map(m => m.warehouse);
    for (const sub of subsWithPartners) {
      log(`  ${user.email}: rendo top-level il sotto-magazzino "${sub.name}"`);
      if (APPLY) await prisma.warehouse.update({ where: { id: sub.id }, data: { parentId: null } });
      flattened++;
    }
  }

  // 4) CategoryTemplate per ogni categoria prodotto mancante (campi vuoti se assente)
  const cats = await prisma.product.findMany({ where: { deletedAt: null }, select: { category: true }, distinct: ['category'] });
  const existing = new Set((await prisma.categoryTemplate.findMany({ select: { name: true } })).map(t => t.name.toLowerCase()));
  for (const { category } of cats) {
    if (!category || existing.has(category.toLowerCase())) continue;
    log(`  Creo CategoryTemplate mancante: "${category}"`);
    if (APPLY) {
      await prisma.categoryTemplate.create({
        data: { name: category, icon: null, fields: JSON.stringify([]), isSystem: false },
      }).catch(() => {/* idempotente: già creato */});
    }
  }

  log('--- RIEPILOGO ---');
  log(`Prodotti spostati: ${movedProducts}`);
  log(`Magazzini base rinominati: ${renamed} · creati: ${createdBase}`);
  log(`Magazzini solo-utente eliminati (vuoti): ${deletedWh}`);
  log(`Sotto-magazzini resi top-level: ${flattened}`);
  if (!APPLY) log('Nessuna modifica scritta (dry-run). Rilancia con --apply dopo il backup.');
}

main()
  .catch(e => { console.error('Errore migrazione:', e); process.exit(1); })
  .finally(() => prisma.$disconnect());
