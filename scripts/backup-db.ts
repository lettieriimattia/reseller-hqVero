/**
 * BACKUP DATABASE — esporta TUTTE le tabelle del DB (Neon/Postgres) in un unico file JSON.
 *
 * Come si usa:
 *   npm run backup
 * (oppure: npx tsx scripts/backup-db.ts)
 *
 * Cosa fa:
 *  - Legge DATABASE_URL dal file .env (nessuna password scritta qui dentro).
 *  - Rileva DA SOLO tutte le tabelle dallo schema Prisma (le tabelle nuove entrano in automatico).
 *  - Salva tutto in  backups/backup-AAAA-MM-GG_HHmmss.json  con conteggi e metadati.
 *
 * NIENTE da installare: usa Prisma e tsx che hai già nel progetto.
 * NB: il file di backup contiene DATI REALI dei clienti → la cartella backups/ è in .gitignore
 *     (non finisce su GitHub). Tienilo in un posto sicuro (Google Drive / iCloud), non in chiaro.
 */
import 'dotenv/config';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { PrismaClient, Prisma } from '@prisma/client';

// JSON non sa serializzare i BigInt: li convertiamo in stringa.
function jsonReplacer(_key: string, value: unknown) {
  return typeof value === 'bigint' ? value.toString() : value;
}

// Nome tabella (PascalCase nello schema) -> proprietà del client Prisma (camelCase).
function toClientKey(modelName: string): string {
  return modelName.charAt(0).toLowerCase() + modelName.slice(1);
}

async function main() {
  // URL del DB da salvare, in ordine di priorità:
  //  1) argomento da riga di comando:  npm run backup -- "postgresql://...neon.tech/..."
  //  2) variabile d'ambiente BACKUP_DATABASE_URL
  //  3) DATABASE_URL del .env (in locale è SQLite → non va bene per il backup di produzione)
  const url = process.argv[2] || process.env.BACKUP_DATABASE_URL || process.env.DATABASE_URL || '';
  if (!/^postgres(ql)?:\/\//.test(url)) {
    console.error('❌ Serve l\'URL Postgres di PRODUZIONE (Neon). Quello locale è SQLite e non contiene i tuoi dati.');
    console.error('   Prendi DATABASE_URL da Render (Environment) e lancia:');
    console.error('   npm run backup -- "postgresql://...neon.tech/...?sslmode=require"');
    process.exit(1);
  }

  const prisma = new PrismaClient({ datasourceUrl: url });
  const models = Prisma.dmmf.datamodel.models; // tutte le tabelle dello schema
  const dump: Record<string, unknown[]> = {};
  const counts: Record<string, number> = {};

  console.log(`\n🗄️  Backup DB — ${models.length} tabelle da esportare...\n`);

  try {
    for (const model of models) {
      const key = toClientKey(model.name);
      const client = (prisma as any)[key];
      if (!client?.findMany) {
        console.warn(`  ⚠️  Salto ${model.name} (accessor non trovato).`);
        continue;
      }
      const rows = await client.findMany();
      dump[model.name] = rows;
      counts[model.name] = rows.length;
      console.log(`  ✓ ${model.name.padEnd(22)} ${rows.length} righe`);
    }

    // Cartella backups/ (creata se non esiste)
    const dir = join(process.cwd(), 'backups');
    mkdirSync(dir, { recursive: true });

    // Nome file con data+ora: backup-2026-07-06_2131.json
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const file = join(dir, `backup-${stamp}.json`);

    const totalRows = Object.values(counts).reduce((a, b) => a + b, 0);
    const payload = {
      _meta: {
        app: 'HQVault',
        createdAt: now.toISOString(),
        tables: Object.keys(dump).length,
        totalRows,
        counts,
      },
      data: dump,
    };

    writeFileSync(file, JSON.stringify(payload, jsonReplacer, 2), 'utf8');

    console.log(`\n✅ Backup completato: ${totalRows} righe in ${Object.keys(dump).length} tabelle`);
    console.log(`📁 File: ${file}\n`);
  } catch (err) {
    console.error('\n❌ Backup FALLITO:', (err as Error).message);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main();
