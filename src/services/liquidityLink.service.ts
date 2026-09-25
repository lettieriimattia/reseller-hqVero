// src/services/liquidityLink.service.ts
// Collegamento Liquidità ↔ acquisti/vendite.
// Un acquisto o una vendita è un GRUPPO: i pezzi coinvolti (LiquidityLink) + le parti del pagamento
// (LiquidityMovement con lo stesso groupId). L'importo del gruppo si ricalcola SEMPRE dai pezzi:
//   acquisto = Σ round(prezzo d'acquisto × quota × 100)       (pezzi non eliminati)
//   vendita  = Σ round((prezzo di vendita − fee) × quota × 100) (pezzi non eliminati e ancora VENDUTI)
// e le parti vengono ridistribuite in proporzione al loro peso originale → la somma torna sempre.
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';

type Tx = Prisma.TransactionClient;
export type Role = 'PURCHASE' | 'SALE';
export interface PartInput { accountId?: string | null; personId?: string | null; personName?: string | null; amountCents: number }

export class LinkError extends Error { status: number; constructor(msg: string, status = 400) { super(msg); this.status = status; } }

// Importo di un pezzo nel gruppo (centesimi). Stessa formula usata dall'app per proporre il totale.
export function pieceCents(role: Role, p: { purchasePrice: number; salePrice: number | null; fees: number | null; status: string; deletedAt: Date | null }, factor: number): number {
  if (p.deletedAt) return 0;
  if (role === 'PURCHASE') return Math.max(0, Math.round((p.purchasePrice || 0) * factor * 100));
  if (p.status !== 'VENDUTO') return 0;
  return Math.max(0, Math.round(((p.salePrice || 0) - (p.fees || 0)) * factor * 100));
}

async function expectedCents(tx: Tx, groupId: string): Promise<{ role: Role; cents: number; userId: string } | null> {
  const links = await tx.liquidityLink.findMany({ where: { groupId } });
  if (links.length === 0) return null;
  const products = await tx.product.findMany({ where: { id: { in: links.map(l => l.productId) } } });
  const byId = new Map(products.map(p => [p.id, p]));
  const role = links[0].role as Role;
  const cents = links.reduce((s, l) => { const p = byId.get(l.productId); return s + (p ? pieceCents(role, p as any, l.factor) : 0); }, 0);
  return { role, cents, userId: links[0].userId };
}

// Divide `total` in proporzione ai pesi; il resto dei centesimi va alle parti più grandi (somma esatta).
export function distribute(total: number, weights: number[]): number[] {
  const W = weights.reduce((a, b) => a + b, 0);
  if (weights.length === 0) return [];
  const w = W > 0 ? weights : weights.map(() => 1);
  const WW = W > 0 ? W : weights.length;
  const base = w.map(x => Math.floor((total * x) / WW));
  let rest = total - base.reduce((a, b) => a + b, 0);
  const order = w.map((x, i) => ({ x, i })).sort((a, b) => b.x - a.x);
  for (let k = 0; rest > 0; k = (k + 1) % order.length, rest--) base[order[k].i]++;
  return base;
}

// Ricalcola gli importi delle parti di un gruppo (dopo modifiche/eliminazioni/ripristini/resi).
export async function recalcGroup(tx: Tx, groupId: string) {
  const exp = await expectedCents(tx, groupId);
  const moves = await tx.liquidityMovement.findMany({ where: { groupId }, orderBy: { createdAt: 'asc' } });
  if (moves.length === 0) return;
  const total = exp ? exp.cents : 0;
  const amounts = distribute(total, moves.map(m => m.weightCents ?? m.amountCents));
  await Promise.all(moves.map((m, i) => (m.amountCents === amounts[i] ? null : tx.liquidityMovement.update({ where: { id: m.id }, data: { amountCents: amounts[i] } }))));
}

// Da chiamare dopo QUALSIASI modifica di un pezzo: ricalcola tutti i gruppi in cui compare.
export async function recalcForProducts(productIds: string[]) {
  if (productIds.length === 0) return;
  const links = await prisma.liquidityLink.findMany({ where: { productId: { in: productIds } }, select: { groupId: true } });
  const groups = [...new Set(links.map(l => l.groupId))];
  for (const g of groups) await prisma.$transaction(tx => recalcGroup(tx, g));
}

// Reso: il pezzo esce dai gruppi di VENDITA (se verrà rivenduto, nascerà un gruppo nuovo).
export async function unlinkSale(productId: string) {
  const links = await prisma.liquidityLink.findMany({ where: { productId, role: 'SALE' } });
  for (const l of links) {
    await prisma.$transaction(async tx => {
      await tx.liquidityLink.delete({ where: { id: l.id } });
      await recalcGroup(tx, l.groupId);
    });
  }
}

// Trasforma le parti del pagamento in movimenti. Acquisto: DA conto/persona → esterno. Vendita: esterno → A conto/persona.
async function writeParts(tx: Tx, userId: string, groupId: string, role: Role, parts: PartInput[], date: Date, note: string) {
  for (const part of parts) {
    let personId = part.personId || null;
    if (!part.accountId && !personId) {
      const name = String(part.personName || '').trim().replace(/\s+/g, ' ').slice(0, 60);
      if (!name) throw new LinkError('Scegli un conto o una persona per ogni parte del pagamento');
      const ex = await tx.liquidityPerson.findFirst({ where: { userId, name: { equals: name, mode: 'insensitive' } } });
      personId = ex ? ex.id : (await tx.liquidityPerson.create({ data: { userId, name } })).id;
    }
    const side = part.accountId ? { account: part.accountId } : { person: personId as string };
    await tx.liquidityMovement.create({ data: {
      userId, groupId, kind: role, date, note, amountCents: part.amountCents, weightCents: part.amountCents,
      ...(role === 'PURCHASE'
        ? ('account' in side ? { fromAccountId: side.account } : { fromPersonId: side.person })
        : ('account' in side ? { toAccountId: side.account } : { toPersonId: side.person })),
    } });
  }
}

async function validateParts(tx: Tx, userId: string, parts: PartInput[]) {
  if (!Array.isArray(parts) || parts.length === 0 || parts.length > 10) throw new LinkError('Indica da dove escono o dove entrano i soldi');
  for (const p of parts) {
    if (!Number.isInteger(p.amountCents) || p.amountCents < 0) throw new LinkError('Importo non valido');
    if (p.accountId && (p.personId || p.personName)) throw new LinkError('Ogni parte è un conto OPPURE una persona');
  }
  const accIds = [...new Set(parts.map(p => p.accountId).filter(Boolean))] as string[];
  if (accIds.length && (await tx.liquidityAccount.count({ where: { id: { in: accIds }, userId } })) !== accIds.length) throw new LinkError('Conto non trovato', 404);
  const perIds = [...new Set(parts.map(p => p.personId).filter(Boolean))] as string[];
  if (perIds.length && (await tx.liquidityPerson.count({ where: { id: { in: perIds }, userId } })) !== perIds.length) throw new LinkError('Persona non trovata', 404);
}

const describe = (products: { brand: string; name: string }[], role: Role) => {
  const first = products[0] ? `${products[0].brand} ${products[0].name}`.trim() : '';
  const more = products.length > 1 ? ` (+${products.length - 1})` : '';
  return `${role === 'PURCHASE' ? 'Acquisto' : 'Vendita'}: ${first}${more}`.slice(0, 300);
};

// Crea il gruppo di un acquisto o di una vendita appena fatti. La somma delle parti deve essere il totale.
export async function createGroup(userId: string, role: Role, productIds: string[], factors: Record<string, number>, parts: PartInput[], date?: Date) {
  if (!['PURCHASE', 'SALE'].includes(role)) throw new LinkError('Operazione non valida');
  const ids = [...new Set(productIds)].slice(0, 200);
  if (ids.length === 0) throw new LinkError('Nessun pezzo indicato');
  return prisma.$transaction(async tx => {
    const products = await tx.product.findMany({ where: { id: { in: ids } } });
    if (products.length !== ids.length) throw new LinkError('Pezzo non trovato', 404);
    // I pezzi devono appartenere a un magazzino dell'utente
    const whIds = [...new Set(products.map(p => p.warehouseId))];
    const mem = await tx.membership.count({ where: { userId, warehouseId: { in: whIds } } });
    if (mem < whIds.length) throw new LinkError('Non hai accesso a questi pezzi', 403);
    if (role === 'SALE' && products.some(p => p.status !== 'VENDUTO')) throw new LinkError('Registra prima la vendita dei pezzi');
    const already = await tx.liquidityLink.count({ where: { productId: { in: ids }, role } });
    if (already > 0) throw new LinkError(role === 'SALE' ? 'Questa vendita ha già un incasso collegato: cambialo dalla scheda del pezzo' : 'Questo acquisto ha già un pagamento collegato: cambialo dalla scheda del pezzo');
    await validateParts(tx, userId, parts);
    const factorOf = (id: string) => { const f = Number(factors?.[id]); return Number.isFinite(f) && f >= 0 && f <= 1 ? f : 1; };
    const total = products.reduce((s, p) => s + pieceCents(role, p as any, factorOf(p.id)), 0);
    const sum = parts.reduce((s, p) => s + p.amountCents, 0);
    if (sum !== total) throw new LinkError(`La somma delle parti (${(sum / 100).toFixed(2)} €) deve essere uguale al totale (${(total / 100).toFixed(2)} €)`);
    const groupId = `g_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    await tx.liquidityLink.createMany({ data: products.map(p => ({ userId, groupId, productId: p.id, role, factor: factorOf(p.id) })) });
    const when = date || (role === 'SALE' ? (products[0].soldAt || new Date()) : new Date());
    await writeParts(tx, userId, groupId, role, parts, when, describe(products, role));
    return { groupId, totalCents: total };
  });
}

// Cambia la FONTE di un pagamento già collegato (es. Contanti → Revolut). Il totale resta quello attuale.
export async function replaceParts(userId: string, groupId: string, parts: PartInput[]) {
  return prisma.$transaction(async tx => {
    const exp = await expectedCents(tx, groupId);
    if (!exp || exp.userId !== userId) throw new LinkError('Pagamento non trovato', 404);
    await validateParts(tx, userId, parts);
    const sum = parts.reduce((s, p) => s + p.amountCents, 0);
    if (sum !== exp.cents) throw new LinkError(`La somma delle parti (${(sum / 100).toFixed(2)} €) deve essere uguale al totale (${(exp.cents / 100).toFixed(2)} €)`);
    const old = await tx.liquidityMovement.findFirst({ where: { groupId }, orderBy: { createdAt: 'asc' } });
    await tx.liquidityMovement.deleteMany({ where: { groupId } });
    await writeParts(tx, userId, groupId, exp.role, parts, old?.date || new Date(), old?.note || '');
    return { groupId, totalCents: exp.cents };
  });
}

// Pagamenti collegati a un pezzo (per la scheda): gruppo, ruolo, totale e parti con i nomi.
export async function linksForProduct(userId: string, productId: string) {
  const links = await prisma.liquidityLink.findMany({ where: { productId, userId } });
  const out = [];
  for (const l of links) {
    const moves = await prisma.liquidityMovement.findMany({
      where: { groupId: l.groupId }, orderBy: { createdAt: 'asc' },
      include: { fromAccount: { select: { name: true } }, toAccount: { select: { name: true } }, fromPerson: { select: { name: true } }, toPerson: { select: { name: true } } },
    });
    const count = await prisma.liquidityLink.count({ where: { groupId: l.groupId } });
    out.push({
      groupId: l.groupId, role: l.role, pieces: count, totalCents: moves.reduce((s, m) => s + m.amountCents, 0),
      parts: moves.map(m => ({
        amountCents: m.amountCents,
        accountId: m.fromAccountId || m.toAccountId, personId: m.fromPersonId || m.toPersonId,
        name: m.fromAccount?.name || m.toAccount?.name || m.fromPerson?.name || m.toPerson?.name || '',
        isPerson: !!(m.fromPersonId || m.toPersonId),
      })),
    });
  }
  return out;
}
