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
  | 'advanced_analytics'; // analytics avanzate

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
    tagline: 'Per iniziare a gestire il magazzino',
    highlights: [
      'Magazzino e vendite',
      'Riconoscimento foto IA',
      'Valutazione di mercato',
      'Fino a 25 prodotti',
    ],
    features: [],
    maxProducts: 25,
    maxTeamMembers: 1,
  },
  starter: {
    id: 'starter',
    name: 'Starter',
    priceMonthly: 9.99,
    tagline: 'Per il reseller che vende ogni giorno',
    highlights: [
      'Tutto del Free',
      'Generatore annunci IA',
      'Assistente trattative (offerte)',
      'Riprezzamento stock fermo',
      'Fino a 150 prodotti · 2 soci',
    ],
    features: ['listing_ai', 'offer_assistant', 'repricing'],
    maxProducts: 150,
    maxTeamMembers: 2,
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    priceMonthly: 19.99,
    tagline: 'Per chi vende su più piattaforme',
    highlights: [
      'Tutto dello Starter',
      'Pubblicazione multi-canale + ritiro automatico',
      'Spedizioni',
      'Analytics avanzate',
      'Fino a 1000 prodotti · 5 soci',
    ],
    features: ['listing_ai', 'offer_assistant', 'repricing', 'crossposting', 'shipping', 'advanced_analytics'],
    maxProducts: 1000,
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
      'Prodotti e soci illimitati',
      'Priorità supporto',
    ],
    features: ['listing_ai', 'offer_assistant', 'repricing', 'crossposting', 'shipping', 'advanced_analytics', 'labels'],
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
