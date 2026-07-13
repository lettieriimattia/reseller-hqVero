// src/services/kicksdb.service.ts
// Fonte catalogo via KicksDB (kicks.dev): API ufficiale sui dati StockX (NON scraping).
// Copre sneaker, abbigliamento, borse, accessori, trading cards. Le immagini sono URL
// diretti del CDN StockX (stabili, hotlinkabili) → salviamo solo il link, zero hosting.
//
// Auth: header Authorization: Bearer <KICKSDB_API_KEY>. Base: https://api.kicks.dev/v3
// Free tier ~50k richieste/mese: con la cache locale (CatalogItem) basta e avanza.

import { prisma } from '../lib/prisma';
import { logger } from '../utils/logger';
import { isPlaceholderImage } from '../utils/imageConsistency';
import { fetchWithTimeout } from '../utils/fetchTimeout';

const KICKS_BASE = 'https://api.kicks.dev/v3';

export function isKicksConfigured(): boolean {
  return !!process.env.KICKSDB_API_KEY;
}

// Tetti di sicurezza quota. PIANO ATTUALE = 1000 richieste/MESE → il tetto che conta è quello
// MENSILE (950, un po' sotto i 1000 per lasciare margine). Questo è il collo di bottiglia UNICO
// da cui passano TUTTE le chiamate KicksDB (app interna + checker pubblico): garantisce che il
// totale mensile non superi mai il piano. Oltre il tetto si serve solo dalla cache locale (gratis).
const MONTHLY_CAP = Number(process.env.KICKSDB_MONTHLY_CAP || 950);
const DAILY_CAP = Number(process.env.KICKSDB_DAILY_CAP || 60); // evita che un singolo giorno bruci il mese

// Contatori PERSISTITI su Setting (stesso pattern di apify.service.ts): il piano free di Render
// va in standby dopo 15min di inattività e si riavvia ad ogni richiesta successiva, molto più
// spesso di un redeploy mensile — contatori in RAM si azzererebbero ad ogni risveglio, facendo
// sforare il tetto reale dei 1000/mese senza che il codice se ne accorga.
function monthKey(): string {
  const d = new Date();
  return `kicksdb_month_${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
function dayKey(): string {
  return `kicksdb_day_${new Date().toISOString().slice(0, 10)}`;
}
async function getCount(key: string): Promise<number> {
  try { const s = await prisma.setting.findUnique({ where: { key } }); return s ? parseInt(s.value, 10) || 0 : 0; }
  catch { return 0; }
}
async function bumpCount(key: string, current: number): Promise<void> {
  try { await prisma.setting.upsert({ where: { key }, update: { value: String(current + 1) }, create: { key, value: '1' } }); }
  catch (err: any) { logger.warn('KicksDB: bump contatore fallito', { key, err: err.message }); }
}
async function underQuota(): Promise<boolean> {
  const mKey = monthKey(), dKey = dayKey();
  const [monthCount, dayCount] = await Promise.all([getCount(mKey), getCount(dKey)]);
  if (monthCount >= MONTHLY_CAP) { logger.warn('KicksDB: tetto MENSILE raggiunto (piano 1000/mese), solo cache'); return false; }
  if (dayCount >= DAILY_CAP) { logger.warn('KicksDB: tetto giornaliero raggiunto, solo cache'); return false; }
  await Promise.all([bumpCount(mKey, monthCount), bumpCount(dKey, dayCount)]);
  return true;
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

// Estrae l'URL immagine da forme diverse della risposta KicksDB (image può essere una stringa,
// un oggetto {original/small/thumbnail}, oppure la foto sta in media/gallery/grid_picture_url).
function pickImage(p: any): string | null {
  const picked = pickImageRaw(p);
  // Scarta i segnaposto ("immagine non disponibile" = X grigia StockX / template GOAT): meglio
  // nessuna foto (→ placeholder logo HQ) che una foto finta.
  return isPlaceholderImage(picked) ? null : picked;
}
function pickImageRaw(p: any): string | null {
  if (!p) return null;
  const img = p.image;
  if (typeof img === 'string' && img) return img;
  if (img && typeof img === 'object') {
    const v = img.original || img.imageUrl || img.url || img.small || img.thumbnail || img.thumb;
    if (typeof v === 'string' && v) return v;
  }
  const m = p.media;
  if (m && typeof m === 'object') {
    const v = m.imageUrl || m.thumbUrl || m.smallImageUrl || m.gallery?.[0];
    if (typeof v === 'string' && v) return v;
  }
  const cands = [
    Array.isArray(p.gallery) ? p.gallery[0] : null,
    Array.isArray(p.images) ? p.images[0] : null,
    p.thumbnail, p.thumb, p.imageUrl, p.grid_picture_url, p.picture_url,
  ];
  for (const c of cands) if (typeof c === 'string' && c) return c;
  return null;
}

function mapProduct(p: any): CatalogCandidate {
  return {
    title: (p?.title || [p?.brand, p?.model].filter(Boolean).join(' ') || '').toString().trim(),
    brand: p?.brand ? String(p.brand) : null,
    styleId: p?.sku ? String(p.sku) : null,
    productId: (p?.id || p?.slug || null) ? String(p.id || p.slug) : null,
    image: pickImage(p),
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
  if (!(await underQuota())) return []; // tetto giornaliero/mensile superato → solo cache
  const q = (query || '').replace(/[–—•|]/g, ' ').replace(/\s+/g, ' ').trim();
  if (q.length < 2) return [];
  const limit = Math.min(Math.max(opts?.limit || 20, 1), 50);
  const url = `${KICKS_BASE}/stockx/products?query=${encodeURIComponent(q)}&limit=${limit}`;
  try {
    // Timeout aggressivo (4s): la chatbox cerca la foto qui durante "aggiungi_prodotto" — se
    // KicksDB è lento, meglio salvare il prodotto senza foto (la aggancia poi lo sweep) che
    // tenere l'utente in attesa a tempo indeterminato.
    const r = await fetchWithTimeout(url, {
      headers: { Authorization: `Bearer ${process.env.KICKSDB_API_KEY || ''}`, Accept: 'application/json' },
    }, 4000);
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
