// src/services/shopify.service.ts
// Integrazione Shopify (Fase 1: SOLA LETTURA — import catalogo).
// Il negozio crea una "custom app" nel suo admin Shopify e ci passa il dominio *.myshopify.com
// + l'Admin API access token. Noi leggiamo prodotti/varianti/giacenze. Nessuna scrittura sul loro store.

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

async function shopifyApi(domain: string, token: string, path: string): Promise<Response> {
  const url = `https://${domain}/admin/api/${API_VERSION}/${path}`;
  return fetch(url, {
    headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
  });
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
