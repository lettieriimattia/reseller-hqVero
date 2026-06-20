// src/config/plans.ts
// Catalogo piani e diritti (entitlements). Unica fonte di verità per il gating.
// I prezzi sono mensili in €. Le feature sono chiavi usate da requireFeature().

export type PlanId = 'free' | 'starter' | 'pro' | 'business';

export type Feature =
  | 'repricing'           // riprezzamento stock fermo
  | 'offer_assistant'     // assistente trattative/offerte
  | 'crossposting'        // pubblicazione multi-canale + ritiro automatico
  | 'listing_ai'          // generatore annunci IA
  | 'shipping'            // spedizioni
  | 'labels'              // etichette/QR magazzino
  | 'advanced_analytics'  // analytics avanzate
  | 'partners'            // magazzini con soci + divisione costi/utili
  | 'marketplace'         // vetrina pubblica + chat acquirenti
  | 'stockx_pricing'      // prezzi reali StockX
  | 'accounting';         // costi extra + export CSV commercialista

export interface Plan {
  id: PlanId;
  name: string;
  priceMonthly: number;
  tagline: string;
  highlights: string[];          // bullet mostrati nella pagina prezzi
  features: Feature[];           // diritti inclusi
  maxProducts: number | null;    // null = illimitato
  maxTeamMembers: number | null; // null = illimitato
}

// I diritti sono cumulativi nei testi, ma qui ogni piano elenca TUTTE le sue feature.
export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: 'free',
    name: 'Free',
    priceMonthly: 0,
    tagline: 'Inizia a gestire il tuo magazzino',
    highlights: [
      'Magazzino e vendite',
      'Riconoscimento prodotto da foto (IA)',
      'Categorie create al volo dall\'IA',
      'Valutazione di mercato base',
      'Fino a 30 prodotti · solo tu',
    ],
    features: [],
    maxProducts: 30,
    maxTeamMembers: 1,
  },
  starter: {
    id: 'starter',
    name: 'Starter',
    priceMonthly: 9.99,
    tagline: 'Per chi vende ogni giorno',
    highlights: [
      'Tutto del Free',
      'Generatore annunci IA + assistente trattative',
      'Riprezzamento stock fermo',
      'Lettura SKU/barcode dalla foto della scatola',
      '1 socio: magazzino condiviso con divisione costi/utili',
      'Fino a 200 prodotti · 2 persone',
    ],
    features: ['listing_ai', 'offer_assistant', 'repricing', 'partners'],
    maxProducts: 200,
    maxTeamMembers: 2,
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    priceMonthly: 19.99,
    tagline: 'Per chi vende su più canali e in team',
    highlights: [
      'Tutto dello Starter',
      'Marketplace pubblico: vendi i tuoi articoli in vetrina + chat',
      'Prezzi reali StockX (valutazione sneaker)',
      'Multi-canale + ritiro automatico · Spedizioni',
      'Analytics avanzate · Costi extra + CSV per il commercialista',
      'Fino a 2000 prodotti · 5 soci',
    ],
    features: ['listing_ai', 'offer_assistant', 'repricing', 'partners', 'crossposting', 'shipping', 'advanced_analytics', 'marketplace', 'stockx_pricing', 'accounting'],
    maxProducts: 2000,
    maxTeamMembers: 5,
  },
  business: {
    id: 'business',
    name: 'Business',
    priceMonthly: 39.99,
    tagline: 'Per negozi e team strutturati',
    highlights: [
      'Tutto del Pro',
      'Etichette/QR magazzino',
      'Prodotti, soci e magazzini illimitati',
      'Priorità supporto',
    ],
    features: ['listing_ai', 'offer_assistant', 'repricing', 'partners', 'crossposting', 'shipping', 'advanced_analytics', 'marketplace', 'stockx_pricing', 'accounting', 'labels'],
    maxProducts: null,
    maxTeamMembers: null,
  },
};

export const PLAN_ORDER: PlanId[] = ['free', 'starter', 'pro', 'business'];

export function isPlanId(x: any): x is PlanId {
  return typeof x === 'string' && (PLAN_ORDER as string[]).includes(x);
}

export function getPlan(planId: string | null | undefined): Plan {
  return PLANS[(planId && isPlanId(planId) ? planId : 'free')];
}

export function hasFeature(planId: string | null | undefined, feature: Feature): boolean {
  return getPlan(planId).features.includes(feature);
}

// Piano minimo che include una certa feature (per messaggi di upsell).
export function minPlanFor(feature: Feature): Plan | null {
  for (const id of PLAN_ORDER) {
    if (PLANS[id].features.includes(feature)) return PLANS[id];
  }
  return null;
}
