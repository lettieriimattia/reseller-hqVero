// src/lib/stripe.ts
// Istanza Stripe condivisa. Restituisce null se la chiave non è configurata,
// così le rotte possono rispondere "pagamenti non attivi" senza crashare.

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Stripe = require('stripe');

export function stripe(): any | null {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  return new Stripe(key);
}

export function isStripeConfigured(): boolean {
  return !!process.env.STRIPE_SECRET_KEY;
}

// Base URL dell'app (per success/cancel url), dietro proxy Render.
export function appBase(req: any): string {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, '');
  const proto = (req.headers['x-forwarded-proto'] || 'https').toString().split(',')[0];
  const host = (req.headers['x-forwarded-host'] || req.headers.host || 'resellerhq.onrender.com').toString();
  return `${proto}://${host}`;
}
