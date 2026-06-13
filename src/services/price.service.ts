// src/services/price.service.ts
// Valutazione di mercato da comps REALI (eBay), con difese anti-falsi.
// Spento finché EBAY_APP_ID / EBAY_CERT_ID non sono configurati (come Sendcloud).
//
// Difese contro i falsi:
//  1) Solo annunci con Authenticity Guarantee (autenticati da eBay).
//  2) Esclusione per parole chiave da replica.
//  3) Mediana con taglio IQR degli outlier (i falsi stanno molto sotto).
//  4) Indice di confidenza in base alla numerosità del campione pulito.

import { logger } from '../utils/logger';

const EBAY_OAUTH = 'https://api.ebay.com/identity/v1/oauth2/token';
const EBAY_BROWSE = 'https://api.ebay.com/buy/browse/v1/item_summary/search';
const MARKETPLACE = process.env.EBAY_MARKETPLACE || 'EBAY_IT';

// Termini che segnalano repliche / non autentici (linguaggio comune dei venditori di falsi)
const REPLICA_TERMS = [
  'replica', 'rep ', ' reps', 'fake', 'aaa', '1:1', 'unauthorized', 'unauthorised',
  'inspired', ' style ', ' type ', 'dhgate', 'batch', 'ljr', 'pk god', 'og tier',
  'b-grade', 'b grade', 'seconds', 'factory', 'unbranded', 'no logo',
];

export function isLikelyReplica(title: string): boolean {
  const t = ' ' + (title || '').toLowerCase() + ' ';
  return REPLICA_TERMS.some(k => t.includes(k));
}

export type Confidence = 'alta' | 'media' | 'bassa';

// Mediana robusta con taglio IQR (scarta gli outlier, tipicamente i falsi sottoprezzo)
export function robustMedian(prices: number[]): { value: number | null; sample: number; confidence: Confidence } {
  const sorted = prices.filter(p => Number.isFinite(p) && p > 0).sort((a, b) => a - b);
  if (sorted.length === 0) return { value: null, sample: 0, confidence: 'bassa' };
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)))];
  const q1 = at(0.25), q3 = at(0.75);
  const iqr = q3 - q1;
  const lo = q1 - 1.5 * iqr, hi = q3 + 1.5 * iqr;
  const trimmed = sorted.filter(p => p >= lo && p <= hi);
  const arr = trimmed.length ? trimmed : sorted;
  const median = arr[Math.floor(arr.length / 2)];
  const confidence: Confidence = arr.length >= 8 ? 'alta' : arr.length >= 3 ? 'media' : 'bassa';
  return { value: Math.round(median), sample: arr.length, confidence };
}

// Legge le chiavi accettando entrambe le convenzioni di nome usate per eBay:
//   App ID  → EBAY_APP_ID  oppure EBAY_CLIENT_ID
//   Cert ID → EBAY_CERT_ID oppure EBAY_CLIENT_SECRET
function getEbayAppId(): string {
  return (process.env.EBAY_APP_ID || process.env.EBAY_CLIENT_ID || '').trim();
}
function getEbayCertId(): string {
  return (process.env.EBAY_CERT_ID || process.env.EBAY_CLIENT_SECRET || '').trim();
}

export function isPriceConfigured(): boolean {
  return !!(getEbayAppId() && getEbayCertId());
}

// Diagnostica all'avvio (visibile nei log Railway): conferma se le chiavi sono lette.
{
  const id = getEbayAppId();
  const cert = getEbayCertId();
  if (id && cert) {
    logger.info(`eBay valutazioni attivo — App ID (${id.length} char) e Cert ID (${cert.length} char) letti, marketplace ${MARKETPLACE}`);
  } else {
    logger.info(`eBay NON configurato — App ID ${id ? 'OK' : 'MANCANTE'}, Cert ID ${cert ? 'OK' : 'MANCANTE'} (attesi EBAY_APP_ID/EBAY_CLIENT_ID e EBAY_CERT_ID/EBAY_CLIENT_SECRET)`);
  }
}

// Token OAuth (client credentials) con cache in memoria
let tokenCache: { token: string; expiresAt: number } | null = null;
async function getEbayToken(): Promise<string | null> {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.token;
  const id = getEbayAppId();
  const cert = getEbayCertId();
  const basic = Buffer.from(`${id}:${cert}`).toString('base64');
  try {
    const r = await fetch(EBAY_OAUTH, {
      method: 'POST',
      headers: { 'Authorization': `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials&scope=https://api.ebay.com/oauth/api_scope',
    });
    if (!r.ok) { logger.error('eBay OAuth fallito', { status: r.status }); return null; }
    const data = await r.json() as any;
    tokenCache = { token: data.access_token, expiresAt: Date.now() + (data.expires_in || 7200) * 1000 };
    return tokenCache.token;
  } catch (err: any) {
    logger.error('Errore token eBay', { err: err.message });
    return null;
  }
}

export interface Valuation {
  configured: boolean;
  value: number | null;       // mediana € sui comps autenticati
  sample: number;             // n. comps puliti usati
  confidence: Confidence;
  source: string;             // es. "eBay (autenticati)"
  authenticatedOnly: boolean;
}

// Una singola ricerca eBay Browse → array di prezzi puliti (repliche escluse).
async function ebayPriceSearch(token: string, query: string, size: string | undefined, authenticatedOnly: boolean): Promise<number[] | null> {
  const params = new URLSearchParams({
    q: [query, size].filter(Boolean).join(' '),
    limit: '50',
  });
  // Solo annunci autenticati da eBay (Authenticity Guarantee) → falsi esclusi alla fonte
  if (authenticatedOnly) params.set('filter', 'qualifiedPrograms:{EBAY_AUTHENTICITY_GUARANTEE}');
  try {
    const r = await fetch(`${EBAY_BROWSE}?${params}`, {
      headers: { 'Authorization': `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': MARKETPLACE },
    });
    if (!r.ok) { logger.error('eBay Browse error', { status: r.status, authenticatedOnly }); return null; }
    const data = await r.json() as any;
    const items: any[] = data?.itemSummaries || [];
    return items
      .filter(it => !isLikelyReplica(it.title || ''))   // esclusione repliche per parole chiave
      .map(it => parseFloat(it?.price?.value))
      .filter(p => Number.isFinite(p) && p > 0);
  } catch (err: any) {
    logger.error('Errore ebayPriceSearch', { err: err.message });
    return null;
  }
}

// Valutazione: prima i comps autenticati (anti-falso massimo). Se troppo pochi
// (su eBay IT l'Authenticity Guarantee copre solo sneaker/borse/orologi), ripiega
// sul mercato generale ma comunque anti-falsi (keyword + taglio outlier IQR).
export async function getMarketValuation(opts: { query: string; size?: string; authenticatedOnly?: boolean }): Promise<Valuation> {
  const preferAuthenticated = opts.authenticatedOnly !== false; // default: prova prima gli autenticati
  if (!isPriceConfigured()) {
    return { configured: false, value: null, sample: 0, confidence: 'bassa', source: 'non configurato', authenticatedOnly: preferAuthenticated };
  }
  const token = await getEbayToken();
  if (!token) return { configured: true, value: null, sample: 0, confidence: 'bassa', source: 'eBay (errore auth)', authenticatedOnly: preferAuthenticated };

  // 1) Comps autenticati
  let prices: number[] = [];
  let usedAuthenticated = false;
  if (preferAuthenticated) {
    const authed = await ebayPriceSearch(token, opts.query, opts.size, true);
    if (authed && authed.length > 0) { prices = authed; usedAuthenticated = true; }
  }

  // 2) Fallback al mercato generale se i comps autenticati sono pochi
  if (prices.length < 3) {
    const general = await ebayPriceSearch(token, opts.query, opts.size, false);
    if (general && general.length > prices.length) { prices = general; usedAuthenticated = false; }
  }

  if (prices.length === 0) {
    return { configured: true, value: null, sample: 0, confidence: 'bassa', source: 'eBay (nessun dato)', authenticatedOnly: usedAuthenticated };
  }

  const { value, sample, confidence } = robustMedian(prices); // mediana robusta anti-outlier (scarta i falsi sottoprezzo)
  return { configured: true, value, sample, confidence, source: usedAuthenticated ? 'eBay (autenticati)' : 'eBay (mercato)', authenticatedOnly: usedAuthenticated };
}
