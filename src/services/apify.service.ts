// src/services/apify.service.ts
// Valutazioni "potenti" via Apify per le categorie che eBay non copre bene:
//   - Borse (Vestiaire Collective)  → brand contemporary (Zadig, Jacquemus…)
//   - Orologi (Chrono24)            → referenze, corredo, prezzi reali
// È a CONSUMO → TETTO MENSILE UNICO e CONDIVISO (borse+orologi pescano dallo stesso
// credito gratis): oltre il limite niente chiamate (si torna a eBay). Mai un addebito
// (basta non mettere la carta su Apify).
//
// Env su Render:
//   APIFY_TOKEN            → token API personale (apify_api_...)
//   APIFY_VESTIAIRE_ACTOR  → id actor borse (es. parseforge/vestiairecollective-scraper)
//   APIFY_CHRONO24_ACTOR   → id actor orologi (lo scegli sull'Apify Store)
//   APIFY_MONTHLY_LIMIT    → tetto TOTALE ricerche/mese (default 30), condiviso

import { PrismaClient } from '@prisma/client';
import { prisma } from "../lib/prisma";
import { logger } from '../utils/logger';


const TOKEN = (process.env.APIFY_TOKEN || '').trim();
const VESTIAIRE_ACTOR = (process.env.APIFY_VESTIAIRE_ACTOR || '').trim();
const CHRONO24_ACTOR = (process.env.APIFY_CHRONO24_ACTOR || '').trim();
const MONTHLY_LIMIT = parseInt(process.env.APIFY_MONTHLY_LIMIT || '30', 10);

export interface ApifyValuation {
  value: number | null;
  currency: string;
  source: string;
  itemName?: string;
  image?: string;
  sample: number;
}

export function isVestiaireConfigured(): boolean { return !!(TOKEN && VESTIAIRE_ACTOR); }
export function isChrono24Configured(): boolean { return !!(TOKEN && CHRONO24_ACTOR); }

// ---- Contatore mensile UNICO (tabella Setting) — condiviso tra tutte le fonti Apify ----
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
export async function apifyRemaining(): Promise<number> {
  return Math.max(0, MONTHLY_LIMIT - (await getMonthlyCount()));
}

// ---- Parsing prezzi (gli actor variano nei nomi campo/formati) ----
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

// ---- Esecutore generico di un actor Apify (un tot di risultati da uno startUrl) ----
async function runScraper(actor: string, startUrl: string, source: string): Promise<ApifyValuation | null> {
  if (!TOKEN || !actor) return null;
  // Tetto mensile condiviso: oltre il limite NON chiamiamo Apify (niente costi).
  if ((await getMonthlyCount()) >= MONTHLY_LIMIT) {
    logger.info('Apify: tetto mensile raggiunto, salto', { limit: MONTHLY_LIMIT, source });
    return null;
  }
  try {
    await bumpMonthlyCount(); // conta PRIMA (prudente)
    const url = `https://api.apify.com/v2/acts/${encodeURIComponent(actor)}/run-sync-get-dataset-items?token=${TOKEN}&maxItems=10&timeout=90`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Copre le convenzioni di entrambi gli actor: Vestiaire usa startUrl +
      // proxyConfiguration; Chrono24 usa startUrls[] + useApifyProxy. Campi extra ignorati.
      body: JSON.stringify({
        startUrl, startUrls: [{ url: startUrl }], maxItems: 10, includeDetails: false,
        useApifyProxy: true,
        proxyConfiguration: { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] },
      }),
    });
    if (!r.ok) { logger.error('Apify run error', { status: r.status, source }); return null; }
    const items = await r.json() as any[];
    if (!Array.isArray(items) || items.length === 0) return { value: null, currency: 'EUR', source, sample: 0 };
    const prices = items.map(pickPrice).filter((n): n is number => n != null);
    const first = items[0] || {};
    return {
      value: median(prices),
      currency: 'EUR',
      source,
      itemName: first.title || first.name || first.brand,
      image: first.imageUrl || first.image_url || first.image || first.photo || (Array.isArray(first.images) ? first.images[0] : undefined),
      sample: prices.length,
    };
  } catch (err: any) {
    logger.error('Errore runScraper Apify', { err: err.message, source });
    return null;
  }
}

// ---- BORSE (Vestiaire Collective, dominio it. → EUR) ----
export async function getBagValue(opts: { query: string }): Promise<ApifyValuation | null> {
  if (!isVestiaireConfigured() || !opts.query || opts.query.trim().length < 2) return null;
  const startUrl = `https://it.vestiairecollective.com/search/?q=${encodeURIComponent(opts.query)}`;
  return runScraper(VESTIAIRE_ACTOR, startUrl, 'Vestiaire (Apify)');
}

// ---- OROLOGI (Chrono24, dominio it. → EUR) ----
export async function getWatchValue(opts: { query: string }): Promise<ApifyValuation | null> {
  if (!isChrono24Configured() || !opts.query || opts.query.trim().length < 2) return null;
  const startUrl = `https://www.chrono24.it/search/index.htm?query=${encodeURIComponent(opts.query)}`;
  return runScraper(CHRONO24_ACTOR, startUrl, 'Chrono24 (Apify)');
}
