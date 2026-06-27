// src/services/pokemon.service.ts
// Catalogo CARTE Pokémon via pokemontcg.io (API gratuita, immagini incluse).
// Le carte SINGOLE raw non sono su StockX/KicksDB → fonte dedicata. Le immagini
// (images.pokemontcg.io) sono URL pubblici hotlinkabili: salviamo solo il link.
//
// Chiave opzionale POKEMONTCG_API_KEY (header X-Api-Key) per limiti più alti;
// senza chiave funziona comunque (limite più basso, ok per la cache locale).

import { logger } from '../utils/logger';
import type { CatalogCandidate } from './kicksdb.service';

const PTCG_BASE = 'https://api.pokemontcg.io/v2';

export function isPokemonConfigured(): boolean {
  return true; // l'API base è gratuita e non richiede chiave
}

// Cerca carte per nome. Ritorna candidati catalogo (productType = 'carte').
export async function pokemonSearch(query: string, limit = 12): Promise<CatalogCandidate[]> {
  const raw = (query || '').trim();
  if (raw.length < 2) return [];
  // Ogni parola come prefisso wildcard (AND): "dark charizard" → name:dark* name:charizard*
  const terms = raw.split(/\s+/).filter(Boolean)
    .map(w => `name:${w.replace(/["':]/g, '')}*`).join(' ');
  const url = `${PTCG_BASE}/cards?q=${encodeURIComponent(terms)}&pageSize=${Math.min(Math.max(limit, 1), 50)}&orderBy=-set.releaseDate`;
  try {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (process.env.POKEMONTCG_API_KEY) headers['X-Api-Key'] = process.env.POKEMONTCG_API_KEY;
    const r = await fetch(url, { headers });
    if (!r.ok) { logger.warn('pokemontcg non ok', { status: r.status }); return []; }
    const d = await r.json() as any;
    const cards: any[] = Array.isArray(d?.data) ? d.data : [];
    return cards.map((c: any) => {
      const setName = c?.set?.name ? String(c.set.name) : '';
      const num = c?.number ? `#${c.number}` : '';
      const title = [c?.name, setName, num].filter(Boolean).join(' · ');
      return {
        title: title || String(c?.name || 'Carta'),
        brand: c?.set?.series ? String(c.set.series) : 'Pokémon',
        styleId: c?.id ? String(c.id) : (c?.number ? String(c.number) : null),
        productId: c?.id ? String(c.id) : null,
        image: c?.images?.small || c?.images?.large || null,
        productType: 'carte',
      } as CatalogCandidate;
    }).filter(c => c.title);
  } catch (e: any) {
    logger.warn('pokemontcg errore', { err: e.message });
    return [];
  }
}
