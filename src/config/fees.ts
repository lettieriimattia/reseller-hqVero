// src/config/fees.ts
// Calcolo della maggiorazione sui pagamenti prodotto in-app.
// Il compratore paga: prezzo articolo + spedizione + commissioni Stripe, così al
// venditore arriva NETTO il prezzo + la spedizione (la fee la copre il compratore).
// Stripe (carte EU): ~1,5% + 0,25€ a transazione.

export const STRIPE_RATE = 0.015;   // 1,5% carte europee
export const STRIPE_FIXED = 0.25;   // 0,25€ fisse
// Commissione di servizio della piattaforma (la nostra, per ogni prodotto venduto).
export const PLATFORM_FEE = Number(process.env.PLATFORM_FEE_EUR ?? 2);

export interface FeeBreakdown {
  itemPrice: number;     // prezzo articolo (netto al venditore)
  shipping: number;      // spedizione (netto al venditore, per l'etichetta)
  serviceFee: number;    // la nostra commissione di servizio (resta a noi)
  fees: number;          // commissioni Stripe a carico del compratore
  total: number;         // totale che paga il compratore
}

// Dato il netto desiderato (prezzo + spedizione + nostra fee), calcola il lordo che
// copre la commissione Stripe, così al venditore arriva il prezzo+spedizione e a noi la fee.
export function computeBuyerBreakdown(itemPrice: number, shipping = 0, serviceFee = PLATFORM_FEE): FeeBreakdown {
  const price = Math.max(0, Math.round((Number(itemPrice) || 0) * 100) / 100);
  const ship = Math.max(0, Math.round((Number(shipping) || 0) * 100) / 100);
  const fee = Math.max(0, Math.round((Number(serviceFee) || 0) * 100) / 100);
  const net = price + ship + fee;
  // gross = (net + fisso) / (1 - rate)  → così net = gross - (gross*rate + fisso)
  const gross = net > 0 ? (net + STRIPE_FIXED) / (1 - STRIPE_RATE) : 0;
  const total = Math.round(gross * 100) / 100;
  const stripeFees = Math.round((total - net) * 100) / 100;
  return { itemPrice: price, shipping: ship, serviceFee: fee, fees: Math.max(0, stripeFees), total };
}
