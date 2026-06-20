// Client Prisma CONDIVISO (singleton).
//
// Prima ogni file di route/service faceva `new PrismaClient()`: ~25 istanze, ognuna
// con il proprio pool di connessioni → spreco di RAM e di connessioni verso Neon
// (causa di OOM/limiti connessioni). Qui ne teniamo UNA sola, riusata ovunque.
//
// Il cache su globalThis evita istanze duplicate anche con hot-reload (tsx watch).

import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as { __prisma?: PrismaClient };

export const prisma: PrismaClient = globalForPrisma.__prisma ?? new PrismaClient();

if (!globalForPrisma.__prisma) globalForPrisma.__prisma = prisma;
