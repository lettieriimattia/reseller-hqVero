// src/routes/tasks.ts
// TASK / NOTE dell'utente (widget promemoria in dashboard). Testo completo in `text`,
// `summary` = titolo brevissimo generato dall'IA (mostrato compatto). Sincronizzati sul DB.

import { Router, Response } from 'express';
import { prisma } from '../lib/prisma';
import { authenticate, AuthRequest } from '../middleware/auth';
import { apiLimiter } from '../middleware/rateLimit';
import { summarizeTaskText } from '../services/ai.service';
import { logger } from '../utils/logger';

const router = Router();
router.use(authenticate, apiLimiter);

// GET /tasks → note dell'utente (le non completate prima, più recenti in cima)
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const rows = await prisma.task.findMany({
      where: { userId: req.user!.userId },
      orderBy: [{ done: 'asc' }, { createdAt: 'desc' }],
      take: 100,
    });
    res.json(rows);
  } catch (err: any) {
    logger.error('GET /tasks', { err: err.message });
    res.status(500).json({ error: 'Errore lettura note' });
  }
});

// POST /tasks { text } → crea la nota; l'IA genera subito il riassunto (~2 parole).
router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const text = (req.body?.text ?? '').toString().trim().slice(0, 2000);
    if (!text) return res.status(400).json({ error: 'Nota vuota.' });
    const summary = await summarizeTaskText(text).catch(() => '');
    const row = await prisma.task.create({ data: { userId: req.user!.userId, text, summary: summary || null } });
    res.json(row);
  } catch (err: any) {
    logger.error('POST /tasks', { err: err.message });
    res.status(500).json({ error: 'Errore creazione nota' });
  }
});

// PATCH /tasks/:id { text?, done? } → aggiorna testo (rigenera il riassunto) o stato fatto.
router.patch('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const existing = await prisma.task.findUnique({ where: { id: req.params.id } });
    if (!existing || existing.userId !== req.user!.userId) return res.status(404).json({ error: 'Non trovata.' });
    const data: any = {};
    if (typeof req.body?.done === 'boolean') data.done = req.body.done;
    if (typeof req.body?.text === 'string') {
      const text = req.body.text.trim().slice(0, 2000);
      if (text) { data.text = text; data.summary = (await summarizeTaskText(text).catch(() => '')) || null; }
    }
    const row = await prisma.task.update({ where: { id: req.params.id }, data });
    res.json(row);
  } catch (err: any) {
    logger.error('PATCH /tasks/:id', { err: err.message });
    res.status(500).json({ error: 'Errore aggiornamento nota' });
  }
});

// DELETE /tasks/:id
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const existing = await prisma.task.findUnique({ where: { id: req.params.id } });
    if (!existing || existing.userId !== req.user!.userId) return res.status(404).json({ error: 'Non trovata.' });
    await prisma.task.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (err: any) {
    logger.error('DELETE /tasks/:id', { err: err.message });
    res.status(500).json({ error: 'Errore eliminazione' });
  }
});

export default router;
