// src/config/plans.ts
// Catalogo piani e diritti (entitlements). Unica fonte di verità per il gating.
// I prezzi sono mensili in €. Le feature sono chiavi usate da requireFeature().

export type PlanId = 'free' | 'starter' | 'pro' | 'business';

export type Feature =
  | 'repricing'           // riprezzamento stock fermo
  | 'offer_assistant'     // assistente trattative/offerte
  | 'crossposting'        // pubblicazione multi-canale + ritiro automatico
  | 'listing_ai'          // generatore annunci IA + lettura barcode/SKU
  | 'shipping'            // spedizioni
  | 'labels'              // etichette/QR magazzino
  | 'advanced_analytics'  // analytics avanzate
  | 'partners'            // magazzini con soci + divisione costi/utili
  | 'marketplace'         // vendere in vetrina pubblica + chat + pagamenti in-app
  | 'stockx_pricing'      // prezzi reali StockX
  | 'accounting'          // costi extra + export CSV commercialista
  | 'returns'             // gestione resi (riporta un venduto in magazzino)
  | 'shopify'             // integrazione Shopify (import catalogo) — piano Store/Business
  | 'no_sale_fee';        // fee di servizio sulle vendite azzerata

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
    tagline: 'Prova a gestire il tuo magazzino',
    highlights: [
      'Magazzino personale + riconoscimento prodotto da foto (IA)',
      'Categorie create al volo dall\'IA',
      'Registra acquisti e vendite manuali',
      'Fino a 25 prodotti · solo tu',
      'Per vendere nel marketplace serve lo Starter',
    ],
    features: [],
    maxProducts: 25,
    maxTeamMembers: 1,
  },
  starter: {
    id: 'starter',
    name: 'Starter',
    priceMonthly: 9.99,
    tagline: 'Per chi vende davvero, ogni giorno',
    highlights: [
      'Tutto del Free',
      'Vendi nel marketplace: vetrina pubblica + chat + pagamenti in-app',
      'Analytics: ROI, andamento, sell-through, giorni medi',
      'Generatore annunci IA + lettura SKU/barcode dalla scatola',
      '1 socio: magazzino condiviso con divisione costi/utili',
      'Gestione resi: riporti un venduto in magazzino',
      'Fino a 150 prodotti · 2 persone',
    ],
    features: ['marketplace', 'listing_ai', 'partners', 'advanced_analytics', 'returns'],
    maxProducts: 150,
    maxTeamMembers: 2,
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    priceMonthly: 19.99,
    tagline: 'Il salto di qualità — quasi tutto incluso',
    highlights: [
      'Tutto dello Starter',
      'Niente fee di servizio sulle tue vendite (azzerata)',
      'Valutazioni reali StockX su tutto (sneaker, elettronica…)',
      'Contabilità: costi extra + CSV per il commercialista',
      'Riprezzamento stock fermo · assistente trattative',
      'Multi-canale + ritiro automatico · spedizioni',
      'Etichette di spedizione + QR magazzino',
      'Fino a 2000 prodotti · 5 soci',
    ],
    features: ['marketplace', 'listing_ai', 'partners', 'stockx_pricing', 'accounting', 'advanced_analytics', 'repricing', 'offer_assistant', 'crossposting', 'shipping', 'no_sale_fee', 'labels', 'returns'],
    maxProducts: 2000,
    maxTeamMembers: 5,
  },
  business: {
    id: 'business',
    name: 'Business/Store',
    priceMonthly: 39.99,
    tagline: 'Per negozi: sincronizza Shopify e gestisci tutto',
    highlights: [
      'Tutto del Pro',
      'Integrazione Shopify: importa il catalogo del tuo store',
      'Etichette/QR magazzino',
      'Prodotti, soci e magazzini illimitati',
      'Priorità supporto',
    ],
    features: ['marketplace', 'listing_ai', 'partners', 'stockx_pricing', 'accounting', 'advanced_analytics', 'repricing', 'offer_assistant', 'crossposting', 'shipping', 'no_sale_fee', 'labels', 'returns', 'shopify'],
    maxProducts: null,
    maxTeamMembers: null,
  },
};

export const PLAN_ORDER: PlanId[] = ['free', 'starter', 'pro', 'business'];

// ==========================================
// FEATURE FLAG — funzioni "in beta": le usano SOLO gli account admin.
// Quando una funzione è approvata, togli la sua chiave da qui → diventa disponibile
// a tutti gli utenti secondo le regole dei piani (PLANS sopra).
// Es: 'labels' è in test → la vedono solo gli admin; quando approvi, rimuovila.
// ==========================================
export const BETA_FEATURES = new Set<Feature>([
  'labels',
]);

export function isBetaFeature(feature: Feature): boolean {
  return BETA_FEATURES.has(feature);
}

// Una feature è "usabile" se: l'utente è admin (beta tester) OPPURE
// è già rilasciata (non in beta) E il piano dell'utente la include.
export function isFeatureLive(planId: string | null | undefined, feature: Feature, isAdmin = false): boolean {
  if (isAdmin) return true;
  if (BETA_FEATURES.has(feature)) return false;
  return hasFeature(planId, feature);
}

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
