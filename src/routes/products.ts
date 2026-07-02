// src/routes/products.ts
// Pilastro 1: Soft delete — mai DELETE fisico dal DB.
// Pilastro 2: Macchina a stati (IN STOCK → RESERVED → VENDUTO → SHIPPED).
//             Transazioni ACID sul sell per prevenire overselling concorrente.
// Pilastro 5: RBAC — MEMBER non vede purchasePrice / dati finanziari.

import { Router, Response } from 'express';
import { PrismaClient, Prisma } from '@prisma/client';
import { prisma } from "../lib/prisma";
import { authenticate, AuthRequest, canAccessProduct } from '../middleware/auth';
import { resolveRole, stripFinancials } from '../middleware/rbac';
import { uploadImages, isCloudinaryConfigured } from '../services/upload.service';
import { apiLimiter } from '../middleware/rateLimit';
import { validate, createProductSchema, editProductSchema, sellProductSchema } from '../middleware/validate';
import { audit } from '../services/audit.service';
import { logInventory } from '../services/inventory-log.service';
import { notifyWarehouseMembers } from '../services/notification.service';
import { getMarketValuation } from '../services/price.service';
import { getStockXValuation, isStockXConfigured, searchStockXCandidates, getStockXImage } from '../services/stockx.service';
import { kicksSearch, isKicksConfigured } from '../services/kicksdb.service';
import { normalizeProductName } from '../services/ai.service';
import { checkProductQuota, requireFeature } from '../middleware/plan';
import { isFeatureLive } from '../config/plans';
import { isAdminEmail } from '../config/admins';
import { logger } from '../utils/logger';

// Quanto un titolo del catalogo combacia con la query (0..1) = frazione delle parole della
// query presenti nel titolo. Serve a NON agganciare foto sbagliate (es. prima Jordan 1 a caso).
function imgMatchScore(query: string, title: string): number {
  const qw = Array.from(new Set(query.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length >= 2)));
  if (!qw.length) return 0;
  const t = (title || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ');
  let hit = 0;
  for (const w of qw) if (t.includes(w)) hit++;
  return hit / qw.length;
}

// Cerca la FOTO ufficiale di un prodotto dal catalogo: prima la cache locale (gratis, niente
// quota), poi KicksDB→StockX. Sceglie il candidato che COMBACIA MEGLIO col nome (soglia minima):
// così non aggancia foto sbagliate e per i nomi inventati non mette nulla. Ritorna {image,sku}|null.
async function findCatalogImage(brand?: string | null, name?: string | null, deep = false): Promise<{ image: string; sku: string | null } | null> {
  const nm = (name || '').trim();
  const q = `${brand || ''} ${nm}`.trim();
  if (q.length < 2) return null;
  // 1) cache locale CatalogItem — niente consumo quota. Prende candidati e sceglie il migliore.
  if (nm.length >= 3) {
    try {
      const first = nm.split(/\s+/)[0];
      const cands = await prisma.catalogItem.findMany({
        where: { image: { not: null }, name: { contains: first, mode: 'insensitive' } }, take: 12,
      });
      let best: any = null, bestS = 0;
      for (const c of cands) { const s = imgMatchScore(q, `${c.brand || ''} ${c.name || ''}`); if (s > bestS) { bestS = s; best = c; } }
      if (best && bestS >= 0.4) return { image: best.image!, sku: best.sku || null };
    } catch { /* ignora */ }
  }
  // 2) fonte esterna (KicksDB → StockX), poi sceglie il candidato col punteggio migliore.
  // Soglia bassa = MASSIMA copertura (ogni prodotto prende la foto del match più vicino).
  try {
    const cands: any[] = [];
    if (isKicksConfigured()) cands.push(...await kicksSearch(q, { limit: 10 }).catch(() => []));
    if (isStockXConfigured()) cands.push(...(await searchStockXCandidates(q, { limit: 10 }).catch(() => [])));
    // Scelgo il candidato che combacia MEGLIO col nome (anche se la ricerca non ha portato la foto).
    let best: any = null, bestS = 0;
    for (const c of cands) { const s = imgMatchScore(q, c.title || ''); if (s > bestS) { bestS = s; best = c; } }
    if (best && bestS >= 0.34) {
      let image = best.image;
      // La ricerca StockX NON include la foto: la recupero dal DETTAGLIO col productId del match.
      if (!image && best.productId) image = await getStockXImage(best.productId).catch(() => null);
      if (image) return { image, sku: best.styleId || null };
    }
  } catch { /* fonte non disponibile */ }
  // 3) DEEP (es. pulsante "Trova foto"): l'IA normalizza il nome al nome ufficiale e ri-cerca.
  if (deep) {
    try {
      const norm = await normalizeProductName(brand || '', nm).catch(() => '');
      if (norm && norm.toLowerCase().replace(/[^a-z0-9]/g, '') !== q.toLowerCase().replace(/[^a-z0-9]/g, '')) {
        return await findCatalogImage(null, norm, false);
      }
    } catch { /* normalizzazione non disponibile */ }
  }
  return null;
}

const router = Router();

// Timeout reservation (15 minuti)
const RESERVATION_TTL_MS = 15 * 60 * 1000;

router.use(authenticate, resolveRole, apiLimiter);

// ==========================================
// GET /products — lista prodotti accessibili
// MEMBER: campi finanziari rimossi dalla risposta.
// ==========================================
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const currentUser = await prisma.user.findUnique({
      where: { id: req.user!.userId },
      include: {
        memberships: { include: { warehouse: { include: { members: true } } } },
      },
    });

    if (!currentUser?.memberships?.length) return res.json([]);

    const isOwner = (req as any).isOwner as boolean;
    const warehouseIds = currentUser.memberships.map(m => m.warehouseId);

    // Recupera tutti i prodotti dei warehouse a cui appartiene l'utente (senza deletedAt)
    const products = await prisma.product.findMany({
      where: {
        warehouseId: { in: warehouseIds },
        deletedAt: null,
      },
      orderBy: { createdAt: 'desc' },
    });

    // MEMORIA: le foto sono base64 pesanti. La lista (card) usa solo la PRIMA foto,
    // quindi spediamo solo quella + il conteggio. Le foto complete si caricano on-demand
    // all'apertura della Modifica (GET /products/:id/photos). Evita OOM con tanti prodotti/utenti.
    const sanitized = products.map(p => {
      const s = stripFinancials(p as any, isOwner) as any;
      let first: string | null = null; let count = 0;
      try { const arr = s.photos ? JSON.parse(s.photos) : []; if (Array.isArray(arr)) { count = arr.length; first = arr[0] || null; } } catch {}
      s.photos = first ? JSON.stringify([first]) : null;
      s.photoCount = count;
      return s;
    });
    res.json(sanitized);
  } catch (err: any) {
    logger.error('Errore GET /products', { err: err.message });
    res.status(500).json({ error: 'Errore database' });
  }
});

// Foto complete di un prodotto (caricate on-demand dalla Modifica, non nella lista).
router.get('/:id/photos', async (req: AuthRequest, res: Response) => {
  try {
    const { allowed, product } = await canAccessProduct(req.user!.userId, req.params.id);
    if (!allowed || !product) return res.status(403).json({ error: 'Non hai accesso a questo prodotto.' });
    let photos: string[] = [];
    try { photos = (product as any).photos ? JSON.parse((product as any).photos) : []; } catch {}
    res.json({ photos: Array.isArray(photos) ? photos : [] });
  } catch (err: any) {
    logger.error('Errore GET /products/:id/photos', { err: err.message });
    res.status(500).json({ error: 'Errore' });
  }
});

// ==========================================
// Magazzino pubblico (auto-pubblicazione): on/off. Quando attivo, ogni nuovo prodotto
// finisce automaticamente in vetrina (Compra) con prezzo = stima di mercato o prezzo inserito.
// ==========================================
router.get('/auto-publish', async (req: AuthRequest, res: Response) => {
  try {
    const s = await prisma.setting.findUnique({ where: { key: `autoPublish:${req.user!.userId}` } });
    res.json({ enabled: s?.value === '1' });
  } catch { res.json({ enabled: false }); }
});
router.put('/auto-publish', async (req: AuthRequest, res: Response) => {
  try {
    const enabled = req.body?.enabled === true;
    await prisma.setting.upsert({
      where: { key: `autoPublish:${req.user!.userId}` },
      create: { key: `autoPublish:${req.user!.userId}`, value: enabled ? '1' : '0' },
      update: { value: enabled ? '1' : '0' },
    });
    res.json({ enabled });
  } catch (err: any) {
    logger.error('Errore PUT /products/auto-publish', { err: err.message });
    res.status(500).json({ error: 'Errore salvataggio' });
  }
});

// ==========================================
// POST /products/lot — crea lotto (N prodotti da prezzo totale)
// ACID transaction: tutti o nessuno.
// ==========================================
router.post('/lot', async (req: AuthRequest, res: Response) => {
  try {
    const { category, lotName, totalPrice, quantity, brand, size, condition, notes, attributes, warehouseId: bodyWarehouseId, customShares, photos } = req.body;

    if (!category || !lotName || !totalPrice || !quantity || quantity < 2 || quantity > 200) {
      return res.status(400).json({ error: 'Dati lotto non validi.' });
    }

    // Foto del lotto (es. la foto della pagina del raccoglitore di carte): applicata a TUTTI i
    // pezzi del lotto. Se è una foto scattata (base64) e Cloudinary è attivo, la carichiamo.
    let lotPhotos: string[] | null = Array.isArray(photos) && photos.length > 0 ? photos.filter((p: any) => typeof p === 'string') : null;
    if (lotPhotos && isCloudinaryConfigured()) {
      const toUp = lotPhotos.filter(p => p.startsWith('data:'));
      if (toUp.length) { const up = await uploadImages(toUp); let i = 0; lotPhotos = lotPhotos.map(p => p.startsWith('data:') ? up[i++] : p); }
    }
    const lotPhotosJson = lotPhotos ? JSON.stringify(lotPhotos) : null;

    // Quote (snapshot delle percentuali del magazzino al momento della creazione),
    // identico al prodotto singolo: ogni pezzo del lotto le porta con sé.
    const parsedShares = customShares && Array.isArray(customShares) && customShares.length > 0
      ? JSON.stringify(customShares.map((s: any) => ({ ...s, percentage: Number(s.percentage) || 0 })))
      : null;

    // Gating piano: il lotto crea `quantity` prodotti → verifica il limite prima.
    const quotaErr = await checkProductQuota(req.user!.userId, quantity);
    if (quotaErr) return res.status(402).json(quotaErr);

    // Nuovo modello: il lotto va nel magazzino scelto (warehouseId) o nel magazzino base.
    const memberships = await prisma.membership.findMany({
      where: { userId: req.user!.userId },
      include: { warehouse: true },
    });
    const targetMembership = bodyWarehouseId
      ? memberships.find(m => m.warehouseId === bodyWarehouseId)
      : (memberships.find(m => m.role === 'OWNER' && !m.warehouse.parentId) || memberships[0]);
    if (!targetMembership) return res.status(403).json({ error: 'Non sei membro di questo magazzino.' });

    const pricePerUnit = Math.round((totalPrice / quantity) * 100) / 100;
    const lotNote = `Lotto: "${lotName}" — ${quantity} pezzi × ${pricePerUnit.toFixed(2)}€`;

    // Il NOME del prodotto NON contiene più il nome del lotto (era ridondante: il lotto si vede
    // già nella scheda, chip "Lotto: …" in alto a destra). Usiamo il brand come nome; se manca,
    // ripieghiamo sul nome del lotto solo perché serve un'etichetta. Niente più numerazione "#N":
    // i pezzi identici si raggruppano in un'unica riga con quantità.
    const itemName = (brand && String(brand).trim()) ? String(brand).trim() : lotName;

    const created = await prisma.$transaction(
      Array.from({ length: quantity }, (_, _i) =>
        prisma.product.create({
          data: {
            category,
            brand: brand || lotName,
            name: itemName,
            size: size || '-',
            condition: condition || 'N/D',
            purchasePrice: pricePerUnit,
            status: 'IN STOCK',
            userId: req.user!.userId,
            warehouseId: targetMembership.warehouseId,
            customShares: parsedShares,
            notes: notes ? `${lotNote} — ${notes}` : lotNote,
            attributes: (attributes && typeof attributes === 'object') ? JSON.stringify(attributes) : null,
            photos: lotPhotosJson,
            lotName,
          },
        })
      )
    );

    // Log inventario per ogni item del lotto
    await Promise.all(
      created.map(p =>
        logInventory({
          productId: p.id,
          userId: req.user!.userId,
          action: 'STATUS_CHANGE',
          field: 'status',
          newValue: 'IN STOCK',
          note: `Creato da lotto "${lotName}"`,
        })
      )
    );

    await audit({
      action: 'PRODUCT_CREATE', userId: req.user!.userId, req,
      resource: created[0].id,
      metadata: { lot: lotName, quantity, totalPrice, pricePerUnit },
    });

    await notifyWarehouseMembers({
      warehouseId: targetMembership.warehouseId,
      excludeUserId: req.user!.userId,
      type: 'PRODUCT_ADDED',
      title: `Lotto aggiunto: ${lotName}`,
      message: `${quantity} pezzi da ${pricePerUnit.toFixed(2)}€ cad. (tot. ${totalPrice}€)`,
    });

    res.json({ created: created.length, pricePerUnit, products: created });
  } catch (err: any) {
    logger.error('Errore POST /products/lot', { err: err.message });
    res.status(500).json({ error: 'Errore creazione lotto' });
  }
});

// ==========================================
// POST /products/lot-smart — Lotto MISTO (IA): crea N articoli DIVERSI (riconosciuti dall'IA)
// con split automatico del costo totale, equo o pesato sul valore di mercato.
// body: { lotName, totalPrice, splitMode:'equal'|'weighted', warehouseId?, items: [
//   { category, brand, name, size, condition, sku?, photo?, marketValue? }, ... ] }
// ==========================================
router.post('/lot-smart', async (req: AuthRequest, res: Response) => {
  try {
    const { lotName, totalPrice, splitMode, warehouseId: bodyWarehouseId, items } = req.body;
    if (!lotName || !Array.isArray(items) || items.length < 1 || items.length > 200) {
      return res.status(400).json({ error: 'Dati lotto non validi.' });
    }
    const total = Math.max(Number(totalPrice) || 0, 0);

    const quotaErr = await checkProductQuota(req.user!.userId, items.length);
    if (quotaErr) return res.status(402).json(quotaErr);

    const memberships = await prisma.membership.findMany({
      where: { userId: req.user!.userId }, include: { warehouse: true },
    });
    const targetMembership = bodyWarehouseId
      ? memberships.find(m => m.warehouseId === bodyWarehouseId)
      : (memberships.find(m => m.role === 'OWNER' && !m.warehouse.parentId) || memberships[0]);
    if (!targetMembership) return res.status(403).json({ error: 'Non sei membro di questo magazzino.' });

    // SPLIT del costo totale fra i pezzi: pesato sul valore di mercato (se richiesto e disponibile),
    // altrimenti equo. L'ultimo pezzo assorbe l'arrotondamento così la somma torna esatta.
    const weights = items.map((it: any) => Math.max(Number(it.marketValue) || 0, 0));
    const weightSum = weights.reduce((a: number, b: number) => a + b, 0);
    const useWeighted = splitMode === 'weighted' && weightSum > 0;
    let allocated = 0;
    const costs = items.map((_: any, i: number) => {
      if (total <= 0) return 0;
      if (i === items.length - 1) return Math.round((total - allocated) * 100) / 100; // resto
      const c = useWeighted
        ? Math.round((total * weights[i] / weightSum) * 100) / 100
        : Math.round((total / items.length) * 100) / 100;
      allocated += c;
      return c;
    });

    const created = await prisma.$transaction(
      items.map((it: any, i: number) => prisma.product.create({
        data: {
          category: (it.category || 'Generico').toString(),
          // brand NON eredita più il nome del lotto (era ridondante col chip "Lotto: …"): resta
          // vuoto se non specificato. Il nome del pezzo è quello scritto nella riga.
          brand: (it.brand || '').toString(),
          name: (it.name || it.brand || 'Articolo').toString(),
          size: (it.size || '-').toString(),
          condition: (it.condition || 'N/D').toString(),
          purchasePrice: costs[i],
          status: 'IN STOCK',
          userId: req.user!.userId,
          warehouseId: targetMembership.warehouseId,
          notes: `Lotto "${lotName}"`,
          photos: it.photo ? JSON.stringify([it.photo]) : null,
          sku: it.sku ? it.sku.toString() : null,
          marketPriceAvg: Number(it.marketValue) > 0 ? Number(it.marketValue) : null,
          lotName,
        },
      }))
    );

    await Promise.all(created.map(p => logInventory({
      productId: p.id, userId: req.user!.userId, action: 'STATUS_CHANGE',
      field: 'status', newValue: 'IN STOCK', note: `Creato da lotto smart "${lotName}"`,
    })));
    await audit({
      action: 'PRODUCT_CREATE', userId: req.user!.userId, req, resource: created[0].id,
      metadata: { lotSmart: lotName, quantity: created.length, totalPrice: total, splitMode: useWeighted ? 'weighted' : 'equal' },
    });
    await notifyWarehouseMembers({
      warehouseId: targetMembership.warehouseId, excludeUserId: req.user!.userId,
      type: 'PRODUCT_ADDED', title: `Lotto aggiunto: ${lotName}`,
      message: `${created.length} pezzi (tot. ${total}€)`,
    });

    res.json({ created: created.length, products: created });
  } catch (err: any) {
    logger.error('Errore POST /products/lot-smart', { err: err.message });
    res.status(500).json({ error: 'Errore creazione lotto smart' });
  }
});

// ==========================================
// POST /products — crea prodotto singolo
// ==========================================
// POST /products/enrich-photos — { ids? } → aggancia la foto dal catalogo ai prodotti SENZA
// immagine. Se 'ids' manca, processa tutti i prodotti IN STOCK dell'utente senza foto.
router.post('/enrich-photos', async (req: AuthRequest, res: Response) => {
  try {
    const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids.slice(0, 300) : [];
    const where: any = { userId: req.user!.userId, deletedAt: null, photos: null };
    if (ids.length) where.id = { in: ids };
    else where.status = 'IN STOCK';
    const products = await prisma.product.findMany({ where, take: 300 });
    let updated = 0;
    for (const p of products) {
      const found = await findCatalogImage(p.brand, p.name, true); // deep: usa l'IA per i nomi abbreviati
      if (found?.image) {
        await prisma.product.update({ where: { id: p.id }, data: { photos: JSON.stringify([found.image]), sku: p.sku || found.sku } });
        updated++;
      }
    }
    res.json({ updated, scanned: products.length });
  } catch (err: any) {
    logger.error('Errore POST /products/enrich-photos', { err: err.message });
    res.status(500).json({ error: 'Errore aggancio foto' });
  }
});

router.post('/', validate(createProductSchema), async (req: AuthRequest, res: Response) => {
  try {
    const {
      category, warehouseId: bodyWarehouseId, brand, name, size, condition, price, customShares, photos,
      marketPriceMin, marketPriceMax, marketPriceAvg, authenticityScore, notes,
      attributes, consignmentName, consignmentPercent, lotName, sku,
    } = req.body;

    // Gating piano: verifica il limite prodotti prima di crearne uno nuovo.
    const quotaErr = await checkProductQuota(req.user!.userId, 1);
    if (quotaErr) return res.status(402).json(quotaErr);

    const memberships = await prisma.membership.findMany({
      where: { userId: req.user!.userId },
      include: { warehouse: true },
    });
    // Nuovo modello: il magazzino è una partnership, non una categoria. Il prodotto va
    // nel warehouseId scelto; in mancanza, nel magazzino base dell'utente (primo top-level OWNER).
    const targetMembership = bodyWarehouseId
      ? memberships.find(m => m.warehouseId === bodyWarehouseId)
      : (memberships.find(m => m.role === 'OWNER' && !m.warehouse.parentId) || memberships[0]);
    // La categoria è trasversale: arriva dal body, indipendente dal magazzino.
    const effectiveCategory = category;
    if (!targetMembership) {
      await audit({
        action: 'UNAUTHORIZED_ACCESS', userId: req.user!.userId, req,
        metadata: { resource: 'product_create', category },
      });
      return res.status(403).json({ error: 'Non sei membro di questo magazzino.' });
    }

    const parsedShares = customShares && Array.isArray(customShares) && customShares.length > 0
      ? JSON.stringify(customShares.map((s: any) => ({ ...s, percentage: Number(s.percentage) || 0 })))
      : null;

    // Auto-pubblicazione: se l'utente ha attivato "magazzino pubblico", ogni nuovo prodotto
    // va in vetrina (Compra). Serve un prezzo pubblico: usa la stima di mercato IA, altrimenti
    // il prezzo inserito. Rispetta il piano (serve la feature 'marketplace').
    let autoPublish = false;
    let autoPublicPrice: number | null = null;
    try {
      const ap = await prisma.setting.findUnique({ where: { key: `autoPublish:${req.user!.userId}` } });
      if (ap?.value === '1') {
        const u = await prisma.user.findUnique({ where: { id: req.user!.userId }, select: { plan: true, email: true } });
        if (isFeatureLive(u?.plan, 'marketplace', isAdminEmail(u?.email))) {
          const pp = (typeof marketPriceAvg === 'number' && marketPriceAvg > 0) ? marketPriceAvg
            : (typeof marketPriceMax === 'number' && marketPriceMax > 0) ? marketPriceMax
            : (price > 0 ? price : null);
          if (pp && pp > 0) { autoPublish = true; autoPublicPrice = Math.round(pp * 100) / 100; }
        }
      }
    } catch { /* best-effort: se fallisce, niente auto-pubblicazione */ }

    // Se Cloudinary è configurato, carica SOLO le foto scattate (base64) e salva gli URL.
    // Le foto già esterne (link http/https, es. immagini del catalogo StockX) restano
    // tali e quali: NON le ricarichiamo su Cloudinary → zero storage occupato.
    let finalPhotos = photos && Array.isArray(photos) && photos.length > 0 ? photos : null;
    // PRASSI: se non è stata fornita nessuna foto, la cerco da sola dal catalogo (a meno che
    // il chiamante chieda di saltare, es. import bulk che poi aggancia le foto in batch).
    if (!finalPhotos && !req.body.skipAutoPhoto) {
      const found = await findCatalogImage(brand, name);
      if (found) finalPhotos = [found.image];
    }
    if (finalPhotos && isCloudinaryConfigured()) {
      const toUpload = finalPhotos.filter((p: any) => typeof p === 'string' && p.startsWith('data:'));
      if (toUpload.length > 0) {
        const uploaded = await uploadImages(toUpload);
        let i = 0;
        finalPhotos = finalPhotos.map((p: any) => (typeof p === 'string' && p.startsWith('data:')) ? uploaded[i++] : p);
      }
    }
    const parsedPhotos = finalPhotos ? JSON.stringify(finalPhotos) : null;

    // Gestione profitShareOverride
    const parsedProfitOverride = req.body.profitShareOverride && Array.isArray(req.body.profitShareOverride) && req.body.profitShareOverride.length > 0
      ? JSON.stringify(req.body.profitShareOverride.map((s: any) => ({ ...s, percentage: Number(s.percentage) || 0 })))
      : null;

    const newProduct = await prisma.product.create({
      data: {
        category: effectiveCategory, brand, name,
        size: (size || '').trim() || '—',
        condition: (condition || '').trim() || '—',
        purchasePrice: price,
        status: 'IN STOCK',
        userId: req.user!.userId,
        warehouseId: targetMembership.warehouseId,
        customShares: parsedShares,
        profitShareOverride: parsedProfitOverride,
        photos: parsedPhotos,
        marketPriceMin, marketPriceMax, marketPriceAvg, authenticityScore,
        notes: notes || null,
        attributes: attributes && typeof attributes === 'object' ? JSON.stringify(attributes) : null,
        consignmentName: (consignmentName || '').trim() || null,
        consignmentPercent: typeof consignmentPercent === 'number' ? consignmentPercent : null,
        lotName: (typeof lotName === 'string' && lotName.trim()) ? lotName.trim() : null,
        sku: (typeof sku === 'string' && sku.trim()) ? sku.trim() : null,
        // Magazzino pubblico attivo → in vetrina automaticamente.
        isPublic: autoPublish,
        publicPrice: autoPublish ? autoPublicPrice : null,
      },
    });

    await logInventory({
      productId: newProduct.id,
      userId: req.user!.userId,
      action: 'STATUS_CHANGE',
      field: 'status',
      newValue: 'IN STOCK',
    });

    await audit({
      action: 'PRODUCT_CREATE', userId: req.user!.userId, req,
      resource: newProduct.id,
      metadata: { brand, name, price },
    });

    await notifyWarehouseMembers({
      warehouseId: targetMembership.warehouseId,
      excludeUserId: req.user!.userId,
      type: 'PRODUCT_ADDED',
      title: 'Nuovo prodotto in magazzino',
      message: `${brand} ${name} (${size}) aggiunto · categoria ${category}`,
    });

    res.json(newProduct);
  } catch (err: any) {
    logger.error('Errore POST /products', { err: err.message });
    res.status(500).json({ error: 'Errore creazione prodotto' });
  }
});

// ==========================================
// POST /products/:id/reserve — riserva un prodotto (stato RESERVED)
// Pilastro 2: previene overselling concorrente.
// ==========================================
router.post('/:id/reserve', async (req: AuthRequest, res: Response) => {
  try {
    // ACID: select-for-update simulato con transaction + check stato
    const result = await prisma.$transaction(async tx => {
      const product = await tx.product.findFirst({
        where: { id: req.params.id, deletedAt: null },
      });
      if (!product) throw Object.assign(new Error('NOT_FOUND'), { status: 404 });
      if (product.status !== 'IN STOCK') {
        throw Object.assign(new Error('NOT_AVAILABLE'), { status: 409 });
      }
      return tx.product.update({
        where: { id: req.params.id },
        data: {
          status: 'RESERVED',
          reservedBy: req.user!.userId,
          reservedAt: new Date(),
        },
      });
    });

    await logInventory({
      productId: result.id,
      userId: req.user!.userId,
      action: 'RESERVE',
      field: 'status',
      oldValue: 'IN STOCK',
      newValue: 'RESERVED',
    });

    res.json({ success: true, reservedUntil: new Date(Date.now() + RESERVATION_TTL_MS) });
  } catch (err: any) {
    if (err.message === 'NOT_FOUND') return res.status(404).json({ error: 'Prodotto non trovato.' });
    if (err.message === 'NOT_AVAILABLE') return res.status(409).json({ error: 'Prodotto non disponibile (già riservato o venduto).' });
    logger.error('Errore POST /products/:id/reserve', { err: err.message });
    res.status(500).json({ error: 'Errore prenotazione' });
  }
});

// ==========================================
// DELETE /products/:id/reserve — rilascia la reservation
// ==========================================
router.delete('/:id/reserve', async (req: AuthRequest, res: Response) => {
  try {
    const product = await prisma.product.findFirst({
      where: { id: req.params.id, deletedAt: null },
    });
    if (!product) return res.status(404).json({ error: 'Prodotto non trovato.' });
    if (product.status !== 'RESERVED') return res.status(400).json({ error: 'Il prodotto non è riservato.' });

    // Solo chi ha riservato o un OWNER può rilasciare
    const isOwner = (req as any).isOwner as boolean;
    if (!isOwner && product.reservedBy !== req.user!.userId) {
      return res.status(403).json({ error: 'Non puoi rilasciare la reservation altrui.' });
    }

    await prisma.product.update({
      where: { id: req.params.id },
      data: { status: 'IN STOCK', reservedBy: null, reservedAt: null },
    });

    await logInventory({
      productId: req.params.id,
      userId: req.user!.userId,
      action: 'RELEASE',
      field: 'status',
      oldValue: 'RESERVED',
      newValue: 'IN STOCK',
    });

    res.json({ success: true });
  } catch (err: any) {
    logger.error('Errore DELETE /products/:id/reserve', { err: err.message });
    res.status(500).json({ error: 'Errore rilascio reservation' });
  }
});

// ==========================================
// PUT /products/:id — registra vendita
// Pilastro 2: ACID — previene race condition su prodotti RESERVED da altri.
// ==========================================
router.put('/:id', validate(sellProductSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { allowed, product } = await canAccessProduct(req.user!.userId, req.params.id);
    if (!allowed || !product) {
      await audit({
        action: 'UNAUTHORIZED_ACCESS', userId: req.user!.userId, req,
        resource: req.params.id, metadata: { type: 'product_sell' },
      });
      return res.status(403).json({ error: 'Non hai accesso a questo prodotto.' });
    }

    if (product.deletedAt) return res.status(404).json({ error: 'Prodotto non trovato.' });
    if (product.status === 'VENDUTO') return res.status(400).json({ error: 'Prodotto già venduto.' });

    // Se RESERVED da qualcun altro, blocca (OWNER può forzare)
    const isOwner = (req as any).isOwner as boolean;
    if (
      product.status === 'RESERVED' &&
      product.reservedBy !== req.user!.userId &&
      !isOwner
    ) {
      return res.status(409).json({ error: 'Prodotto riservato da un altro utente.' });
    }

    const { salePrice, platform, fees, customer } = req.body;
    const cust = typeof customer === 'string' && customer.trim() ? customer.trim().slice(0, 120) : null;

    // ACID transaction
    const updated = await prisma.$transaction(async tx => {
      const current = await tx.product.findUnique({ where: { id: req.params.id } });
      if (!current || current.status === 'VENDUTO') {
        throw Object.assign(new Error('ALREADY_SOLD'), { status: 409 });
      }
      return tx.product.update({
        where: { id: req.params.id },
        data: {
          salePrice, platform, fees, customer: cust,
          status: 'VENDUTO', soldAt: new Date(),
          reservedBy: null, reservedAt: null,
        },
      });
    });

    await logInventory({
      productId: updated.id,
      userId: req.user!.userId,
      action: 'STATUS_CHANGE',
      field: 'status',
      oldValue: product.status,
      newValue: 'VENDUTO',
      note: `Venduto ${salePrice}€ su ${platform}`,
    });

    await audit({
      action: 'PRODUCT_SELL', userId: req.user!.userId, req,
      resource: updated.id,
      metadata: { salePrice, platform, profit: salePrice - product.purchasePrice - (fees || 0) },
    });

    if (updated.warehouseId) {
      await notifyWarehouseMembers({
        warehouseId: updated.warehouseId,
        excludeUserId: req.user!.userId,
        type: 'SALE',
        title: '💰 Vendita registrata',
        message: `${product.brand} ${product.name} venduto a ${salePrice}€ su ${platform}`,
      });
    }

    res.json(updated);
  } catch (err: any) {
    if (err.message === 'ALREADY_SOLD') return res.status(409).json({ error: 'Prodotto già venduto da un altro utente.' });
    logger.error('Errore PUT /products/:id', { err: err.message });
    res.status(500).json({ error: 'Errore vendita' });
  }
});

// ==========================================
// POST /products/:id/return — reso: VENDUTO → IN STOCK
// Operazione inversa della vendita: ripulisce i dati di vendita.
// ==========================================
router.post('/:id/return', async (req: AuthRequest, res: Response) => {
  try {
    const { allowed, product } = await canAccessProduct(req.user!.userId, req.params.id);
    if (!allowed || !product) {
      await audit({
        action: 'UNAUTHORIZED_ACCESS', userId: req.user!.userId, req,
        resource: req.params.id, metadata: { type: 'product_return' },
      });
      return res.status(403).json({ error: 'Non hai accesso a questo prodotto.' });
    }
    if (product.deletedAt) return res.status(404).json({ error: 'Prodotto non trovato.' });
    if (product.status !== 'VENDUTO') return res.status(400).json({ error: 'Solo un prodotto venduto può essere reso.' });

    const updated = await prisma.product.update({
      where: { id: req.params.id },
      data: {
        status: 'IN STOCK',
        salePrice: null, platform: null, fees: null, soldAt: null,
        reservedBy: null, reservedAt: null,
      },
    });

    await logInventory({
      productId: updated.id,
      userId: req.user!.userId,
      action: 'STATUS_CHANGE',
      field: 'status',
      oldValue: 'VENDUTO',
      newValue: 'IN STOCK',
      note: 'Reso: prodotto rientrato in stock',
    });

    await audit({
      action: 'PRODUCT_RETURN', userId: req.user!.userId, req,
      resource: updated.id,
      metadata: { brand: product.brand, name: product.name },
    });

    if (updated.warehouseId) {
      await notifyWarehouseMembers({
        warehouseId: updated.warehouseId,
        excludeUserId: req.user!.userId,
        type: 'SALE',
        title: '↩️ Reso registrato',
        message: `${product.brand} ${product.name} è rientrato in stock`,
      });
    }

    res.json(updated);
  } catch (err: any) {
    logger.error('Errore POST /products/:id/return', { err: err.message });
    res.status(500).json({ error: 'Errore reso' });
  }
});

// ==========================================
// PUT /products/:id/edit — modifica prodotto
// ==========================================
router.put('/:id/edit', validate(editProductSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { allowed, product } = await canAccessProduct(req.user!.userId, req.params.id);
    if (!allowed || !product) {
      await audit({
        action: 'UNAUTHORIZED_ACCESS', userId: req.user!.userId, req,
        resource: req.params.id, metadata: { type: 'product_edit' },
      });
      return res.status(403).json({ error: 'Non hai accesso a questo prodotto.' });
    }
    if (product.deletedAt) return res.status(404).json({ error: 'Prodotto non trovato.' });

    const { category, brand, name, size, condition, purchasePrice, customShares, photos, notes, attributes, consignmentName, consignmentPercent, warehouseId: newWarehouseId, salePrice, platform, fees, customer, quickSalePrice, purchaseDate, soldDate } = req.body;
    // Date facoltative: parse sicuro (ISO/yyyy-mm-dd). Ignora se non valide.
    const parseDate = (v: any): Date | null | undefined => {
      if (v === undefined) return undefined;      // non toccare
      if (v === null || v === '') return null;    // azzera
      const d = new Date(v); return isNaN(d.getTime()) ? undefined : d;
    };
    const purchaseAt = parseDate(purchaseDate);
    const soldAtDate = parseDate(soldDate);

    // Spostamento in un altro magazzino: consentito solo se l'utente ne è membro.
    let warehouseMove: string | undefined = undefined;
    if (newWarehouseId && newWarehouseId !== product.warehouseId) {
      const member = await prisma.membership.findFirst({ where: { userId: req.user!.userId, warehouseId: newWarehouseId } });
      if (!member) return res.status(403).json({ error: 'Non sei membro del magazzino di destinazione.' });
      warehouseMove = newWarehouseId;
    }

    // Log variazione prezzo d'acquisto (dato sensibile)
    if (purchasePrice !== undefined && purchasePrice !== product.purchasePrice) {
      await logInventory({
        productId: product.id,
        userId: req.user!.userId,
        action: 'PRICE_CHANGE',
        field: 'purchasePrice',
        oldValue: product.purchasePrice,
        newValue: purchasePrice,
      });
    }

    // Log variazione attributi dinamici
    if (attributes !== undefined) {
      await logInventory({
        productId: product.id,
        userId: req.user!.userId,
        action: 'ATTR_CHANGE',
        field: 'attributes',
        note: 'Aggiornamento campi dinamici',
      });
    }

    const parsedShares = customShares && Array.isArray(customShares) && customShares.length > 0
      ? JSON.stringify(customShares.map((s: any) => ({ ...s, percentage: Number(s.percentage) || 0 })))
      : null;

    let finalEditPhotos = photos && Array.isArray(photos) && photos.length > 0 ? photos : null;
    if (finalEditPhotos && isCloudinaryConfigured()) {
      finalEditPhotos = await uploadImages(finalEditPhotos);
    }
    const parsedPhotos = finalEditPhotos ? JSON.stringify(finalEditPhotos) : null;

    // Gestione profitShareOverride
    const parsedProfitOverride = req.body.profitShareOverride && Array.isArray(req.body.profitShareOverride) && req.body.profitShareOverride.length > 0
      ? JSON.stringify(req.body.profitShareOverride.map((s: any) => ({ ...s, percentage: Number(s.percentage) || 0 })))
      : null;

    const p = await prisma.product.update({
      where: { id: req.params.id },
      data: {
        category, brand, name,
        size: (size || '').trim() || '—',
        condition: (condition || '').trim() || '—',
        purchasePrice,
        ...(warehouseMove ? { warehouseId: warehouseMove } : {}),
        customShares: parsedShares,
        profitShareOverride: parsedProfitOverride,
        photos: parsedPhotos,
        notes: notes !== undefined ? (notes || null) : undefined,
        attributes: attributes !== undefined
          ? (attributes && typeof attributes === 'object' ? JSON.stringify(attributes) : null)
          : undefined,
        consignmentName: consignmentName !== undefined ? ((consignmentName || '').trim() || null) : undefined,
        consignmentPercent: consignmentPercent !== undefined ? (typeof consignmentPercent === 'number' ? consignmentPercent : null) : undefined,
        // Modifica VENDITA (solo se inviati: prodotto già venduto). undefined = non toccare.
        salePrice: salePrice !== undefined ? (typeof salePrice === 'number' ? salePrice : null) : undefined,
        platform: platform !== undefined ? ((platform || '').toString().trim() || null) : undefined,
        fees: fees !== undefined ? (typeof fees === 'number' ? fees : null) : undefined,
        customer: customer !== undefined ? ((customer || '').toString().trim() || null) : undefined,
        quickSalePrice: quickSalePrice !== undefined ? (typeof quickSalePrice === 'number' ? quickSalePrice : null) : undefined,
        // Date facoltative: acquisto = createdAt, vendita = soldAt (solo se valide).
        ...(purchaseAt !== undefined ? { createdAt: purchaseAt ?? undefined } : {}),
        ...(soldAtDate !== undefined ? { soldAt: soldAtDate } : {}),
      },
    });

    await audit({
      action: 'PRODUCT_EDIT', userId: req.user!.userId, req,
      resource: p.id, metadata: { changes: { brand, name, purchasePrice } },
    });

    res.json(p);
  } catch (err: any) {
    logger.error('Errore PUT /products/:id/edit', { err: err.message });
    res.status(500).json({ error: 'Errore modifica' });
  }
});

// ==========================================
// PATCH /products/:id/notes — aggiorna solo le note
// ==========================================
router.patch('/:id/notes', async (req: AuthRequest, res: Response) => {
  try {
    const { allowed, product } = await canAccessProduct(req.user!.userId, req.params.id);
    if (!allowed) return res.status(403).json({ error: 'Non hai accesso a questo prodotto.' });
    if (product?.deletedAt) return res.status(404).json({ error: 'Prodotto non trovato.' });

    const { notes } = req.body;
    const p = await prisma.product.update({
      where: { id: req.params.id },
      data: { notes: notes || null },
    });
    res.json({ notes: p.notes });
  } catch (err: any) {
    logger.error('Errore PATCH /products/:id/notes', { err: err.message });
    res.status(500).json({ error: 'Errore salvataggio note' });
  }
});

// ==========================================
// DELETE /products/:id — SOFT DELETE (mai DELETE fisico)
// Pilastro 1: i dati non vengono mai cancellati davvero.
// ==========================================
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { allowed, product } = await canAccessProduct(req.user!.userId, req.params.id);
    if (!allowed || !product) return res.status(403).json({ error: 'Non hai accesso a questo prodotto.' });
    if (product.deletedAt) return res.status(404).json({ error: 'Prodotto già eliminato.' });

    await prisma.product.update({
      where: { id: req.params.id },
      data: { deletedAt: new Date() },
    });

    await logInventory({
      productId: req.params.id,
      userId: req.user!.userId,
      action: 'SOFT_DELETE',
      field: 'deletedAt',
      note: `${product.brand} ${product.name}`,
    });

    await audit({
      action: 'PRODUCT_DELETE', userId: req.user!.userId, req,
      resource: req.params.id,
      metadata: { brand: product.brand, name: product.name, softDelete: true },
    });

    res.json({ success: true });
  } catch (err: any) {
    logger.error('Errore DELETE /products/:id', { err: err.message });
    res.status(500).json({ error: 'Errore eliminazione' });
  }
});

// ==========================================
// POST /products/:id/restore — annulla un'eliminazione (ripristina dal soft-delete)
// ==========================================
router.post('/:id/restore', async (req: AuthRequest, res: Response) => {
  try {
    const { allowed, product } = await canAccessProduct(req.user!.userId, req.params.id);
    if (!allowed || !product) return res.status(403).json({ error: 'Non hai accesso a questo prodotto.' });
    if (!product.deletedAt) return res.status(400).json({ error: 'Il prodotto non è eliminato.' });

    await prisma.product.update({
      where: { id: req.params.id },
      data: { deletedAt: null },
    });

    await logInventory({
      productId: req.params.id,
      userId: req.user!.userId,
      action: 'SOFT_DELETE',
      field: 'deletedAt',
      note: `Ripristinato: ${product.brand} ${product.name}`,
    });

    await audit({
      action: 'PRODUCT_EDIT', userId: req.user!.userId, req,
      resource: req.params.id,
      metadata: { brand: product.brand, name: product.name, restored: true },
    });

    res.json({ success: true });
  } catch (err: any) {
    logger.error('Errore POST /products/:id/restore', { err: err.message });
    res.status(500).json({ error: 'Errore ripristino' });
  }
});

// ==========================================
// GET /products/:id/valuation — valutazione di mercato (eBay autenticati, anti-falsi)
// Risponde { configured:false } finché non sono presenti le chiavi della fonte prezzi.
// ==========================================
router.get('/:id/valuation', requireFeature('stockx_pricing'), async (req: AuthRequest, res: Response) => {
  try {
    const { allowed, product } = await canAccessProduct(req.user!.userId, req.params.id);
    if (!allowed || !product) return res.status(403).json({ error: 'Non hai accesso a questo prodotto.' });
    if (product.deletedAt) return res.status(404).json({ error: 'Prodotto non trovato.' });

    const query = `${product.brand} ${product.name}`.trim();
    // StockX: prova SEMPRE. Restituiamo anche il MOTIVO preciso se non c'è valore,
    // così dall'app si capisce se manca la configurazione, la connessione o solo il match.
    const sx = await getStockXValuation({ query, name: product.name || undefined, size: product.size || undefined, sku: product.sku || undefined, category: product.category || undefined });
    if (sx.value != null) {
      return res.json({ configured: true, value: sx.value, source: 'Valutazione di mercato', sample: sx.sample || 1, confidence: 'alta', authenticatedOnly: true });
    }
    res.json({
      configured: sx.configured,
      connected: sx.connected ?? false,
      value: null,
      // sx.source è già esplicativo: "non configurato" | "non connesso" | "nessun risultato" | "errore"
      source: sx.source,
      sample: 0,
    });
  } catch (err: any) {
    logger.error('Errore GET /products/:id/valuation', { err: err.message });
    res.status(500).json({ error: 'Errore valutazione' });
  }
});

// ==========================================
// PATCH /products/publish-all — pubblica/ritira TUTTO il magazzino (OWNER del magazzino)
// Pubblicando, usa come prezzo pubblico: publicPrice ?? salePrice ?? marketPriceAvg.
// Gli articoli senza prezzo vengono saltati (restano privati).
// ==========================================
router.patch('/publish-all', requireFeature('marketplace'), async (req: AuthRequest, res: Response) => {
  try {
    const { warehouseId, isPublic } = req.body || {};
    if (!warehouseId) return res.status(400).json({ error: 'warehouseId richiesto' });
    const membership = await prisma.membership.findFirst({ where: { userId: req.user!.userId, warehouseId, role: 'OWNER' } });
    if (!membership) return res.status(403).json({ error: 'Solo il fondatore del magazzino può farlo.' });

    if (!isPublic) {
      const r = await prisma.product.updateMany({ where: { warehouseId, deletedAt: null }, data: { isPublic: false } });
      return res.json({ unpublished: r.count });
    }

    const items = await prisma.product.findMany({
      where: { warehouseId, status: 'IN STOCK', deletedAt: null },
      select: { id: true, publicPrice: true, salePrice: true, marketPriceAvg: true },
    });
    const withPrice = items.filter(p => (p.publicPrice ?? p.salePrice ?? p.marketPriceAvg) != null);
    await prisma.$transaction(withPrice.map(p =>
      prisma.product.update({ where: { id: p.id }, data: { isPublic: true, publicPrice: (p.publicPrice ?? p.salePrice ?? p.marketPriceAvg) as number } })
    ));
    res.json({ published: withPrice.length, skipped: items.length - withPrice.length });
  } catch (err: any) {
    logger.error('Errore PATCH /products/publish-all', { err: err.message });
    res.status(500).json({ error: 'Errore pubblicazione di massa' });
  }
});

// ==========================================
// PATCH /products/:id/toship — aggiungi/togli dalla lista "da spedire"
// (es. articolo venduto su un'altra piattaforma da spedire manualmente)
// ==========================================
router.patch('/:id/toship', async (req: AuthRequest, res: Response) => {
  try {
    const { allowed, product } = await canAccessProduct(req.user!.userId, req.params.id);
    if (!allowed || !product) return res.status(403).json({ error: 'Non hai accesso a questo prodotto.' });
    if (product.deletedAt) return res.status(404).json({ error: 'Prodotto non trovato.' });
    const toShip = req.body?.toShip === true;
    const updated = await prisma.product.update({ where: { id: product.id }, data: { toShip }, select: { id: true, toShip: true } });
    res.json(updated);
  } catch (err: any) {
    logger.error('Errore PATCH /products/:id/toship', { err: err.message });
    res.status(500).json({ error: 'Errore aggiornamento' });
  }
});

// ==========================================
// PATCH /products/:id/publish — pubblica/ritira l'articolo dal marketplace pubblico
// ==========================================
router.patch('/:id/publish', requireFeature('marketplace'), async (req: AuthRequest, res: Response) => {
  try {
    const { allowed, product } = await canAccessProduct(req.user!.userId, req.params.id);
    if (!allowed || !product) return res.status(403).json({ error: 'Non hai accesso a questo prodotto.' });
    if (product.deletedAt) return res.status(404).json({ error: 'Prodotto non trovato.' });

    const isPublic = req.body?.isPublic === true;
    const rawPrice = Number(req.body?.publicPrice);
    const publicPrice = !isNaN(rawPrice) && rawPrice > 0 ? Math.round(rawPrice * 100) / 100 : null;
    if (isPublic && publicPrice == null) return res.status(400).json({ error: 'Inserisci un prezzo pubblico valido.' });
    const rawShip = Number(req.body?.shippingCost);
    const shippingCost = !isNaN(rawShip) && rawShip > 0 ? Math.round(rawShip * 100) / 100 : null;

    const updated = await prisma.product.update({
      where: { id: product.id },
      data: { isPublic, publicPrice: isPublic ? publicPrice : null, shippingCost: isPublic ? shippingCost : null },
      select: { id: true, isPublic: true, publicPrice: true, shippingCost: true },
    });
    res.json(updated);
  } catch (err: any) {
    logger.error('Errore PATCH /products/:id/publish', { err: err.message });
    res.status(500).json({ error: 'Errore pubblicazione' });
  }
});

export default router;
