// src/routes/shipping.ts
// Integrazione Sendcloud per etichette spedizione.
// Piano gratuito: 400 spedizioni/mese, API inclusa, BRT + GLS + Poste + DHL.
// Richiede SENDCLOUD_API_KEY e SENDCLOUD_API_SECRET in env (da app.sendcloud.com → Settings → API).

import { Router, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { authenticate, AuthRequest, canAccessProduct } from '../middleware/auth';
import { apiLimiter } from '../middleware/rateLimit';
import { logger } from '../utils/logger';

const router = Router();
const prisma = new PrismaClient();
const SENDCLOUD_BASE = 'https://panel.sendcloud.sc/api/v2';

router.use(authenticate, apiLimiter);

function sendcloudHeaders() {
  const key    = (process.env.SENDCLOUD_API_KEY    || '').trim();
  const secret = (process.env.SENDCLOUD_API_SECRET || '').trim();
  const b64    = Buffer.from(`${key}:${secret}`).toString('base64');
  return {
    'Authorization': `Basic ${b64}`,
    'Content-Type': 'application/json',
  };
}

function isConfigured() {
  return !!(process.env.SENDCLOUD_API_KEY && process.env.SENDCLOUD_API_SECRET);
}

// ==========================================
// GET /shipping/ping — verifica connessione Sendcloud
// ==========================================
router.get('/ping', async (req: AuthRequest, res: Response) => {
  if (!isConfigured()) return res.json({ ok: false, error: 'SENDCLOUD_API_KEY / SENDCLOUD_API_SECRET non configurate' });

  const r = await fetch(`${SENDCLOUD_BASE}/user`, { headers: sendcloudHeaders() }).catch(() => null);
  if (!r) return res.json({ ok: false, error: 'Errore di rete verso Sendcloud' });

  const body = await r.text();
  let user: any = null;
  try { user = JSON.parse(body); } catch {}

  res.json({
    ok: r.ok,
    status: r.status,
    username: user?.user?.username || null,
    email: user?.user?.email || null,
    plan: user?.user?.plan_name || null,
  });
});

// ==========================================
// GET /shipping/rates — tariffe disponibili
// Query params: fromZip, toZip, weight (kg)
// ==========================================
router.get('/rates', async (req: AuthRequest, res: Response) => {
  if (!isConfigured()) {
    return res.status(503).json({ error: 'Sendcloud non configurato. Aggiungi SENDCLOUD_API_KEY e SENDCLOUD_API_SECRET su Railway.' });
  }

  const { fromZip = '20100', toZip, weight = '1' } = req.query as Record<string, string>;
  if (!toZip) return res.status(400).json({ error: 'toZip obbligatorio' });

  const weightGrams = Math.round(parseFloat(weight) * 1000);

  const params = new URLSearchParams({
    from_postal_code: fromZip,
    to_postal_code:   toZip,
    to_country:       'IT',
    weight:           String(weightGrams),
  });

  try {
    const r = await fetch(`${SENDCLOUD_BASE}/shipping_methods?${params}`, {
      headers: sendcloudHeaders(),
    });

    if (!r.ok) {
      const errText = await r.text();
      logger.error('Sendcloud rates error', { status: r.status, body: errText });
      return res.status(r.status).json({ error: `Errore Sendcloud (${r.status})` });
    }

    const data = await r.json() as any;
    const methods: any[] = data?.shipping_methods || [];

    const weightKg = parseFloat(weight);
    const available = methods
      .filter((m: any) => {
        const minW = parseFloat(m.min_weight || '0');
        const maxW = parseFloat(m.max_weight || '999');
        return weightKg >= minW && weightKg <= maxW;
      })
      .map((m: any) => {
        // Cerca il prezzo per l'IT nel campo countries oppure price diretto
        const itCountry = m.countries?.find((c: any) => c.iso_2 === 'IT');
        const price = itCountry?.price ?? m.price ?? 0;
        return {
          id:           m.id,
          name:         m.name,
          carrier:      m.carrier,
          price:        typeof price === 'string' ? parseFloat(price) : price,
          minWeight:    parseFloat(m.min_weight || '0'),
          maxWeight:    parseFloat(m.max_weight || '999'),
        };
      })
      .filter((m: any) => m.price > 0)
      .sort((a: any, b: any) => a.price - b.price);

    res.json(available);
  } catch (err: any) {
    logger.error('Errore GET /shipping/rates', { err: err.message });
    res.status(500).json({ error: 'Errore comunicazione Sendcloud' });
  }
});

// ==========================================
// POST /shipping/book — crea spedizione + ottieni etichetta PDF
// ==========================================
router.post('/book', async (req: AuthRequest, res: Response) => {
  if (!isConfigured()) return res.status(503).json({ error: 'Sendcloud non configurato.' });

  const { productId, serviceId, from, to, pkg, content } = req.body;

  if (!serviceId || !to?.name || !to?.address || !to?.zip || !to?.city || !pkg?.weight) {
    return res.status(400).json({ error: 'Dati spedizione incompleti.' });
  }

  let product: any = null;
  if (productId) {
    const access = await canAccessProduct(req.user!.userId, productId);
    if (!access.allowed) return res.status(403).json({ error: 'Accesso negato al prodotto.' });
    product = access.product;
  }

  try {
    const parcelBody = {
      parcel: {
        name:        to.name,
        address:     to.address,
        city:        to.city,
        postal_code: to.zip,
        country:     'IT',
        telephone:   to.phone  || '',
        email:       to.email  || '',
        weight:      parseFloat(pkg.weight).toFixed(3),
        shipment:    { id: Number(serviceId) },
        request_label: true,
        order_number:  `HQ-${Date.now()}`,
        data: content || (product ? `${product.brand} ${product.name}` : 'Articolo'),
      },
    };

    const r = await fetch(`${SENDCLOUD_BASE}/parcels`, {
      method: 'POST',
      headers: sendcloudHeaders(),
      body: JSON.stringify(parcelBody),
    });

    const respText = await r.text();
    let resp: any = {};
    try { resp = JSON.parse(respText); } catch {}

    if (!r.ok) {
      const msg = resp?.error?.message || resp?.parcel?.error || `Errore Sendcloud (${r.status})`;
      logger.error('Sendcloud book error', { status: r.status, msg });
      return res.status(r.status).json({ error: msg });
    }

    const parcel = resp.parcel;
    const trackingNumber = parcel?.tracking_number || parcel?.id?.toString();

    // URL etichetta: prova label_printer (A6) poi normal_printer (A4)
    const labelUrl: string | null =
      parcel?.label?.label_printer ||
      (Array.isArray(parcel?.label?.normal_printer) ? parcel.label.normal_printer[0] : null) ||
      null;

    // Salva tracking sul prodotto
    if (productId && trackingNumber) {
      await prisma.product.update({
        where: { id: productId },
        data: {
          trackingCode:     trackingNumber,
          trackingCarrier:  parcel?.carrier?.code || 'Sendcloud',
          trackingStatus:   'PENDING',
          trackingUpdatedAt: new Date(),
        },
      }).catch(() => {});
    }

    logger.info('Spedizione Sendcloud creata', { parcelId: parcel?.id, trackingNumber });
    res.json({ reference: trackingNumber, labelUrl, parcel });
  } catch (err: any) {
    logger.error('Errore POST /shipping/book', { err: err.message });
    res.status(500).json({ error: 'Errore prenotazione spedizione' });
  }
});

export default router;
