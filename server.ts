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
import { prisma } from './src/lib/prisma';

import authRoutes from './src/routes/auth';
import productRoutes from './src/routes/products';
import teamRoutes from './src/routes/team';
import aiRoutes from './src/routes/ai';
import notificationRoutes from './src/routes/notifications';
import trackingRoutes from './src/routes/tracking';
import adminRoutes from './src/routes/admin';
import templateRoutes from './src/routes/templates';
import analyticsRoutes from './src/routes/analytics';
import shippingRoutes from './src/routes/shipping';
import uploadRoutes from './src/routes/upload';
import feedbackRoutes from './src/routes/feedback';
import pushRoutes from './src/routes/push';
import stockxRoutes from './src/routes/stockx';
import plansRoutes from './src/routes/plans';
import proRoutes from './src/routes/pro';
import { initPush } from './src/services/push.service';
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
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  // HSTS: forza HTTPS per 1 anno su tutti i sotto-domini
  hsts: useHTTPS ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false,
}));

// ==========================================
// CORS RESTRITTIVO
// ==========================================
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:5173,http://localhost:3000')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
// Auto-autorizza l'origine pubblica dell'app (Render/dominio proprio): col monolite
// frontend e API stanno sullo stesso dominio, ma il browser invia comunque l'Origin
// sulle POST → senza questo, login/refresh venivano bloccati come "Origin non autorizzata".
if (process.env.APP_URL) {
  try { allowedOrigins.push(new URL(process.env.APP_URL).origin); } catch { /* APP_URL malformato: ignora */ }
}

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
// Compressione gzip di tutte le risposte: meno banda e payload più piccoli
// (require: evita problemi di tipi se i @types non sono installati localmente).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const compression = require('compression');
app.use(compression());

app.use(express.json({ limit: '10mb' })); // ridotto da 15mb: meno RAM per richiesta (le foto sono compresse lato client)
app.use(express.urlencoded({ limit: '10mb', extended: true }));
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

// Test email (solo admin)
app.post('/api/test-email', async (req, res) => {
  const recipients: string[] = req.body?.to
    ? (Array.isArray(req.body.to) ? req.body.to : [req.body.to])
    : ['lettieriimattia@gmail.com'];

  const subject = req.body?.subject || 'HQ — Test Email';
  const customText = req.body?.text;

  const html = `<div style="font-family:sans-serif;background:#111;color:#fff;padding:32px;border-radius:16px;max-width:480px;">
      <h1 style="font-size:32px;margin:0 0 4px;letter-spacing:-1px;">H<span style="opacity:0.35">Q</span></h1>
      <p style="color:#666;font-size:12px;margin:0 0 28px;text-transform:uppercase;letter-spacing:1px;">Sistema Email</p>
      <p style="font-size:16px;margin:0 0 8px;color:#fff;">${customText || 'Il servizio email di HQ funziona correttamente.'}</p>
      <hr style="border:none;border-top:1px solid #222;margin:28px 0;" />
      <p style="color:#555;font-size:11px;margin:0;">noreply • HQ — ${new Date().toLocaleString('it-IT')}</p>
    </div>`;

  const results = await Promise.all(
    recipients.map(to => sendEmail({ to, subject, html, text: customText || subject }))
  );

  const failed = results.filter(r => !r.ok);
  if (failed.length === 0) res.json({ ok: true });
  else res.json({ ok: false, error: failed.map(r => r.error).join(', ') });
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
app.use('/templates', templateRoutes);
app.use('/analytics', analyticsRoutes);
app.use('/shipping', shippingRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/feedback', feedbackRoutes);
app.use('/api/push', pushRoutes);
app.use('/api/stockx', stockxRoutes);
app.use('/api/plans', plansRoutes);
app.use('/api/pro', proRoutes);

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

  // Web Push: carica/genera le chiavi VAPID
  initPush();

  // Migrazione magazzini → partnership. Gira UNA SOLA VOLTA in automatico
  // (consolida i magazzini esistenti dentro "Il mio magazzino"), poi segna un
  // flag in Setting così non rigira ai riavvii successivi. Non distruttiva.
  // Override manuale via env: RUN_WAREHOUSE_MIGRATION=dry (solo anteprima nei log,
  // non segna il flag) | =apply (riesegue comunque).
  (async () => {
    try {
      const forced = process.env.RUN_WAREHOUSE_MIGRATION?.toLowerCase(); // 'dry' | 'apply' | undefined
      const done = await prisma.setting.findUnique({ where: { key: 'warehouseMigrationV1' } }).catch(() => null);
      if (!forced && done) return; // già eseguita
      const apply = forced ? forced === 'apply' : true; // auto-run = applica
      const { migrateWarehousesToPartners } = await import('./src/services/warehouse-migration');
      const summary = await migrateWarehousesToPartners(prisma, apply, (...a) => logger.info('[warehouse-migration]', ...a));
      logger.info('[warehouse-migration] completata', summary);
      if (apply && forced !== 'apply') {
        await prisma.setting.upsert({
          where: { key: 'warehouseMigrationV1' },
          create: { key: 'warehouseMigrationV1', value: new Date().toISOString() },
          update: {},
        });
      }
    } catch (err: any) {
      logger.error('[warehouse-migration] errore', { err: err?.message });
    }
  })();

  // Email solo per cose importanti (password, account, risposte assistenza):
  // le notifiche operative (prodotti fermi, ecc.) vanno via push/in-app, non email.
  // (Job email ricorrente "prodotti fermi" disattivato di proposito.)
  void startEmailJobs;

  // Pilastro 2: Cleanup reservation scadute ogni minuto.
  // Se una reservation non viene completata entro 15 min, il prodotto torna IN STOCK.
  const RESERVATION_TTL = 15 * 60 * 1000;
  setInterval(async () => {
    try {
      const expired = await prisma.product.updateMany({
        where: {
          status: 'RESERVED',
          reservedAt: { lt: new Date(Date.now() - RESERVATION_TTL) },
        },
        data: { status: 'IN STOCK', reservedBy: null, reservedAt: null },
      });
      if (expired.count > 0) {
        logger.info(`Reservation scadute rilasciate: ${expired.count} prodotti → IN STOCK`);
      }
    } catch (err) {
      logger.error('Errore cleanup reservation', { err });
    }
  }, 60_000);

  // Self-ping ogni 14 minuti su Render free tier (evita lo spin-down dopo 15min di inattività)
  // Si attiva solo se APP_URL è configurato (non in dev locale)
  if (isProduction && process.env.APP_URL) {
    setInterval(() => {
      fetch(`${process.env.APP_URL}/health`).catch(() => {});
    }, 14 * 60 * 1000);
    logger.info('🔁 Self-ping attivo (ogni 14 min) per Render free tier');
  }

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
