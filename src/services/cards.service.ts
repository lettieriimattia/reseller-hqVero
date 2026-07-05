// src/services/cards.service.ts
// Valutazione carte Pokémon da Pokémon TCG API (pokemontcg.io).
// Prezzi in EURO da Cardmarket (mercato europeo) → adatti all'Italia.
// API gratuita. Chiave opzionale (POKEMONTCG_API_KEY) per limiti più alti:
//   https://dev.pokemontcg.io  → si registra e si ottiene la key in 1 minuto.

import { logger } from '../utils/logger';

const API_BASE = 'https://api.pokemontcg.io/v2/cards';
const API_KEY = (process.env.POKEMONTCG_API_KEY || '').trim();

export interface CardValuation {
  configured: boolean;
  value: number | null;     // prezzo di mercato (EUR)
  low: number | null;       // prezzo basso (EUR)
  currency: string;         // 'EUR'
  source: string;           // es. "Cardmarket (Pokémon)"
  cardName?: string;        // nome carta abbinata
  setName?: string;         // set
  image?: string;           // immagine carta
  sample: number;           // n. risultati considerati
}

const empty = (): CardValuation => ({
  configured: true, value: null, low: null, currency: 'EUR', source: 'Pokémon TCG', sample: 0,
});

// Parole "collab/serie" che NON sono nel NOME della carta ma nel SET/promo (es. la Pikachu
// "Van Gogh" è promo SVP, non si chiama così): le togliamo dalla query name: e le usiamo dopo
// per lo scoring sul set, così non svuotano la ricerca.
const SET_HINT_WORDS = ['van', 'gogh', 'museum', 'promo', 'special', 'delivery', 'collab', 'collaboration'];

// Costruisce la query Lucene di pokemontcg.io. Il NOME va cercato per PAROLE in wildcard
// (name:pikachu*) invece che come stringa esatta: "Pikachu Van Gogh" come stringa esatta non
// esiste e svuoterebbe la ricerca. Il numero, se c'è, resta il vincolo più forte.
// pokemontcg.io salva il numero SENZA il totale del set: "271/264" sulla carta → number "271".
// Prendiamo la parte prima dello slash (e togliamo eventuali zeri iniziali non servono, ma li
// lasciamo com'è: il campo è testuale, es. "SV-P", "271", "H12").
function numberCore(raw?: string): string {
  return (raw || '').replace(/["\\:]/g, ' ').split('/')[0].trim();
}
function buildQuery(opts: { name?: string; number?: string; setName?: string }): string {
  const parts: string[] = [];
  const clean = (s: string) => s.replace(/["\\:]/g, ' ').trim();
  const num = numberCore(opts.number);
  if (num) {
    // Col NUMERO abbiamo il vincolo più specifico: NON aggiungiamo i filtri name:* — spesso
    // l'utente mette nel "nome" anche il set (es. "Gengar VMAX Fusion Strike") e quelle parole,
    // ANDate come name:, svuoterebbero la ricerca (la carta si chiama solo "Gengar VMAX"). Il
    // nome/set lo usiamo DOPO per lo scoring tra i risultati con quel numero.
    parts.push(`number:"${num}"`);
  } else if (opts.name) {
    const words = clean(opts.name).split(/\s+/).filter(w => w.length >= 2 && !SET_HINT_WORDS.includes(w.toLowerCase()));
    for (const w of words) parts.push(`name:${w}*`);
  }
  if (opts.setName) parts.push(`set.name:"${clean(opts.setName)}"`);
  return parts.join(' ');
}

// Valuta una carta Pokémon. Restituisce il prezzo Cardmarket (EUR) della miglior corrispondenza.
export async function getPokemonCardValue(opts: { name?: string; number?: string; setName?: string }): Promise<CardValuation> {
  const q = buildQuery(opts);
  if (!q) return empty();

  try {
    const url = `${API_BASE}?q=${encodeURIComponent(q)}&pageSize=30&orderBy=-set.releaseDate`;
    const r = await fetch(url, { headers: API_KEY ? { 'X-Api-Key': API_KEY } : {} });
    if (!r.ok) {
      logger.error('pokemontcg.io error', { status: r.status, q });
      return empty();
    }
    const data = await r.json() as any;
    const cards: any[] = data?.data || [];
    if (cards.length === 0) return empty();

    // Preferisci le carte che hanno prezzi Cardmarket (EUR).
    const withPrice = cards.filter(c => c?.cardmarket?.prices);
    const pool = withPrice.length > 0 ? withPrice : cards;

    // SCELTA DEL MATCH: punteggio per parole del nome originale (INCLUSE quelle di set/collab
    // come "van gogh") presenti in nome+set della carta → prende la variante giusta, non una
    // Pikachu a caso. Il numero esatto, se c'è, vince su tutto.
    const qWords = (opts.name || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length >= 2);
    const scoreOf = (c: any) => {
      const hay = `${c?.name || ''} ${c?.set?.name || ''} ${c?.set?.series || ''}`.toLowerCase();
      return qWords.reduce((s, w) => s + (hay.includes(w) ? 1 : 0), 0);
    };
    const num = numberCore(opts.number);
    let best = pool[0];
    if (num) {
      // Tra i risultati con quel numero, scegli quello che COMBACIA MEGLIO col nome+set scritto
      // dall'utente (es. numero 271 esiste in più set → prende quello di "Fusion Strike"/"Gengar").
      const numMatches = pool.filter(c => (c.number || '').toString() === num);
      const pickFrom = numMatches.length > 0 ? numMatches : pool;
      best = [...pickFrom].sort((a, b) => {
        const d = scoreOf(b) - scoreOf(a);
        if (d !== 0) return d;
        return (b?.cardmarket?.prices ? 1 : 0) - (a?.cardmarket?.prices ? 1 : 0);
      })[0] || best;
    }
    if (!num && qWords.length > 0) {
      // ordina per: punteggio parole desc, poi prezzo presente, poi set più recente (già ordinato)
      const ranked = [...pool].sort((a, b) => {
        const d = scoreOf(b) - scoreOf(a);
        if (d !== 0) return d;
        return (b?.cardmarket?.prices ? 1 : 0) - (a?.cardmarket?.prices ? 1 : 0);
      });
      if (ranked[0] && scoreOf(ranked[0]) > 0) best = ranked[0];
    }

    const cm = best?.cardmarket?.prices || {};
    // trendPrice = prezzo di tendenza Cardmarket; fallback su averageSellPrice / avg30.
    const value = cm.trendPrice ?? cm.averageSellPrice ?? cm.avg30 ?? cm.avg7 ?? null;
    const low = cm.lowPrice ?? cm.lowPriceExPlus ?? null;

    return {
      configured: true,
      value: value != null ? Math.round(value * 100) / 100 : null,
      low: low != null ? Math.round(low * 100) / 100 : null,
      currency: 'EUR',
      source: 'Cardmarket (Pokémon)',
      cardName: best?.name,
      setName: best?.set?.name,
      image: best?.images?.small,
      sample: pool.length,
    };
  } catch (err: any) {
    logger.error('Errore getPokemonCardValue', { err: err.message });
    return empty();
  }
}

// ==========================================
// MAGIC: The Gathering — Scryfall (gratis, nessuna chiave). Prezzi EUR (Cardmarket).
// ==========================================
export async function getMagicCardValue(opts: { name?: string; number?: string; setName?: string }): Promise<CardValuation> {
  if (!opts.name) return { ...empty(), source: 'Scryfall (Magic)' };
  try {
    const r = await fetch(`https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(opts.name)}`, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'HQVault/1.0' },
    });
    if (!r.ok) { logger.error('Scryfall error', { status: r.status, name: opts.name }); return { ...empty(), source: 'Scryfall (Magic)' }; }
    const c = await r.json() as any;
    const eur = c?.prices?.eur ? parseFloat(c.prices.eur) : null;
    return {
      configured: true,
      value: eur != null ? Math.round(eur * 100) / 100 : null,
      low: null,
      currency: 'EUR',
      source: 'Cardmarket (Magic)',
      cardName: c?.name,
      setName: c?.set_name,
      image: c?.image_uris?.small,
      sample: 1,
    };
  } catch (err: any) {
    logger.error('Errore getMagicCardValue', { err: err.message });
    return { ...empty(), source: 'Scryfall (Magic)' };
  }
}

// ==========================================
// YU-GI-OH! — YGOPRODeck (gratis, nessuna chiave). Prezzo Cardmarket (EUR).
// ==========================================
export async function getYugiohCardValue(opts: { name?: string }): Promise<CardValuation> {
  if (!opts.name) return { ...empty(), source: 'YGOPRODeck (Yu-Gi-Oh)' };
  try {
    const r = await fetch(`https://db.ygoprodeck.com/api/v7/cardinfo.php?fname=${encodeURIComponent(opts.name)}`);
    if (!r.ok) { logger.error('YGOPRODeck error', { status: r.status, name: opts.name }); return { ...empty(), source: 'YGOPRODeck (Yu-Gi-Oh)' }; }
    const data = await r.json() as any;
    const card = data?.data?.[0];
    const cm = card?.card_prices?.[0]?.cardmarket_price ? parseFloat(card.card_prices[0].cardmarket_price) : null;
    return {
      configured: true,
      value: cm != null && cm > 0 ? Math.round(cm * 100) / 100 : null,
      low: null,
      currency: 'EUR',
      source: 'Cardmarket (Yu-Gi-Oh)',
      cardName: card?.name,
      setName: card?.card_sets?.[0]?.set_name,
      image: card?.card_images?.[0]?.image_url_small,
      sample: 1,
    };
  } catch (err: any) {
    logger.error('Errore getYugiohCardValue', { err: err.message });
    return { ...empty(), source: 'YGOPRODeck (Yu-Gi-Oh)' };
  }
}

// ==========================================
// DISPATCHER: instrada al servizio giusto in base al gioco.
// ==========================================
export async function getCardValue(opts: { game?: string; name?: string; number?: string; setName?: string }): Promise<CardValuation> {
  const g = (opts.game || 'pokemon').toLowerCase();
  if (g.includes('magic') || g.includes('mtg')) return getMagicCardValue(opts);
  if (g.includes('yugi') || g.includes('yu-gi') || g.includes('ygo')) return getYugiohCardValue(opts);
  return getPokemonCardValue(opts);
}
