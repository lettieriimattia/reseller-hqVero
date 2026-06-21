// src/services/stockx.service.ts
// Integrazione StockX (fonte prezzi primaria per le sneaker).
// OAuth Authorization Code (Auth0). SPENTO finché non sono configurate le chiavi:
//   STOCKX_CLIENT_ID, STOCKX_CLIENT_SECRET, STOCKX_API_KEY  (su Railway)
//   STOCKX_REDIRECT_URI opzionale (altrimenti dedotto dal dominio della richiesta).
import { PrismaClient } from '@prisma/client';
import { prisma } from "../lib/prisma";
import { logger } from '../utils/logger';


const STOCKX_AUTHORIZE = 'https://accounts.stockx.com/authorize';
const STOCKX_TOKEN = 'https://accounts.stockx.com/oauth/token';
const STOCKX_AUDIENCE = 'gateway.stockx.com';

export function isStockXConfigured(): boolean {
  return !!(process.env.STOCKX_CLIENT_ID && process.env.STOCKX_CLIENT_SECRET && process.env.STOCKX_API_KEY);
}

// Redirect URI: da env se fissato, altrimenti dedotto dal dominio della richiesta.
export function getRedirectUri(req?: any): string {
  if (process.env.STOCKX_REDIRECT_URI) return process.env.STOCKX_REDIRECT_URI;
  if (req) {
    const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').toString().split(',')[0];
    const host = (req.headers['x-forwarded-host'] || req.headers.host || '').toString();
    if (host) return `${proto}://${host}/api/stockx/callback`;
  }
  return '';
}

export function getAuthorizeUrl(redirectUri: string, state: string): string {
  // Costruito a mano (non URLSearchParams) così lo spazio nello scope diventa %20
  // e non '+': StockX/PerimeterX a volte rifiuta il '+' e ti rimanda alla home.
  const q = [
    `response_type=code`,
    `client_id=${encodeURIComponent(process.env.STOCKX_CLIENT_ID || '')}`,
    `redirect_uri=${encodeURIComponent(redirectUri)}`,
    `scope=${encodeURIComponent('offline_access openid')}`,
    `audience=${encodeURIComponent(STOCKX_AUDIENCE)}`,
    `state=${encodeURIComponent(state)}`,
  ].join('&');
  return `${STOCKX_AUTHORIZE}?${q}`;
}

// Scambia il code per i token e salva il refresh_token (Setting key/value).
export async function exchangeCodeForTokens(code: string, redirectUri: string): Promise<any | null> {
  try {
    const res = await fetch(STOCKX_TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: process.env.STOCKX_CLIENT_ID || '',
        client_secret: process.env.STOCKX_CLIENT_SECRET || '',
        code,
        redirect_uri: redirectUri,
      }),
    });
    if (!res.ok) { logger.error('StockX token exchange fallito', { status: res.status }); return null; }
    const data = await res.json() as any;
    if (data.refresh_token) {
      await prisma.setting.upsert({
        where: { key: 'stockxRefreshToken' },
        create: { key: 'stockxRefreshToken', value: data.refresh_token },
        update: { value: data.refresh_token },
      });
    }
    return data;
  } catch (err: any) {
    logger.error('Errore exchangeCodeForTokens StockX', { err: err.message });
    return null;
  }
}

export async function isStockXConnected(): Promise<boolean> {
  const s = await prisma.setting.findUnique({ where: { key: 'stockxRefreshToken' } }).catch(() => null);
  return !!s?.value;
}

// Access token (refresh) con cache in memoria.
let accessCache: { token: string; expiresAt: number } | null = null;
export async function getStockXAccessToken(): Promise<string | null> {
  if (!isStockXConfigured()) return null;
  if (accessCache && accessCache.expiresAt > Date.now() + 60_000) return accessCache.token;
  const stored = await prisma.setting.findUnique({ where: { key: 'stockxRefreshToken' } }).catch(() => null);
  if (!stored?.value) return null;
  try {
    const res = await fetch(STOCKX_TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: process.env.STOCKX_CLIENT_ID || '',
        client_secret: process.env.STOCKX_CLIENT_SECRET || '',
        refresh_token: stored.value,
        audience: STOCKX_AUDIENCE,
      }),
    });
    if (!res.ok) { logger.error('StockX refresh fallito', { status: res.status }); return null; }
    const data = await res.json() as any;
    accessCache = { token: data.access_token, expiresAt: Date.now() + (data.expires_in || 3600) * 1000 };
    return data.access_token;
  } catch (err: any) {
    logger.error('Errore getStockXAccessToken', { err: err.message });
    return null;
  }
}

const STOCKX_API_BASE = 'https://api.stockx.com';

// Normalizza una taglia per il confronto con le variant StockX (es. "EU 42" / "42" / "9.5").
function normSize(s?: string): string {
  return (s || '').toString().toLowerCase().replace(/eu|us|uk|taglia|size/g, '').replace(/[^0-9.,]/g, '').replace(',', '.').trim();
}

// Prezzo da una singola variante. NB: highestBidAmount è l'offerta più alta (spesso una
// "civetta" bassissima) → NON è il prezzo di mercato, lo escludiamo. Usiamo il lowest ask.
function variantPrice(v: any): number | null {
  const candidates = [
    v?.lowestAskAmount, v?.standardMarketData?.lowestAsk, v?.flexLowestAskAmount,
    v?.sellFasterAmount, v?.standardMarketData?.sellFaster, v?.earnMoreAmount,
  ];
  for (const c of candidates) {
    const n = Number(c);
    if (!isNaN(n) && n > 0) return Math.round(n);
  }
  return null;
}

// Il market-data StockX può essere un ARRAY di varianti (una per taglia) o un singolo oggetto.
// Prezzo di mercato = il lowest ask più basso tra le varianti disponibili ("a partire da").
function pickStockXPrice(md: any): number | null {
  const arr = Array.isArray(md) ? md : (Array.isArray(md?.variants) ? md.variants : [md]);
  const asks = arr
    .map((v: any) => Number(v?.lowestAskAmount ?? v?.standardMarketData?.lowestAsk))
    .filter((n: number) => !isNaN(n) && n > 0);
  if (asks.length) return Math.round(Math.min(...asks));
  // Nessun "ask" disponibile: ripiega su altri segnali di prezzo per-variante.
  for (const v of arr) { const p = variantPrice(v); if (p) return p; }
  return null;
}

// Valutazione StockX REALE: catalog search → (variant per taglia) → market data in EUR.
// Difensiva: in caso di errore/forma diversa ritorna value null senza rompere l'app.
export async function getStockXValuation(opts: { query: string; name?: string; size?: string; sku?: string }): Promise<{ configured: boolean; connected?: boolean; value: number | null; source: string; itemName?: string; brand?: string; model?: string; image?: string | null; styleId?: string | null; sample?: number }> {
  if (!isStockXConfigured()) return { configured: false, value: null, source: 'StockX (non configurato)' };
  const token = await getStockXAccessToken();
  if (!token) return { configured: true, connected: false, value: null, source: 'StockX (non connesso)' };

  const headers = {
    Authorization: `Bearer ${token}`,
    'x-api-key': process.env.STOCKX_API_KEY || '',
    Accept: 'application/json',
  };

  // Pulisce la query: trattini "lunghi", separatori e doppi spazi confondono la ricerca StockX.
  const clean = (s: string) => (s || '').replace(/[–—]/g, ' ').replace(/[•|]/g, ' ').replace(/\s+/g, ' ').trim();
  // Candidati in ordine di precisione:
  //  1) SKU/style code (match esatto)
  //  2) solo NOME (senza brand): es. "Air Jordan 4 Off-White Sail" — su StockX le Jordan
  //     stanno sotto "Jordan", quindi anteporre "NIKE" spesso azzera i risultati.
  //  3) query completa pulita (brand + nome)  4) query grezza
  const candidates = Array.from(new Set([
    opts.sku ? opts.sku.trim() : '',
    opts.name ? clean(opts.name) : '',
    clean(opts.query),
    opts.query,
  ].filter(Boolean)));

  // --- Matching robusto: scegli il risultato che combacia col nome riconosciuto,
  //     non il primo a caso (StockX mette in cima i modelli più popolari/hype). ---
  const toks = (s: string) => clean(s).toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 1);
  const nameStr = (opts.name || opts.query || '').toLowerCase();
  const qSet = new Set(toks(opts.name || opts.query));
  // Collab/edizioni speciali: se sono nel titolo StockX ma NON nel nome riconosciuto,
  // è quasi certo un modello diverso (e molto più caro) → forte penalità.
  const COLLAB = ['travis scott', 'off-white', 'off white', 'dior', 'fragment', 'union', 'tiffany', 'louis vuitton', 'ben & jerry', 'a ma maniere', 'sacai', 'supreme', 'kaws'];
  const scoreOf = (title: string) => {
    const t = (title || '').toLowerCase();
    const tSet = new Set(toks(title));
    let matched = 0; qSet.forEach(x => { if (tSet.has(x)) matched++; });
    let penalty = 0; for (const c of COLLAB) { if (t.includes(c) && !nameStr.includes(c)) penalty++; }
    return { matched, penalty, final: matched - 2 * penalty };
  };

  try {
    let product: any = null;
    let best = { final: -Infinity, matched: 0 };
    let searchFailed = false;
    for (const q of candidates) {
      const sr = await fetch(`${STOCKX_API_BASE}/v2/catalog/search?query=${encodeURIComponent(q)}&pageNumber=1&pageSize=10`, { headers });
      if (!sr.ok) { logger.warn('StockX search non ok', { status: sr.status, q }); searchFailed = true; continue; }
      const sd = await sr.json() as any;
      const products: any[] = sd?.products || sd?.data || sd?.hits || [];
      if (!Array.isArray(products) || products.length === 0) continue;
      // Match esatto per style code (SKU): vince su tutto.
      if (opts.sku) {
        const exact = products.find((p: any) => (p.styleId || p.productAttributes?.styleId || '').toString().toLowerCase() === opts.sku!.toLowerCase());
        if (exact) { product = exact; best = { final: 99, matched: qSet.size }; break; }
      }
      // Altrimenti scegli il titolo che combacia meglio col nome riconosciuto.
      for (const p of products) {
        const sc = scoreOf(p.title || p.name || '');
        if (sc.final > best.final) { best = { final: sc.final, matched: sc.matched }; product = p; }
      }
    }
    // Soglia di affidabilità: serve un minimo di parole in comune e niente collab "intrusa".
    const minMatch = Math.max(2, Math.ceil(qSet.size * 0.5));
    if (product && (best.matched < minMatch || best.final < 2)) {
      return { configured: true, connected: true, value: null, source: 'StockX (nessun match affidabile)' };
    }
    if (!product) {
      return { configured: true, connected: true, value: null, source: searchFailed ? 'StockX (ricerca fallita)' : 'StockX (nessun risultato)' };
    }
    const productId = product.productId || product.id || product.urlKey;
    const itemName = product.title || product.name || [product.brand, product.model].filter(Boolean).join(' ');
    const brand = product.brand || undefined;
    const model = product.model || product.styleId || product.title || undefined;
    // Immagine prodotto (per la conferma visiva del riconoscimento IA). Campi variabili → difensivo.
    const image = product.media?.imageUrl || product.media?.thumbUrl || product.media?.smallImageUrl
      || product.image || product.thumbUrl || product.productAttributes?.image || null;
    const styleId = product.styleId || product.productAttributes?.styleId || null;

    let value: number | null = null;

    // 2) Prova il market data della variant corrispondente alla taglia
    if (opts.size && productId) {
      try {
        const vr = await fetch(`${STOCKX_API_BASE}/v2/catalog/products/${encodeURIComponent(productId)}/variants?currencyCode=EUR`, { headers });
        if (vr.ok) {
          const vd = await vr.json() as any;
          const variants = Array.isArray(vd) ? vd : (vd?.variants || vd?.data || []);
          const target = normSize(opts.size);
          const match = variants.find((v: any) => normSize(v.variantValue || v.size || v.sizeChart?.displayOptions?.[0]?.size) === target);
          if (match?.variantId) {
            const md = await fetch(`${STOCKX_API_BASE}/v2/catalog/products/${encodeURIComponent(productId)}/variants/${encodeURIComponent(match.variantId)}/market-data?currencyCode=EUR`, { headers });
            if (md.ok) value = pickStockXPrice(await md.json());
          }
        }
      } catch { /* fallback al market data di prodotto */ }
    }

    // 3) Fallback: market data a livello di prodotto
    let mdError: string | null = null;
    if (value == null && productId) {
      const md = await fetch(`${STOCKX_API_BASE}/v2/catalog/products/${encodeURIComponent(productId)}/market-data?currencyCode=EUR`, { headers });
      if (md.ok) {
        value = pickStockXPrice(await md.json());
      } else {
        // StockX richiede billing+shipping completi sull'account per dare i prezzi (market-data).
        const t = await md.text().catch(() => '');
        if (/billing|shipping/i.test(t)) mdError = 'StockX (manca billing/shipping sull\'account StockX)';
        else mdError = `StockX (market-data ${md.status})`;
        logger.warn('StockX market-data non ok', { status: md.status, productId });
      }
    }

    return { configured: true, connected: true, value, source: value != null ? 'StockX' : (mdError || 'StockX (nessun prezzo)'), itemName, brand, model, image, styleId, sample: 1 };
  } catch (err: any) {
    logger.error('Errore getStockXValuation', { err: err.message });
    return { configured: true, connected: true, value: null, source: 'StockX (errore)' };
  }
}
