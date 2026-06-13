// src/routes/admin.ts
// Pannello admin — solo per l'utente con ADMIN_EMAIL

import { Router, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { authenticate, AuthRequest } from '../middleware/auth';
import { logger } from '../utils/logger';
import { sendEmail } from '../services/email.service';
import { isPlanId } from '../config/plans';

const router = Router();
const prisma = new PrismaClient();

// L'UNICO account admin. Hard-coded (NON modificabile via env) così nessuna
// configurazione errata o variabile d'ambiente può concedere admin ad altri.
export const ADMIN_EMAIL = 'noreply.hq.app@gmail.com';

// Middleware: solo l'account admin
function requireAdmin(req: AuthRequest, res: Response, next: any) {
  if (req.user?.email?.toLowerCase() !== ADMIN_EMAIL) {
    return res.status(403).json({ error: 'Accesso riservato.' });
  }
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
      subject: 'Risposta dal team di ResellerHQ',
      text: `Ciao${fb.userName ? ' ' + fb.userName : ''},\n\nhai scritto:\n"${fb.message}"\n\nLa nostra risposta:\n${reply}\n\n— Il team di ResellerHQ`,
      html: `<p>Ciao${fb.userName ? ' ' + fb.userName : ''},</p><p>hai scritto:</p><blockquote style="color:#666;border-left:3px solid #ddd;padding-left:10px">${fb.message.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br/>')}</blockquote><p><b>La nostra risposta:</b></p><p>${reply.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br/>')}</p><p style="color:#888">— Il team di ResellerHQ</p>`,
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

export default router;
