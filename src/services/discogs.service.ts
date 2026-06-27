// src/services/discogs.service.ts
// Valutazione vinili/dischi da Discogs (gratis). Prezzo più basso disponibile sul
// marketplace, in EURO. Richiede un token personale gratuito: DISCOGS_TOKEN
//   https://www.discogs.com/settings/developers  → "Generate new token"

import { logger } from '../utils/logger';

const TOKEN = (process.env.DISCOGS_TOKEN || '').trim();
const UA = 'HQVault/1.0';

export interface VinylValuation {
  value: number | null;   // prezzo più basso sul marketplace (EUR)
  currency: string;
  source: string;
  itemName?: string;      // "Artista – Titolo"
  sample: number;         // num. copie in vendita
  image?: string;
}

export function isDiscogsConfigured(): boolean { return !!TOKEN; }

export async function getVinylValue(opts: { query: string }): Promise<VinylValuation | null> {
  if (!TOKEN || !opts.query || opts.query.trim().length < 2) return null;
  try {
    // 1) Cerca la release più pertinente
    const sr = await fetch(
      `https://api.discogs.com/database/search?q=${encodeURIComponent(opts.query)}&type=release&per_page=5&token=${TOKEN}`,
      { headers: { 'User-Agent': UA } }
    );
    if (!sr.ok) { logger.error('Discogs search error', { status: sr.status }); return null; }
    const sd = await sr.json() as any;
    const rel = sd?.results?.[0];
    if (!rel?.id) return { value: null, currency: 'EUR', source: 'Discogs', sample: 0 };

    // 2) Statistiche di mercato (prezzo più basso disponibile, in EUR)
    const stRes = await fetch(
      `https://api.discogs.com/marketplace/stats/${rel.id}?curr_abbr=EUR&token=${TOKEN}`,
      { headers: { 'User-Agent': UA } }
    );
    const st = stRes.ok ? await stRes.json() as any : {};
    const value = st?.lowest_price?.value ?? null;

    return {
      value: value != null ? Math.round(value * 100) / 100 : null,
      currency: 'EUR',
      source: 'Discogs (marketplace)',
      itemName: rel.title,
      sample: st?.num_for_sale ?? 0,
      image: rel.cover_image || rel.thumb,
    };
  } catch (err: any) {
    logger.error('Errore getVinylValue', { err: err.message });
    return null;
  }
}
