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
import { scanProductAuto, confirmVisualMatch } from '../services/ai.service';
import { getLegoRaw, isLegoConfigured } from '../services/apify.service';
import { getBrickLinkRaw, isBrickLinkConfigured } from '../services/bricklink.service';
import { getBrickEconomyRaw, isBrickEconomyConfigured } from '../services/brickeconomy.service';
import { isAdminEmail } from '../config/admins';
import { imageMatchesTitle } from '../utils/imageConsistency';

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
// ⚠️ TEMPORANEO (fase test): default 0 = NESSUN limite, così si prova liberamente.
// Prima del lancio pubblico: rimettere '2' qui sotto (o impostare PUBLIC_PRICE_CHECKS_PER_DAY su Render).
const FREE_CHECKS = Math.max(0, parseInt(process.env.PUBLIC_PRICE_CHECKS_PER_DAY || '0', 10) || 0);
const UNLIMITED_CHECKS = FREE_CHECKS === 0;
// Scan FOTO (vision IA, costa): limite STRETTO e separato. Default 1/giorno per IP. Admin illimitato.
const PHOTO_FREE = Math.max(1, parseInt(process.env.PUBLIC_PHOTO_SCANS_PER_DAY || '1', 10) || 1);
const photoByIp = new Map<string, { date: string; count: number }>();
const pcByIp = new Map<string, { date: string; count: number }>();
function clientIp(req: Request): string {
  const xff = (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim();
  return xff || (req.socket && req.socket.remoteAddress) || 'unknown';
}

// Foto di ripiego dalla cache LOCALE (CatalogItem: immagini già scaricate da KicksDB/StockX
// durante l'uso dell'app). Nessuna chiamata esterna → costo ZERO, sicura per la quota KicksDB.
// NB: brand e name sono salvati SEPARATI (es. brand="Jordan", name="1 Retro Low OG SP...") quindi
// cercare l'intero nome come UNA sottostringa unica non trova mai nulla. Cerchiamo per PAROLE
// distintive (OR) e poi scegliamo il candidato con più parole in comune (punteggio), come fa
// già il catalogo interno.
async function findCachedImage(name: string): Promise<string | null> {
  const words = (name || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 2);
  if (!words.length) return null;
  // Le parole più LUNGHE sono di solito le più specifiche (nome modello/collab) → filtrano meglio.
  const distinctive = [...words].sort((a, b) => b.length - a.length).slice(0, 3);
  const mostDistinctive = distinctive[0]; // es. "krueger" — la parola che identifica DAVVERO il modello
  try {
    const cands = await prisma.catalogItem.findMany({
      where: { AND: [
        { image: { not: null } },
        { OR: distinctive.map(w => ({ OR: [
          { name: { contains: w, mode: 'insensitive' as const } },
          { brand: { contains: w, mode: 'insensitive' as const } },
        ] })) },
      ] },
      take: 20,
    });
    if (!cands.length) return null;
    let best: typeof cands[number] | null = null; let bestScore = -1;
    for (const c of cands) {
      const hay = `${c.brand} ${c.name}`.toLowerCase();
      const score = words.reduce((s, w) => s + (hay.includes(w) ? 1 : 0), 0);
      if (score > bestScore) { bestScore = score; best = c; }
    }
    if (!best) return null;
    // Soglia minima: senza questa, bastava condividere parole GENERICHE ("nike"/"dunk"/"low")
    // per prendere la foto di una scarpa completamente diversa (es. "Freddy Krueger" mostrava
    // una Dunk qualsiasi). Ora serve un punteggio solido E la parola più specifica presente
    // davvero — altrimenti meglio NESSUNA foto che una sbagliata.
    const hayBest = `${best.brand} ${best.name}`.toLowerCase();
    const minScore = Math.max(2, Math.ceil(words.length * 0.6));
    if (bestScore < minScore || !hayBest.includes(mostDistinctive)) return null;
    if (!best.image) return null;
    // Coerenza nome↔immagine ANCHE per la cache: righe scritte PRIMA che questo controllo
    // esistesse (es. da StockX con title/media già inconsistenti a monte) vanno scartate qui,
    // non solo alla fonte. La riga viene anche ripulita (foto azzerata) invece di restare
    // "avvelenata" per sempre: così una futura ricerca buona potrà rimpiazzarla.
    if (!imageMatchesTitle(best.image, hayBest)) {
      prisma.catalogItem.update({ where: { id: best.id }, data: { image: null } }).catch(() => {});
      return null;
    }
    return best.image;
  } catch { return null; }
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
  if (/pokemon|pokémon|pikachu|charizard|\bcarta\b|\bcard\b|\bpsa\b|\btcg\b|magic|yu-?gi-?oh/.test(s)) return { cat: 'carte', label: 'Carte' };
  if (/rolex|omega|seiko|casio|patek|audemars|tudor|orolog|\bwatch\b|submariner|daytona|nautilus/.test(s)) return { cat: 'orologi', label: 'Orologi' };
  if (/louis vuitton|\blv\b|gucci|prada|chanel|hermes|hermès|dior|\bborsa\b|handbag|speedy|birkin|neverfull/.test(s)) return { cat: 'borse', label: 'Borse' };
  if (/vinile|vinyl|\blp\b|33 giri|album .*disco/.test(s)) return { cat: 'vinili', label: 'Vinili' };
  if (/jordan|yeezy|\bdunk\b|air force|air max|new balance|sneaker|scarp|adidas|\bnike\b/.test(s)) return { cat: 'scarpe', label: 'Sneaker' };
  if (/supreme|palace|hoodie|felpa|maglia|\btee\b|giacca|jeans|streetwear|abbigliamento|stone island/.test(s)) return { cat: 'streetwear', label: 'Streetwear' };
  return null;
}

// Mappa la categoria dello SCAN (italiano: "Scarpe","Vestiti","Pokemon"...) alle chiavi del
// dropdown del checker — usata per riaprire il form pre-compilato quando la foto non basta.
function mapScanCategory(cat: string): string {
  const c = (cat || '').toLowerCase();
  if (c.includes('scarp') || c.includes('sneaker')) return 'scarpe';
  if (c.includes('vestit') || c.includes('abbigli') || c.includes('street')) return 'streetwear';
  if (c.includes('pokemon') || c.includes('pokémon') || c.includes('carte') || c.includes('card') || c.includes('tcg')) return 'carte';
  if (c.includes('orolog') || c.includes('watch')) return 'orologi';
  if (c.includes('bors') || c.includes('bag')) return 'borse';
  return 'altro';
}

// DEBUG LEGO (pubblico ma protetto da chiave): funziona anche in incognito/non loggato.
// Mostra se APIFY è configurato + la risposta GREZZA dell'actor (status, campi, primo item),
// così capiamo perché un set non viene valutato. Apri:
//   /api/lego-debug?key=hqlego2026&set=10300
router.get('/lego-debug', async (req: Request, res: Response) => {
  if (String(req.query.key || '') !== 'hqlego2026') return res.status(403).json({ error: 'chiave mancante' });
  const set = String(req.query.set || '10300').trim();
  const [brickeconomy, bricklink, apify] = await Promise.all([
    getBrickEconomyRaw(set).catch((e: any) => ({ error: e?.message })),
    getBrickLinkRaw(set).catch((e: any) => ({ error: e?.message })),
    getLegoRaw(set).catch((e: any) => ({ error: e?.message })),
  ]);
  return res.json({
    brickeconomyConfigured: isBrickEconomyConfigured(),
    bricklinkConfigured: isBrickLinkConfigured(),
    apifyConfigured: isLegoConfigured(),
    brickeconomy, // 1ª scelta: valore di mercato, niente vincolo venditore
    bricklink,    // 2ª scelta: API ufficiale (serve venditore)
    apify,        // 3ª scelta: actor (spesso bloccato da CAPTCHA)
  });
});

// POST /api/photo-check — { image: dataURL } → riconosce il prodotto dalla FOTO (vision IA) e
// lo valuta. Limite STRETTO (default 1/giorno per IP) perché la vision costa. Admin illimitato.
router.post('/photo-check', async (req: Request, res: Response) => {
  const ip = clientIp(req);
  const admin = isAdminRequest(req);
  const today = new Date().toISOString().slice(0, 10);
  const rec = photoByIp.get(ip);
  const used = rec && rec.date === today ? rec.count : 0;
  if (!admin && used >= PHOTO_FREE) return res.json({ limited: true, freeLimit: PHOTO_FREE });

  const image = String(req.body?.image || '');
  if (!/^data:image\//.test(image) || image.length < 100) return res.status(400).json({ error: 'Foto non valida.' });
  if (image.length > 9_000_000) return res.status(413).json({ error: 'Foto troppo grande.' });

  // La ricerca si CONSUMA solo se troviamo un valore vero (sotto). Un "troppo generico" non conta:
  // l'utente può riprovare subito senza perdere una delle sue prove giornaliere.
  try {
    const scan = await scanProductAuto(image, []);
    const brand = (scan.brand || '').trim();
    const model = (scan.model || '').trim();
    const name = [brand, model].filter(Boolean).join(' ').trim();
    const category = (scan.category || scan.detectedCategory || 'altro').toString();
    const shownCat = scan.detectedCategory || category;
    const suggestedCategory = mapScanCategory(category + ' ' + shownCat);
    if (!name) return res.json({ value: null, recognized: false, detected: shownCat, suggestedCategory, remaining: admin ? null : Math.max(0, PHOTO_FREE - used), freeLimit: PHOTO_FREE });
    const isCards = /cart|pok|tcg/i.test(category + ' ' + shownCat);
    const val = await getValuation({ category, name, brand: '', game: isCards ? 'pokemon' : undefined });
    prisma.priceCheckLog.create({ data: { ipHash: ipHashOf(ip), query: ('📷 ' + name).slice(0, 80), found: val.value != null } }).catch(() => {});
    // Rete di sicurezza anti-allucinazione: "confidence HIGH" è un'AUTO-valutazione dell'IA e può
    // essere sicura ma SBAGLIATA (confonde due grail SB Dunk diversi tra loro, es. "De La Soul" per
    // "Freddy Krueger" — entrambi reali, prezzi molto diversi). Per sneaker/streetwear con un
    // valore trovato, verifica INDIPENDENTE: una seconda domanda mirata "è ESATTAMENTE questo?"
    // invece di fidarsi del solo riconoscimento iniziale.
    const isSneakerLike = /scarp|sneaker|shoe|street|abbigli|vestit/i.test(category + ' ' + shownCat);
    const visualOk = val.value == null || !isSneakerLike || await confirmVisualMatch(image, val.itemName || name).catch(() => false);
    if (val.value != null && visualOk) {
      if (!admin) {
        photoByIp.set(ip, { date: today, count: used + 1 });
        if (photoByIp.size > 8000) { for (const [k, vv] of photoByIp) if (vv.date !== today) photoByIp.delete(k); }
      }
      const remaining = admin ? null : Math.max(0, PHOTO_FREE - (used + 1));
      // Niente foto di catalogo qui: chi cerca via FOTO ha già la sua immagine, non serve
      // mostrarne un'altra presa dal catalogo (quella resta solo per la ricerca da testo).
      return res.json({ value: val.value, currency: val.currency || 'EUR', name: val.itemName || name, source: val.source, image: null, recognized: true, detected: shownCat, remaining, freeLimit: PHOTO_FREE });
    }
    // Nessun valore affidabile (o verifica visiva non confermata): "troppo generico, riprova" —
    // non consuma la prova giornaliera. Suggeriamo un nome di ripiego per pre-compilare il form
    // testuale: se la verifica visiva ha bocciato una collab/colorway specifica, usiamo il
    // modello BASE (senza quella parte non confermata) invece del nome rischioso intero.
    const details: any = scan.details || {};
    const baseModel = [scan.brand, details.model].filter(Boolean).join(' ').trim();
    const suggestedName = (val.value != null && !visualOk && baseModel) ? baseModel : name;
    return res.json({ value: null, tooGeneric: true, name, suggestedName, suggestedCategory, recognized: true, detected: shownCat, remaining: admin ? null : Math.max(0, PHOTO_FREE - used), freeLimit: PHOTO_FREE });
  } catch (e: any) {
    logger.warn('photo-check errore', { err: e?.message });
    return res.json({ value: null, error: true, remaining: admin ? null : Math.max(0, PHOTO_FREE - used), freeLimit: PHOTO_FREE });
  }
});

// POST /api/price-check — { query, category?, size?, condition?, number? } → valore di mercato.
router.post('/price-check', async (req: Request, res: Response) => {
  const ip = clientIp(req);
  const admin = isAdminRequest(req); // tu (admin) provi senza limiti
  const today = new Date().toISOString().slice(0, 10);
  const rec = pcByIp.get(ip);
  const used = rec && rec.date === today ? rec.count : 0;
  if (!admin && !UNLIMITED_CHECKS && used >= FREE_CHECKS) return res.json({ limited: true, freeLimit: FREE_CHECKS });

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

  // La ricerca si CONSUMA solo se troviamo un valore vero (sotto). Un "troppo generico" non conta:
  // l'utente può riprovare subito con un nome più preciso senza perdere una prova.
  try {
    const val = await getValuation({ category, name: query, brand: '', size: size || undefined, condition: condition || undefined, number: number || undefined, game: isCards ? 'pokemon' : undefined });
    // Traccia l'uso (anonimo) per le statistiche admin: riutilizzi per visitatore.
    prisma.priceCheckLog.create({ data: { ipHash: ipHashOf(ip), query: query.slice(0, 80), found: val.value != null } }).catch(() => {});
    if (val.value != null) {
      if (!admin && !UNLIMITED_CHECKS) {
        pcByIp.set(ip, { date: today, count: used + 1 });
        if (pcByIp.size > 8000) { for (const [k, vv] of pcByIp) if (vv.date !== today) pcByIp.delete(k); } // pulizia
      }
      const remaining = (admin || UNLIMITED_CHECKS) ? null : Math.max(0, FREE_CHECKS - (used + 1));
      // Foto: PRIMA la cache locale (immagini KicksDB già scaricate durante l'uso dell'app — zero
      // chiamate esterne, zero costo quota, già filtrata per match affidabile). Solo se la cache
      // non ha nulla, ripiego sulla foto della fonte (es. StockX), che può avere colorway sbagliate
      // rispetto al titolo (dato StockX stesso inconsistente in alcuni prodotti).
      const image = (await findCachedImage(val.itemName || query)) || val.image;
      return res.json({ value: val.value, currency: val.currency || 'EUR', name: val.itemName || query, source: val.source || 'StockX', base: (val as any).low ?? null, image, detected, remaining, freeLimit: FREE_CHECKS });
    }
    // Nessun valore affidabile: "troppo generico, riprova" — non consuma la prova giornaliera.
    const remaining = (admin || UNLIMITED_CHECKS) ? null : Math.max(0, FREE_CHECKS - used);
    return res.json({ value: null, tooGeneric: true, name: query, detected, remaining, freeLimit: FREE_CHECKS });
  } catch (e: any) {
    logger.warn('price-check errore', { err: e?.message });
    return res.json({ value: null, remaining: (admin || UNLIMITED_CHECKS) ? null : Math.max(0, FREE_CHECKS - used), freeLimit: FREE_CHECKS });
  }
});

export default router;
