// src/routes/admin.ts
// Pannello admin — solo per l'utente con ADMIN_EMAIL

import { Router, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { prisma } from "../lib/prisma";
import { authenticate, AuthRequest } from '../middleware/auth';
import { logger } from '../utils/logger';
import { sendEmail } from '../services/email.service';
import { isPlanId } from '../config/plans';
import { refundProductPayment, releaseHold, reverseSaleAfterRefund, reasonLabel } from '../services/dispute.service';

const router = Router();

// Account admin (definiti in config/admins.ts). Re-export per compatibilità.
export { ADMIN_EMAILS, ADMIN_EMAIL, isAdminEmail } from '../config/admins';
import { isAdminEmail } from '../config/admins';

// Middleware: solo gli account admin + DEVONO avere il 2FA attivo (sicurezza pannello admin).
async function requireAdmin(req: AuthRequest, res: Response, next: any) {
  if (!isAdminEmail(req.user?.email)) {
    return res.status(403).json({ error: 'Accesso riservato.' });
  }
  // Il pannello admin esige il 2FA: senza, niente accesso (l'admin lo attiva da Impostazioni → 2FA).
  try {
    const u = await prisma.user.findUnique({ where: { id: req.user!.userId }, select: { twoFactorEnabled: true } });
    if (!u?.twoFactorEnabled) {
      return res.status(403).json({ error: 'Per accedere al pannello admin devi prima attivare il 2FA (Impostazioni → Autenticazione a due fattori).', need2FA: true });
    }
  } catch { return res.status(500).json({ error: 'Errore verifica admin.' }); }
  next();
}

router.use(authenticate);
router.use(requireAdmin);

// GET /admin/users — lista completa utenti con statistiche
router.get('/users', async (req: AuthRequest, res: Response) => {
  try {
    const users = await prisma.user.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        memberships: { include: { warehouse: true } },
        products: { select: { id: true, status: true, purchasePrice: true, salePrice: true, fees: true } },
        _count: { select: { products: true } },
      },
    });

    const result = users.map(u => {
      const sold = u.products.filter(p => p.status === 'VENDUTO');
      const inStock = u.products.filter(p => p.status === 'IN STOCK');
      return {
        id: u.id,
        name: u.name,
        email: u.email,
        plan: u.plan,
        createdAt: u.createdAt,
        lastLoginAt: u.lastLoginAt,
        twoFactorEnabled: u.twoFactorEnabled,
        warehouses: u.memberships.map(m => ({
          name: m.warehouse.name.replace('Magazzino ', ''),
          role: m.role,
        })),
        stats: {
          totalProducts: u._count.products,
          inStock: inStock.length,
          sold: sold.length,
        },
      };
    });

    res.json({ users: result, total: result.length });
  } catch (err: any) {
    logger.error('Errore GET /admin/users', { err: err.message });
    res.status(500).json({ error: 'Errore database' });
  }
});

// DELETE /admin/users/:id — elimina utente (con tutti i suoi dati)
router.delete('/users/:id', async (req: AuthRequest, res: Response) => {
  try {
    if (req.params.id === req.user!.userId) {
      return res.status(400).json({ error: 'Non puoi eliminare te stesso.' });
    }
    await prisma.user.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err: any) {
    logger.error('Errore DELETE /admin/users/:id', { err: err.message });
    res.status(500).json({ error: 'Errore eliminazione' });
  }
});

// POST /admin/users/:id/plan — cambia il piano di un utente (per test/gestione)
router.post('/users/:id/plan', async (req: AuthRequest, res: Response) => {
  try {
    const plan = (req.body?.plan ?? '').toString();
    if (!isPlanId(plan)) return res.status(400).json({ error: 'Piano non valido.' });
    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: { plan },
      select: { id: true, email: true, plan: true },
    });
    res.json({ success: true, user });
  } catch (err: any) {
    logger.error('Errore POST /admin/users/:id/plan', { err: err.message });
    res.status(500).json({ error: 'Errore aggiornamento piano' });
  }
});

// ==========================================
// RICHIESTE (Aiuto & Assistenza)
// ==========================================

// GET /admin/feedback — lista richieste (più recenti prima)
router.get('/feedback', async (_req: AuthRequest, res: Response) => {
  try {
    const items = await prisma.feedback.findMany({ orderBy: { createdAt: 'desc' }, take: 200 });
    const nuove = items.filter(f => f.status === 'nuova').length;
    res.json({ feedback: items, total: items.length, nuove });
  } catch (err: any) {
    logger.error('Errore GET /admin/feedback', { err: err.message });
    res.status(500).json({ error: 'Errore database' });
  }
});

// POST /admin/feedback/:id/reply — rispondi: la risposta arriva via email all'utente
router.post('/feedback/:id/reply', async (req: AuthRequest, res: Response) => {
  try {
    const reply = (req.body?.reply ?? '').toString().trim();
    if (reply.length < 2) return res.status(400).json({ error: 'Scrivi una risposta.' });
    if (reply.length > 6000) return res.status(400).json({ error: 'Risposta troppo lunga.' });

    const fb = await prisma.feedback.findUnique({ where: { id: req.params.id } });
    if (!fb) return res.status(404).json({ error: 'Richiesta non trovata.' });

    const sent = await sendEmail({
      to: fb.userEmail,
      subject: 'Risposta dal team di HQVault',
      text: `Ciao${fb.userName ? ' ' + fb.userName : ''},\n\nhai scritto:\n"${fb.message}"\n\nLa nostra risposta:\n${reply}\n\n— Il team di HQVault`,
      html: `<p>Ciao${fb.userName ? ' ' + fb.userName : ''},</p><p>hai scritto:</p><blockquote style="color:#666;border-left:3px solid #ddd;padding-left:10px">${fb.message.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br/>')}</blockquote><p><b>La nostra risposta:</b></p><p>${reply.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br/>')}</p><p style="color:#888">— Il team di HQVault</p>`,
    });
    if (!sent.ok) {
      logger.warn('Risposta feedback non inviata', { err: sent.error });
      return res.status(502).json({ error: 'Email non inviata (controlla BREVO_API_KEY). Riprova.' });
    }

    const updated = await prisma.feedback.update({
      where: { id: fb.id },
      data: { reply, status: 'risposta', repliedAt: new Date() },
    });
    res.json({ ok: true, feedback: updated });
  } catch (err: any) {
    logger.error('Errore POST /admin/feedback/:id/reply', { err: err.message });
    res.status(500).json({ error: 'Errore invio risposta' });
  }
});

// DELETE /admin/feedback/:id — elimina una richiesta gestita
router.delete('/feedback/:id', async (req: AuthRequest, res: Response) => {
  try {
    await prisma.feedback.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (err: any) {
    logger.error('Errore DELETE /admin/feedback/:id', { err: err.message });
    res.status(500).json({ error: 'Errore eliminazione' });
  }
});

// ==========================================
// CONSEGNE — panoramica spedizioni in corso (pagate, in attesa di consegna)
// ==========================================
router.get('/deliveries', async (_req: AuthRequest, res: Response) => {
  try {
    const items = await prisma.product.findMany({
      where: { status: 'PAGATO', deletedAt: null },
      orderBy: { paidAt: 'desc' },
      select: {
        id: true, brand: true, name: true, heldAmount: true,
        trackingCode: true, trackingCarrier: true, trackingStatus: true,
        paidAt: true, deliveredAt: true, autoReleaseAt: true, disputeStatus: true,
        userId: true, buyerUserId: true,
      },
    });
    const userIds = Array.from(new Set(items.flatMap(p => [p.userId, p.buyerUserId].filter(Boolean) as string[])));
    const users = await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } });
    const uMap = new Map(users.map(u => [u.id, u.name]));
    res.json({
      deliveries: items.map(p => ({
        productId: p.id, product: `${p.brand} ${p.name}`, amount: p.heldAmount ?? 0,
        trackingCode: p.trackingCode, trackingCarrier: p.trackingCarrier, trackingStatus: p.trackingStatus,
        paidAt: p.paidAt, deliveredAt: p.deliveredAt, autoReleaseAt: p.autoReleaseAt,
        disputeStatus: p.disputeStatus,
        seller: uMap.get(p.userId) || '—',
        buyer: p.buyerUserId ? (uMap.get(p.buyerUserId) || '—') : '—',
      })),
      total: items.length,
    });
  } catch (err: any) {
    logger.error('Errore GET /admin/deliveries', { err: err.message });
    res.status(500).json({ error: 'Errore database' });
  }
});

// ==========================================
// CONTESTAZIONI / RESI — mediazione (casi escalati dal venditore)
// ==========================================

// GET /admin/disputes — contestazioni aperte/escalate
router.get('/disputes', async (_req: AuthRequest, res: Response) => {
  try {
    const items = await prisma.product.findMany({
      where: { disputeStatus: { in: ['OPEN', 'ESCALATED'] }, deletedAt: null },
      orderBy: { disputeOpenedAt: 'desc' },
      select: {
        id: true, brand: true, name: true, heldAmount: true, shippingCost: true,
        disputeStatus: true, disputeReason: true, disputeNote: true, disputePhotos: true,
        disputeOpenedAt: true, userId: true, buyerUserId: true,
      },
    });
    const userIds = Array.from(new Set(items.flatMap(p => [p.userId, p.buyerUserId].filter(Boolean) as string[])));
    const users = await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true } });
    const uMap = new Map(users.map(u => [u.id, u]));
    res.json({
      disputes: items.map(p => {
        let photos: string[] = []; try { photos = p.disputePhotos ? JSON.parse(p.disputePhotos) : []; } catch {}
        return {
          productId: p.id, product: `${p.brand} ${p.name}`,
          amount: p.heldAmount ?? 0,
          status: p.disputeStatus, reason: p.disputeReason, reasonLabel: reasonLabel(p.disputeReason),
          note: p.disputeNote, photos, openedAt: p.disputeOpenedAt,
          seller: uMap.get(p.userId) || null,
          buyer: p.buyerUserId ? (uMap.get(p.buyerUserId) || null) : null,
        };
      }),
      total: items.length,
    });
  } catch (err: any) {
    logger.error('Errore GET /admin/disputes', { err: err.message });
    res.status(500).json({ error: 'Errore database' });
  }
});

// POST /admin/disputes/:productId/resolve — l'admin decide
//  decision 'refund_buyer'   → rimborso totale al compratore (articolo torna al venditore)
//  decision 'release_seller' → contestazione respinta, fondi al venditore
router.post('/disputes/:productId/resolve', async (req: AuthRequest, res: Response) => {
  try {
    const product = await prisma.product.findUnique({ where: { id: req.params.productId } });
    if (!product || product.deletedAt) return res.status(404).json({ error: 'Articolo non trovato' });
    if (!product.disputeStatus) return res.status(400).json({ error: 'Nessuna contestazione su questo articolo.' });

    const decision = (req.body?.decision || '').toString();
    const convo = await prisma.conversation.findFirst({ where: { productId: product.id } });

    if (decision === 'refund_buyer') {
      const r = await refundProductPayment(product);
      if (!r.ok) return res.status(502).json({ error: r.error || 'Rimborso non riuscito' });
      await reverseSaleAfterRefund(product.id, product.heldAmount ?? 0);
      if (convo) await prisma.message.create({ data: { conversationId: convo.id, senderId: product.buyerUserId || product.userId, text: '⚖️ L\'assistenza ha deciso a favore del compratore: rimborso totale effettuato.' } });
    } else if (decision === 'release_seller') {
      await prisma.product.update({ where: { id: product.id }, data: { disputeStatus: null } });
      await releaseHold(product.id);
      // Verdetto chiuso: elimina le foto prova dal DB (privacy + spazio), tieni motivo/nota.
      await prisma.product.update({ where: { id: product.id }, data: { disputeStatus: 'RESOLVED_RELEASE', disputeResolvedAt: new Date(), disputePhotos: null } });
      if (convo) await prisma.message.create({ data: { conversationId: convo.id, senderId: product.userId, text: '⚖️ L\'assistenza ha respinto la contestazione: i fondi sono stati sbloccati al venditore.' } });
    } else {
      return res.status(400).json({ error: 'Decisione non valida.' });
    }
    if (convo) await prisma.conversation.update({ where: { id: convo.id }, data: { updatedAt: new Date() } });
    res.json({ success: true });
  } catch (err: any) {
    logger.error('Errore POST /admin/disputes/:id/resolve', { err: err.message });
    res.status(500).json({ error: 'Errore risoluzione' });
  }
});

export default router;
