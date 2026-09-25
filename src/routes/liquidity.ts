// src/routes/liquidity.ts
// LIQUIDITÀ personale dell'utente (i soci non la vedono): conti, persone (crediti/debiti) e movimenti.
// REGOLA: i saldi non si scrivono mai. Derivano dai movimenti:
//   saldo(conto | persona) = Σ movimenti in entrata − Σ movimenti in uscita
//   persona: positivo = mi deve (credito), negativo = le devo (debito)
//   TOTALE = Σ conti + Σ persone (crediti − debiti)
// Ogni movimento sposta amountCents DA una sorgente A una destinazione (conto, persona o esterno = null).
import { Router, Response } from 'express';
import { prisma } from '../lib/prisma';
import { authenticate, AuthRequest } from '../middleware/auth';
import { logger } from '../utils/logger';

const router = Router();
router.use(authenticate);

const ACCOUNT_TYPES = ['CASH', 'BANK', 'CRYPTO', 'PLATFORM', 'OTHER'];
type Side = 'account' | 'person' | 'none' | 'account?';
// Per ogni tipo di operazione: cosa deve essere la sorgente (from) e la destinazione (to).
const KINDS: Record<string, { from: Side; to: Side }> = {
  OPENING:         { from: 'none',     to: 'account' },  // saldo iniziale positivo
  OPENING_NEG:     { from: 'account',  to: 'none' },     // saldo iniziale negativo (es. conto in rosso)
  DEPOSIT:         { from: 'none',     to: 'account' },  // aggiungi soldi
  WITHDRAW:        { from: 'account',  to: 'none' },     // togli soldi
  TRANSFER:        { from: 'account',  to: 'account' },  // tra conti
  CREDIT:          { from: 'account?', to: 'person' },   // mi deve (se gli ho dato soldi: da un conto)
  DEBT:            { from: 'person',   to: 'account?' }, // gli devo (se mi ha dato soldi: su un conto)
  SETTLE_IN:       { from: 'person',   to: 'account' },  // mi paga (anche in parte o più del dovuto)
  SETTLE_OUT:      { from: 'account',  to: 'person' },   // lo pago io
  PERSON_TRANSFER: { from: 'person',   to: 'person' },   // una persona paga un'altra per conto mio
};
const MAX_CENTS = 100_000_000_00; // 100 milioni di €

const uid = (req: AuthRequest) => req.user!.userId;
const cleanName = (s: any, max = 60) => String(s ?? '').trim().replace(/\s+/g, ' ').slice(0, max);

async function balances(userId: string) {
  const [accounts, people, inA, outA, inP, outP] = await Promise.all([
    prisma.liquidityAccount.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } }),
    prisma.liquidityPerson.findMany({ where: { userId }, orderBy: { name: 'asc' } }),
    prisma.liquidityMovement.groupBy({ by: ['toAccountId'], where: { userId, toAccountId: { not: null } }, _sum: { amountCents: true } }),
    prisma.liquidityMovement.groupBy({ by: ['fromAccountId'], where: { userId, fromAccountId: { not: null } }, _sum: { amountCents: true } }),
    prisma.liquidityMovement.groupBy({ by: ['toPersonId'], where: { userId, toPersonId: { not: null } }, _sum: { amountCents: true } }),
    prisma.liquidityMovement.groupBy({ by: ['fromPersonId'], where: { userId, fromPersonId: { not: null } }, _sum: { amountCents: true } }),
  ]);
  const sum = (rows: any[], key: string) => new Map(rows.map(r => [r[key], r._sum.amountCents || 0]));
  const ia = sum(inA, 'toAccountId'), oa = sum(outA, 'fromAccountId'), ip = sum(inP, 'toPersonId'), op = sum(outP, 'fromPersonId');
  const acc = accounts.map(a => ({ id: a.id, name: a.name, type: a.type, archived: a.archived, balanceCents: (ia.get(a.id) || 0) - (oa.get(a.id) || 0) }));
  const ppl = people.map(p => ({ id: p.id, name: p.name, note: p.note, archived: p.archived, balanceCents: (ip.get(p.id) || 0) - (op.get(p.id) || 0) }));
  const totalCents = acc.reduce((s, a) => s + a.balanceCents, 0) + ppl.reduce((s, p) => s + p.balanceCents, 0);
  return { accounts: acc, people: ppl, totalCents };
}

// GET /liquidity — conti, persone e totale (tutti calcolati dai movimenti)
router.get('/', async (req: AuthRequest, res: Response) => {
  try { res.json(await balances(uid(req))); }
  catch (err: any) { logger.error('Errore GET /liquidity', { err: err.message }); res.status(500).json({ error: 'Errore nel caricare la liquidità' }); }
});

// GET /liquidity/movements?accountId=…|personId=… — storico (più recenti prima)
router.get('/movements', async (req: AuthRequest, res: Response) => {
  try {
    const userId = uid(req);
    const accountId = req.query.accountId ? String(req.query.accountId) : null;
    const personId = req.query.personId ? String(req.query.personId) : null;
    const where: any = { userId };
    if (accountId) where.OR = [{ fromAccountId: accountId }, { toAccountId: accountId }];
    if (personId) where.OR = [{ fromPersonId: personId }, { toPersonId: personId }];
    const rows = await prisma.liquidityMovement.findMany({
      where, orderBy: [{ date: 'desc' }, { createdAt: 'desc' }], take: Math.min(500, Number(req.query.limit) || 300),
      include: { fromAccount: { select: { name: true } }, toAccount: { select: { name: true } }, fromPerson: { select: { name: true } }, toPerson: { select: { name: true } } },
    });
    res.json(rows.map(m => ({
      id: m.id, date: m.date, amountCents: m.amountCents, kind: m.kind, note: m.note,
      fromAccountId: m.fromAccountId, toAccountId: m.toAccountId, fromPersonId: m.fromPersonId, toPersonId: m.toPersonId,
      from: m.fromAccount?.name || m.fromPerson?.name || null, to: m.toAccount?.name || m.toPerson?.name || null,
    })));
  } catch (err: any) { logger.error('Errore GET /liquidity/movements', { err: err.message }); res.status(500).json({ error: 'Errore nel caricare i movimenti' }); }
});

// POST /liquidity/accounts { name, type, initialCents } — il saldo iniziale diventa un movimento
router.post('/accounts', async (req: AuthRequest, res: Response) => {
  try {
    const userId = uid(req);
    const name = cleanName(req.body?.name);
    const type = String(req.body?.type || 'OTHER').toUpperCase();
    const initial = Math.round(Number(req.body?.initialCents) || 0);
    if (!name) return res.status(400).json({ error: 'Dai un nome al conto' });
    if (!ACCOUNT_TYPES.includes(type)) return res.status(400).json({ error: 'Tipo di conto non valido' });
    if (Math.abs(initial) > MAX_CENTS) return res.status(400).json({ error: 'Importo troppo grande' });
    const account = await prisma.$transaction(async tx => {
      const a = await tx.liquidityAccount.create({ data: { userId, name, type } });
      if (initial !== 0) {
        await tx.liquidityMovement.create({ data: {
          userId, kind: initial > 0 ? 'OPENING' : 'OPENING_NEG', amountCents: Math.abs(initial), note: 'Saldo iniziale',
          ...(initial > 0 ? { toAccountId: a.id } : { fromAccountId: a.id }),
        } });
      }
      return a;
    });
    res.status(201).json({ id: account.id });
  } catch (err: any) { logger.error('Errore POST /liquidity/accounts', { err: err.message }); res.status(500).json({ error: 'Errore nel creare il conto' }); }
});

// PATCH /liquidity/accounts/:id { name?, type?, archived? } — il saldo NON si modifica qui
router.patch('/accounts/:id', async (req: AuthRequest, res: Response) => {
  try {
    const a = await prisma.liquidityAccount.findFirst({ where: { id: req.params.id, userId: uid(req) } });
    if (!a) return res.status(404).json({ error: 'Conto non trovato' });
    const data: any = {};
    if (req.body?.name !== undefined) { const n = cleanName(req.body.name); if (!n) return res.status(400).json({ error: 'Nome non valido' }); data.name = n; }
    if (req.body?.type !== undefined) { const ty = String(req.body.type).toUpperCase(); if (!ACCOUNT_TYPES.includes(ty)) return res.status(400).json({ error: 'Tipo non valido' }); data.type = ty; }
    if (req.body?.archived !== undefined) data.archived = !!req.body.archived;
    await prisma.liquidityAccount.update({ where: { id: a.id }, data });
    res.json({ ok: true });
  } catch (err: any) { logger.error('Errore PATCH /liquidity/accounts', { err: err.message }); res.status(500).json({ error: 'Errore nel modificare il conto' }); }
});

// POST /liquidity/people { name, note }
router.post('/people', async (req: AuthRequest, res: Response) => {
  try {
    const userId = uid(req);
    const name = cleanName(req.body?.name);
    if (!name) return res.status(400).json({ error: 'Scrivi il nome della persona' });
    const existing = await prisma.liquidityPerson.findFirst({ where: { userId, name: { equals: name, mode: 'insensitive' } } });
    if (existing) return res.json({ id: existing.id, existing: true });
    const p = await prisma.liquidityPerson.create({ data: { userId, name, note: cleanName(req.body?.note, 200) || null } });
    res.status(201).json({ id: p.id });
  } catch (err: any) { logger.error('Errore POST /liquidity/people', { err: err.message }); res.status(500).json({ error: 'Errore nel creare la persona' }); }
});

router.patch('/people/:id', async (req: AuthRequest, res: Response) => {
  try {
    const p = await prisma.liquidityPerson.findFirst({ where: { id: req.params.id, userId: uid(req) } });
    if (!p) return res.status(404).json({ error: 'Persona non trovata' });
    const data: any = {};
    if (req.body?.name !== undefined) { const n = cleanName(req.body.name); if (!n) return res.status(400).json({ error: 'Nome non valido' }); data.name = n; }
    if (req.body?.note !== undefined) data.note = cleanName(req.body.note, 200) || null;
    if (req.body?.archived !== undefined) data.archived = !!req.body.archived;
    await prisma.liquidityPerson.update({ where: { id: p.id }, data });
    res.json({ ok: true });
  } catch (err: any) { logger.error('Errore PATCH /liquidity/people', { err: err.message }); res.status(500).json({ error: 'Errore nel modificare la persona' }); }
});

// POST /liquidity/movements — una qualsiasi operazione. Persone nuove si possono creare al volo col nome.
router.post('/movements', async (req: AuthRequest, res: Response) => {
  try {
    const userId = uid(req);
    const b = req.body || {};
    const kind = String(b.kind || '').toUpperCase();
    const rule = KINDS[kind];
    if (!rule || kind.startsWith('OPENING')) return res.status(400).json({ error: 'Operazione non valida' });
    const amountCents = Math.round(Number(b.amountCents));
    if (!Number.isFinite(amountCents) || amountCents <= 0) return res.status(400).json({ error: "Scrivi un importo maggiore di zero" });
    if (amountCents > MAX_CENTS) return res.status(400).json({ error: 'Importo troppo grande' });
    let date = new Date();
    if (b.date) { date = new Date(b.date); if (isNaN(date.getTime())) return res.status(400).json({ error: 'Data non valida' }); }

    // Persone indicate per nome (nuove o esistenti)
    const personByName = async (n: any) => {
      const name = cleanName(n);
      if (!name) return null;
      const ex = await prisma.liquidityPerson.findFirst({ where: { userId, name: { equals: name, mode: 'insensitive' } } });
      return ex ? ex.id : (await prisma.liquidityPerson.create({ data: { userId, name } })).id;
    };
    let fromPersonId: string | null = b.fromPersonId || null, toPersonId: string | null = b.toPersonId || null;
    const fromAccountId: string | null = b.fromAccountId || null, toAccountId: string | null = b.toAccountId || null;

    // Verifica sorgente/destinazione rispetto al tipo, PRIMA di creare persone nuove
    const check = (side: Side, acc: string | null, per: string | null, perName: any, label: string): string | null => {
      const hasPer = !!per || !!cleanName(perName);
      if (side === 'account' && (!acc || hasPer)) return `Scegli il conto ${label}`;
      if (side === 'account?' && hasPer) return `Qui ${label} può esserci solo un conto`;
      if (side === 'person' && (!hasPer || acc)) return `Scegli la persona ${label}`;
      if (side === 'none' && (acc || hasPer)) return 'Operazione non valida';
      return null;
    };
    const e1 = check(rule.from, fromAccountId, fromPersonId, b.fromPersonName, 'da cui escono i soldi');
    const e2 = check(rule.to, toAccountId, toPersonId, b.toPersonName, 'in cui entrano i soldi');
    if (e1 || e2) return res.status(400).json({ error: e1 || e2 });
    if (fromAccountId && fromAccountId === toAccountId) return res.status(400).json({ error: 'Scegli due conti diversi' });

    // I conti e le persone devono essere dell'utente
    const accIds = [fromAccountId, toAccountId].filter(Boolean) as string[];
    if (accIds.length) {
      const n = await prisma.liquidityAccount.count({ where: { id: { in: accIds }, userId } });
      if (n !== new Set(accIds).size) return res.status(404).json({ error: 'Conto non trovato' });
    }
    if (!fromPersonId && rule.from === 'person') fromPersonId = await personByName(b.fromPersonName);
    if (!toPersonId && rule.to === 'person') toPersonId = await personByName(b.toPersonName);
    const perIds = [fromPersonId, toPersonId].filter(Boolean) as string[];
    if (perIds.length) {
      const n = await prisma.liquidityPerson.count({ where: { id: { in: perIds }, userId } });
      if (n !== new Set(perIds).size) return res.status(404).json({ error: 'Persona non trovata' });
    }
    if (fromPersonId && fromPersonId === toPersonId) return res.status(400).json({ error: 'Scegli due persone diverse' });

    const m = await prisma.liquidityMovement.create({ data: {
      userId, kind, amountCents, date, note: cleanName(b.note, 300) || null, fromAccountId, toAccountId, fromPersonId, toPersonId,
    } });
    res.status(201).json({ id: m.id });
  } catch (err: any) { logger.error('Errore POST /liquidity/movements', { err: err.message }); res.status(500).json({ error: "Errore nel registrare l'operazione" }); }
});

// DELETE /liquidity/movements/:id — per correggere un errore: i saldi si ricalcolano da soli
router.delete('/movements/:id', async (req: AuthRequest, res: Response) => {
  try {
    const m = await prisma.liquidityMovement.findFirst({ where: { id: req.params.id, userId: uid(req) } });
    if (!m) return res.status(404).json({ error: 'Movimento non trovato' });
    await prisma.liquidityMovement.delete({ where: { id: m.id } });
    res.json({ ok: true });
  } catch (err: any) { logger.error('Errore DELETE /liquidity/movements', { err: err.message }); res.status(500).json({ error: "Errore nell'eliminare il movimento" }); }
});

export default router;
