// src/routes/shipping.ts
// Integrazione Packlink Pro per etichette spedizione reali.
// Richiede PACKLINK_API_KEY in env (da packlink.it → Impostazioni → API).

import { Router, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { authenticate, AuthRequest, canAccessProduct } from '../middleware/auth';
import { apiLimiter } from '../middleware/rateLimit';
import { logger } from '../utils/logger';

const router = Router();
const prisma = new PrismaClient();
const PACKLINK_BASE = 'https://api.packlink.com';

router.use(authenticate, apiLimiter);

function packlinkHeaders() {
  const key = (process.env.PACKLINK_API_KEY || '').trim();
  return {
    'Authorization': `Apikey ${key}`,
    'Content-Type': 'application/json',
  };
}

// ==========================================
// GET /shipping/ping — verifica chiave API Packlink (solo debug admin)
// ==========================================
router.get('/ping', async (req: AuthRequest, res: Response) => {
  const key = (process.env.PACKLINK_API_KEY || '').trim();
  if (!key) return res.json({ ok: false, error: 'PACKLINK_API_KEY non configurata' });

  const baseParams = 'from[country]=IT&from[zip]=20100&to[country]=IT&to[zip]=00100&packages[0][weight]=1&packages[0][width]=30&packages[0][height]=20&packages[0][length]=20';

  const tests = [
    { label: 'Apikey + source=PRO',  url: `${PACKLINK_BASE}/v1/services?${baseParams}&source=PRO`, auth: `Apikey ${key}` },
    { label: 'Apikey senza source',  url: `${PACKLINK_BASE}/v1/services?${baseParams}`,             auth: `Apikey ${key}` },
    { label: 'Bearer',               url: `${PACKLINK_BASE}/v1/services?${baseParams}`,             auth: `Bearer ${key}` },
    { label: 'Raw key',              url: `${PACKLINK_BASE}/v1/services?${baseParams}`,             auth: key },
  ];

  const results = await Promise.all(tests.map(async t => {
    const r = await fetch(t.url, {
      headers: { 'Authorization': t.auth, 'Content-Type': 'application/json' },
    }).catch(() => null);
    if (!r) return { label: t.label, status: 0, ok: false };
    const body = await r.text();
    return { label: t.label, status: r.status, ok: r.ok, snippet: body.slice(0, 120) };
  }));

  res.json({ keyLength: key.length, keyPreview: `${key.slice(0,8)}…${key.slice(-4)}`, results });
});

// ==========================================
// GET /shipping/rates — tariffe disponibili
// Query params: fromZip, toZip, weight (kg), width, height, length (cm)
// ==========================================
router.get('/rates', async (req: AuthRequest, res: Response) => {
  const apiKey = process.env.PACKLINK_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'Packlink non configurato. Aggiungi PACKLINK_API_KEY nelle variabili di Railway.' });

  const { fromZip = '20100', toZip, weight = '1', width = '30', height = '20', length = '20' } = req.query as Record<string, string>;
  if (!toZip) return res.status(400).json({ error: 'toZip obbligatorio' });

  try {
    const params = new URLSearchParams({
      'from[country]': 'IT', 'from[zip]': fromZip,
      'to[country]': 'IT',   'to[zip]': toZip,
      'packages[0][weight]': weight,
      'packages[0][width]': width,
      'packages[0][height]': height,
      'packages[0][length]': length,
      'source': 'PRO',
    });

    const r = await fetch(`${PACKLINK_BASE}/v1/services?${params}`, {
      headers: packlinkHeaders(),
    });

    if (!r.ok) {
      const errText = await r.text().catch(() => '');
      logger.error('Packlink rates error', { status: r.status, body: errText });
      let msg = `Errore Packlink (${r.status})`;
      try {
        const errJson = JSON.parse(errText);
        msg = errJson?.messages?.[0] || errJson?.detail || errJson?.message || msg;
      } catch {}
      return res.status(r.status).json({ error: msg, detail: errText.slice(0, 200) });
    }

    const services = await r.json() as any[];
    // Filtra solo servizi disponibili e ordina per prezzo
    const available = (Array.isArray(services) ? services : [])
      .filter((s: any) => s.available !== false)
      .map((s: any) => ({
        id: s.id,
        name: s.name,
        carrier: s.carrier_name || s.carrier?.name || '',
        price: s.price?.tax_price ?? s.base_price?.tax_price ?? 0,
        transitHours: s.transit_hours,
        logo: s.logo_url || null,
      }))
      .sort((a: any, b: any) => a.price - b.price);

    res.json(available);
  } catch (err: any) {
    logger.error('Errore GET /shipping/rates', { err: err.message });
    res.status(500).json({ error: 'Errore comunicazione Packlink' });
  }
});

// ==========================================
// POST /shipping/book — prenota spedizione + ottieni etichetta PDF
// ==========================================
router.post('/book', async (req: AuthRequest, res: Response) => {
  const apiKey = process.env.PACKLINK_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'Packlink non configurato.' });

  const { productId, serviceId, from, to, pkg, content } = req.body;

  if (!serviceId || !from?.zip || !to?.name || !to?.address || !to?.zip || !pkg?.weight) {
    return res.status(400).json({ error: 'Dati spedizione incompleti.' });
  }

  // Verifica accesso al prodotto (opzionale — la spedizione può esistere anche senza prodotto)
  let product: any = null;
  if (productId) {
    const access = await canAccessProduct(req.user!.userId, productId);
    if (!access.allowed) return res.status(403).json({ error: 'Accesso negato al prodotto.' });
    product = access.product;
  }

  try {
    const body = {
      service_id: serviceId,
      draft: false,
      content: content || (product ? `${product.brand} ${product.name}` : 'Articolo'),
      from: {
        country: 'IT',
        zip_code: from.zip,
        city: from.city || '',
        street1: from.address || '',
        name: from.name || '',
        phone: from.phone || '',
        email: from.email || req.user!.email,
        company: from.company || null,
      },
      to: {
        country: 'IT',
        zip_code: to.zip,
        city: to.city || '',
        street1: to.address,
        name: to.name,
        phone: to.phone || '',
        email: to.email || '',
        company: null,
      },
      packages: [{
        weight: parseFloat(pkg.weight),
        width:  parseFloat(pkg.width  || 30),
        height: parseFloat(pkg.height || 20),
        length: parseFloat(pkg.length || 20),
      }],
    };

    const r = await fetch(`${PACKLINK_BASE}/v1/shipments`, {
      method: 'POST',
      headers: packlinkHeaders(),
      body: JSON.stringify(body),
    });

    if (!r.ok) {
      const err = await r.json().catch(() => ({})) as any;
      const msg = err?.messages?.[0] || err?.detail || `Errore Packlink (${r.status})`;
      logger.error('Packlink book error', { status: r.status, err });
      return res.status(r.status).json({ error: msg });
    }

    const shipment = await r.json() as any;
    const reference = shipment.reference;

    // Recupera l'etichetta PDF
    let labelUrl: string | null = null;
    try {
      const labelR = await fetch(`${PACKLINK_BASE}/v1/shipments/${reference}/labels`, {
        headers: packlinkHeaders(),
      });
      if (labelR.ok) {
        const labelData = await labelR.json() as any;
        labelUrl = labelData?.labels?.[0] || null;
      }
    } catch { /* non bloccante */ }

    // Salva tracking sul prodotto se fornito
    if (productId && reference) {
      await prisma.product.update({
        where: { id: productId },
        data: {
          trackingCode: reference,
          trackingCarrier: 'Packlink',
          trackingStatus: 'PENDING',
          trackingUpdatedAt: new Date(),
        },
      }).catch(() => {});
    }

    logger.info('Spedizione Packlink creata', { reference, productId });
    res.json({ reference, labelUrl, shipment });
  } catch (err: any) {
    logger.error('Errore POST /shipping/book', { err: err.message });
    res.status(500).json({ error: 'Errore prenotazione spedizione' });
  }
});

export default router;
