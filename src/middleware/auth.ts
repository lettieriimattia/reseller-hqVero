// src/middleware/auth.ts
// Middleware di autenticazione e autorizzazione.

import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import { logger } from '../utils/logger';

const prisma = new PrismaClient();

export interface AuthRequest extends Request {
  user?: {
    userId: string;
    email: string;
  };
}

// ==========================================
// AUTHENTICATE - verifica access token
// ==========================================
export const authenticate = (req: AuthRequest, res: Response, next: NextFunction) => {
  // Token viene SEMPRE da httpOnly cookie (no localStorage, no header)
  const token = req.cookies?.access_token;
  
  if (!token) {
    return res.status(401).json({ error: 'Accesso negato. Effettua il login.' });
  }
  
  const secret = process.env.JWT_ACCESS_SECRET;
  if (!secret) {
    logger.error('JWT_ACCESS_SECRET non configurato!');
    return res.status(500).json({ error: 'Errore di configurazione server.' });
  }
  
  jwt.verify(token, secret, (err, decoded: any) => {
    if (err) {
      // Token scaduto → il client chiamerà /auth/refresh per rinnovarlo
      if (err.name === 'TokenExpiredError') {
        return res.status(401).json({ error: 'Token scaduto.', code: 'TOKEN_EXPIRED' });
      }
      return res.status(403).json({ error: 'Token non valido.' });
    }
    
    req.user = { userId: decoded.userId, email: decoded.email };
    next();
  });
};

// ==========================================
// AUTHORIZE WAREHOUSE - verifica che l'utente abbia accesso al warehouse
// ==========================================
// Da usare per operazioni su prodotti / team / warehouse specifici.
// Previene IDOR (Insecure Direct Object Reference) — un utente non può
// modificare/vedere risorse di un team a cui non appartiene.

export const authorizeWarehouseAccess = async (
  userId: string,
  warehouseId: string
): Promise<boolean> => {
  const membership = await prisma.membership.findFirst({
    where: { userId, warehouseId },
  });
  return membership !== null;
};

export const authorizeWarehouseOwner = async (
  userId: string,
  warehouseId: string
): Promise<boolean> => {
  const membership = await prisma.membership.findFirst({
    where: { userId, warehouseId, role: 'OWNER' },
  });
  return membership !== null;
};

// Helper: verifica che un prodotto sia accessibile all'utente
// (il prodotto appartiene a un warehouse di cui l'utente è membro)
export const canAccessProduct = async (
  userId: string,
  productId: string
): Promise<{ allowed: boolean; product: any | null }> => {
  const product = await prisma.product.findUnique({
    where: { id: productId },
  });
  if (!product) return { allowed: false, product: null };
  
  // Per backward compatibility: se il prodotto non ha warehouseId,
  // verifichiamo via category (vecchio sistema)
  if (!product.warehouseId) {
    const myMemberships = await prisma.membership.findMany({
      where: { userId },
      include: { warehouse: true },
    });
    const allowedCategories = myMemberships.map(m => 
      m.warehouse.name.replace('Magazzino ', '')
    );
    const productOwnerMemberships = await prisma.membership.findMany({
      where: { userId: product.userId },
    });
    const sharedWarehouse = myMemberships.some(mine =>
      productOwnerMemberships.some(theirs => theirs.warehouseId === mine.warehouseId)
    );
    return {
      allowed: sharedWarehouse && allowedCategories.includes(product.category),
      product
    };
  }
  
  const allowed = await authorizeWarehouseAccess(userId, product.warehouseId);
  return { allowed, product };
};
