// src/services/valuation.service.ts
// Dispatcher unico della valutazione: instrada al servizio giusto per categoria.
//  - Carte (Pokémon/Magic/Yu-Gi-Oh) → catalogo dedicato, prezzo REALE in EUR (reliable)
//  - Vinili/dischi → Discogs, prezzo marketplace EUR (reliable)
//  - Tutto il resto (sneaker, vestiti, borse, orologi, LEGO, ecc.) → eBay annunci
//    attivi: stima INDICATIVA (reliable=false), finché non c'è una fonte dedicata.

import { getCardValue } from './cards.service';
import { getVinylValue } from './discogs.service';
import { getMarketValuation } from './price.service';

export interface UnifiedValuation {
  value: number | null;
  currency: string;
  source: string;
  reliable: boolean;   // true = fonte affidabile (catalogo/Discogs); false = eBay indicativo
  sample: number;
  low?: number | null;
  itemName?: string;
  extra?: string;      // set / titolo
}

const CARD_KEYS = ['pokemon', 'pokémon', 'carte', 'card', 'tcg', 'magic', 'mtg', 'yugioh', 'yu-gi-oh', 'ygo'];
const VINYL_KEYS = ['vinil', 'disco', 'dischi', 'vinyl', 'record', 'lp', '33 giri', '45 giri'];

function matches(cat: string, keys: string[]): boolean {
  const c = (cat || '').toLowerCase();
  return keys.some(k => c.includes(k));
}

export async function getValuation(opts: {
  category?: string; game?: string; brand?: string; name?: string;
  size?: string; number?: string; setName?: string; condition?: string;
}): Promise<UnifiedValuation> {
  const cat = (opts.category || '').toLowerCase();

  // 1) CARTE → catalogo dedicato (affidabile)
  if (opts.game || matches(cat, CARD_KEYS)) {
    const v = await getCardValue({ game: opts.game, name: opts.name, number: opts.number, setName: opts.setName });
    if (v.value != null) {
      return { value: v.value, currency: v.currency, source: v.source, reliable: true, sample: v.sample, low: v.low, itemName: v.cardName, extra: v.setName };
    }
    // niente match nel catalogo → non inventiamo: nessun valore (meglio di uno falso)
    return { value: null, currency: 'EUR', source: v.source, reliable: true, sample: 0 };
  }

  // 2) VINILI → Discogs (affidabile)
  if (matches(cat, VINYL_KEYS)) {
    const q = [opts.brand, opts.name].filter(Boolean).join(' ').trim();
    const v = await getVinylValue({ query: q });
    if (v && v.value != null) {
      return { value: v.value, currency: v.currency, source: v.source, reliable: true, sample: v.sample, itemName: v.itemName };
    }
    // se Discogs non trova/non configurato → cade su eBay indicativo qui sotto
  }

  // 3) RESTO → eBay annunci attivi: stima INDICATIVA
  const q = [opts.brand, opts.name].filter(Boolean).join(' ').trim();
  if (q.length < 2) return { value: null, currency: 'EUR', source: 'dati insufficienti', reliable: false, sample: 0 };
  const eb = await getMarketValuation({ query: q, size: opts.size, condition: opts.condition });
  if (!eb.configured) return { value: null, currency: 'EUR', source: 'non configurato', reliable: false, sample: 0 };
  return {
    value: eb.value,
    currency: 'EUR',
    source: eb.value != null ? 'eBay · annunci attivi (indicativo)' : 'nessun dato eBay',
    reliable: false,
    sample: eb.sample,
  };
}
