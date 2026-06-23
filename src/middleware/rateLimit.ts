// src/middleware/rateLimit.ts
// Rate limiting differenziato per endpoint.

import rateLimit from 'express-rate-limit';

const LOGIN_LIMIT = parseInt(process.env.RATE_LIMIT_LOGIN || '5');
// API generale: alzato a 1000/15min. Ogni azione (salvataggio prodotto, fetch lista,
// notifiche, team…) è una richiesta: con l'uso intenso / caricamento in blocco i 100
// precedenti si esaurivano in pochi minuti e l'app "smetteva di funzionare".
const API_LIMIT = parseInt(process.env.RATE_LIMIT_API || '1000');
// IA: alzato a 500/ora. ATTENZIONE: UNA scansione fa ~3 chiamate IA (full-scan +
// valutazione + stockx-match), quindi 20/ora bastavano per appena ~6-7 scansioni →
// dopo ~10 minuti di lavoro l'IA si bloccava. 500/ora = ~160 scansioni/ora per utente.
const AI_LIMIT = parseInt(process.env.RATE_LIMIT_AI || '500');

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
