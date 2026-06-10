// src/routes/upload.ts
// Upload foto prodotti su Cloudinary.
// Se Cloudinary non è configurato, restituisce il base64 (fallback — compatibilità Railway).

import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { apiLimiter } from '../middleware/rateLimit';
import { uploadImage, isCloudinaryConfigured } from '../services/upload.service';
import { logger } from '../utils/logger';

const router = Router();
router.use(authenticate, apiLimiter);

// POST /api/upload — carica una foto su Cloudinary, restituisce URL
// Body: { imageBase64: string }
// Response: { url: string, cloudinary: boolean }
router.post('/', async (req: AuthRequest, res: Response) => {
  const { imageBase64 } = req.body;
  if (!imageBase64 || typeof imageBase64 !== 'string') {
    return res.status(400).json({ error: 'imageBase64 obbligatorio' });
  }

  // Limite dimensione: 10MB base64 ≈ 7.5MB immagine
  if (imageBase64.length > 10 * 1024 * 1024) {
    return res.status(413).json({ error: 'Immagine troppo grande (max ~7MB)' });
  }

  try {
    const url = await uploadImage(imageBase64);
    res.json({ url, cloudinary: isCloudinaryConfigured() });
  } catch (err: any) {
    logger.error('Errore POST /api/upload', { err: err.message });
    res.status(500).json({ error: 'Errore caricamento immagine' });
  }
});

export default router;
