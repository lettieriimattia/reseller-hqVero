// src/services/valuation.service.ts
// Dispatcher unico della valutazione: instrada al servizio giusto per categoria.
//  - Carte (Pokémon/Magic/Yu-Gi-Oh) → catalogo dedicato, prezzo REALE in EUR (reliable)
//  - Vinili/dischi → Discogs, prezzo marketplace EUR (reliable)
//  - Tutto il resto (sneaker, vestiti, borse, orologi, LEGO, ecc.) → eBay annunci
//    attivi: stima INDICATIVA (reliable=false), finché non c'è una fonte dedicata.

import { getCardValue } from './cards.service';
import { getVinylValue } from './discogs.service';
import { getBagValue, getWatchValue, getLegoValue, isVestiaireConfigured, isChrono24Configured, isLegoConfigured } from './apify.service';
import { getStockXValuation, isStockXConfigured } from './stockx.service';
import { getGradedCardValue } from './tcggraded.service';
import { getBrickLinkValue, isBrickLinkConfigured } from './bricklink.service';
import { getBrickEconomyValue, isBrickEconomyConfigured } from './brickeconomy.service';

export interface UnifiedValuation {
  value: number | null;
  currency: string;
  source: string;
  reliable: boolean;   // true = fonte affidabile (catalogo/Discogs); false = eBay indicativo
  sample: number;
  low?: number | null;
  itemName?: string;
  extra?: string;      // set / titolo
  image?: string | null;  // foto ufficiale del prodotto (StockX/Cardmarket/Apify) per la card visiva
}

const CARD_KEYS = ['pokemon', 'pokémon', 'carte', 'card', 'tcg', 'magic', 'mtg', 'yugioh', 'yu-gi-oh', 'ygo'];
const LEGO_KEYS = ['lego', 'brickset', 'bricklink', 'mattoncini', 'minifig'];
const VINYL_KEYS = ['vinil', 'disco', 'dischi', 'vinyl', 'record', 'lp', '33 giri', '45 giri'];
const BAG_KEYS = ['bors', 'bag', 'pochette', 'zaino', 'tracoll', 'clutch', 'handbag', 'shopper'];
const WATCH_KEYS = ['orolog', 'watch', 'chrono'];
const SHOE_KEYS = ['scarp', 'sneaker', 'calzatur', 'shoe', 'ginnastica'];
// Abbigliamento/streetwear: le uniche categorie (oltre alle scarpe) a cui si applica la % per
// condizione. Orologi/borse/elettronica/carte NON scalano di prezzo con quelle percentuali.
const APPAREL_KEYS = ['abbigli', 'street', 'vestit', 'felpa', 'hoodie', 'shirt', 'maglia', 'maglion',
  'giacc', 'jacket', 'pantalon', 'tee', 't-shirt', 'cappell', 'beanie', 'short', 'jeans', 'tuta',
  'crewneck', 'cardigan', 'polo', 'camic', 'gilet', 'coat', 'cappotto', 'piumino'];

function matches(cat: string, keys: string[]): boolean {
  const c = (cat || '').toLowerCase();
  return keys.some(k => c.includes(k));
}

// Valore in base alla CONDIZIONE: percentuale del prezzo base (nuovo/DS = 100%). Numeri di
// partenza — regolabili qui in un punto solo (li conferma il socio). Il match è per "contiene".
// Percentuali REALI (fornite dal socio) per SCARPE e VESTITI: 100 / 77 / 62 / 45 / 30.
const CONDITION_PCT: Array<[string, number]> = [
  ['deadstock', 1], ['ds', 1], ['nuovo', 1], ['new', 1], ['sigillat', 1],
  ['come nuovo', 0.77], ['vnds', 0.77], ['quasi nuovo', 0.77],
  ['usato ottimo', 0.62], ['ottim', 0.62],
  ['usato buono', 0.45], ['buono', 0.45], ['buone', 0.45],
  ['usato discreto', 0.30], ['discret', 0.30], ['segni', 0.30],
];
function conditionMultiplier(condition?: string): { pct: number; label: string } {
  const c = (condition || '').toLowerCase().trim();
  if (!c) return { pct: 1, label: '' };
  for (const [k, pct] of CONDITION_PCT) if (c.includes(k)) return { pct, label: k };
  return { pct: 1, label: '' };
}

// Legge la gradazione dal campo "condition" (es. "Gradata 10", "Gradata 9.5", "Raw (Non Gradata)").
function parseGrade(condition?: string): { graded: boolean; grade: number | null } {
  const c = (condition || '').toLowerCase();
  if (!/grad/.test(c) || /\braw\b|non\s*grad/.test(c)) return { graded: false, grade: null };
  const m = c.match(/(\d+(?:[.,]\d)?)/);
  return { graded: true, grade: m ? parseFloat(m[1].replace(',', '.')) : null };
}

export async function getValuation(opts: {
  category?: string; game?: string; brand?: string; name?: string;
  size?: string; number?: string; setName?: string; condition?: string; sku?: string;
}): Promise<UnifiedValuation> {
  const cat = (opts.category || '').toLowerCase();

  // 1) CARTE → catalogo dedicato. Cardmarket dà il prezzo RAW (non gradata): se la carta è
  // GRADATA applichiamo un moltiplicatore per grado (STIMA) — una PSA/BGS alta vale molto più
  // del raw. Lo dichiariamo nella fonte così è trasparente.
  if (opts.game || matches(cat, CARD_KEYS)) {
    const v = await getCardValue({ game: opts.game, name: opts.name, number: opts.number, setName: opts.setName });
    if (v.value != null) {
      const g = parseGrade(opts.condition);
      if (g.graded) {
        // Gradata → prezzo REALE da TCG Price Lookup (PSA/BGS/CGC). Finite le richieste del giorno
        // (blocked) o nessun valore → fallback al prezzo RAW dichiarando "NON gradata".
        const gr = await getGradedCardValue({ name: opts.name, number: opts.number, game: opts.game, grade: g.grade });
        if (gr.value != null) {
          return { value: gr.value, currency: gr.currency, source: gr.source, reliable: true, sample: v.sample, low: v.value, itemName: v.cardName, extra: v.setName, image: v.image };
        }
        const note = gr.blocked ? ' · limite gradati/giorno raggiunto → prezzo NON gradata' : ' · prezzo NON gradata';
        return { value: v.value, currency: v.currency, source: v.source + note, reliable: false, sample: v.sample, low: v.low, itemName: v.cardName, extra: v.setName, image: v.image };
      }
      return { value: v.value, currency: v.currency, source: v.source, reliable: true, sample: v.sample, low: v.low, itemName: v.cardName, extra: v.setName, image: v.image };
    }
    // niente match nel catalogo → non inventiamo: nessun valore (meglio di uno falso)
    return { value: null, currency: 'EUR', source: v.source, reliable: true, sample: 0 };
  }

  // 1b) BORSE → Apify/Vestiaire. È la fonte di verità: se l'actor GIRA (v != null)
  // restituiamo il suo esito — trovato (prezzo+modello = conferma) o non trovato
  // (value null → "controlla modello"). Solo se è stato saltato per il tetto (v null)
  // cadiamo su eBay sotto.
  if (matches(cat, BAG_KEYS) && isVestiaireConfigured()) {
    const q = [opts.brand, opts.name].filter(Boolean).join(' ').trim();
    const v = await getBagValue({ query: q });
    if (v) return { value: v.value, currency: v.currency, source: v.source, reliable: true, sample: v.sample, itemName: v.itemName, image: v.image };
  }

  // 1c) OROLOGI → Apify/Chrono24 (stessa logica, tetto condiviso).
  if (matches(cat, WATCH_KEYS) && isChrono24Configured()) {
    const q = [opts.brand, opts.name].filter(Boolean).join(' ').trim();
    const v = await getWatchValue({ query: q });
    if (v) return { value: v.value, currency: v.currency, source: v.source, reliable: true, sample: v.sample, itemName: v.itemName, image: v.image };
  }

  // 1c-bis) LEGO → in ordine di preferenza:
  //   1) BrickEconomy (valore di mercato, chiave semplice, NIENTE vincolo venditore)
  //   2) BrickLink API ufficiale (prezzi reali, ma richiede account venditore)
  //   3) Apify scraper (spesso bloccato da BrickLink con "Human Verification")
  if (matches(cat, LEGO_KEYS)) {
    const q = [opts.name, opts.brand].filter(Boolean).join(' ').trim();
    if (isBrickEconomyConfigured()) {
      const v = await getBrickEconomyValue({ query: q, condition: opts.condition });
      if (v && v.value != null) return { value: v.value, currency: v.currency, source: v.source, reliable: true, sample: v.sample, itemName: v.itemName, low: v.low };
    }
    if (isBrickLinkConfigured()) {
      const v = await getBrickLinkValue({ query: q, condition: opts.condition });
      if (v && v.value != null) return { value: v.value, currency: v.currency, source: v.source, reliable: true, sample: v.sample, itemName: v.itemName, low: v.low };
    }
    if (isLegoConfigured()) {
      const v = await getLegoValue({ query: q, condition: opts.condition });
      if (v && v.value != null) return { value: v.value, currency: v.currency, source: v.source, reliable: true, sample: v.sample, itemName: v.itemName };
    }
  }

  // 1d) SNEAKER → StockX (fonte di prezzo affidabile, in EUR). Se configurato e
  // restituisce un valore lo usiamo; altrimenti si cade su eBay indicativo sotto.
  if (matches(cat, SHOE_KEYS) && isStockXConfigured()) {
    const q = [opts.brand, opts.name].filter(Boolean).join(' ').trim();
    if (q.length >= 2) {
      const v = await getStockXValuation({ query: q, name: opts.name, size: opts.size, category: opts.category || 'scarpe', sku: opts.sku });
      if (v.value != null) {
        // StockX dà il prezzo del NUOVO/DS. Se la scarpa è usata, applichiamo la % per condizione
        // (mostrata in trasparenza nella fonte). ⚠️ Percentuali PROVVISORIE — da confermare col socio.
        const cm = conditionMultiplier(opts.condition);
        const adjusted = Math.round((v.value as number) * cm.pct);
        const src = cm.pct !== 1 ? `Valutazione di mercato · ${Math.round(cm.pct * 100)}% (${cm.label})` : 'Valutazione di mercato';
        return { value: adjusted, currency: 'EUR', source: src, reliable: true, sample: v.sample || 1, itemName: v.itemName, low: cm.pct !== 1 ? v.value : undefined, image: v.image };
      }
    }
  }

  // 2) VINILI → Discogs (affidabile)
  if (matches(cat, VINYL_KEYS)) {
    const q = [opts.brand, opts.name].filter(Boolean).join(' ').trim();
    const v = await getVinylValue({ query: q });
    if (v && v.value != null) {
      return { value: v.value, currency: v.currency, source: v.source, reliable: true, sample: v.sample, itemName: v.itemName, image: v.image };
    }
    // se Discogs non trova/non configurato → cade su eBay indicativo qui sotto
  }

  // 3) FALLBACK GENERICO → StockX non copre solo le sneaker: anche elettronica
  // (iPhone, console), streetwear, accessori e collezionabili. Per qualsiasi categoria
  // senza fonte dedicata (o se quella dedicata non ha trovato) proviamo comunque StockX.
  if (isStockXConfigured()) {
    const q = [opts.brand, opts.name].filter(Boolean).join(' ').trim();
    if (q.length >= 2) {
      const v = await getStockXValuation({ query: q, name: opts.name, size: opts.size, category: opts.category, sku: opts.sku });
      if (v.value != null) {
        // La % per condizione si applica SOLO ad abbigliamento/streetwear (le scarpe hanno il ramo
        // dedicato sopra). Elettronica, accessori e altro passano di qui SENZA scalare il prezzo:
        // quelle percentuali (100/77/62/45/30) valgono solo per scarpe e vestiti.
        const cm = matches(cat, APPAREL_KEYS) ? conditionMultiplier(opts.condition) : { pct: 1, label: '' };
        const adjusted = Math.round((v.value as number) * cm.pct);
        const src = cm.pct !== 1 ? `Valutazione di mercato · ${Math.round(cm.pct * 100)}% (${cm.label})` : 'Valutazione di mercato';
        return { value: adjusted, currency: 'EUR', source: src, reliable: true, sample: v.sample || 1, itemName: v.itemName, low: cm.pct !== 1 ? v.value : undefined, image: v.image };
      }
    }
  }

  // 4) Nessuna fonte ha trovato un prezzo affidabile (eBay rimosso: prezzi inaffidabili).
  return { value: null, currency: 'EUR', source: 'Valutazione non disponibile', reliable: false, sample: 0 };
}
