// src/routes/chat.ts
// Chat marketplace acquirente↔venditore. SOLO TESTO: niente link né foto (anti-truffa).
// Semplice (polling lato client), leggera per Render.

import { Router, Response } from 'express';
import { prisma } from '../lib/prisma';
import { authenticate, AuthRequest } from '../middleware/auth';
import { addTracking } from '../services/tracking.service';
import { notifyWarehouseMembers } from '../services/notification.service';
import { logger } from '../utils/logger';

const router = Router();
router.use(authenticate);

// Blocca link/URL nei messaggi (primo vettore di truffa). Niente foto: la chat è solo testo.
const LINK_RE = /(https?:\/\/|www\.|\b[a-z0-9][a-z0-9-]*\.(com|net|org|it|io|co|me|app|shop|store|xyz|info|biz|eu|de|fr|es|uk|gg|to|link)\b|t\.me\/|wa\.me\/|@[a-z0-9_.]+)/i;
function hasLink(text: string): boolean { return LINK_RE.test(text); }

// Lista conversazioni dell'utente (come acquirente o venditore).
router.get('/conversations', async (req: AuthRequest, res: Response) => {
  try {
    const uid = req.user!.userId;
    const convos = await prisma.conversation.findMany({
      where: { OR: [{ buyerId: uid }, { sellerId: uid }] },
      orderBy: { updatedAt: 'desc' },
      include: { messages: { orderBy: { createdAt: 'desc' }, take: 1 } },
    });
    // Arricchisci con prodotto + nome controparte
    const productIds = Array.from(new Set(convos.map(c => c.productId)));
    const userIds = Array.from(new Set(convos.flatMap(c => [c.buyerId, c.sellerId])));
    const [products, users] = await Promise.all([
      prisma.product.findMany({ where: { id: { in: productIds } }, select: { id: true, brand: true, name: true, photos: true, publicPrice: true, status: true } }),
      prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }),
    ]);
    const pMap = new Map(products.map(p => [p.id, p]));
    const uMap = new Map(users.map(u => [u.id, u.name]));
    res.json(convos.map(c => {
      const p = pMap.get(c.productId) as any;
      const otherId = c.buyerId === uid ? c.sellerId : c.buyerId;
      let photo: string | null = null;
      try { const arr = p?.photos ? JSON.parse(p.photos) : []; photo = arr[0] || null; } catch {}
      return {
        id: c.id, productId: c.productId,
        productName: p ? `${p.brand} ${p.name}` : 'Articolo',
        productPhoto: photo, price: p?.publicPrice ?? null,
        productStatus: p?.status ?? null,
        role: c.buyerId === uid ? 'buyer' : 'seller',
        otherName: uMap.get(otherId) || 'Utente',
        lastMessage: c.messages[0]?.text || null,
        lastAt: c.messages[0]?.createdAt || c.createdAt,
      };
    }));
  } catch (e: any) { logger.error('GET /chat/conversations', { err: e.message }); res.status(500).json({ error: 'Errore chat' }); }
});

async function assertParticipant(conversationId: string, uid: string) {
  const c = await prisma.conversation.findUnique({ where: { id: conversationId } });
  if (!c) return null;
  if (c.buyerId !== uid && c.sellerId !== uid) return null;
  return c;
}

// Messaggi di una conversazione (segna come letti quelli ricevuti).
router.get('/:id/messages', async (req: AuthRequest, res: Response) => {
  try {
    const c = await assertParticipant(req.params.id, req.user!.userId);
    if (!c) return res.status(403).json({ error: 'Non autorizzato' });
    const messages = await prisma.message.findMany({ where: { conversationId: c.id }, orderBy: { createdAt: 'asc' } });
    await prisma.message.updateMany({
      where: { conversationId: c.id, senderId: { not: req.user!.userId }, readAt: null },
      data: { readAt: new Date() },
    });
    res.json(messages.map(m => ({ id: m.id, text: m.text, mine: m.senderId === req.user!.userId, createdAt: m.createdAt, offerAmount: m.offerAmount ?? null, offerStatus: m.offerStatus ?? null })));
  } catch (e: any) { logger.error('GET /chat/:id/messages', { err: e.message }); res.status(500).json({ error: 'Errore' }); }
});

// Invia messaggio (solo testo, niente link/foto).
router.post('/:id/messages', async (req: AuthRequest, res: Response) => {
  try {
    const c = await assertParticipant(req.params.id, req.user!.userId);
    if (!c) return res.status(403).json({ error: 'Non autorizzato' });
    const text = (req.body?.text || '').toString().trim().slice(0, 1000);
    if (!text) return res.status(400).json({ error: 'Messaggio vuoto' });
    if (hasLink(text)) {
      return res.status(400).json({ error: 'Per la tua sicurezza non si possono inviare link o contatti esterni in chat.' });
    }
    const msg = await prisma.message.create({ data: { conversationId: c.id, senderId: req.user!.userId, text } });
    await prisma.conversation.update({ where: { id: c.id }, data: { updatedAt: new Date() } });
    res.json({ id: msg.id, text: msg.text, mine: true, createdAt: msg.createdAt });
  } catch (e: any) { logger.error('POST /chat/:id/messages', { err: e.message }); res.status(500).json({ error: 'Errore invio' }); }
});

// VENDITORE: completa la vendita dalla chat e spedisce.
// Segna l'articolo VENDUTO (prezzo concordato), lo toglie dalla vetrina e — se fornito —
// registra il tracking OUTBOUND (così segui la spedizione fino alla consegna).
router.post('/:id/ship', async (req: AuthRequest, res: Response) => {
  try {
    const uid = req.user!.userId;
    const c = await assertParticipant(req.params.id, uid);
    if (!c) return res.status(403).json({ error: 'Non autorizzato' });
    if (c.sellerId !== uid) return res.status(403).json({ error: 'Solo il venditore può completare la vendita.' });

    const product = await prisma.product.findUnique({ where: { id: c.productId } });
    if (!product || product.deletedAt) return res.status(404).json({ error: 'Articolo non trovato' });
    if (product.userId !== uid) return res.status(403).json({ error: 'Non è un tuo articolo.' });
    if (product.status === 'VENDUTO') return res.status(400).json({ error: 'Articolo già venduto.' });

    const trackingCode = (req.body?.trackingCode || '').toString().trim();
    const carrier = (req.body?.carrier || 'Auto').toString().trim();
    const alreadyPaid = product.status === 'PAGATO'; // pagato in-app: prezzo già fissato

    if (alreadyPaid) {
      // Articolo già pagato in-app: NON tocchiamo prezzo/stato (resta PAGATO finché il
      // compratore non conferma "Consegnato"). Qui aggiungiamo solo la spedizione/tracking.
      if (trackingCode.length < 4) return res.status(400).json({ error: 'Inserisci il codice di tracking.' });
      const r = await addTracking(product.id, trackingCode, carrier, 'OUTBOUND');
      await prisma.message.create({ data: { conversationId: c.id, senderId: uid, text: `📦 Spedito! Codice tracking: ${trackingCode} (${carrier}). Quando ricevi il pacco premi "Consegnato" per sbloccare il pagamento al venditore.` } });
      await prisma.conversation.update({ where: { id: c.id }, data: { updatedAt: new Date() } });
      return res.json({ success: true, tracked: r.success, paid: true });
    }

    // Vendita SENZA pagamento in-app (accordo in chat): segna venduto al prezzo concordato.
    const salePrice = Math.round((Number(req.body?.salePrice) || 0) * 100) / 100;
    if (!(salePrice > 0)) return res.status(400).json({ error: 'Inserisci il prezzo di vendita concordato.' });
    const fees = Math.max(0, Math.round((Number(req.body?.fees) || 0) * 100) / 100);

    await prisma.product.update({
      where: { id: product.id },
      data: { status: 'VENDUTO', soldAt: new Date(), salePrice, fees, platform: 'Marketplace', isPublic: false },
    });

    let tracked = false;
    if (trackingCode.length >= 4) {
      const r = await addTracking(product.id, trackingCode, carrier, 'OUTBOUND');
      tracked = r.success;
    }

    const text = tracked
      ? `✅ Vendita confermata e articolo spedito! Codice tracking: ${trackingCode} (${carrier}). Cercalo sul sito del corriere.`
      : `✅ Vendita confermata! L'articolo sarà spedito a breve.`;
    await prisma.message.create({ data: { conversationId: c.id, senderId: uid, text } });
    await prisma.conversation.update({ where: { id: c.id }, data: { updatedAt: new Date() } });

    res.json({ success: true, tracked });
  } catch (e: any) { logger.error('POST /chat/:id/ship', { err: e.message }); res.status(500).json({ error: 'Errore completamento vendita' }); }
});

// OFFERTE — contrattazione del prezzo in chat.
// Il compratore propone un prezzo; il venditore accetta (fissa il prezzo d'acquisto) o rifiuta.
router.post('/:id/offer', async (req: AuthRequest, res: Response) => {
  try {
    const uid = req.user!.userId;
    const c = await assertParticipant(req.params.id, uid);
    if (!c) return res.status(403).json({ error: 'Non autorizzato' });
    if (c.buyerId !== uid) return res.status(403).json({ error: 'Solo il compratore può fare un\'offerta.' });
    const amount = Math.round((Number(req.body?.amount) || 0) * 100) / 100;
    if (!(amount > 0)) return res.status(400).json({ error: 'Importo offerta non valido.' });
    const msg = await prisma.message.create({
      data: { conversationId: c.id, senderId: uid, text: `💶 Offerta: ${amount.toFixed(2)}€`, offerAmount: amount, offerStatus: 'pending' },
    });
    await prisma.conversation.update({ where: { id: c.id }, data: { updatedAt: new Date() } });
    res.json({ id: msg.id, text: msg.text, mine: true, createdAt: msg.createdAt, offerAmount: amount, offerStatus: 'pending' });
  } catch (e: any) { logger.error('POST /chat/:id/offer', { err: e.message }); res.status(500).json({ error: 'Errore offerta' }); }
});

// Venditore accetta/rifiuta un'offerta.
router.post('/:id/offer/:msgId/:action', async (req: AuthRequest, res: Response) => {
  try {
    const uid = req.user!.userId;
    const action = req.params.action;
    if (action !== 'accept' && action !== 'decline') return res.status(400).json({ error: 'Azione non valida' });
    const c = await assertParticipant(req.params.id, uid);
    if (!c) return res.status(403).json({ error: 'Non autorizzato' });
    if (c.sellerId !== uid) return res.status(403).json({ error: 'Solo il venditore può rispondere alle offerte.' });
    const offer = await prisma.message.findFirst({ where: { id: req.params.msgId, conversationId: c.id } });
    if (!offer || offer.offerAmount == null) return res.status(404).json({ error: 'Offerta non trovata' });
    if (offer.offerStatus !== 'pending') return res.status(400).json({ error: 'Offerta già gestita.' });

    const accepted = action === 'accept';
    await prisma.message.update({ where: { id: offer.id }, data: { offerStatus: accepted ? 'accepted' : 'declined' } });
    if (accepted) {
      await prisma.conversation.update({ where: { id: c.id }, data: { agreedPrice: offer.offerAmount, updatedAt: new Date() } });
    }
    await prisma.message.create({
      data: { conversationId: c.id, senderId: uid, text: accepted ? `✅ Offerta accettata: ${offer.offerAmount.toFixed(2)}€. Puoi completare l'acquisto a questo prezzo.` : `❌ Offerta rifiutata.` },
    });
    res.json({ success: true, accepted, agreedPrice: accepted ? offer.offerAmount : null });
  } catch (e: any) { logger.error('POST /chat/:id/offer/action', { err: e.message }); res.status(500).json({ error: 'Errore gestione offerta' }); }
});

// COMPRATORE: conferma "Consegnato" → sblocca i fondi al venditore (diventa VENDUTO,
// le percentuali tra soci si applicano ora) e l'importo entra nel portafoglio prelevabile.
router.post('/:id/confirm-delivery', async (req: AuthRequest, res: Response) => {
  try {
    const uid = req.user!.userId;
    const c = await assertParticipant(req.params.id, uid);
    if (!c) return res.status(403).json({ error: 'Non autorizzato' });
    if (c.buyerId !== uid) return res.status(403).json({ error: 'Solo il compratore può confermare la consegna.' });

    const product = await prisma.product.findUnique({ where: { id: c.productId } });
    if (!product || product.deletedAt) return res.status(404).json({ error: 'Articolo non trovato' });
    if (product.status !== 'PAGATO') return res.status(400).json({ error: 'Questo articolo non è in attesa di consegna.' });

    const salePrice = Math.max(0, Math.round((((product.heldAmount ?? product.publicPrice ?? 0) - (product.shippingCost ?? 0))) * 100) / 100);
    await prisma.product.update({
      where: { id: product.id },
      data: { status: 'VENDUTO', soldAt: new Date(), salePrice, deliveredConfirmedAt: new Date() },
    });

    await prisma.message.create({ data: { conversationId: c.id, senderId: uid, text: '📬 Consegna confermata! Grazie. Il pagamento è stato sbloccato per il venditore.' } });
    await prisma.conversation.update({ where: { id: c.id }, data: { updatedAt: new Date() } });

    if (product.warehouseId) {
      await notifyWarehouseMembers({
        warehouseId: product.warehouseId, excludeUserId: uid, type: 'SALE',
        title: '✅ Consegna confermata — fondi sbloccati',
        message: `${product.brand} ${product.name}: il compratore ha confermato. Trovi l'importo nel Portafoglio, pronto da riscuotere.`,
      }).catch(() => {});
    }
    res.json({ success: true });
  } catch (e: any) { logger.error('POST /chat/:id/confirm-delivery', { err: e.message }); res.status(500).json({ error: 'Errore conferma consegna' }); }
});

export default router;
