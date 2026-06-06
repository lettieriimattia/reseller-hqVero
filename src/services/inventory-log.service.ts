// src/services/inventory-log.service.ts
// Pilastro 1 & 2: Append-only log di ogni mutazione su Product.
// Mai modificare o eliminare righe — solo aggiungere.

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export type InventoryAction =
  | 'STATUS_CHANGE'
  | 'PRICE_CHANGE'
  | 'ATTR_CHANGE'
  | 'RESERVE'
  | 'RELEASE'
  | 'SOFT_DELETE'
  | 'RESTORE';

export async function logInventory(opts: {
  productId: string;
  userId: string;
  action: InventoryAction;
  field?: string;
  oldValue?: string | number | null;
  newValue?: string | number | null;
  note?: string;
}): Promise<void> {
  try {
    await prisma.inventoryLog.create({
      data: {
        productId: opts.productId,
        userId: opts.userId,
        action: opts.action,
        field: opts.field ?? null,
        oldValue: opts.oldValue != null ? String(opts.oldValue) : null,
        newValue: opts.newValue != null ? String(opts.newValue) : null,
        note: opts.note ?? null,
      },
    });
  } catch {
    // Non bloccante — un errore di log non deve far fallire l'operazione principale
  }
}
