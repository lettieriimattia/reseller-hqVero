// src/services/shopify.service.ts
// Integrazione Shopify. Fase 1 (sola lettura): import catalogo. Fase 2 (scrittura): sync
// giacenza bidirezionale — richiede sullo store i permessi read_products+read_inventory
// (Fase 1) più write_inventory+read_orders (Fase 2) sulla custom app.
// Il negozio crea una "custom app" nel suo admin Shopify e ci passa il dominio *.myshopify.com
// + l'Admin API access token (+ per il webhook ordini, il Client secret dell'app).

import crypto from 'crypto';

const API_VERSION = '2024-07';

export interface ShopifyVariant {
  id: number;
  title: string;
  option1: string | null;
  option2: string | null;
  option3: string | null;
  price: string;
  sku: string | null;
  inventory_quantity: number;
  inventory_item_id: number;
}
export interface ShopifyProduct {
  id: number;
  title: string;
  vendor: string;
  product_type: string;
  status: string; // active | archived | draft
  images: { src: string }[];
  image?: { src: string } | null;
  variants: ShopifyVariant[];
  options: { name: string; position: number }[];
}

// Normalizza il dominio: toglie protocollo/slash. L'Admin API vuole il dominio *.myshopify.com.
export function normalizeShopDomain(input: string): string {
  return (input || '').trim().toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/\s+/g, '');
}

async function shopifyApi(domain: string, token: string, path: string, init?: RequestInit): Promise<Response> {
  const url = `https://${domain}/admin/api/${API_VERSION}/${path}`;
  return fetch(url, {
    ...init,
    headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json', ...(init?.headers || {}) },
  });
}

// Riprova le chiamate di SCRITTURA (decremento giacenza) su errori transitori: la quota Shopify
// è generosa ma un 429/5xx isolato non deve far perdere la sync. 3 tentativi, backoff 500ms/1500ms.
async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: any;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (err) {
      lastErr = err;
      if (i < attempts - 1) await new Promise(r => setTimeout(r, 500 * Math.pow(3, i)));
    }
  }
  throw lastErr;
}

// Verifica le credenziali: ritorna il nome dello shop o lancia un errore leggibile.
export async function verifyShopify(domain: string, token: string): Promise<{ name: string; domain: string; currency: string }> {
  const d = normalizeShopDomain(domain);
  if (!/\.myshopify\.com$/.test(d)) {
    throw Object.assign(new Error('Usa il dominio *.myshopify.com (lo trovi nell\'admin Shopify), non il dominio del sito.'), { status: 400 });
  }
  let res: Response;
  try {
    res = await shopifyApi(d, token, 'shop.json');
  } catch {
    throw Object.assign(new Error('Impossibile raggiungere Shopify. Controlla il dominio.'), { status: 502 });
  }
  if (res.status === 401 || res.status === 403) {
    throw Object.assign(new Error('Token non valido o permessi mancanti (serve read_products e read_inventory).'), { status: 401 });
  }
  if (!res.ok) {
    throw Object.assign(new Error(`Shopify ha risposto ${res.status}.`), { status: 502 });
  }
  const data: any = await res.json();
  return { name: data?.shop?.name || d, domain: d, currency: data?.shop?.currency || 'EUR' };
}

// Scarica TUTTI i prodotti (paginazione per since_id, max 250 a giro). cap = tetto di sicurezza.
export async function fetchAllShopifyProducts(domain: string, token: string, cap = 5000): Promise<ShopifyProduct[]> {
  const d = normalizeShopDomain(domain);
  const out: ShopifyProduct[] = [];
  let sinceId = 0;
  // Loop finché ci sono pagine piene o finché non superiamo il cap.
  for (let page = 0; page < 200; page++) {
    const res = await shopifyApi(d, token, `products.json?limit=250&since_id=${sinceId}&status=active`);
    if (!res.ok) throw Object.assign(new Error(`Shopify products ${res.status}`), { status: 502 });
    const data: any = await res.json();
    const batch: ShopifyProduct[] = Array.isArray(data?.products) ? data.products : [];
    if (batch.length === 0) break;
    out.push(...batch);
    sinceId = batch[batch.length - 1].id;
    if (out.length >= cap || batch.length < 250) break;
    // Rispetta il rate limit (2 req/s sul REST): piccola pausa.
    await new Promise(r => setTimeout(r, 300));
  }
  return out.slice(0, cap);
}

// ==========================================
// FASE 2 — SCRITTURA: sync giacenza bidirezionale
// ==========================================

export interface ShopifyLocation { id: number; name: string; active: boolean; }

// Elenca le location dello store (serve almeno l'id per leggere/scrivere l'inventario:
// Shopify tiene la giacenza per coppia variante+location, non per variante da sola).
export async function fetchShopifyLocations(domain: string, token: string): Promise<ShopifyLocation[]> {
  const d = normalizeShopDomain(domain);
  const res = await shopifyApi(d, token, 'locations.json');
  if (!res.ok) throw Object.assign(new Error(`Shopify locations ${res.status}`), { status: 502 });
  const data: any = await res.json();
  return (Array.isArray(data?.locations) ? data.locations : []).filter((l: any) => l.active !== false);
}

// Scala (o aumenta, con delta negativo/positivo) la giacenza di UNA variante su UNA location.
// Usa l'endpoint "adjust" (relativo), più sicuro di "set" (assoluto) quando più canali vendono
// in parallelo: non serve conoscere/leggere prima la quantità corrente.
export async function adjustShopifyInventory(
  domain: string, token: string, inventoryItemId: string, locationId: string, delta: number,
): Promise<void> {
  const d = normalizeShopDomain(domain);
  await withRetry(async () => {
    const res = await shopifyApi(d, token, 'inventory_levels/adjust.json', {
      method: 'POST',
      body: JSON.stringify({
        inventory_item_id: Number(inventoryItemId),
        location_id: Number(locationId),
        available_adjustment: delta,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw Object.assign(new Error(`Shopify inventory adjust ${res.status}: ${body.slice(0, 200)}`), { status: res.status });
    }
  });
}

// Registra il webhook "ordine creato" verso il nostro endpoint (una tantum, bottone in
// Impostazioni). Richiede lo scope read_orders sulla custom app.
export async function registerOrderWebhook(domain: string, token: string, callbackUrl: string): Promise<{ id: number }> {
  const d = normalizeShopDomain(domain);
  const res = await shopifyApi(d, token, 'webhooks.json', {
    method: 'POST',
    body: JSON.stringify({ webhook: { topic: 'orders/create', address: callbackUrl, format: 'json' } }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw Object.assign(new Error(`Shopify webhook register ${res.status}: ${body.slice(0, 200)}`), { status: 502 });
  }
  const data: any = await res.json();
  return { id: data?.webhook?.id };
}

// Verifica la firma HMAC-SHA256 del webhook (header X-Shopify-Hmac-Sha256) contro il Client
// secret dell'app custom, calcolata sul body RAW (deve essere montata prima di express.json()).
export function verifyShopifyWebhookHmac(rawBody: Buffer, hmacHeader: string | undefined, secret: string): boolean {
  if (!hmacHeader) return false;
  try {
    const digest = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader));
  } catch { return false; }
}

// Ordine Shopify grezzo (solo i campi che ci servono dal payload webhook orders/create).
export interface ShopifyOrderLineItem { variant_id: number | null; quantity: number; price: string; title: string; }
export interface ShopifyOrderWebhookPayload {
  id: number;
  email?: string;
  customer?: { first_name?: string; last_name?: string };
  line_items: ShopifyOrderLineItem[];
}
