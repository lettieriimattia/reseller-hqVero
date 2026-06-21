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
  try {
    const r = await fetch(`https://api.stockx.com/v2/catalog/search?query=${encodeURIComponent(q)}&pageNumber=1&pageSize=5`, {
      headers: { Authorization: `Bearer ${token}`, 'x-api-key': process.env.STOCKX_API_KEY || '', Accept: 'application/json' },
    });
    const text = await r.text();
    let json: any = null; try { json = JSON.parse(text); } catch {}
    res.json({
      step: 'search', query: q, httpStatus: r.status,
      topLevelKeys: json && typeof json === 'object' ? Object.keys(json) : null,
      // primi 1500 char della risposta grezza (per vedere la struttura reale)
      rawPreview: text.slice(0, 1500),
    });
  } catch (e: any) {
    res.json({ step: 'search', error: e.message });
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
