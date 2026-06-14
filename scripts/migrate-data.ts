// ==========================================================================
// Migrazione dati Railway → Neon (senza pg_dump: usa Prisma).
//
// USO:
//   1) npx prisma generate
//   2) crea lo schema vuoto su Neon:
//        DEST=<neon-url> e poi: cross-env DATABASE_URL=$DEST npx prisma db push
//      (lo facciamo a parte dal terminale)
//   3) copia i dati:
//        SOURCE_DATABASE_URL=<railway-public-url> \
//        DEST_DATABASE_URL=<neon-url> \
//        npx tsx scripts/migrate-data.ts
//
// Copia TUTTE le tabelle nell'ordine giusto (genitori prima dei figli) per
// rispettare le foreign key, preservando gli id originali (le relazioni
// restano intatte). Idempotente: usa skipDuplicates, quindi puoi rilanciarlo.
// ==========================================================================

import { PrismaClient } from '@prisma/client';

const SOURCE_URL = process.env.SOURCE_DATABASE_URL;
const DEST_URL = process.env.DEST_DATABASE_URL;

if (!SOURCE_URL || !DEST_URL) {
  console.error('❌ Servono SOURCE_DATABASE_URL (Railway) e DEST_DATABASE_URL (Neon).');
  process.exit(1);
}

const src = new PrismaClient({ datasources: { db: { url: SOURCE_URL } } });
const dst = new PrismaClient({ datasources: { db: { url: DEST_URL } } });

// Ordine FK-safe: i genitori prima dei figli.
const TABLES: { name: string; src: any; dst: any }[] = [
  { name: 'User',             src: () => src.user,             dst: () => dst.user },
  { name: 'Warehouse',        src: () => src.warehouse,        dst: () => dst.warehouse },
  { name: 'Membership',       src: () => src.membership,       dst: () => dst.membership },
  { name: 'Product',          src: () => src.product,          dst: () => dst.product },
  { name: 'RefreshToken',     src: () => src.refreshToken,     dst: () => dst.refreshToken },
  { name: 'AuditLog',         src: () => src.auditLog,         dst: () => dst.auditLog },
  { name: 'Notification',     src: () => src.notification,     dst: () => dst.notification },
  { name: 'MarketPrice',      src: () => src.marketPrice,      dst: () => dst.marketPrice },
  { name: 'CategoryTemplate', src: () => src.categoryTemplate, dst: () => dst.categoryTemplate },
  { name: 'InventoryLog',     src: () => src.inventoryLog,     dst: () => dst.inventoryLog },
  { name: 'Feedback',         src: () => src.feedback,         dst: () => dst.feedback },
  { name: 'PushSubscription', src: () => src.pushSubscription, dst: () => dst.pushSubscription },
  { name: 'Setting',          src: () => src.setting,          dst: () => dst.setting },
].map((t: any) => ({ name: t.name, src: t.src(), dst: t.dst() }));

const BATCH = 500;

async function main() {
  console.log('🔗 Connessione a Railway (sorgente) e Neon (destinazione)...\n');

  let totalCopied = 0;
  for (const t of TABLES) {
    const rows: any[] = await t.src.findMany();
    if (rows.length === 0) {
      console.log(`• ${t.name.padEnd(18)} 0 righe (niente da copiare)`);
      continue;
    }
    let copied = 0;
    for (let i = 0; i < rows.length; i += BATCH) {
      const slice = rows.slice(i, i + BATCH);
      const res = await t.dst.createMany({ data: slice, skipDuplicates: true });
      copied += res.count;
    }
    totalCopied += copied;
    const skipped = rows.length - copied;
    console.log(`✓ ${t.name.padEnd(18)} ${copied}/${rows.length} copiate${skipped ? ` (${skipped} gia' presenti, saltate)` : ''}`);
  }

  console.log(`\n✅ Migrazione completata. Righe nuove copiate: ${totalCopied}`);
}

main()
  .catch((e) => { console.error('\n❌ Errore migrazione:', e); process.exit(1); })
  .finally(async () => { await src.$disconnect(); await dst.$disconnect(); });
