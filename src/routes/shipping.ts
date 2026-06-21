// src/routes/shipping.ts
// Integrazione Sendcloud per etichette spedizione.
// Piano gratuito: 400 spedizioni/mese, API inclusa, BRT + GLS + Poste + DHL.
// Richiede SENDCLOUD_API_KEY e SENDCLOUD_API_SECRET in env (da app.sendcloud.com → Settings → API).

import { Router, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { prisma } from "../lib/prisma";
import { authenticate, AuthRequest, canAccessProduct } from '../middleware/auth';
import { apiLimiter } from '../middleware/rateLimit';
import { logger } from '../utils/logger';

const router = Router();
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
// GET /shipping/rates — tariffe disponibili (demo se Sendcloud non configurato)
// ==========================================
router.get('/rates', async (req: AuthRequest, res: Response) => {
  if (!isConfigured()) {
    // Modalità demo: tariffe simulate per testare il flusso UI
    return res.json([
      { id: 'demo-1', name: 'BRT Express',          carrier: 'brt',   price: 5.90,  minWeight: 0, maxWeight: 30, demo: true },
      { id: 'demo-2', name: 'GLS Standard',          carrier: 'gls',   price: 4.50,  minWeight: 0, maxWeight: 30, demo: true },
      { id: 'demo-3', name: 'Poste Italiane Pacco',  carrier: 'poste', price: 6.20,  minWeight: 0, maxWeight: 20, demo: true },
      { id: 'demo-4', name: 'DHL Express',           carrier: 'dhl',   price: 12.00, minWeight: 0, maxWeight: 30, demo: true },
    ]);
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
// POST /shipping/book — crea spedizione (demo se Sendcloud non configurato)
// ==========================================
router.post('/book', async (req: AuthRequest, res: Response) => {
  if (!isConfigured()) {
    // Modalità demo: genera etichetta HTML stampabile senza corriere reale
    const { productId, from, to, pkg, content, serviceId } = req.body;

    // Se il prodotto ha GIÀ un'etichetta salvata → restituisci QUELLA (non crearne un'altra).
    if (productId) {
      const access = await canAccessProduct(req.user!.userId, productId);
      if (access.allowed && (access.product as any)?.shippingLabel) {
        try {
          const saved = JSON.parse((access.product as any).shippingLabel);
          if (saved?.trackingCode) {
            return res.json({ reference: saved.trackingCode, labelUrl: saved.labelUrl || null, labelHtml: generateDemoLabel(saved), demo: true, existing: true });
          }
        } catch { /* snapshot corrotto: rigenera sotto */ }
      }
    }

    const demoServices: Record<string, string> = {
      'demo-1': 'BRT Express', 'demo-2': 'GLS Standard',
      'demo-3': 'Poste Italiane Pacco', 'demo-4': 'DHL Express',
    };
    const carrier = demoServices[serviceId] || serviceId;
    const trackingCode = `HQ-DEMO-${Date.now()}`;
    const snapshot = { from, to, pkg, content, carrier, trackingCode };
    const labelHtml = generateDemoLabel(snapshot);

    // Salva l'etichetta sul prodotto: così resta e si riapre identica.
    if (productId) {
      await prisma.product.update({
        where: { id: productId },
        data: { trackingCode, trackingCarrier: carrier, shippingLabel: JSON.stringify(snapshot) },
      }).catch(() => {});
    }

    return res.json({ reference: trackingCode, labelUrl: null, labelHtml, demo: true });
  }

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
          // Salva il riferimento all'etichetta reale: si riapre senza ricrearla.
          shippingLabel:    JSON.stringify({ labelUrl, trackingCode: trackingNumber, carrier: parcel?.carrier?.code || 'Sendcloud' }),
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

function generateDemoLabel(opts: {
  from: any; to: any; pkg: any; content?: string; carrier: string; trackingCode: string;
}): string {
  const { from, to, pkg, content, carrier, trackingCode } = opts;
  const date = new Date().toLocaleDateString('it-IT', { day: '2-digit', month: 'short', year: 'numeric' });
  // Barcode visuale semplice (linee verticali CSS — non scansionabile ma estetico)
  const bars = Array.from({ length: 60 }, (_, i) =>
    `<div style="width:${i % 5 === 0 ? 3 : 1}px;height:50px;background:#000;display:inline-block;margin:0 0.3px"></div>`
  ).join('');

  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<title>Etichetta ${trackingCode}</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:Arial,sans-serif;background:#fff;padding:10mm}
  .label{border:2px solid #000;width:100mm;padding:5mm;page-break-inside:avoid}
  .header{display:flex;justify-content:space-between;align-items:center;border-bottom:2px solid #000;padding-bottom:3mm;margin-bottom:3mm}
  .logo{font-size:22px;font-weight:900;letter-spacing:-1px}
  .logo span{opacity:.2}
  .carrier{font-size:14px;font-weight:700;background:#000;color:#fff;padding:2px 8px;border-radius:3px}
  .section{margin-bottom:3mm}
  .label-title{font-size:8px;text-transform:uppercase;letter-spacing:1px;color:#666;margin-bottom:1mm}
  .value{font-size:11px;font-weight:700;color:#000;line-height:1.3}
  .value-sm{font-size:10px;color:#333;line-height:1.4}
  .divider{border-top:1px dashed #ccc;margin:3mm 0}
  .barcode{text-align:center;margin:3mm 0}
  .tracking{text-align:center;font-family:monospace;font-size:9px;font-weight:700;letter-spacing:2px;margin-top:1mm}
  .demo-badge{background:#ff4d00;color:#fff;font-size:9px;font-weight:700;padding:1px 6px;border-radius:3px;text-align:center;margin-bottom:2mm}
  .weight-box{display:inline-block;border:1px solid #000;padding:1mm 3mm;font-size:10px;font-weight:700}
  @media print{body{padding:0}@page{margin:5mm;size:100mm 150mm}}
</style></head>
<body><div class="label">
  <div class="demo-badge">⚠ ETICHETTA DEMO — Non spedire</div>
  <div class="header">
    <div class="logo">H<span>Q</span></div>
    <div class="carrier">${carrier}</div>
    <div class="weight-box">${pkg?.weight || '1'} kg</div>
  </div>
  <div class="section">
    <div class="label-title">Mittente</div>
    <div class="value">${from?.name || '—'}</div>
    <div class="value-sm">${from?.address || '—'}</div>
    <div class="value-sm">${from?.zip || ''} ${from?.city || ''}</div>
  </div>
  <div class="divider"></div>
  <div class="section">
    <div class="label-title">Destinatario</div>
    <div class="value" style="font-size:14px">${to?.name || '—'}</div>
    <div class="value-sm">${to?.address || '—'}</div>
    <div class="value" style="font-size:14px">${to?.zip || ''} ${to?.city || ''}</div>
  </div>
  <div class="divider"></div>
  <div class="section">
    <div class="label-title">Contenuto</div>
    <div class="value-sm">${content || '—'}</div>
  </div>
  <div class="barcode">${bars}</div>
  <div class="tracking">${trackingCode}</div>
  <div class="divider"></div>
  <div style="display:flex;justify-content:space-between;font-size:8px;color:#999">
    <span>${date}</span>
    <span>HQ Reseller Manager</span>
  </div>
</div>
<script>window.onload=()=>{window.print()}<\/script>
</body></html>`;
}

export default router;
