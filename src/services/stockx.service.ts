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
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.STOCKX_CLIENT_ID || '',
    redirect_uri: redirectUri,
    scope: 'offline_access openid',
    audience: STOCKX_AUDIENCE,
    state,
  });
  return `${STOCKX_AUTHORIZE}?${params.toString()}`;
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

// Valutazione StockX — scheletro. Da completare (catalog search + market data)
// quando l'accesso API è approvato e attivo.
export async function getStockXValuation(opts: { query: string; size?: string }): Promise<{ configured: boolean; connected?: boolean; value: number | null; source: string }> {
  if (!isStockXConfigured()) return { configured: false, value: null, source: 'StockX (non configurato)' };
  const token = await getStockXAccessToken();
  if (!token) return { configured: true, connected: false, value: null, source: 'StockX (non connesso)' };
  // TODO: chiamare /v2/catalog/search e i market data quando l'API è attiva.
  void opts;
  return { configured: true, connected: true, value: null, source: 'StockX' };
}
