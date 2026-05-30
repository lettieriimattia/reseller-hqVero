// src/middleware/rateLimit.ts
// Rate limiting differenziato per endpoint.

import rateLimit from 'express-rate-limit';

const LOGIN_LIMIT = parseInt(process.env.RATE_LIMIT_LOGIN || '5');
const API_LIMIT = parseInt(process.env.RATE_LIMIT_API || '100');
const AI_LIMIT = parseInt(process.env.RATE_LIMIT_AI || '20');

// ==========================================
// LOGIN / REGISTER - molto restrittivo
// Previene brute force su credenziali
// ==========================================
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minuti
  max: LOGIN_LIMIT,
  message: {
    error: `Troppi tentativi. Riprova fra 15 minuti.`,
  },
  standardHeaders: true,
  legacyHeaders: false,
  // Conta solo richieste fallite
  skipSuccessfulRequests: true,
});

// ==========================================
// API GENERALE - più permissivo
// ==========================================
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: API_LIMIT,
  message: { error: 'Limite richieste raggiunto. Riprova fra qualche minuto.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ==========================================
// IA - molto costosa, limite stretto per utente
// ==========================================
export const aiLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 ora
  max: AI_LIMIT,
  message: { 
    error: `Hai raggiunto il limite di ${AI_LIMIT} scansioni IA all'ora. Riprova più tardi.` 
  },
  standardHeaders: true,
  legacyHeaders: false,
  // Usa l'userId quando autenticato, altrimenti IP
  keyGenerator: (req: any) => req.user?.userId || req.ip,
});

// ==========================================
// PASSWORD RESET / 2FA - restrittivo
// ==========================================
export const sensitiveLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: { error: 'Troppe richieste per questa operazione sensibile.' },
  standardHeaders: true,
  legacyHeaders: false,
});
