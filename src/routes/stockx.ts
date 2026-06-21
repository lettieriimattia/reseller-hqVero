// src/routes/stockx.ts — OAuth StockX (scheletro, spento finché non ci sono le chiavi)
import { Router, Response } from 'express';
import { randomBytes } from 'crypto';
import { authenticate, AuthRequest } from '../middleware/auth';
import { logger } from '../utils/logger';
import {
  isStockXConfigured, isStockXConnected, getRedirectUri, getAuthorizeUrl, exchangeCodeForTokens,
  getStockXAccessToken,
} from '../services/stockx.service';

const router = Router();

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
