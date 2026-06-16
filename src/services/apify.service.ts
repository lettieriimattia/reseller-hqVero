// src/services/apify.service.ts
// Valutazione borse (e affini) via Apify + scraper Vestiaire Collective.
// Copre i brand "contemporary" (Zadig & Voltaire, Jacquemus, Balenciaga…) che eBay
// non trova. È a CONSUMO, quindi mettiamo un TETTO MENSILE per non sforare il credito
// gratis → oltre il limite, niente chiamate (si torna a eBay). Mai un addebito.
//
// Env su Render:
//   APIFY_TOKEN            → token API (apify.com → Settings → Integrations)
//   APIFY_VESTIAIRE_ACTOR  → id dell'actor scelto (es. "user~vestiaire-scraper")
//   APIFY_MONTHLY_LIMIT    → max ricerche/mese (default 80, prudente per stare nel free)

import { PrismaClient } from '@prisma/client';
import { logger } from '../utils/logger';

const prisma = new PrismaClient();

const TOKEN = (process.env.APIFY_TOKEN || '').trim();
const ACTOR = (process.env.APIFY_VESTIAIRE_ACTOR || '').trim();
const MONTHLY_LIMIT = parseInt(process.env.APIFY_MONTHLY_LIMIT || '80', 10);

export interface BagValuation {
  value: number | null;   // mediana prezzi trovati (EUR)
  currency: string;
  source: string;
  itemName?: string;
  image?: string;
  sample: number;
}

export function isApifyConfigured(): boolean { return !!(TOKEN && ACTOR); }

// ---- Contatore mensile (tabella Setting key/value) ----
function monthKey(): string {
  const d = new Date();
  return `apify_count_${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
async function getMonthlyCount(): Promise<number> {
  try { const s = await prisma.setting.findUnique({ where: { key: monthKey() } }); return s ? parseInt(s.value, 10) || 0 : 0; }
  catch { return 0; }
}
async function bumpMonthlyCount(): Promise<void> {
  const key = monthKey();
  const current = await getMonthlyCount();
  try { await prisma.setting.upsert({ where: { key }, update: { value: String(current + 1) }, create: { key, value: '1' } }); }
  catch (err: any) { logger.error('Errore bump contatore Apify', { err: err.message }); }
}

// Quante ricerche restano questo mese (per UI/diagnostica)
export async function apifyRemaining(): Promise<number> {
  return Math.max(0, MONTHLY_LIMIT - (await getMonthlyCount()));
}

// Estrae un prezzo numerico da campi/formati diversi (gli actor variano).
function parsePrice(raw: any): number | null {
  if (raw == null) return null;
  if (typeof raw === 'number' && isFinite(raw)) return raw;
  if (typeof raw === 'object') {
    if (typeof raw.cents === 'number') return raw.cents / 100;
    if (raw.value != null) return parsePrice(raw.value);
    if (raw.amount != null) return parsePrice(raw.amount);
    return null;
  }
  const s = String(raw).replace(/[^\d.,]/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.');
  const n = parseFloat(s);
  return isFinite(n) && n > 0 ? n : null;
}
function pickPrice(it: any): number | null {
  for (const k of ['price', 'currentPrice', 'sellingPrice', 'priceWithoutTax', 'priceWithCurrency', 'amount', 'cost']) {
    const v = parsePrice(it?.[k]);
    if (v != null && v > 0) return v;
  }
  return null;
}
function median(arr: number[]): number | null {
  const a = arr.filter(n => isFinite(n) && n > 0).sort((x, y) => x - y);
  if (a.length === 0) return null;
  return Math.round(a[Math.floor(a.length / 2)]);
}

export async function getBagValue(opts: { query: string }): Promise<BagValuation | null> {
  if (!isApifyConfigured() || !opts.query || opts.query.trim().length < 2) return null;

  // Tetto mensile: oltre il limite NON chiamiamo Apify (niente costi). Si torna a eBay.
  const used = await getMonthlyCount();
  if (used >= MONTHLY_LIMIT) {
    logger.info('Apify: tetto mensile raggiunto, salto la chiamata', { used, limit: MONTHLY_LIMIT });
    return null;
  }

  try {
    await bumpMonthlyCount(); // conta PRIMA (prudente: non sforare anche con errori)
    // L'actor parseforge/vestiairecollective-scraper vuole uno startUrl (URL di ricerca
    // Vestiaire). Uso il dominio it. per avere i prezzi in EURO.
    const startUrl = `https://it.vestiairecollective.com/search/?q=${encodeURIComponent(opts.query)}`;
    const url = `https://api.apify.com/v2/acts/${encodeURIComponent(ACTOR)}/run-sync-get-dataset-items?token=${TOKEN}&maxItems=10&timeout=90`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        startUrl,
        maxItems: 10,
        includeDetails: false,
        proxyConfiguration: { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] },
      }),
    });
    if (!r.ok) { logger.error('Apify run error', { status: r.status }); return null; }
    const items = await r.json() as any[];
    if (!Array.isArray(items) || items.length === 0) {
      return { value: null, currency: 'EUR', source: 'Vestiaire (Apify)', sample: 0 };
    }
    const prices = items.map(pickPrice).filter((n): n is number => n != null);
    const first = items[0] || {};
    return {
      value: median(prices),
      currency: 'EUR',
      source: 'Vestiaire (Apify)',
      itemName: first.title || first.name || first.brand,
      image: first.imageUrl || first.image || first.photo || (Array.isArray(first.images) ? first.images[0] : undefined),
      sample: prices.length,
    };
  } catch (err: any) {
    logger.error('Errore getBagValue', { err: err.message });
    return null;
  }
}
