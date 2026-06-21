// src/routes/chat.ts
// Chat marketplace acquirente↔venditore. SOLO TESTO: niente link né foto (anti-truffa).
// Semplice (polling lato client), leggera per Render.

import { Router, Response } from 'express';
import { prisma } from '../lib/prisma';
import { authenticate, AuthRequest } from '../middleware/auth';
import { addTracking } from '../services/tracking.service';
import { notifyWarehouseMembers, notify } from '../services/notification.service';
import { logger } from '../utils/logger';
import { refundProductPayment, releaseHold, reverseSaleAfterRefund, reasonLabel, DISPUTE_REASONS, SHIP_FALLBACK_DAYS } from '../services/dispute.service';

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
      prisma.product.findMany({ where: { id: { in: productIds } }, select: { id: true, brand: true, name: true, photos: true, publicPrice: true, status: true, trackingCode: true, trackingCarrier: true, trackingStatus: true, disputeStatus: true, disputeReason: true } }),
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
        trackingCode: p?.trackingCode ?? null,
        trackingCarrier: p?.trackingCarrier ?? null,
        trackingStatus: p?.trackingStatus ?? null,
        disputeStatus: p?.disputeStatus ?? null,
        disputeReason: p?.disputeReason ?? null,
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
    // Notifica l'altro partecipante (push, se ha i messaggi attivi).
    const otherId = c.buyerId === req.user!.userId ? c.sellerId : c.buyerId;
    notify({ userId: otherId, type: 'MESSAGE', title: '💬 Nuovo messaggio', message: text.slice(0, 120), link: '/?view=chat' }).catch(() => {});
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
      // Rete di sicurezza: se la consegna non viene mai rilevata, sblocca comunque dopo SHIP_FALLBACK_DAYS.
      // (Quando il tracking segna "consegnato", la finestra si stringe a 5gg — vedi tracking.service.)
      const fallback = new Date(Date.now() + SHIP_FALLBACK_DAYS * 86400000);
      await prisma.product.update({ where: { id: product.id }, data: { autoReleaseAt: fallback } }).catch(() => {});
      // Stesso tracking anche sulla copia del compratore (in arrivo / INBOUND).
      const buyerCopy = await prisma.product.findFirst({ where: { sourceProductId: product.id, userId: c.buyerId, deletedAt: null } }).catch(() => null);
      if (buyerCopy) await addTracking(buyerCopy.id, trackingCode, carrier, 'INBOUND').catch(() => {});
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
    notify({ userId: c.sellerId, type: 'OFFER', title: '💶 Nuova offerta', message: `Hai ricevuto un'offerta di ${amount.toFixed(2)}€`, link: '/?view=chat' }).catch(() => {});
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
    notify({ userId: c.buyerId, type: 'OFFER', title: accepted ? '✅ Offerta accettata' : '❌ Offerta rifiutata', message: accepted ? `La tua offerta di ${offer.offerAmount.toFixed(2)}€ è stata accettata!` : 'Il venditore ha rifiutato la tua offerta.', link: '/?view=chat' }).catch(() => {});
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
    if (product.disputeStatus) return res.status(400).json({ error: 'C\'è una contestazione aperta su questo articolo.' });

    await releaseHold(product.id);
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

// ==========================================
// CONTESTAZIONI / RESI
// ==========================================

// COMPRATORE: apre una contestazione su un articolo pagato (fondi ancora congelati).
// Motivo + descrizione + foto come prova. Il venditore deve rispondere.
router.post('/:id/dispute', async (req: AuthRequest, res: Response) => {
  try {
    const uid = req.user!.userId;
    const c = await assertParticipant(req.params.id, uid);
    if (!c) return res.status(403).json({ error: 'Non autorizzato' });
    if (c.buyerId !== uid) return res.status(403).json({ error: 'Solo il compratore può aprire una contestazione.' });

    const product = await prisma.product.findUnique({ where: { id: c.productId } });
    if (!product || product.deletedAt) return res.status(404).json({ error: 'Articolo non trovato' });
    if (product.status !== 'PAGATO') return res.status(400).json({ error: 'Puoi contestare solo un articolo pagato e non ancora sbloccato.' });
    if (product.disputeStatus) return res.status(400).json({ error: 'Hai già aperto una contestazione su questo articolo.' });

    const reason = (req.body?.reason || '').toString();
    if (!DISPUTE_REASONS.includes(reason as any)) return res.status(400).json({ error: 'Motivo non valido.' });
    const note = (req.body?.note || '').toString().trim().slice(0, 1000);
    let photos: string[] = [];
    if (Array.isArray(req.body?.photos)) {
      photos = req.body.photos.filter((p: any) => typeof p === 'string' && /^data:image\/(jpeg|jpg|png|webp);base64,/.test(p)).slice(0, 5);
    }

    await prisma.product.update({
      where: { id: product.id },
      data: {
        disputeStatus: 'OPEN',
        disputeReason: reason,
        disputeNote: note || null,
        disputePhotos: photos.length ? JSON.stringify(photos) : null,
        disputeOpenedAt: new Date(),
      },
    });
    await prisma.message.create({ data: { conversationId: c.id, senderId: uid, text: `⚠️ Contestazione aperta: ${reasonLabel(reason)}${note ? ` — ${note}` : ''}. Il venditore può rimborsarti o rispondere.` } });
    await prisma.conversation.update({ where: { id: c.id }, data: { updatedAt: new Date() } });

    if (product.warehouseId) {
      await notifyWarehouseMembers({
        warehouseId: product.warehouseId, excludeUserId: uid, type: 'SALE',
        title: '⚠️ Contestazione ricevuta',
        message: `${product.brand} ${product.name}: ${reasonLabel(reason)}. Apri la chat per rispondere (rimborso totale/parziale o contesta).`,
      }).catch(() => {});
    }
    res.json({ success: true });
  } catch (e: any) { logger.error('POST /chat/:id/dispute', { err: e.message }); res.status(500).json({ error: 'Errore apertura contestazione' }); }
});

// VENDITORE: risponde a una contestazione.
//  action 'refund'  → rimborso totale (l'articolo torna invenduto, copia compratore rimossa)
//  action 'partial' → rimborso parziale (il compratore tiene l'oggetto, il resto si sblocca)
//  action 'contest' → escala all'assistenza (admin) per la mediazione
router.post('/:id/dispute/respond', async (req: AuthRequest, res: Response) => {
  try {
    const uid = req.user!.userId;
    const c = await assertParticipant(req.params.id, uid);
    if (!c) return res.status(403).json({ error: 'Non autorizzato' });
    if (c.sellerId !== uid) return res.status(403).json({ error: 'Solo il venditore può rispondere alla contestazione.' });

    const product = await prisma.product.findUnique({ where: { id: c.productId } });
    if (!product || product.deletedAt) return res.status(404).json({ error: 'Articolo non trovato' });
    if (product.disputeStatus !== 'OPEN') return res.status(400).json({ error: 'Nessuna contestazione da gestire.' });

    const action = (req.body?.action || '').toString();

    if (action === 'refund') {
      const r = await refundProductPayment(product);
      if (!r.ok) return res.status(502).json({ error: r.error || 'Rimborso non riuscito' });
      await reverseSaleAfterRefund(product.id, product.heldAmount ?? 0);
      await prisma.message.create({ data: { conversationId: c.id, senderId: uid, text: '✅ Rimborso totale effettuato. Riceverai i soldi sul metodo di pagamento entro pochi giorni.' } });
    } else if (action === 'partial') {
      const amount = Math.round((Number(req.body?.amount) || 0) * 100) / 100;
      const maxRefund = (product.heldAmount ?? 0);
      if (!(amount > 0) || amount >= maxRefund) return res.status(400).json({ error: 'Importo rimborso parziale non valido.' });
      const r = await refundProductPayment(product, amount);
      if (!r.ok) return res.status(502).json({ error: r.error || 'Rimborso non riuscito' });
      await releaseHold(product.id, { partialRefund: amount });
      await prisma.message.create({ data: { conversationId: c.id, senderId: uid, text: `✅ Rimborso parziale di ${amount.toFixed(2)}€ effettuato. Tieni l'articolo; il resto è stato sbloccato.` } });
    } else if (action === 'contest') {
      await prisma.product.update({ where: { id: product.id }, data: { disputeStatus: 'ESCALATED' } });
      await prisma.message.create({ data: { conversationId: c.id, senderId: uid, text: '⚖️ Il venditore ha contestato. L\'assistenza ResellerHQ esaminerà il caso e deciderà.' } });
    } else {
      return res.status(400).json({ error: 'Azione non valida.' });
    }
    await prisma.conversation.update({ where: { id: c.id }, data: { updatedAt: new Date() } });
    res.json({ success: true });
  } catch (e: any) { logger.error('POST /chat/:id/dispute/respond', { err: e.message }); res.status(500).json({ error: 'Errore gestione contestazione' }); }
});

// Dettaglio contestazione (motivo, nota, foto) — visibile ai due partecipanti.
router.get('/:id/dispute', async (req: AuthRequest, res: Response) => {
  try {
    const c = await assertParticipant(req.params.id, req.user!.userId);
    if (!c) return res.status(403).json({ error: 'Non autorizzato' });
    const p = await prisma.product.findUnique({ where: { id: c.productId }, select: { disputeStatus: true, disputeReason: true, disputeNote: true, disputePhotos: true, disputeOpenedAt: true, heldAmount: true } });
    if (!p?.disputeStatus) return res.json({ open: false });
    let photos: string[] = []; try { photos = p.disputePhotos ? JSON.parse(p.disputePhotos) : []; } catch {}
    res.json({ open: true, status: p.disputeStatus, reason: p.disputeReason, reasonLabel: reasonLabel(p.disputeReason), note: p.disputeNote, photos, openedAt: p.disputeOpenedAt, amount: p.heldAmount });
  } catch (e: any) { logger.error('GET /chat/:id/dispute', { err: e.message }); res.status(500).json({ error: 'Errore' }); }
});

export default router;
