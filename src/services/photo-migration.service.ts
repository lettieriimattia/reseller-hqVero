// src/services/photo-migration.service.ts
// Migra le foto VECCHIE da base64 (pesanti, nel DB) a Cloudinary (URL leggeri).
// Gira AUTOMATICAMENTE all'avvio del server, in background, a piccoli lotti per non
// saturare la RAM (importante sul piano Free 512MB). Si ferma da sola quando finisce
// e segna un flag così non rigira inutilmente ai riavvii successivi.

import { prisma } from '../lib/prisma';
import { uploadImage, isCloudinaryConfigured } from './upload.service';
import { logger } from '../utils/logger';

const FLAG_KEY = 'photoMigrationCloudinaryV1';
const BATCH = 5;            // pochi prodotti per volta → niente picchi di RAM
const PAUSE_MS = 1500;      // respiro tra un lotto e l'altro

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function migratePhotosToCloudinary(): Promise<void> {
  if (!isCloudinaryConfigured()) {
    logger.info('[photo-migration] Cloudinary non configurato → salto la migrazione foto');
    return;
  }
  // Già completata in passato? non rigirare.
  const done = await prisma.setting.findUnique({ where: { key: FLAG_KEY } }).catch(() => null);
  if (done) return;

  let total = 0;
  try {
    for (;;) {
      const batch = await prisma.product.findMany({
        where: { deletedAt: null, photos: { contains: 'data:image' } },
        select: { id: true, photos: true },
        take: BATCH,
      });
      if (batch.length === 0) break;

      for (const p of batch) {
        let arr: string[] = [];
        try { arr = p.photos ? JSON.parse(p.photos) : []; } catch { arr = []; }
        if (!Array.isArray(arr) || arr.length === 0) {
          await prisma.product.update({ where: { id: p.id }, data: { photos: null } }).catch(() => {});
          continue;
        }
        const out: string[] = [];
        for (const img of arr) {
          if (typeof img === 'string' && img.startsWith('data:')) {
            const url = await uploadImage(img).catch(() => img); // se fallisce, tiene il base64
            out.push(url);
          } else {
            out.push(img);
          }
        }
        await prisma.product.update({ where: { id: p.id }, data: { photos: JSON.stringify(out) } }).catch(() => {});
        total++;
      }
      logger.info(`[photo-migration] migrati finora: ${total}`);
      await sleep(PAUSE_MS); // lascia respirare il processo
    }

    await prisma.setting.upsert({
      where: { key: FLAG_KEY },
      create: { key: FLAG_KEY, value: new Date().toISOString() },
      update: { value: new Date().toISOString() },
    }).catch(() => {});
    logger.info(`[photo-migration] completata: ${total} prodotti migrati su Cloudinary`);
  } catch (err: any) {
    // Non segniamo il flag: riproverà al prossimo avvio dal punto in cui è rimasta.
    logger.error('[photo-migration] errore', { err: err?.message, migratedFinora: total });
  }
}
