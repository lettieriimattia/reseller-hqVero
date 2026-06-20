// ==========================================================================
// CLI per la migrazione magazzini → partnership (logica in
// src/services/warehouse-migration.ts). NON DISTRUTTIVA.
//
// USO (serve DATABASE_URL del DB reale nell'ambiente):
//   Dry-run (default, non scrive):  npx tsx scripts/migrate-warehouses-to-partners.ts
//   Applica (dopo backup Neon):     npx tsx scripts/migrate-warehouses-to-partners.ts --apply
//
// In alternativa si esegue su Render via env RUN_WAREHOUSE_MIGRATION (vedi server.ts).
// ==========================================================================

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { migrateWarehousesToPartners } from '../src/services/warehouse-migration';

const APPLY = process.argv.includes('--apply');
const prisma = new PrismaClient();

migrateWarehousesToPartners(prisma, APPLY)
  .then(() => { if (!APPLY) console.log('Dry-run: nessuna modifica scritta. Rilancia con --apply dopo il backup.'); })
  .catch(e => { console.error('Errore migrazione:', e); process.exit(1); })
  .finally(() => prisma.$disconnect());
