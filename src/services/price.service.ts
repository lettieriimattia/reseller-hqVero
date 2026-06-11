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

export function isPriceConfigured(): boolean {
  return !!(process.env.EBAY_APP_ID && process.env.EBAY_CERT_ID);
}

// Token OAuth (client credentials) con cache in memoria
let tokenCache: { token: string; expiresAt: number } | null = null;
async function getEbayToken(): Promise<string | null> {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.token;
  const id = (process.env.EBAY_APP_ID || '').trim();
  const cert = (process.env.EBAY_CERT_ID || '').trim();
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

// Valutazione: cerca comps su eBay, tiene solo gli autenticati, esclude repliche, mediana robusta.
export async function getMarketValuation(opts: { query: string; size?: string; authenticatedOnly?: boolean }): Promise<Valuation> {
  const authenticatedOnly = opts.authenticatedOnly !== false; // default: solo autenticati
  if (!isPriceConfigured()) {
    return { configured: false, value: null, sample: 0, confidence: 'bassa', source: 'non configurato', authenticatedOnly };
  }
  const token = await getEbayToken();
  if (!token) return { configured: true, value: null, sample: 0, confidence: 'bassa', source: 'eBay (errore auth)', authenticatedOnly };

  const params = new URLSearchParams({
    q: [opts.query, opts.size].filter(Boolean).join(' '),
    limit: '50',
  });
  // Solo annunci autenticati da eBay → i falsi sono esclusi alla fonte
  if (authenticatedOnly) params.set('filter', 'qualifiedPrograms:{EBAY_AUTHENTICITY_GUARANTEE}');

  try {
    const r = await fetch(`${EBAY_BROWSE}?${params}`, {
      headers: { 'Authorization': `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': MARKETPLACE },
    });
    if (!r.ok) { logger.error('eBay Browse error', { status: r.status }); return { configured: true, value: null, sample: 0, confidence: 'bassa', source: 'eBay (errore)', authenticatedOnly }; }
    const data = await r.json() as any;
    const items: any[] = data?.itemSummaries || [];
    const prices = items
      .filter(it => !isLikelyReplica(it.title || ''))                 // 2) esclusione repliche
      .map(it => parseFloat(it?.price?.value))
      .filter(p => Number.isFinite(p) && p > 0);
    const { value, sample, confidence } = robustMedian(prices);       // 3) mediana robusta anti-outlier
    return { configured: true, value, sample, confidence, source: authenticatedOnly ? 'eBay (autenticati)' : 'eBay', authenticatedOnly };
  } catch (err: any) {
    logger.error('Errore getMarketValuation', { err: err.message });
    return { configured: true, value: null, sample: 0, confidence: 'bassa', source: 'eBay (errore)', authenticatedOnly };
  }
}
