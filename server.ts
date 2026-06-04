// server.ts
// Entry point Reseller HQ Backend v2.0
// Con: helmet, CORS strict, cookie-parser, rate limiting, audit log, gestione errori globale.

import dotenv from 'dotenv';
dotenv.config();

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import https from 'https';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { PrismaClient } from '@prisma/client';

import authRoutes from './src/routes/auth';
import productRoutes from './src/routes/products';
import teamRoutes from './src/routes/team';
import aiRoutes from './src/routes/ai';
import notificationRoutes from './src/routes/notifications';
import trackingRoutes from './src/routes/tracking';
import adminRoutes from './src/routes/admin';
import { sendEmail } from './src/services/email.service';
import { pollAllActiveTrackings } from './src/services/tracking.service';
import { startEmailJobs } from './src/services/email-jobs.service';

import { logger } from './src/utils/logger';

// ==========================================
// VALIDAZIONE ENV CRITICHE ALL'AVVIO
// ==========================================
// Failsafe: il server non parte se mancano variabili di sicurezza essenziali.
// In passato JWT_SECRET aveva un fallback hardcoded — bug grave.
const REQUIRED_ENV = [
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
  'ENCRYPTION_KEY',
  'DATABASE_URL',
];

const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length > 0) {
  logger.error('Variabili d\'ambiente mancanti', { missing });
  console.error(`
❌ AVVIO BLOCCATO: Variabili d'ambiente obbligatorie mancanti: ${missing.join(', ')}

Crea un file .env nella root del backend partendo da .env.example
Per generare i segreti:
  openssl rand -base64 64    # per JWT_ACCESS_SECRET e JWT_REFRESH_SECRET
  openssl rand -hex 32       # per ENCRYPTION_KEY
`);
  process.exit(1);
}

// Validazione lunghezza segreti
if (process.env.JWT_ACCESS_SECRET!.length < 32) {
  console.error('❌ JWT_ACCESS_SECRET troppo corto (min 32 caratteri)');
  process.exit(1);
}
if (process.env.ENCRYPTION_KEY!.length !== 64) {
  console.error('❌ ENCRYPTION_KEY deve essere esattamente 64 caratteri esadecimali');
  process.exit(1);
}

const app = express();
const prisma = new PrismaClient();
const PORT = parseInt(process.env.PORT || '3000');
const isProduction = process.env.NODE_ENV === 'production';

// Carica i certificati SSL se disponibili (sia in dev che in prod)
const certsDir = path.join(process.cwd(), 'certs');
const tlsKey  = path.join(certsDir, 'server.key');
const tlsCert = path.join(certsDir, 'server.crt');
const useHTTPS = fs.existsSync(tlsKey) && fs.existsSync(tlsCert);
const tlsOptions = useHTTPS
  ? { key: fs.readFileSync(tlsKey), cert: fs.readFileSync(tlsCert) }
  : null;

// ==========================================
// TRUST PROXY (per IP reale dietro reverse proxy)
// ==========================================
if (isProduction) {
  app.set('trust proxy', 1);
}

// ==========================================
// HELMET - Security headers rafforzati
// ==========================================
app.use(helmet({
  contentSecurityPolicy: isProduction ? undefined : false,
  crossOriginEmbedderPolicy: false,
  // HSTS: forza HTTPS per 1 anno su tutti i sotto-domini
  hsts: useHTTPS ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false,
}));

// ==========================================
// CORS RESTRITTIVO
// ==========================================
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:5173,http://localhost:3000')
  .split(',')
  .map(s => s.trim());

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);

    // In sviluppo, accetta qualsiasi IP della rete locale (es. telefono su Wi-Fi)
    if (!isProduction && /^https?:\/\/(localhost|127\.0\.0\.1|192\.168\.\d{1,3}\.\d{1,3})(:\d+)?$/.test(origin)) {
      return callback(null, true);
    }

    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      logger.warn('CORS bloccato', { origin });
      callback(new Error(`Origin ${origin} non autorizzata`));
    }
  },
  credentials: true, // Indispensabile per i cookies
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-CSRF-Token'],
}));

// ==========================================
// PARSERS
// ==========================================
app.use(express.json({ limit: '15mb' })); // 15mb per immagini base64
app.use(express.urlencoded({ limit: '15mb', extended: true }));
app.use(cookieParser());

// ==========================================
// REQUEST LOGGING (in dev)
// ==========================================
if (!isProduction) {
  app.use((req, res, next) => {
    logger.debug(`${req.method} ${req.path}`, { ip: req.ip });
    next();
  });
}

// ==========================================
// FRONTEND STATICO (prima delle route, solo in produzione)
// ==========================================
if (isProduction) {
  const frontendDist = path.join(__dirname, '..', 'frontend', 'dist');
  app.use(express.static(frontendDist));
}

// ==========================================
// HEALTH CHECK
// ==========================================
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Test email (solo in dev o per admin)
app.post('/api/test-email', async (req, res) => {
  const result = await sendEmail({
    to: 'lettieriimattia@gmail.com',
    subject: 'HQ — Test Email',
    html: `<div style="font-family:sans-serif;background:#111;color:#fff;padding:32px;border-radius:16px;max-width:480px;">
      <h1 style="font-size:32px;margin:0 0 4px;letter-spacing:-1px;">H<span style="opacity:0.35">Q</span></h1>
      <p style="color:#666;font-size:12px;margin:0 0 28px;text-transform:uppercase;letter-spacing:1px;">Sistema Email</p>
      <p style="font-size:16px;margin:0 0 8px;color:#fff;">Il servizio email di HQ funziona correttamente.</p>
      <p style="color:#888;font-size:13px;margin:0;">Questo è un messaggio di test automatico. Nessuna azione richiesta.</p>
      <hr style="border:none;border-top:1px solid #222;margin:28px 0;" />
      <p style="color:#555;font-size:11px;margin:0;">noreply • HQ — ${new Date().toLocaleString('it-IT')}</p>
    </div>`,
    text: 'Il servizio email di HQ funziona correttamente. Questo è un messaggio di test automatico.',
  });
  res.json(result);
});

// ==========================================
// ROUTES
// ==========================================
app.use('/auth', authRoutes);
app.use('/products', productRoutes);
app.use('/team', teamRoutes);     // monta GET / e PUT /percentage
app.use('/', teamRoutes);          // monta /warehouses/join e /warehouses (mantenuto per compat)
app.use('/api/ai', aiRoutes);
app.use('/notifications', notificationRoutes);
app.use('/tracking', trackingRoutes);
app.use('/admin', adminRoutes);

// ==========================================
// SPA FALLBACK + 404
// ==========================================
if (isProduction) {
  const frontendDist = path.join(__dirname, '..', 'frontend', 'dist');
  app.get('*', (_req, res) => {
    res.sendFile(path.join(frontendDist, 'index.html'));
  });
} else {
  app.use((_req, res) => {
    res.status(404).json({ error: 'Endpoint non trovato' });
  });
}

// ==========================================
// GLOBAL ERROR HANDLER
// ==========================================
// NON espone stack trace al client (anti-disclosure)
app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
  logger.error('Errore non gestito', {
    error: err.message,
    stack: isProduction ? undefined : err.stack,
    path: req.path,
    method: req.method,
  });
  
  // CORS error
  if (err.message?.includes('Origin')) {
    return res.status(403).json({ error: 'Origin non autorizzata' });
  }
  
  // Payload too large
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'File troppo grande. Max 15MB.' });
  }
  
  // Default
  res.status(err.status || 500).json({
    error: isProduction ? 'Errore interno del server' : err.message,
  });
});

// ==========================================
// GRACEFUL SHUTDOWN
// ==========================================
const shutdown = async (signal: string) => {
  logger.info(`${signal} ricevuto, chiusura graceful...`);
  await prisma.$disconnect();
  process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ==========================================
// AVVIO — HTTPS se i certificati esistono, HTTP come fallback
// ==========================================
const serverInstance = tlsOptions
  ? https.createServer(tlsOptions, app)
  : http.createServer(app);

serverInstance.listen(PORT, () => {
  const protocol = tlsOptions ? 'https' : 'http';
  logger.info(`🚀 Reseller HQ Backend attivo su ${protocol}://localhost:${PORT} (${isProduction ? 'PROD' : 'DEV'})`);
  if (tlsOptions) logger.info('🔒 HTTPS attivo con certificato locale');
  logger.info(`   CORS permesso da: ${allowedOrigins.join(', ')} + rete locale 192.168.x.x`);

  // Job email automatiche (prodotti fermi ogni 2 settimane + consegna)
  startEmailJobs();

  // Polling tracking ogni 2 ore (solo se API key configurata)
  if (process.env.TRACKING_17TRACK_KEY) {
    const TWO_HOURS = 2 * 60 * 60 * 1000;
    setInterval(() => {
      pollAllActiveTrackings().catch(err =>
        logger.error('Errore polling tracking automatico', { err })
      );
    }, TWO_HOURS);
    logger.info('📦 Tracking automatico attivo (poll ogni 2 ore)');
  }
});
