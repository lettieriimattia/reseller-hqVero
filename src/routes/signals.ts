// src/routes/signals.ts
// Segnali di pre-lancio PUBBLICI (niente login):
//  - POST /api/waitlist  → salva l'email di chi vuole essere avvisato al lancio (consenso dato nel form)
//  - POST /api/hit       → conta una visita a una landing (nessun cookie, nessun dato personale)
//  - GET  /api/hit       → variante beacon via <img> (fallback se sendBeacon non parte)
// Va montato PRIMA di app.use('/', teamRoutes), altrimenti authenticate risponde 401.

import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma';
import { logger } from '../utils/logger';
import { getValuation } from '../services/valuation.service';
import { estimatePriceRange } from '../services/ai.service';
import { isAdminEmail } from '../config/admins';

// L'ADMIN (loggato nel browser) NON è soggetto al limite di ricerche: così puoi provare liberamente.
function isAdminRequest(req: Request): boolean {
  try {
    const token = (req as any).cookies?.access_token;
    if (!token || !process.env.JWT_ACCESS_SECRET) return false;
    const payload: any = jwt.verify(token, process.env.JWT_ACCESS_SECRET);
    return isAdminEmail(payload?.email);
  } catch { return false; }
}

// Hash dell'IP (privacy): identifica il visitatore per contare i riutilizzi, senza salvare l'IP.
function ipHashOf(ip: string): string {
  return crypto.createHash('sha256').update(`${ip}|hq-pricecheck`).digest('hex').slice(0, 16);
}

const router = Router();

// PROVA GRATIS "quanto vale" sulla landing: N valutazioni al giorno PER IP, poi il risultato
// diventa l'iscrizione (waitlist). L'admin loggato è illimitato. Modificabile con PUBLIC_PRICE_CHECKS_PER_DAY.
const FREE_CHECKS = Math.max(1, parseInt(process.env.PUBLIC_PRICE_CHECKS_PER_DAY || '2', 10) || 2);
const pcByIp = new Map<string, { date: string; count: number }>();
function clientIp(req: Request): string {
  const xff = (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim();
  return xff || (req.socket && req.socket.remoteAddress) || 'unknown';
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ALLOWED_PATHS = new Set(['home', 'magazzino', 'spedizione', 'valore', 'waitlist', 'privacy']);

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

// "Altro": indovina la categoria dal testo, così instradiamo alla fonte giusta. Se non capisce,
// null → fallback generico (StockX prova qualsiasi cosa). Euristica leggera, niente IA.
function detectCategory(q: string): { cat: string; label: string } | null {
  const s = q.toLowerCase();
  if (/\blego\b|minifig|bricklink|mattoncini/.test(s)) return { cat: 'lego', label: 'LEGO' };
  if (/pokemon|pokémon|pikachu|charizard|\bcarta\b|\bcard\b|\bpsa\b|\btcg\b|magic|yu-?gi-?oh/.test(s)) return { cat: 'carte', label: 'Carte' };
  if (/rolex|omega|seiko|casio|patek|audemars|tudor|orolog|\bwatch\b|submariner|daytona|nautilus/.test(s)) return { cat: 'orologi', label: 'Orologi' };
  if (/louis vuitton|\blv\b|gucci|prada|chanel|hermes|hermès|dior|\bborsa\b|handbag|speedy|birkin|neverfull/.test(s)) return { cat: 'borse', label: 'Borse' };
  if (/vinile|vinyl|\blp\b|33 giri|album .*disco/.test(s)) return { cat: 'vinili', label: 'Vinili' };
  if (/jordan|yeezy|\bdunk\b|air force|air max|new balance|sneaker|scarp|adidas|\bnike\b/.test(s)) return { cat: 'scarpe', label: 'Sneaker' };
  if (/supreme|palace|hoodie|felpa|maglia|\btee\b|giacca|jeans|streetwear|abbigliamento|stone island/.test(s)) return { cat: 'streetwear', label: 'Streetwear' };
  return null;
}

// POST /api/price-check — { query, category?, size?, condition?, number? } → valore di mercato.
router.post('/price-check', async (req: Request, res: Response) => {
  const ip = clientIp(req);
  const admin = isAdminRequest(req); // tu (admin) provi senza limiti
  const today = new Date().toISOString().slice(0, 10);
  const rec = pcByIp.get(ip);
  const used = rec && rec.date === today ? rec.count : 0;
  if (!admin && used >= FREE_CHECKS) return res.json({ limited: true, freeLimit: FREE_CHECKS });

  const query = String(req.body?.query || '').trim();
  const size = String(req.body?.size || '').trim();
  const condition = String(req.body?.condition || '').trim();
  const number = String(req.body?.number || '').trim();
  let category = (String(req.body?.category || 'scarpe').trim() || 'scarpe').toLowerCase();
  if (query.length < 2) return res.status(400).json({ error: 'Scrivi marca e modello.' });
  // "Altro": prova a capire la categoria dal testo → instrada alla fonte giusta.
  let detected: string | null = null;
  if (category === 'altro') { const d = detectCategory(query); if (d) { category = d.cat; detected = d.label; } }
  const isCards = /cart|pok|tcg/.test(category);

  // consuma una ricerca (l'admin no: prova illimitata)
  if (!admin) {
    pcByIp.set(ip, { date: today, count: used + 1 });
    if (pcByIp.size > 8000) { for (const [k, vv] of pcByIp) if (vv.date !== today) pcByIp.delete(k); } // pulizia
  }
  const remaining = admin ? 999 : Math.max(0, FREE_CHECKS - (used + 1));

  try {
    const val = await getValuation({ category, name: query, brand: '', size: size || undefined, condition: condition || undefined, number: number || undefined, game: isCards ? 'pokemon' : undefined });
    // Traccia l'uso (anonimo) per le statistiche admin: riutilizzi per visitatore.
    prisma.priceCheckLog.create({ data: { ipHash: ipHashOf(ip), query: query.slice(0, 80), found: val.value != null } }).catch(() => {});
    if (val.value != null) {
      return res.json({ value: val.value, currency: val.currency || 'EUR', name: val.itemName || query, source: val.source || 'StockX', base: (val as any).low ?? null, detected, remaining, freeLimit: FREE_CHECKS });
    }
    // Nessuna fonte ha un prezzo → stima IA indicativa in un RANGE (chiaramente etichettata).
    const range = await estimatePriceRange(query).catch(() => null);
    return res.json({ value: null, range, name: query, source: 'Stima indicativa (IA)', detected, remaining, freeLimit: FREE_CHECKS });
  } catch (e: any) {
    logger.warn('price-check errore', { err: e?.message });
    return res.json({ value: null, remaining, freeLimit: FREE_CHECKS });
  }
});

export default router;
