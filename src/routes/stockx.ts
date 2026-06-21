// src/routes/stockx.ts — OAuth StockX (scheletro, spento finché non ci sono le chiavi)
import { Router, Response } from 'express';
import { randomBytes } from 'crypto';
import { authenticate, AuthRequest } from '../middleware/auth';
import { logger } from '../utils/logger';
import {
  isStockXConfigured, isStockXConnected, getRedirectUri, getAuthorizeUrl, exchangeCodeForTokens,
  getStockXAccessToken,
} from '../services/stockx.service';
import { isAdminEmail } from '../config/admins';

const router = Router();

// DEBUG (solo admin): mostra la risposta GREZZA della ricerca catalogo StockX.
// Serve a capire perché "nessun risultato": struttura risposta? 0 risultati? errore?
// Uso: apri /stockx/debug?q=Nike%20Dunk%20Low%20Panda da loggato admin.
router.get('/debug', authenticate, async (req: AuthRequest, res: Response) => {
  if (!isAdminEmail(req.user?.email)) return res.status(403).json({ error: 'Solo admin' });
  if (!isStockXConfigured()) return res.json({ step: 'config', configured: false });
  const token = await getStockXAccessToken().catch(() => null);
  if (!token) return res.json({ step: 'token', configured: true, tokenOk: false });
  const q = (req.query.q as string) || 'Nike Dunk Low Panda';
  const headers = { Authorization: `Bearer ${token}`, 'x-api-key': process.env.STOCKX_API_KEY || '', Accept: 'application/json' };
  try {
    // 1) Ricerca
    const sr = await fetch(`https://api.stockx.com/v2/catalog/search?query=${encodeURIComponent(q)}&pageNumber=1&pageSize=5`, { headers });
    const sText = await sr.text();
    let sJson: any = null; try { sJson = JSON.parse(sText); } catch {}
    const product = sJson?.products?.[0] || null;
    const productId = product?.productId || product?.id || product?.urlKey || null;

    // 2) Market data a livello di prodotto (qui di solito sta il problema: nomi campo prezzo)
    let mdStatus: number | null = null;
    let mdPreview: string | null = null;
    let mdKeys: string[] | null = null;
    if (productId) {
      const md = await fetch(`https://api.stockx.com/v2/catalog/products/${encodeURIComponent(productId)}/market-data?currencyCode=EUR`, { headers });
      mdStatus = md.status;
      const mdText = await md.text();
      try { const mj = JSON.parse(mdText); mdKeys = mj && typeof mj === 'object' ? Object.keys(Array.isArray(mj) ? (mj[0] || {}) : mj) : null; } catch {}
      mdPreview = mdText.slice(0, 1500);
    }

    res.json({
      query: q,
      search: { httpStatus: sr.status, count: sJson?.count ?? null, firstTitle: product?.title ?? null, productId },
      marketData: { httpStatus: mdStatus, topLevelKeys: mdKeys, rawPreview: mdPreview },
    });
  } catch (e: any) {
    res.json({ error: e.message });
  }
});

// Stato per il frontend: configurato? token salvato? token ANCORA VALIDO?
// tokenOk verifica davvero il token (il refresh può scadere): così "Collegato" è veritiero
// e se la sessione è scaduta il frontend mostra "Riconnetti".
router.get('/status', authenticate, async (_req: AuthRequest, res: Response) => {
  const configured = isStockXConfigured();
  let connected = false;
  let tokenOk = false;
  if (configured && await isStockXConnected()) {
    connected = true;
    const t = await getStockXAccessToken().catch(() => null);
    tokenOk = !!t;
  }
  res.json({ configured, connected, tokenOk });
});

// Avvio OAuth: restituisce l'URL di autorizzazione (il frontend ci reindirizza).
// Restituire JSON (non redirect) evita problemi di auth sulla navigazione del browser.
router.get('/connect', authenticate, (req: AuthRequest, res: Response) => {
  if (!isStockXConfigured()) return res.status(400).json({ error: 'StockX non configurato' });
  const state = randomBytes(16).toString('hex');
  const redirectUri = getRedirectUri(req);
  res.json({ url: getAuthorizeUrl(redirectUri, state) });
});

// Callback OAuth: StockX reindirizza qui col code. Niente auth (è StockX a chiamare).
router.get('/callback', async (req, res) => {
  const code = req.query.code as string | undefined;
  if (!code) return res.redirect('/?stockx=error');
  try {
    const redirectUri = getRedirectUri(req);
    const tokens = await exchangeCodeForTokens(code, redirectUri);
    return res.redirect(tokens?.refresh_token ? '/?stockx=connected' : '/?stockx=error');
  } catch (err: any) {
    logger.error('StockX callback', { err: err.message });
    return res.redirect('/?stockx=error');
  }
});

export default router;
