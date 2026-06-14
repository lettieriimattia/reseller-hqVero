// Confronto conteggi righe Railway (sorgente) vs Neon (destinazione).
import { PrismaClient } from '@prisma/client';

const src = new PrismaClient({ datasources: { db: { url: process.env.SOURCE_DATABASE_URL } } });
const dst = new PrismaClient({ datasources: { db: { url: process.env.DEST_DATABASE_URL } } });

const tables = ['user','warehouse','membership','product','refreshToken','auditLog','notification','marketPrice','categoryTemplate','inventoryLog','feedback','pushSubscription','setting'];

async function main() {
  console.log('Tabella'.padEnd(20) + 'Railway'.padEnd(10) + 'Neon'.padEnd(10) + 'Stato');
  console.log('-'.repeat(50));
  let allOk = true;
  for (const t of tables) {
    const a = await (src as any)[t].count();
    const b = await (dst as any)[t].count();
    const ok = b >= a;
    if (!ok) allOk = false;
    const flag = b === a ? 'OK' : b > a ? `+${b - a} su Neon (nuovi)` : `MANCANO ${a - b}!`;
    console.log(t.padEnd(20) + String(a).padEnd(10) + String(b).padEnd(10) + flag);
  }
  console.log('-'.repeat(50));
  console.log(allOk ? 'RISULTATO: Neon ha tutto (>= Railway). ✅' : 'RISULTATO: mancano dati su Neon! ❌');
}
main().catch(e => { console.error(e); process.exit(1); })
  .finally(async () => { await src.$disconnect(); await dst.$disconnect(); });
