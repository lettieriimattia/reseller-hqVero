// src/services/bricklink.service.ts
// Valutazione LEGO tramite l'API UFFICIALE di BrickLink (niente scraping, niente CAPTCHA).
// BrickLink usa OAuth 1.0a (firma HMAC-SHA1). Servono 4 credenziali, gratuite, dal tuo account:
//   https://www.bricklink.com/v2/api/register_consumer.page  → registra IP "0.0.0.0" (= qualsiasi IP, così Render funziona)
// Env su Render:
//   BRICKLINK_CONSUMER_KEY, BRICKLINK_CONSUMER_SECRET, BRICKLINK_TOKEN, BRICKLINK_TOKEN_SECRET
//
// Endpoint usato: Price Guide del SET, tipo "sold" (venduto ultimi 6 mesi), in EUR.
//   GET /items/SET/{no}/price?guide_type=sold&new_or_used=N&currency_code=EUR

import crypto from 'crypto';
import { logger } from '../utils/logger';

const CK = (process.env.BRICKLINK_CONSUMER_KEY || '').trim();
const CS = (process.env.BRICKLINK_CONSUMER_SECRET || '').trim();
const TK = (process.env.BRICKLINK_TOKEN || '').trim();
const TS = (process.env.BRICKLINK_TOKEN_SECRET || '').trim();
const BASE = 'https://api.bricklink.com/api/store/v1';

export function isBrickLinkConfigured(): boolean { return !!(CK && CS && TK && TS); }

// RFC 3986 percent-encoding (OAuth vuole anche ! * ' ( ) codificati)
function enc(s: string): string {
  return encodeURIComponent(s).replace(/[!*'()]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

// Firma OAuth 1.0a e restituisce l'header Authorization per una GET con query params.
function authHeader(method: string, url: string, query: Record<string, string>): string {
  const oauth: Record<string, string> = {
    oauth_consumer_key: CK,
    oauth_token: TK,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_version: '1.0',
  };
  // Base string: tutti i parametri (query + oauth) ordinati per chiave, codificati.
  const all: Record<string, string> = { ...query, ...oauth };
  const paramStr = Object.keys(all).sort().map(k => `${enc(k)}=${enc(all[k])}`).join('&');
  const baseStr = [method.toUpperCase(), enc(url), enc(paramStr)].join('&');
  const signingKey = `${enc(CS)}&${enc(TS)}`;
  const signature = crypto.createHmac('sha1', signingKey).update(baseStr).digest('base64');
  oauth.oauth_signature = signature;
  const header = 'OAuth ' + Object.keys(oauth).sort().map(k => `${enc(k)}="${enc(oauth[k])}"`).join(', ');
  return header;
}

interface BLPrice { avg: number | null; qtyAvg: number | null; min: number | null; max: number | null; unitQty: number; totalQty: number; }

async function priceGuide(setNo: string, newOrUsed: 'N' | 'U'): Promise<BLPrice | null> {
  const path = `/items/SET/${encodeURIComponent(setNo)}/price`;
  const url = `${BASE}${path}`;
  const query = { guide_type: 'sold', new_or_used: newOrUsed, currency_code: 'EUR' };
  const qs = Object.keys(query).map(k => `${k}=${encodeURIComponent((query as any)[k])}`).join('&');
  try {
    const r = await fetch(`${url}?${qs}`, { headers: { Authorization: authHeader('GET', url, query) } });
    if (!r.ok) { logger.error('BrickLink API error', { status: r.status, setNo }); return null; }
    const j: any = await r.json();
    if (j?.meta?.code && j.meta.code !== 200) { logger.error('BrickLink meta', { meta: j.meta, setNo }); return null; }
    const d = j?.data;
    if (!d) return null;
    const n = (x: any) => { const v = parseFloat(x); return isFinite(v) && v > 0 ? v : null; };
    return {
      avg: n(d.avg_price), qtyAvg: n(d.qty_avg_price), min: n(d.min_price), max: n(d.max_price),
      unitQty: parseInt(d.unit_quantity, 10) || 0, totalQty: parseInt(d.total_quantity, 10) || 0,
    };
  } catch (err: any) { logger.error('Errore BrickLink priceGuide', { err: err?.message, setNo }); return null; }
}

// Normalizza "10300" / "lego 10300 modular" / "75192-1" → "10300-1" (BrickLink vuole la variante).
function normalizeSetNo(q: string): string | null {
  const m = String(q || '').match(/\b(\d{3,7})(-\d+)?\b/);
  if (!m) return null;
  return m[2] ? `${m[1]}${m[2]}` : `${m[1]}-1`;
}

export interface BrickLinkValuation {
  value: number | null; currency: string; source: string; sample: number; itemName?: string; low?: number | null;
}

// Valuta un SET: prezzo VENDUTO ultimi 6 mesi, nuovo (default) o usato. Preferisce la media pesata
// sulle quantità (qty_avg_price), più robusta rispetto agli outlier.
export async function getBrickLinkValue(opts: { query: string; condition?: string }): Promise<BrickLinkValuation | null> {
  if (!isBrickLinkConfigured()) return null;
  const setNo = normalizeSetNo(opts.query);
  if (!setNo) return null;
  const wantUsed = /usa|used/i.test(opts.condition || '');
  const p = await priceGuide(setNo, wantUsed ? 'U' : 'N');
  // Se il nuovo non ha venduti (set recente mai rivenduto sigillato) provo l'usato, e viceversa.
  const fallback = !p || (p.qtyAvg == null && p.avg == null) ? await priceGuide(setNo, wantUsed ? 'N' : 'U') : null;
  const chosen = (p && (p.qtyAvg != null || p.avg != null)) ? p : fallback;
  const usedFinal = (chosen === fallback) ? !wantUsed : wantUsed;
  if (!chosen) return { value: null, currency: 'EUR', source: 'BrickLink (nessun venduto)', sample: 0 };
  const value = chosen.qtyAvg ?? chosen.avg;
  return {
    value: value != null ? Math.round(value) : null,
    currency: 'EUR',
    source: `BrickLink Price Guide · venduto ${usedFinal ? 'usato' : 'nuovo'} (6 mesi)`,
    sample: chosen.unitQty,
    itemName: `Set ${setNo}`,
    low: chosen.min ?? undefined,
  };
}

// DEBUG (per capire cosa risponde l'API): nuovo + usato grezzi.
export async function getBrickLinkRaw(query: string): Promise<any> {
  const configured = isBrickLinkConfigured();
  if (!configured) return { configured, error: 'Credenziali BrickLink mancanti (BRICKLINK_CONSUMER_KEY/SECRET, BRICKLINK_TOKEN/SECRET)' };
  const setNo = normalizeSetNo(query);
  if (!setNo) return { configured, error: 'numero set non riconosciuto' };
  const [n, u] = await Promise.all([priceGuide(setNo, 'N'), priceGuide(setNo, 'U')]);
  return { configured, setNo, new: n, used: u };
}
