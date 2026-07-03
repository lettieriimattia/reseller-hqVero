// src/routes/signals.ts
// Segnali di pre-lancio PUBBLICI (niente login):
//  - POST /api/waitlist  → salva l'email di chi vuole essere avvisato al lancio (consenso dato nel form)
//  - POST /api/hit       → conta una visita a una landing (nessun cookie, nessun dato personale)
//  - GET  /api/hit       → variante beacon via <img> (fallback se sendBeacon non parte)
// Va montato PRIMA di app.use('/', teamRoutes), altrimenti authenticate risponde 401.

import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { logger } from '../utils/logger';

const router = Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ALLOWED_PATHS = new Set(['home', 'magazzino', 'spedizione', 'waitlist']);

// Da dove arriva il visitatore (host grezzo → etichetta semplice), senza tracciare la persona.
function refLabel(referrer?: string): string {
  if (!referrer) return 'direct';
  try {
    const h = new URL(referrer).hostname.replace(/^www\./, '').toLowerCase();
    if (h.includes('google')) return 'google';
    if (h.includes('bing')) return 'bing';
    if (h.includes('instagram')) return 'instagram';
    if (h.includes('tiktok')) return 'tiktok';
    if (h.includes('t.co') || h.includes('twitter') || h.includes('x.com')) return 'twitter';
    if (h.includes('facebook') || h.includes('fb.')) return 'facebook';
    if (h.includes('reddit')) return 'reddit';
    if (h.includes('resellerhq') || h.includes('hqvault')) return 'internal';
    return h.slice(0, 40);
  } catch { return 'direct'; }
}

// POST /api/waitlist — { email, source }
router.post('/waitlist', async (req: Request, res: Response) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email) || email.length > 160) return res.status(400).json({ error: 'Email non valida.' });
    const source = String(req.body?.source || '').trim().slice(0, 40) || null;
    const referrer = refLabel(req.get('referer') || undefined);
    // Email univoca: se c'è già, avviso che è GIÀ iscritta (niente doppioni).
    const existing = await prisma.waitlist.findUnique({ where: { email }, select: { id: true } });
    if (existing) return res.json({ ok: true, already: true });
    await prisma.waitlist.create({ data: { email, source, referrer } });
    return res.json({ ok: true, already: false });
  } catch (e: any) {
    logger.warn('POST /api/waitlist', { err: e?.message });
    return res.status(500).json({ error: 'Riprova tra poco.' });
  }
});

// Registra una visita (path whitelisted). Best-effort: non deve mai rallentare/rompere la pagina.
async function logHit(path: string, referrer?: string, country?: string) {
  if (!ALLOWED_PATHS.has(path)) return;
  await prisma.pageHit.create({ data: { path, referrer: refLabel(referrer), country: country || null } }).catch(() => {});
}

// POST /api/hit — via navigator.sendBeacon: il "p" può stare nel body O nella query (?p=…),
// perché sendBeacon(url) manda un POST col body vuoto ma l'URL con la query.
router.post('/hit', async (req: Request, res: Response) => {
  res.status(204).end(); // rispondi subito, poi logga
  const p = String(req.body?.p || (req.query.p as string) || '').trim();
  await logHit(p, req.get('referer') || undefined, (req.get('cf-ipcountry') || '') || undefined);
});

// GET /api/hit?p=home — fallback beacon via <img> (per browser che bloccano sendBeacon)
router.get('/hit', async (req: Request, res: Response) => {
  res.status(204).end();
  const p = String((req.query.p as string) || '').trim();
  await logHit(p, req.get('referer') || undefined, (req.get('cf-ipcountry') || '') || undefined);
});

export default router;
