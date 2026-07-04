// src/routes/ai.ts
// Endpoint IA: scan prodotto, generatore annunci.

import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { aiLimiter } from '../middleware/rateLimit';
import { validate, aiScanSchema, priceEstimateSchema } from '../middleware/validate';
import { scanProduct, scanProductAuto, estimateMarketPrice, generateListing, getVisionStatus, ListingPlatform, scanLotItems } from '../services/ai.service';
import { pokemonSearch } from '../services/pokemon.service';
import { kicksSearch, isKicksConfigured } from '../services/kicksdb.service';
import { searchStockXCandidates } from '../services/stockx.service';
import { getMarketValuation } from '../services/price.service';
import { getCardValue } from '../services/cards.service';
import { getValuation } from '../services/valuation.service';
import { getStockXValuation, isStockXConfigured } from '../services/stockx.service';
import { requireFeature } from '../middleware/plan';
import { PrismaClient } from '@prisma/client';
import { prisma } from "../lib/prisma";
import { audit } from '../services/audit.service';
import { logger } from '../utils/logger';
import jwt from 'jsonwebtoken';
import { isAdminEmail } from '../config/admins';
import { isVestiaireConfigured, isChrono24Configured, isLegoConfigured, getLegoRaw } from '../services/apify.service';

const router = Router();

// Diagnostica pubblica (nessun segreto): quale provider/modello vision è attivo + quali
// fonti Apify sono configurate (solo true/false, nessuna chiave). Apri: /api/ai/vision-status
router.get('/vision-status', (_req, res) => {
  res.json({
    ...getVisionStatus(),
    apify: { vestiaire: isVestiaireConfigured(), chrono24: isChrono24Configured(), lego: isLegoConfigured() },
  });
});

function isAdminReq(req: any): boolean {
  try {
    const token = req.cookies?.access_token;
    if (!token || !process.env.JWT_ACCESS_SECRET) return false;
    const p: any = jwt.verify(token, process.env.JWT_ACCESS_SECRET);
    return isAdminEmail(p?.email);
  } catch { return false; }
}

// DEBUG LEGO (solo admin, loggato): mostra la risposta grezza dell'actor per capire i campi prezzo.
// Apri da loggato: /api/ai/lego-debug?set=10300
router.get('/lego-debug', async (req: any, res) => {
  if (!isAdminReq(req)) return res.status(403).json({ error: 'solo admin' });
  const set = String(req.query.set || '10300').trim();
  const raw = await getLegoRaw(set);
  res.json(raw);
});

router.use(authenticate);
router.use(aiLimiter);

// ==========================================
// POST /api/ai/scan - scan unificato
// ==========================================
router.post('/scan', validate(aiScanSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { imageBase64, category, existingCategories } = req.body;
    // Senza categoria → modalità automatica: l'IA rileva l'oggetto dalla foto
    const result = category
      ? await scanProduct(imageBase64, category)
      : await scanProductAuto(imageBase64, existingCategories || []);

    await audit({
      action: 'AI_SCAN', userId: req.user!.userId, req,
      metadata: { category: category || result.detectedCategory || 'auto', auto: !category, confidence: result.confidence }
    });

    res.json(result);
  } catch (err: any) {
    logger.error('Errore /ai/scan', { err: err.message });
    res.status(500).json({ error: err.message || 'Errore scan IA' });
  }
});

// ==========================================
// POST /api/ai/scan-items — riconosce PIÙ prodotti (anche MISTI: scarpe + carte + vestiti) in
// UNA foto e per ognuno recupera la FOTO ufficiale dal catalogo giusto (Pokémon o StockX/KicksDB).
// Per i "lotti": ogni prodotto diventa una riga. (Compat: risponde anche su /scan-cards.)
// ==========================================
const scanItemsHandler = async (req: AuthRequest, res: Response) => {
  try {
    const { imageBase64 } = req.body || {};
    if (!imageBase64 || typeof imageBase64 !== 'string') return res.status(400).json({ error: 'Immagine mancante.' });
    const items = await scanLotItems(imageBase64);
    const out: any[] = [];
    for (const it of items) {
      let image: string | null = null;
      const q = it.code ? `${it.name} ${it.code}` : it.name;
      try {
        if (it.type === 'card') {
          const f = await pokemonSearch(q, 1).catch(() => []);
          if (f[0]?.image) image = f[0].image;
        } else {
          if (isKicksConfigured()) { const k = await kicksSearch(q, { limit: 1 }).catch(() => []); if (k[0]?.image) image = k[0].image; }
          if (!image && isStockXConfigured()) { const s = await searchStockXCandidates(q, { limit: 1 }).catch(() => []); if (s[0]?.image) image = s[0].image; }
        }
      } catch { /* foto facoltativa */ }
      out.push({ name: it.name, number: it.code, type: it.type, image });
    }
    await audit({ action: 'AI_SCAN', userId: req.user!.userId, req, metadata: { type: 'multi_item', count: out.length } });
    res.json({ items: out });
  } catch (err: any) {
    logger.error('Errore /ai/scan-items', { err: err.message });
    res.status(500).json({ error: err.message || 'Errore riconoscimento prodotti' });
  }
};
router.post('/scan-items', scanItemsHandler);
router.post('/scan-cards', scanItemsHandler); // compat

// ==========================================
// POST /api/ai/price - stima prezzo di mercato
// ==========================================
router.post('/price', validate(priceEstimateSchema), async (req: AuthRequest, res: Response) => {
  try {
    const result = await estimateMarketPrice(req.body);
    res.json(result);
  } catch (err: any) {
    logger.error('Errore /ai/price', { err: err.message });
    res.status(500).json({ error: 'Errore stima prezzo' });
  }
});

// ==========================================
// POST /api/ai/market-value - valutazione di mercato da query (sourcing, senza prodotto salvato)
// ==========================================
router.post('/market-value', requireFeature('stockx_pricing'), async (req: AuthRequest, res: Response) => {
  try {
    const { query, size, condition, category, sku } = req.body || {};
    const q = (query ?? '').toString().trim();
    if (q.length < 2) return res.status(400).json({ error: 'Inserisci brand e modello.' });
    // eBay rimosso: prezzo solo da StockX (sneaker). Altre categorie → nessun valore.
    void condition;
    const sx = await getStockXValuation({ query: q, name: q, size: size ? size.toString() : undefined, category: category?.toString(), sku: sku?.toString() });
    const valuation = { configured: sx.configured, value: sx.value, source: 'Valutazione di mercato', sample: sx.sample || 0, confidence: sx.value != null ? 'alta' : 'bassa' };
    logger.info('market-value esito', { query: q, value: sx.value });
    res.json(valuation);
  } catch (err: any) {
    logger.error('Errore /ai/market-value', { err: err.message });
    res.status(500).json({ error: 'Errore valutazione' });
  }
});

// ==========================================
// POST /api/ai/value - valutazione UNIFICATA (instrada per categoria)
// ==========================================
router.post('/value', async (req: AuthRequest, res: Response) => {
  try {
    const { category, game, brand, name, size, number, setName, condition, sku } = req.body || {};
    const val = await getValuation({
      category: category?.toString(),
      game: game?.toString(),
      brand: brand?.toString(),
      name: name?.toString(),
      size: size?.toString(),
      number: number?.toString(),
      setName: setName?.toString(),
      condition: condition?.toString(),
      sku: sku?.toString(),
    });
    logger.info('value esito', { category, game, value: val.value, reliable: val.reliable, source: val.source });
    res.json(val);
  } catch (err: any) {
    logger.error('Errore /ai/value', { err: err.message });
    res.status(500).json({ error: 'Errore valutazione' });
  }
});

// ==========================================
// POST /api/ai/stockx-match - conferma visiva: dato ciò che ha riconosciuto l'IA,
// chiede a StockX il match e restituisce foto + nome + prezzo per confronto.
// ==========================================
router.post('/stockx-match', requireFeature('stockx_pricing'), async (req: AuthRequest, res: Response) => {
  try {
    const query = (req.body?.query ?? '').toString().trim();
    const size = (req.body?.size ?? '').toString().trim() || undefined;
    const category = (req.body?.category ?? '').toString().trim() || undefined;
    const sku = (req.body?.sku ?? '').toString().trim() || undefined;
    if (query.length < 2) return res.json({ found: false });
    if (!isStockXConfigured()) return res.json({ found: false, reason: 'non configurato' });
    const sx = await getStockXValuation({ query, name: query, size, category, sku });
    if (!sx.itemName && !sx.image) return res.json({ found: false });
    res.json({ found: true, title: sx.itemName || null, image: sx.image || null, price: sx.value ?? null, sku: sx.styleId || null });
  } catch (err: any) {
    logger.error('Errore /ai/stockx-match', { err: err.message });
    res.json({ found: false });
  }
});

// ==========================================
// POST /api/ai/barcode-lookup - dal barcode/style code prova a riconoscere il prodotto
// (per ora via StockX: ricerca catalogo + prezzo). Risponde { found, brand, name, value }.
// ==========================================
router.post('/barcode-lookup', async (req: AuthRequest, res: Response) => {
  try {
    const code = (req.body?.barcode ?? '').toString().trim();
    if (!code || code.length < 4) return res.status(400).json({ error: 'Barcode non valido' });

    if (!isStockXConfigured()) {
      return res.json({ found: false, barcode: code, reason: 'StockX non configurato' });
    }
    const sx = await getStockXValuation({ query: code });
    if (sx.brand || sx.model || sx.itemName) {
      return res.json({
        found: true,
        barcode: code,
        brand: sx.brand || null,
        name: sx.model || sx.itemName || null,
        value: sx.value ?? null,
        source: 'StockX',
      });
    }
    return res.json({ found: false, barcode: code });
  } catch (err: any) {
    logger.error('Errore /ai/barcode-lookup', { err: err.message });
    res.status(500).json({ error: 'Errore lookup barcode' });
  }
});

// ==========================================
// POST /api/ai/card-value - valutazione carte Pokémon (Cardmarket EUR)
// ==========================================
router.post('/card-value', async (req: AuthRequest, res: Response) => {
  try {
    const { name, number, setName, game } = req.body || {};
    if (!name && !number) return res.status(400).json({ error: 'Serve almeno il nome della carta.' });
    const val = await getCardValue({
      game: game ? game.toString() : undefined,
      name: name ? name.toString() : undefined,
      number: number ? number.toString() : undefined,
      setName: setName ? setName.toString() : undefined,
    });
    logger.info('card-value esito', { game, name, number, value: val.value, sample: val.sample });
    res.json(val);
  } catch (err: any) {
    logger.error('Errore /ai/card-value', { err: err.message });
    res.status(500).json({ error: 'Errore valutazione carta' });
  }
});

// ==========================================
// POST /api/ai/full-scan - scan riconoscimento prodotto
// ==========================================
router.post('/full-scan', validate(aiScanSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { imageBase64, category, existingCategories } = req.body;
    const scan = category
      ? await scanProduct(imageBase64, category)
      : await scanProductAuto(imageBase64, existingCategories || []);

    await audit({
      action: 'AI_SCAN', userId: req.user!.userId, req,
      metadata: { type: 'full_scan', category: category || scan.detectedCategory || 'auto', auto: !category, confidence: scan.confidence }
    });

    res.json({ scan, price: null, authenticity: null });
  } catch (err: any) {
    logger.error('Errore /ai/full-scan', { err: err.message });
    res.status(500).json({ error: err.message || 'Errore scansione' });
  }
});

// ==========================================
// POST /api/ai/generate-listing — genera annuncio per piattaforma
// ==========================================
router.post('/generate-listing', async (req: AuthRequest, res: Response) => {
  try {
    const { productId, platform } = req.body;
    const validPlatforms: ListingPlatform[] = ['vinted', 'ebay', 'depop', 'wallapop', 'subito'];
    if (!productId || !validPlatforms.includes(platform)) {
      return res.status(400).json({ error: 'productId e platform obbligatori' });
    }

    const product = await prisma.product.findFirst({
      where: { id: productId, deletedAt: null },
    });
    if (!product) return res.status(404).json({ error: 'Prodotto non trovato' });

    let attributes: Record<string, any> | undefined;
    try {
      if (product.attributes && typeof product.attributes === 'object') {
        attributes = product.attributes as Record<string, any>;
      }
    } catch {}

    const listing = await generateListing({
      category: product.category,
      brand: product.brand,
      name: product.name,
      size: product.size,
      condition: product.condition,
      purchasePrice: product.purchasePrice,
      marketPriceMin: product.marketPriceMin ?? undefined,
      marketPriceMax: product.marketPriceMax ?? undefined,
      marketPriceAvg: product.marketPriceAvg ?? undefined,
      notes: product.notes ?? undefined,
      attributes,
      platform,
    });

    res.json(listing);
  } catch (err: any) {
    logger.error('Errore /ai/generate-listing', { err: err.message });
    res.status(500).json({ error: err.message || 'Errore generazione annuncio' });
  }
});

export default router;
