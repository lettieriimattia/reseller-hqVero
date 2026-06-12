// src/middleware/validate.ts
// Validazione input con Zod. Schemi rigidi per ogni endpoint.

import { Request, Response, NextFunction } from 'express';
import { z, ZodSchema } from 'zod';

export const validate = (schema: ZodSchema) => (req: Request, res: Response, next: NextFunction) => {
  const result = schema.safeParse(req.body);
  if (!result.success) {
    return res.status(400).json({
      error: 'Dati non validi',
      details: result.error.errors.map(e => ({
        field: e.path.join('.'),
        message: e.message,
      })),
    });
  }
  req.body = result.data;
  next();
};

// ==========================================
// SCHEMI - AUTH
// ==========================================
export const registerSchema = z.object({
  email: z.string().email('Email non valida').toLowerCase().max(255),
  password: z.string().min(10, 'Password troppo corta').max(128),
  name: z.string().min(2, 'Nome troppo corto').max(50)
    .regex(/^[\p{L}\s'\-\.]+$/u, 'Nome contiene caratteri non validi'),
  categories: z.array(z.enum(['Scarpe', 'Vestiti', 'Pokemon', 'Orologi'])).optional(),
  joinCode: z.string().regex(/^INV-[A-Z0-9]{8,16}$/, 'Codice invito malformato').optional(),
  marketingConsent: z.boolean().optional(),
}).refine(
  (data) => data.categories?.length || data.joinCode,
  { message: 'Specifica almeno categorie o un codice invito' }
);

export const loginSchema = z.object({
  email: z.string().email().toLowerCase().max(255),
  password: z.string().min(1).max(128),
  twoFactorCode: z.string().regex(/^\d{6}$/).optional(),
});

export const twoFactorSetupSchema = z.object({
  code: z.string().regex(/^\d{6}$/, 'Codice deve essere 6 cifre'),
});

// ==========================================
// SCHEMI - PRODOTTI
// ==========================================
const sharesSchema = z.array(z.object({
  userId: z.string().cuid(),
  name: z.string().max(50),
  percentage: z.union([z.number(), z.string()]).transform(v => Number(v)).pipe(z.number().min(0).max(100)),
})).optional();

const photosSchema = z.array(
  z.string().min(10).regex(/^data:image\/(jpeg|jpg|png|webp);base64,/, 'Formato immagine non valido')
).max(5).optional();

export const createProductSchema = z.object({
  category: z.string().min(1).max(50),
  brand: z.string().min(1).max(100),
  name: z.string().min(1).max(200),
  size: z.string().min(1).max(50),
  condition: z.string().min(1).max(100),
  price: z.number().positive().max(1000000),
  customShares: sharesSchema,
  photos: photosSchema,
  // Campi opzionali dall'IA
  marketPriceMin: z.number().nonnegative().optional(),
  marketPriceMax: z.number().nonnegative().optional(),
  marketPriceAvg: z.number().nonnegative().optional(),
  authenticityScore: z.number().int().min(0).max(100).optional(),
});

export const editProductSchema = z.object({
  category: z.string().min(1).max(50),
  brand: z.string().min(1).max(100),
  name: z.string().min(1).max(200),
  size: z.string().min(1).max(50),
  condition: z.string().min(1).max(100),
  purchasePrice: z.number().positive().max(1000000),
  customShares: sharesSchema,
  photos: photosSchema,
});

export const sellProductSchema = z.object({
  salePrice: z.number().positive().max(1000000),
  platform: z.enum(['Vinted', 'Subito', 'StockX', 'eBay', 'Privato']),
  fees: z.number().nonnegative().max(1000000),
});

// ==========================================
// SCHEMI - TEAM
// ==========================================
export const teamPercentageSchema = z.object({
  warehouseId: z.string().cuid(),
  updates: z.array(z.object({
    userId: z.string().cuid(),
    membershipId: z.string().cuid(),
    percentage: z.number().min(0).max(100),
  })).min(1),
});

export const joinWarehouseSchema = z.object({
  inviteCode: z.string().regex(/^INV-[A-Z0-9]{8,16}$/),
});

export const createWarehouseSchema = z.object({
  name: z.string().min(1).max(50)
    .regex(/^[\p{L}\p{N}\s'\-]+$/u, 'Nome reparto contiene caratteri non validi'),
});

// ==========================================
// SCHEMI - IA
// ==========================================
export const aiScanSchema = z.object({
  imageBase64: z.string().min(100).max(10 * 1024 * 1024) // Max 10MB base64
    .regex(/^data:image\/(jpeg|jpg|png|webp);base64,/, 'Formato immagine non valido'),
  // Categoria opzionale: se assente → modalità automatica (l'IA rileva dalla foto).
  // Stringa libera (max 50): supporta categorie personalizzate oltre alle 4 core.
  category: z.string().min(1).max(50).optional(),
});

export const priceEstimateSchema = z.object({
  category: z.string().min(1).max(50),
  brand: z.string().min(1).max(100),
  modelName: z.string().min(1).max(200),
  size: z.string().max(50).optional(),
  condition: z.string().max(100).optional(),
});
