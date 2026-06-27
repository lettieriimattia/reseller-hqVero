// src/services/kicksdb.service.ts
// Fonte catalogo via KicksDB (kicks.dev): API ufficiale sui dati StockX (NON scraping).
// Copre sneaker, abbigliamento, borse, accessori, trading cards. Le immagini sono URL
// diretti del CDN StockX (stabili, hotlinkabili) → salviamo solo il link, zero hosting.
//
// Auth: header Authorization: Bearer <KICKSDB_API_KEY>. Base: https://api.kicks.dev/v3
// Free tier ~50k richieste/mese: con la cache locale (CatalogItem) basta e avanza.

import { logger } from '../utils/logger';

const KICKS_BASE = 'https://api.kicks.dev/v3';

export function isKicksConfigured(): boolean {
  return !!process.env.KICKSDB_API_KEY;
}

// Shape comune di un candidato catalogo (allineato a StockXCandidate + brand).
export interface CatalogCandidate {
  title: string;
  brand: string | null;
  styleId: string | null;
  productId: string | null;
  image: string | null;
  productType: string | null;
}

function mapProduct(p: any): CatalogCandidate {
  return {
    title: (p?.title || [p?.brand, p?.model].filter(Boolean).join(' ') || '').toString().trim(),
    brand: p?.brand ? String(p.brand) : null,
    styleId: p?.sku ? String(p.sku) : null,
    productId: (p?.id || p?.slug || null) ? String(p.id || p.slug) : null,
    image: p?.image || (Array.isArray(p?.gallery) ? p.gallery[0] : null) || null,
    productType: (p?.product_type || (Array.isArray(p?.categories) ? p.categories[0] : null) || null),
  };
}

// Ricerca prodotti su KicksDB (dati StockX). productType filtra per tipo (sneakers,
// apparel, accessories, handbags, trading-cards, electronics...). Difensiva: torna [] su errore.
export async function kicksSearch(
  query: string,
  opts?: { limit?: number; productType?: string },
): Promise<CatalogCandidate[]> {
  if (!isKicksConfigured()) return [];
  const q = (query || '').replace(/[–—•|]/g, ' ').replace(/\s+/g, ' ').trim();
  if (q.length < 2) return [];
  const limit = Math.min(Math.max(opts?.limit || 20, 1), 50);
  const url = `${KICKS_BASE}/stockx/products?query=${encodeURIComponent(q)}&limit=${limit}`;
  try {
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${process.env.KICKSDB_API_KEY || ''}`, Accept: 'application/json' },
    });
    if (!r.ok) { logger.warn('KicksDB search non ok', { status: r.status }); return []; }
    const d = await r.json() as any;
    const items: any[] = Array.isArray(d?.data) ? d.data : (Array.isArray(d?.products) ? d.products : []);
    // NB: niente filtro per product_type — i valori KicksDB sono incoerenti e svuotavano
    // le categorie. La categoria la decide la SCHEDA in cui cerchiamo (vedi upsert forceCategory).
    return items.map(mapProduct).filter(c => c.title).slice(0, limit);
  } catch (e: any) {
    logger.warn('KicksDB search errore', { err: e.message });
    return [];
  }
}
