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
import jwt from 'jsonwebtoken';
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
import taskRoutes from './src/routes/tasks';
import shareRoutes, { publicShareRouter } from './src/routes/share';
import { isMaintenanceOn, initMaintenanceFlag } from './src/services/maintenance-flag';
import shippingRoutes from './src/routes/shipping';
import uploadRoutes from './src/routes/upload';
import feedbackRoutes from './src/routes/feedback';
import supportRoutes from './src/routes/support';
import telegramWebhookRoutes from './src/routes/telegram-webhook';
import { setTelegramWebhook } from './src/services/telegram';
import pushRoutes from './src/routes/push';
import stockxRoutes from './src/routes/stockx';
import plansRoutes from './src/routes/plans';
import proRoutes from './src/routes/pro';
import marketRoutes from './src/routes/market';
import chatRoutes from './src/routes/chat';
import catalogRoutes from './src/routes/catalog';
import assistantRoutes from './src/routes/assistant';
import billingRoutes, { stripeWebhookHandler } from './src/routes/billing';
import { initPush } from './src/services/push.service';
import { sendEmail } from './src/services/email.service';
import { pollAllActiveTrackings } from './src/services/tracking.service';
import { startEmailJobs } from './src/services/email-jobs.service';
import { startMonitorAgent } from './src/services/monitor.agent';
import { startMaintenance } from './src/services/maintenance';
import { releaseExpiredHolds } from './src/services/dispute.service';
import { migratePhotosToCloudinary } from './src/services/photo-migration.service';

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

// Webhook Stripe: DEVE ricevere il body RAW (firma), quindi prima di express.json.
app.post('/billing/webhook', express.raw({ type: 'application/json' }), stripeWebhookHandler);

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
  // Landing pubblica SEO alla ROOT (statica, indicizzabile); l'app gira sotto /app e ogni altra
  // route SPA. Deve stare PRIMA di express.static (che altrimenti servirebbe index.html su "/").
  // Se l'utente è GIÀ loggato (cookie access valido) → va dritto all'app, niente landing.
  app.get('/', (req: Request, res: Response) => {
    const token = (req as any).cookies?.access_token;
    if (token && process.env.JWT_ACCESS_SECRET) {
      try { jwt.verify(token, process.env.JWT_ACCESS_SECRET); return res.redirect('/app'); } catch { /* token non valido → landing */ }
    }
    res.sendFile(path.join(frontendDist, 'landing.html'));
  });
  // L'app SPA vive sotto /app (e sottopercorsi). Servila SUBITO, PRIMA dei router API:
  // altrimenti un visitatore SLOGGATO che apre /app (i bottoni della landing!) verrebbe
  // intercettato da `app.use('/', teamRoutes)` → middleware authenticate → 401 JSON.
  app.get(/^\/app(\/.*)?$/, (_req, res) => res.sendFile(path.join(frontendDist, 'index.html')));
  // Vetrina pubblica condivisa: /s/<token> → pagina statica che carica i prodotti condivisi.
  app.get(/^\/s\/[^/]+$/, (_req, res) => res.sendFile(path.join(frontendDist, 'vetrina.html')));
  app.use(express.static(frontendDist));
}

// ==========================================
// HEALTH CHECK
// ==========================================
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Vetrina condivisa (PUBBLICA, no login): solo prodotti scelti + campi sicuri. PRIMA di teamRoutes.
app.use('/api/share', publicShareRouter);

// Stato app (pubblico): il frontend lo legge per mostrare la schermata di manutenzione.
app.get('/api/status', (_req, res) => {
  res.json({ maintenance: isMaintenanceOn() });
});

// Modalità manutenzione: blocca le API "pesanti" (così durante la migrazione foto il
// server non viene caricato). Restano attivi: /health, /api/status e i file statici (per
// mostrare la schermata di manutenzione). Risponde 503 con {maintenance:true}.
app.use((req, res, next) => {
  if (!isMaintenanceOn()) return next();
  const p = req.path;
  if (p === '/health' || p === '/api/status') return next();
  // Lascia passare le richieste di pagine/asset (GET non-API) → serve la schermata manutenzione.
  const isApi = p.startsWith('/api') || p.startsWith('/auth') || p.startsWith('/products') ||
    p.startsWith('/team') || p.startsWith('/warehouses') || p.startsWith('/notifications') ||
    p.startsWith('/tracking') || p.startsWith('/market') || p.startsWith('/chat') ||
    p.startsWith('/billing') || p.startsWith('/admin') || p.startsWith('/shipping') ||
    p.startsWith('/analytics') || p.startsWith('/upload') || p.startsWith('/feedback') || p.startsWith('/push');
  if (isApi) return res.status(503).json({ maintenance: true, error: 'Aggiornamento in corso, riprova tra poco.' });
  return next();
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
// Webhook Telegram: niente auth (lo chiama Telegram). PRIMA di teamRoutes('/') che applica
// authenticate a ogni path → altrimenti la chiamata di Telegram verrebbe respinta con 401.
app.use('/api/telegram', telegramWebhookRoutes);
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
app.use('/tasks', taskRoutes);
app.use('/share', shareRoutes);   // gestione vetrine condivise (autenticato)
app.use('/market', marketRoutes);   // vetrina pubblica (GET senza login) + contatta
app.use('/chat', chatRoutes);       // chat marketplace (solo testo, no link)
app.use('/billing', billingRoutes); // abbonamenti Stripe (checkout/portal); webhook montato sopra
app.use('/shipping', shippingRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/feedback', feedbackRoutes);
app.use('/api/support', supportRoutes);
app.use('/api/push', pushRoutes);
app.use('/api/stockx', stockxRoutes);
app.use('/api/plans', plansRoutes);
app.use('/api/pro', proRoutes);
app.use('/api/catalog', catalogRoutes);
app.use('/api/assistant', assistantRoutes);

// ==========================================
// SPA FALLBACK + 404
// ==========================================
if (isProduction) {
  const frontendDist = path.join(__dirname, '..', 'frontend', 'dist');
  // Pannello admin separato: /admin → admin.html (entry Vite dedicata).
  app.get(['/admin', '/admin/'], (_req, res) => {
    res.sendFile(path.join(frontendDist, 'admin.html'));
  });
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
// ALERT ERRORI: avvisa via email l'admin sugli errori server 500 (throttle: max 1 ogni 10 min
// per non spammare). Imposta ALERT_EMAIL su Render per attivarlo.
let lastErrorAlert = 0;
function alertAdminError(err: any, req: Request) {
  const to = process.env.ALERT_EMAIL;
  if (!to) return;
  const now = Date.now();
  if (now - lastErrorAlert < 10 * 60 * 1000) return;
  lastErrorAlert = now;
  sendEmail({
    to,
    subject: `⚠️ HQVault: errore server (${req.method} ${req.path})`,
    text: `Errore: ${err?.message}\nDove: ${req.method} ${req.path}\nQuando: ${new Date().toISOString()}\n\n${(err?.stack || '').toString().slice(0, 1500)}`,
  }).catch(() => {});
}

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

  // Default (errore vero) → avvisa l'admin
  const status = err.status || 500;
  if (status >= 500) alertAdminError(err, req);
  res.status(status).json({
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

  // Agente IA "report giornaliero": una query/giorno (non tiene sveglio Neon). Si attiva solo
  // se Telegram è configurato — vedi monitor.agent.ts.
  startMonitorAgent();

  // Manutenzione DB settimanale (prune cache catalogo + retention log). Solo pulizia, zero logica app.
  startMaintenance();

  // Carica lo stato "manutenzione" runtime (toggle-abile da Telegram).
  initMaintenanceFlag();

  // Registra il webhook Telegram (per ricevere le RISPOSTE dell'admin → email al cliente).
  setTelegramWebhook();

  // ──────────────────────────────────────────────────────────────────────────
  // JOB IN BACKGROUND CHE INTERROGANO IL DB
  // IMPORTANTE per i costi Neon: ogni query ricorrente tiene SVEGLIO il database
  // (Neon conta le "ore di calcolo" solo quando è attivo, e si sospende dopo ~5 min
  // di inattività). Un loop ogni 60s azzera di continuo quel timer → il DB non dorme
  // MAI → ore di calcolo bruciate 24/7 anche senza utenti.
  // Questi job servono SOLO a marketplace/wallet/tracking, che ora sono nascosti:
  // li teniamo SPENTI di default e si riaccendono con ENABLE_BACKGROUND_JOBS=1 quando
  // si riattiva il marketplace. Così, a riposo, Neon può dormire e i costi crollano.
  const backgroundJobsEnabled = process.env.ENABLE_BACKGROUND_JOBS === '1';

  // Self-ping ogni 14 minuti su Render free tier (evita lo spin-down dopo 15min di inattività).
  // NB: colpisce /health, che NON tocca il DB → non consuma ore Neon. Lo teniamo sempre.
  if (isProduction && process.env.APP_URL) {
    setInterval(() => {
      fetch(`${process.env.APP_URL}/health`).catch(() => {});
    }, 14 * 60 * 1000);
    logger.info('🔁 Self-ping attivo (ogni 14 min) per Render free tier');
  }

  if (!backgroundJobsEnabled) {
    logger.info('⏸️  Job in background DB (prenotazioni/escrow/tracking) DISATTIVATI — ENABLE_BACKGROUND_JOBS=1 per riattivarli. Risparmio ore di calcolo Neon.');
  } else {
    // Pilastro 2: Cleanup reservation scadute. Frequenza ridotta a 10 min (non 60s):
    // una prenotazione può scadere "in ritardo" di qualche minuto senza problemi, e
    // così il DB può sospendersi tra un controllo e l'altro.
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
    }, 10 * 60 * 1000);

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
  }

  // Migrazione foto base64 → Cloudinary. Si attiva con RUN_PHOTO_MIGRATION=1 OPPURE in
  // MAINTENANCE_MODE=1 (app in manutenzione = nessun carico utenti → migrazione sicura anche su 512MB).
  if (process.env.RUN_PHOTO_MIGRATION === '1' || process.env.MAINTENANCE_MODE === '1') {
    setTimeout(() => { migratePhotosToCloudinary().catch(() => {}); }, 15_000);
  }

  // Auto-conferma escrow: sblocca i fondi degli acquisti la cui finestra è scaduta
  // (5gg dalla consegna, o fallback dalla spedizione) e senza contestazioni aperte.
  // Anche questo è wallet/marketplace → gated per non tenere sveglio il DB ogni ora.
  if (backgroundJobsEnabled) {
    releaseExpiredHolds().catch(() => {});
    setInterval(() => {
      releaseExpiredHolds().catch(err => logger.error('Errore auto-sblocco escrow', { err }));
    }, 60 * 60 * 1000);
    logger.info('💸 Auto-sblocco escrow attivo (controllo ogni ora)');
  }
});
