// src/services/upload.service.ts
// Upload foto su Cloudinary (gratis 25GB, no CC).
// Se CLOUDINARY_CLOUD_NAME non è configurato, restituisce il base64 originale (fallback locale).

import { v2 as cloudinary } from 'cloudinary';
import { logger } from '../utils/logger';

let configured = false;

function ensureConfigured() {
  if (configured) return;
  const cloud = process.env.CLOUDINARY_CLOUD_NAME;
  const key   = process.env.CLOUDINARY_API_KEY;
  const secret= process.env.CLOUDINARY_API_SECRET;
  if (cloud && key && secret) {
    cloudinary.config({ cloud_name: cloud, api_key: key, api_secret: secret, secure: true });
    configured = true;
  }
}

export function isCloudinaryConfigured(): boolean {
  return !!(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);
}

// Carica una singola immagine (base64 o URL) su Cloudinary.
// Restituisce l'URL pubblico ottimizzato.
export async function uploadImage(base64OrUrl: string, folder = 'hq-products'): Promise<string> {
  ensureConfigured();

  if (!isCloudinaryConfigured()) {
    // Fallback: restituisce il base64 originale (comportamento precedente)
    return base64OrUrl;
  }

  // Se è già un URL Cloudinary, non caricare di nuovo
  if (base64OrUrl.startsWith('https://res.cloudinary.com')) {
    return base64OrUrl;
  }
  // Le foto ESTERNE (StockX, carte pokemontcg, ecc.) NON si caricano su Cloudinary: si tengono
  // come LINK. Sono già online e pubbliche → un solo URL condiviso, zero storage e zero doppioni.
  // Le foto SCATTATE/dalla libreria (base64) invece si caricano normalmente (NON le tocchiamo/dedup).
  if (/^https?:\/\//i.test(base64OrUrl)) {
    return base64OrUrl;
  }

  try {
    const result = await cloudinary.uploader.upload(base64OrUrl, {
      folder,
      transformation: [
        { width: 1024, height: 1024, crop: 'limit', quality: 'auto:good', fetch_format: 'auto' },
      ],
    });
    return result.secure_url;
  } catch (err: any) {
    logger.error('Cloudinary upload error', { err: err.message });
    // Se il caricamento fallisce, restituisce il base64 originale come fallback
    return base64OrUrl;
  }
}

// Carica un array di immagini in parallelo
export async function uploadImages(images: string[], folder = 'hq-products'): Promise<string[]> {
  if (!isCloudinaryConfigured()) return images;
  const results = await Promise.all(images.map(img => uploadImage(img, folder)));
  return results;
}
