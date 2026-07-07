// src/routes/auth.ts
// Rotte autenticazione: register, login, refresh, logout, 2FA.

import { Router, Request, Response } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { PrismaClient, Prisma } from '@prisma/client';
import { prisma } from "../lib/prisma";
import { authenticator } from 'otplib';
import QRCode from 'qrcode';

import { authenticate, AuthRequest } from '../middleware/auth';
import { authLimiter, sensitiveLimiter } from '../middleware/rateLimit';
import { validate, registerSchema, loginSchema, twoFactorSetupSchema } from '../middleware/validate';
import { 
  encrypt, decrypt,
  generateInviteCode, generateBackupCodes, 
  generateRefreshToken, hashRefreshToken,
  validatePassword 
} from '../utils/security';
import { audit } from '../services/audit.service';
import { sendEmail } from '../services/email.service';
import { logger } from '../utils/logger';

const router = Router();

const BCRYPT_ROUNDS = 12;
const MAX_LOGIN_FAILS = 5;
const LOCK_DURATION_MS = 15 * 60 * 1000; // 15 minuti
const VERIFY_TTL_MS = 30 * 60 * 1000; // codice valido 30 minuti

// La verifica email è attiva solo se l'invio email è configurato (BREVO_API_KEY).
// Così, se l'email non è pronta, le registrazioni non si bloccano.
// Verifica email ATTIVA: si applica solo se l'invio email è configurato (BREVO_API_KEY).
// Se BREVO non è impostata, emailConfigured()=false → non blocca le registrazioni.
const EMAIL_VERIFICATION_ENABLED = true;
function emailConfigured() { return EMAIL_VERIFICATION_ENABLED && !!process.env.BREVO_API_KEY; }
function genVerifyCode() { return Math.floor(100000 + Math.random() * 900000).toString(); }

// Genera + salva + invia il codice di verifica a un utente.
async function sendVerificationCode(user: { id: string; email: string; name?: string }) {
  const code = genVerifyCode();
  await prisma.user.update({
    where: { id: user.id },
    data: { emailVerifyCode: code, emailVerifyExpires: new Date(Date.now() + VERIFY_TTL_MS) },
  });
  await sendEmail({
    to: user.email,
    subject: 'Il tuo codice di verifica — HQ',
    text: `Il tuo codice di verifica è: ${code}. Scade tra 30 minuti.`,
    html: `<div style="font-family:Arial,sans-serif"><h2>Conferma la tua email</h2><p>Il tuo codice di verifica è:</p><p style="font-size:28px;font-weight:bold;letter-spacing:4px">${code}</p><p style="color:#888">Scade tra 30 minuti. Se non hai creato un account, ignora questa email.</p></div>`,
  }).catch((e) => logger.error('Invio codice verifica fallito', { err: e?.message }));
}

const RESET_TTL_MS = 30 * 60 * 1000; // codice reset valido 30 minuti

// Genera + salva + invia il codice per il RECUPERO password.
async function sendPasswordResetCode(user: { id: string; email: string; name?: string }) {
  const code = genVerifyCode();
  await prisma.user.update({
    where: { id: user.id },
    data: { passwordResetCode: code, passwordResetExpires: new Date(Date.now() + RESET_TTL_MS) },
  });
  await sendEmail({
    to: user.email,
    subject: 'Recupero password — HQVault',
    text: `Il tuo codice per reimpostare la password è: ${code}. Scade tra 30 minuti. Se non l'hai richiesto, ignora questa email: il tuo account è al sicuro.`,
    html: `<div style="font-family:Arial,sans-serif"><h2>Reimposta la password</h2><p>Il tuo codice è:</p><p style="font-size:28px;font-weight:bold;letter-spacing:4px">${code}</p><p style="color:#888">Scade tra 30 minuti. Se non hai richiesto il recupero, ignora questa email.</p></div>`,
  }).catch((e) => logger.error('Invio codice reset fallito', { err: e?.message }));
}

// Oggetto utente standard restituito al frontend (login + verifica).
export function userResponse(user: any) {
  return {
    id: user.id, name: user.name, email: user.email,
    twoFactorEnabled: user.twoFactorEnabled, plan: user.plan,
    warehouses: (user.memberships || []).map((m: any) => ({
      id: m.warehouse.id, name: m.warehouse.name, role: m.role,
      inviteCode: m.role === 'OWNER' ? m.warehouse.inviteCode : null,
      aiConfig: m.warehouse.aiConfig || null,
      parentId: m.warehouse.parentId || null, category: m.warehouse.category || null,
      percentage: m.percentage,
    })),
  };
}

// ==========================================
// HELPER: setta cookies access + refresh
// ==========================================
export async function issueTokens(res: Response, user: { id: string; email: string }, req: Request) {
  const accessSecret = process.env.JWT_ACCESS_SECRET!;
  const refreshSecret = process.env.JWT_REFRESH_SECRET!;
  
  const accessToken = jwt.sign(
    { userId: user.id, email: user.email },
    accessSecret,
    { expiresIn: (process.env.JWT_ACCESS_EXPIRES || '15m') } as any
  );
  
  const refreshPlain = generateRefreshToken();
  const refreshHashed = hashRefreshToken(refreshPlain);
  
  // Salva nel DB (sessione lunga: 30 giorni, così non si rilogga di continuo)
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  await prisma.refreshToken.create({
    data: {
      token: refreshHashed,
      userId: user.id,
      userAgent: req.headers['user-agent']?.slice(0, 500),
      ipAddress: req.ip,
      expiresAt,
    },
  });
  
  const isProd = process.env.NODE_ENV === 'production';
  const secure = process.env.COOKIE_SECURE === 'true';
  const domain = process.env.COOKIE_DOMAIN || undefined;
  // COOKIE_SAME_SITE=none quando frontend e backend sono su domini diversi (es. Vercel + Render)
  // In sviluppo locale resta 'lax' per compatibilità con HTTP
  const sameSiteEnv = process.env.COOKIE_SAME_SITE as 'lax' | 'none' | 'strict' | undefined;
  const sameSite = sameSiteEnv || (isProd ? 'lax' : 'lax');

  const cookieOpts = {
    httpOnly: true,
    secure: isProd || secure,
    sameSite,
    domain,
  };
  
  res.cookie('access_token', accessToken, {
    ...cookieOpts,
    maxAge: 15 * 60 * 1000, // 15 minuti
  });
  
  res.cookie('refresh_token', refreshPlain, {
    ...cookieOpts,
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 giorni
    path: '/auth/refresh', // Limitiamo il refresh token al solo endpoint refresh
  });
}

// ==========================================
// POST /auth/register
// ==========================================
router.post('/register', authLimiter, validate(registerSchema), async (req, res) => {
  const { email, password, name, categories, joinCode, marketingConsent } = req.body;

  // BETA CHIUSA: creare un account è possibile SOLO a chi ha il codice beta (cookie hq_beta).
  // ⚠️ TEMPORANEO: SOSPESA finché le landing non sono online (i beta tester senza codice devono
  // potersi registrare/usare l'app). Per RIATTIVARLA al lancio: BETA_GATE_ON = true.
  const BETA_GATE_ON = false;
  const betaKey = process.env.BETA_ACCESS_KEY || '';
  if (BETA_GATE_ON && betaKey && !joinCode && (req as any).cookies?.hq_beta !== '1') {
    await audit({ action: 'REGISTER', success: false, req, metadata: { reason: 'beta_gate', email } });
    return res.status(403).json({ error: 'Registrazioni su invito. Serve il codice di accesso.' });
  }

  try {
    // Password policy
    const pwValidation = validatePassword(password);
    if (!pwValidation.valid) {
      return res.status(400).json({ error: 'Password non sicura', details: pwValidation.errors });
    }
    
    // Esiste già?
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      await audit({ action: 'REGISTER', success: false, req, metadata: { reason: 'email_exists', email } });
      return res.status(400).json({ error: 'Email già registrata.' });
    }
    
    const hashedPassword = await bcrypt.hash(password, BCRYPT_ROUNDS);
    
    // CASO 1: Join team via codice invito
    if (joinCode) {
      const joinedUser = await prisma.$transaction(async (tx) => {
        const inviteWarehouse = await tx.warehouse.findUnique({ where: { inviteCode: joinCode } });
        if (!inviteWarehouse) throw new Error('INVALID_INVITE_CODE');
        
        // Verifica scadenza
        if (inviteWarehouse.inviteCodeExpiresAt && inviteWarehouse.inviteCodeExpiresAt < new Date()) {
          throw new Error('EXPIRED_INVITE_CODE');
        }
        
        const ownerMembership = await tx.membership.findFirst({
          where: { warehouseId: inviteWarehouse.id, role: 'OWNER' },
        });
        if (!ownerMembership) throw new Error('NO_OWNER');
        
        const allOwnerWarehouses = await tx.membership.findMany({
          where: { userId: ownerMembership.userId, role: 'OWNER' },
        });
        
        return await tx.user.create({
          data: {
            email, password: hashedPassword, name,
            marketingConsent: marketingConsent === true,
            emailVerified: !emailConfigured(),
            memberships: {
              create: allOwnerWarehouses.map(m => ({
                role: 'MEMBER', percentage: 0,
                warehouse: { connect: { id: m.warehouseId } },
              })),
            },
          },
        });
      });

      await audit({ action: 'REGISTER', success: true, req, metadata: { type: 'join_team', email } });
      if (emailConfigured() && joinedUser) {
        await sendVerificationCode(joinedUser);
        return res.json({ needsVerification: true, email, message: 'Ti abbiamo inviato un codice di verifica via email.' });
      }
      return res.json({ message: 'Sei entrato nel team con successo! Effettua il login.' });
    }
    
    // CASO 2: Nuovo utente → parte con UN SOLO magazzino base "Il mio magazzino"
    // (da solo, senza soci). Le categorie sono trasversali e si creano al volo
    // dopo (foto/IA o a mano), non più legate al magazzino.
    const newUser = await prisma.user.create({
      data: {
        email, password: hashedPassword, name,
        marketingConsent: marketingConsent === true,
        emailVerified: !emailConfigured(), // se l'email è configurata → deve verificare
        memberships: {
          create: [{
            role: 'OWNER', percentage: 100,
            warehouse: {
              create: {
                name: 'Il mio magazzino',
                inviteCode: generateInviteCode(),
                inviteCodeExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
              },
            },
          }],
        },
      },
    });

    await audit({ action: 'REGISTER', success: true, req, metadata: { type: 'new_team', email } });
    if (emailConfigured()) {
      await sendVerificationCode(newUser);
      return res.json({ needsVerification: true, email, message: 'Ti abbiamo inviato un codice di verifica via email.' });
    }
    res.json({ message: 'Account creato con successo! Effettua il login.' });
    
  } catch (err: any) {
    if (err.message === 'INVALID_INVITE_CODE') {
      return res.status(400).json({ error: 'Codice invito non valido.' });
    }
    if (err.message === 'EXPIRED_INVITE_CODE') {
      return res.status(400).json({ error: 'Codice invito scaduto. Chiedi al tuo socio di rigenerarlo.' });
    }
    logger.error('Errore registrazione', { err: err.message });
    res.status(500).json({ error: 'Errore durante la registrazione.' });
  }
});

// ==========================================
// MODALITÀ DEMO — accesso SENZA login (per video/walkthrough, anche con AI).
// GET /auth/demo-login  → entra nell'account demo (già pieno di dati) e va a /app.
// GET /auth/demo-login?reset=1 → ripulisce e ri-semina i dati demo (stato pulito).
// Gated da DEMO_ENABLED (default ON; per spegnerla: DEMO_ENABLED=false). Account isolato,
// piano "business" = nessun paywall, tutte le sezioni visibili.
// ==========================================
const DEMO_EMAIL = process.env.DEMO_EMAIL || 'demo@hqvault.app';
const DEMO_ENABLED = process.env.DEMO_ENABLED !== 'false';

async function seedDemoProducts(userId: string, warehouseId: string | null) {
  const daysAgo = (n: number) => new Date(Date.now() - n * 86400000);
  const items: any[] = [
    { category: 'Sneakers', brand: 'Nike', name: 'Air Jordan 1 Retro High OG Chicago', size: '42', condition: 'Nuovo', purchasePrice: 180, salePrice: 320, status: 'VENDUTO', platform: 'StockX', fees: 38, soldAt: daysAgo(5), marketPriceAvg: 330 },
    { category: 'Sneakers', brand: 'Nike', name: 'Dunk Low Retro White Black Panda', size: '43', condition: 'Nuovo', purchasePrice: 110, status: 'IN STOCK', marketPriceAvg: 135 },
    { category: 'Sneakers', brand: 'adidas', name: 'Yeezy Boost 350 V2 Bone', size: '44', condition: 'Nuovo', purchasePrice: 190, status: 'IN STOCK', marketPriceAvg: 215 },
    { category: 'Sneakers', brand: 'New Balance', name: '550 White Green', size: '41', condition: 'Nuovo', purchasePrice: 120, salePrice: 160, status: 'VENDUTO', platform: 'Vinted', fees: 8, soldAt: daysAgo(12), marketPriceAvg: 155 },
    { category: 'Streetwear', brand: 'Supreme', name: 'Box Logo Hooded Sweatshirt Black FW23', size: 'L', condition: 'Nuovo', purchasePrice: 280, status: 'IN STOCK', marketPriceAvg: 420 },
    { category: 'Streetwear', brand: 'Stüssy', name: '8 Ball Tee White', size: 'M', condition: 'Nuovo', purchasePrice: 35, salePrice: 70, status: 'VENDUTO', platform: 'Wallapop', fees: 3, soldAt: daysAgo(2), marketPriceAvg: 65 },
    { category: 'Borse', brand: 'Louis Vuitton', name: 'Pochette Accessoires Monogram', size: 'Unica', condition: 'Usato', purchasePrice: 600, status: 'IN STOCK', marketPriceAvg: 760 },
    { category: 'Pokemon', brand: 'Pokémon', name: 'Charizard ex 199/165 SV 151', size: 'PSA 10', condition: 'Nuovo', purchasePrice: 90, status: 'IN STOCK', marketPriceAvg: 140 },
    { category: 'Sneakers', brand: 'Nike', name: 'Travis Scott x Air Jordan 1 Low OG Olive', size: '42.5', condition: 'Nuovo', purchasePrice: 350, status: 'IN STOCK', trackingCarrier: 'BRT', trackingCode: 'DEMO123456IT', trackingDirection: 'INBOUND', trackingStatus: 'IN_TRANSIT', marketPriceAvg: 520 },
    { category: 'Elettronica', brand: 'Apple', name: 'iPhone 15 Pro 256GB Titanio Naturale', size: 'Unica', condition: 'Nuovo', purchasePrice: 950, salePrice: 1080, status: 'VENDUTO', platform: 'Subito', fees: 0, soldAt: daysAgo(20), marketPriceAvg: 1050 },
  ];
  await prisma.product.createMany({
    data: items.map(it => ({
      userId, warehouseId,
      category: it.category, brand: it.brand, name: it.name, size: it.size, condition: it.condition,
      purchasePrice: it.purchasePrice, salePrice: it.salePrice ?? null, platform: it.platform ?? null, fees: it.fees ?? null,
      status: it.status, soldAt: it.soldAt ?? null,
      trackingCarrier: it.trackingCarrier ?? null, trackingCode: it.trackingCode ?? null,
      trackingDirection: it.trackingDirection ?? null, trackingStatus: it.trackingStatus ?? null,
      marketPriceAvg: it.marketPriceAvg ?? null,
    })),
  });
}

router.get('/demo-login', authLimiter, async (req: Request, res: Response) => {
  if (!DEMO_ENABLED) return res.status(404).send('Demo non attiva.');
  // ANTI-BYPASS del cancello beta: la demo crea una sessione valida.
  // ⚠️ TEMPORANEO: SOSPESO col resto del gate beta. Per RIATTIVARLO: BETA_GATE_ON = true.
  const BETA_GATE_ON = false;
  const betaKey = process.env.BETA_ACCESS_KEY || '';
  if (BETA_GATE_ON && betaKey && req.query.beta !== betaKey && (req as any).cookies?.hq_beta !== '1') {
    return res.status(404).send('Demo non attiva.');
  }
  try {
    let user = await prisma.user.findUnique({ where: { email: DEMO_EMAIL }, include: { memberships: true } });
    if (!user) {
      const hashed = await bcrypt.hash('demo-' + Math.random().toString(36).slice(2) + Date.now(), BCRYPT_ROUNDS);
      user = await prisma.user.create({
        data: {
          email: DEMO_EMAIL, password: hashed, name: 'Demo HQVault',
          plan: 'business', emailVerified: true, marketingConsent: false,
          memberships: { create: [{ role: 'OWNER', percentage: 100, warehouse: { create: { name: 'Magazzino Demo', inviteCode: generateInviteCode(), inviteCodeExpiresAt: new Date(Date.now() + 30 * 86400000) } } }] },
        },
        include: { memberships: true },
      });
    }
    if (user.plan !== 'business') await prisma.user.update({ where: { id: user.id }, data: { plan: 'business' } });
    const whId = user.memberships?.[0]?.warehouseId || null;
    if (req.query.reset === '1') await prisma.product.deleteMany({ where: { userId: user.id } });
    const count = await prisma.product.count({ where: { userId: user.id, deletedAt: null } });
    if (count === 0) await seedDemoProducts(user.id, whId);
    await issueTokens(res, user, req);
    return res.redirect('/app');
  } catch (e: any) {
    logger.error('Errore demo-login', { err: e.message });
    return res.status(500).send('Errore avvio demo.');
  }
});

// ==========================================
// POST /auth/login
// ==========================================
router.post('/login', authLimiter, validate(loginSchema), async (req, res) => {
  const { email, password, twoFactorCode } = req.body;
  
  try {
    const user = await prisma.user.findUnique({
      where: { email },
      include: { memberships: { include: { warehouse: true } } },
    });
    
    // Risposta generica anche se l'email non esiste (anti-enumeration)
    if (!user) {
      // Aspettiamo comunque per equalizzare il timing (anti timing-attack)
      await bcrypt.compare(password, '$2b$12$dummyhashtoavoidtimingattacksxxxxxxxxxxxxxxxxxxxxxxxx');
      await audit({ action: 'LOGIN_FAIL', success: false, req, metadata: { reason: 'no_user', email } });
      return res.status(400).json({ error: 'Credenziali non valide.' });
    }
    
    // Account bloccato?
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      const remaining = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60000);
      return res.status(423).json({ 
        error: `Account temporaneamente bloccato. Riprova fra ${remaining} minuti.` 
      });
    }
    
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      // Incrementa contatore tentativi falliti
      const newFailCount = user.failedLoginCount + 1;
      const shouldLock = newFailCount >= MAX_LOGIN_FAILS;
      
      await prisma.user.update({
        where: { id: user.id },
        data: {
          failedLoginCount: newFailCount,
          lockedUntil: shouldLock ? new Date(Date.now() + LOCK_DURATION_MS) : null,
        },
      });
      
      await audit({ 
        action: 'LOGIN_FAIL', success: false, userId: user.id, req,
        metadata: { reason: 'wrong_password', failCount: newFailCount }
      });
      
      if (shouldLock) {
        await audit({ action: 'SECURITY_LOCK', userId: user.id, req });
        return res.status(423).json({ 
          error: `Account bloccato per 15 minuti dopo ${MAX_LOGIN_FAILS} tentativi falliti.` 
        });
      }
      return res.status(400).json({ error: 'Credenziali non valide.' });
    }
    
    // Password OK - blocca se l'email non è ancora verificata (anti email inesistenti)
    if (!user.emailVerified && emailConfigured()) {
      await sendVerificationCode(user);
      return res.status(200).json({ needsVerification: true, email: user.email, message: 'Verifica la tua email: ti abbiamo inviato un nuovo codice.' });
    }

    // verifica 2FA se abilitato
    if (user.twoFactorEnabled) {
      if (!twoFactorCode) {
        return res.status(200).json({ require2FA: true });
      }
      
      const decryptedSecret = decrypt(user.twoFactorSecret!);
      const isValid = authenticator.check(twoFactorCode, decryptedSecret);
      
      if (!isValid) {
        // Prova con codice di backup
        const backupCodes = user.twoFactorBackup ? JSON.parse(decrypt(user.twoFactorBackup)) : [];
        const matchIdx = backupCodes.indexOf(twoFactorCode.toUpperCase());
        
        if (matchIdx === -1) {
          await audit({ action: 'LOGIN_FAIL', success: false, userId: user.id, req, metadata: { reason: '2fa_invalid' } });
          return res.status(400).json({ error: 'Codice 2FA non valido.', require2FA: true });
        }
        
        // Consuma il codice di backup
        backupCodes.splice(matchIdx, 1);
        await prisma.user.update({
          where: { id: user.id },
          data: { twoFactorBackup: encrypt(JSON.stringify(backupCodes)) },
        });
      }
    }
    
    // Login OK - reset contatori e issue tokens
    await prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginCount: 0,
        lockedUntil: null,
        lastLoginAt: new Date(),
        lastLoginIp: req.ip,
      },
    });
    
    await issueTokens(res, user, req);
    await audit({ action: 'LOGIN_SUCCESS', success: true, userId: user.id, req });
    
    res.json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        twoFactorEnabled: user.twoFactorEnabled,
        plan: user.plan,
        warehouses: user.memberships.map((m: any) => ({
          id: m.warehouse.id,
          name: m.warehouse.name,
          role: m.role,
          inviteCode: m.role === 'OWNER' ? m.warehouse.inviteCode : null,
          aiConfig: m.warehouse.aiConfig || null,
          parentId: m.warehouse.parentId || null, category: m.warehouse.category || null,
          percentage: m.percentage,
        })),
      },
    });
  } catch (err: any) {
    logger.error('Errore login', { err: err.message });
    res.status(500).json({ error: 'Errore durante il login.' });
  }
});

// ==========================================
// POST /auth/verify-email — conferma il codice e fa il login
// ==========================================
router.post('/verify-email', authLimiter, async (req: Request, res: Response) => {
  try {
    const email = (req.body?.email || '').toString().trim().toLowerCase();
    const code = (req.body?.code || '').toString().trim();
    if (!email || !code) return res.status(400).json({ error: 'Email e codice obbligatori.' });
    const user = await prisma.user.findUnique({
      where: { email },
      include: { memberships: { include: { warehouse: true } } },
    });
    if (!user) return res.status(400).json({ error: 'Codice non valido.' });
    if (user.emailVerified) {
      // già verificata: procedi al login
      await issueTokens(res, user, req);
      return res.json({ user: userResponse(user) });
    }
    if (!user.emailVerifyCode || !user.emailVerifyExpires || user.emailVerifyExpires < new Date()) {
      return res.status(400).json({ error: 'Codice scaduto. Richiedine uno nuovo.' });
    }
    if (user.emailVerifyCode !== code) {
      return res.status(400).json({ error: 'Codice non valido.' });
    }
    await prisma.user.update({
      where: { id: user.id },
      data: { emailVerified: true, emailVerifyCode: null, emailVerifyExpires: null, lastLoginAt: new Date(), lastLoginIp: req.ip },
    });
    await issueTokens(res, user, req);
    await audit({ action: 'LOGIN_SUCCESS', success: true, userId: user.id, req, metadata: { via: 'email_verify' } });
    res.json({ user: userResponse(user) });
  } catch (err: any) {
    logger.error('Errore verify-email', { err: err.message });
    res.status(500).json({ error: 'Errore verifica.' });
  }
});

// POST /auth/resend-verification — rimanda il codice
router.post('/resend-verification', authLimiter, async (req: Request, res: Response) => {
  try {
    const email = (req.body?.email || '').toString().trim().toLowerCase();
    const user = await prisma.user.findUnique({ where: { email } });
    // Risposta generica (anti-enumeration): non riveliamo se l'email esiste.
    if (user && !user.emailVerified) await sendVerificationCode(user);
    res.json({ ok: true });
  } catch (err: any) {
    logger.error('Errore resend-verification', { err: err.message });
    res.json({ ok: true });
  }
});

// ==========================================
// POST /auth/forgot-password — { email } → invia un codice OTP per reimpostare la password.
// Risposta SEMPRE generica (anti-enumeration): non rivela se l'email è registrata.
// ==========================================
router.post('/forgot-password', authLimiter, async (req: Request, res: Response) => {
  try {
    const email = (req.body?.email || '').toString().trim().toLowerCase();
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(400).json({ error: 'Email non valida.' });
    }
    const user = await prisma.user.findUnique({ where: { email } });
    if (user) {
      await sendPasswordResetCode(user);
      await audit({ action: 'PASSWORD_RESET_REQUEST', userId: user.id, req }).catch(() => {});
    }
    return res.json({ ok: true, message: 'Se l\'email è registrata, ti abbiamo inviato un codice per reimpostare la password.' });
  } catch (err: any) {
    logger.error('Errore forgot-password', { err: err.message });
    return res.status(500).json({ error: 'Errore. Riprova.' });
  }
});

// ==========================================
// POST /auth/reset-password — { email, code, newPassword } → verifica il codice e imposta la
// nuova password. Sblocca l'account, verifica l'email, e INVALIDA tutte le sessioni attive.
// ==========================================
router.post('/reset-password', authLimiter, async (req: Request, res: Response) => {
  try {
    const email = (req.body?.email || '').toString().trim().toLowerCase();
    const code = (req.body?.code || '').toString().trim();
    const newPassword = (req.body?.newPassword || '').toString();
    if (!email || !code || !newPassword) return res.status(400).json({ error: 'Dati mancanti.' });

    const pw = validatePassword(newPassword);
    if (!pw.valid) return res.status(400).json({ error: 'Password troppo debole: ' + pw.errors.join(', ') });

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !user.passwordResetCode || !user.passwordResetExpires
      || user.passwordResetCode !== code || user.passwordResetExpires < new Date()) {
      await audit({ action: 'PASSWORD_RESET_FAIL', userId: user?.id, success: false, req }).catch(() => {});
      return res.status(400).json({ error: 'Codice non valido o scaduto.' });
    }

    const hashed = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await prisma.user.update({
      where: { id: user.id },
      data: {
        password: hashed,
        passwordResetCode: null,
        passwordResetExpires: null,
        failedLoginCount: 0,   // il reset sblocca l'account
        lockedUntil: null,
        emailVerified: true,   // ha dimostrato di possedere l'email
      },
    });
    // SICUREZZA: dopo un reset, revoca tutte le sessioni attive (refresh token).
    await prisma.refreshToken.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: new Date() },
    }).catch(() => {});

    await audit({ action: 'PASSWORD_RESET_SUCCESS', userId: user.id, req }).catch(() => {});
    return res.json({ ok: true, message: 'Password reimpostata. Ora puoi accedere con la nuova password.' });
  } catch (err: any) {
    logger.error('Errore reset-password', { err: err.message });
    return res.status(500).json({ error: 'Errore. Riprova.' });
  }
});

// ==========================================
// POST /auth/refresh
// ==========================================
router.post('/refresh', async (req: Request, res: Response) => {
  const refreshPlain = req.cookies?.refresh_token;
  if (!refreshPlain) return res.status(401).json({ error: 'No refresh token' });
  
  const refreshHashed = hashRefreshToken(refreshPlain);
  
  try {
    const stored = await prisma.refreshToken.findUnique({
      where: { token: refreshHashed },
      include: { user: true },
    });
    
    if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
      return res.status(401).json({ error: 'Refresh token non valido o scaduto.' });
    }

    // NIENTE rotazione: il vecchio refresh token resta valido. Evita il logout quando
    // l'app fa più refresh in parallelo all'avvio (race) e regge anche se un cookie
    // ruotato non si salva (PWA iOS). issueTokens crea comunque un token aggiornato.
    await issueTokens(res, stored.user, req);
    await audit({ action: 'TOKEN_REFRESH', userId: stored.userId, req });
    
    res.json({ success: true });
  } catch (err: any) {
    logger.error('Errore refresh token', { err: err.message });
    res.status(500).json({ error: 'Errore refresh' });
  }
});

// ==========================================
// POST /auth/logout
// ==========================================
router.post('/logout', async (req: Request, res: Response) => {
  const refreshPlain = req.cookies?.refresh_token;
  
  if (refreshPlain) {
    const refreshHashed = hashRefreshToken(refreshPlain);
    await prisma.refreshToken.updateMany({
      where: { token: refreshHashed },
      data: { revokedAt: new Date() },
    }).catch(() => {});
  }
  
  const opts = {
    httpOnly: true,
    secure: process.env.COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    domain: process.env.COOKIE_DOMAIN || undefined,
  };
  
  res.clearCookie('access_token', opts);
  res.clearCookie('refresh_token', { ...opts, path: '/auth/refresh' });
  
  res.json({ success: true });
});

// ==========================================
// GET /auth/me
// ==========================================
router.get('/me', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.userId },
      include: { memberships: { include: { warehouse: true } } },
    });
    if (!user) return res.status(404).json({ error: 'Utente non trovato' });
    
    res.json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        twoFactorEnabled: user.twoFactorEnabled,
        plan: user.plan,
        warehouses: user.memberships.map((m: any) => ({
          id: m.warehouse.id,
          name: m.warehouse.name,
          role: m.role,
          inviteCode: m.role === 'OWNER' ? m.warehouse.inviteCode : null,
          aiConfig: m.warehouse.aiConfig || null,
          parentId: m.warehouse.parentId || null, category: m.warehouse.category || null,
          percentage: m.percentage,
        })),
      },
    });
  } catch (err) {
    res.status(500).json({ error: 'Errore' });
  }
});

// ==========================================
// 2FA - SETUP (genera QR code)
// ==========================================
router.post('/2fa/setup', authenticate, sensitiveLimiter, async (req: AuthRequest, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user!.userId } });
    if (!user) return res.status(404).json({ error: 'Utente non trovato' });
    
    if (user.twoFactorEnabled) {
      return res.status(400).json({ error: '2FA già abilitato. Disabilitalo prima di rigenerarlo.' });
    }
    
    const secret = authenticator.generateSecret();
    const otpauth = authenticator.keyuri(user.email, 'HQVault', secret);
    const qrDataUrl = await QRCode.toDataURL(otpauth);
    
    // Salva temporaneamente (non ancora attivo) il secret cifrato
    // L'utente dovrà confermare con un codice per attivarlo
    await prisma.user.update({
      where: { id: user.id },
      data: { twoFactorSecret: encrypt(secret) },
    });
    
    res.json({ qrCode: qrDataUrl, manualKey: secret });
  } catch (err: any) {
    logger.error('Errore 2FA setup', { err: err.message });
    res.status(500).json({ error: 'Errore setup 2FA' });
  }
});

// ==========================================
// 2FA - VERIFY (attiva)
// ==========================================
router.post('/2fa/verify', authenticate, sensitiveLimiter, validate(twoFactorSetupSchema), async (req: AuthRequest, res) => {
  const { code } = req.body;
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user!.userId } });
    if (!user || !user.twoFactorSecret) return res.status(400).json({ error: 'Setup 2FA non avviato.' });
    
    const secret = decrypt(user.twoFactorSecret);
    if (!authenticator.check(code, secret)) {
      return res.status(400).json({ error: 'Codice non valido.' });
    }
    
    // Genera codici di backup
    const backupCodes = generateBackupCodes(10);
    
    await prisma.user.update({
      where: { id: user.id },
      data: {
        twoFactorEnabled: true,
        twoFactorBackup: encrypt(JSON.stringify(backupCodes)),
      },
    });
    
    await audit({ action: '2FA_ENABLE', userId: user.id, req });
    
    res.json({ 
      success: true,
      backupCodes,
      warning: 'Salva questi codici di backup in un posto sicuro. Ti permetteranno di accedere se perdi l\'app authenticator. Ogni codice è usabile una sola volta.'
    });
  } catch (err: any) {
    logger.error('Errore 2FA verify', { err: err.message });
    res.status(500).json({ error: 'Errore verifica 2FA' });
  }
});

// ==========================================
// 2FA - DISABLE
// ==========================================
router.post('/2fa/disable', authenticate, sensitiveLimiter, async (req: AuthRequest, res) => {
  const { password, code } = req.body;
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user!.userId } });
    if (!user) return res.status(404).json({ error: 'Utente non trovato' });
    
    // Richiede password + codice 2FA per disabilitare
    if (!password) return res.status(400).json({ error: 'Password richiesta.' });
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) return res.status(400).json({ error: 'Password errata.' });
    
    if (user.twoFactorEnabled) {
      if (!code) return res.status(400).json({ error: 'Codice 2FA richiesto.' });
      const secret = decrypt(user.twoFactorSecret!);
      if (!authenticator.check(code, secret)) {
        return res.status(400).json({ error: 'Codice 2FA non valido.' });
      }
    }
    
    await prisma.user.update({
      where: { id: user.id },
      data: { twoFactorEnabled: false, twoFactorSecret: null, twoFactorBackup: null },
    });
    
    await audit({ action: '2FA_DISABLE', userId: user.id, req });
    res.json({ success: true });
  } catch (err: any) {
    logger.error('Errore 2FA disable', { err: err.message });
    res.status(500).json({ error: 'Errore disabilitazione 2FA' });
  }
});

// ==========================================
// PUT /auth/password — cambia password
// ==========================================
router.put('/password', authenticate, sensitiveLimiter, async (req: AuthRequest, res) => {
  const { currentPassword, newPassword } = req.body;
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user!.userId } });
    if (!user) return res.status(404).json({ error: 'Utente non trovato' });
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Password attuale e nuova sono richieste.' });
    }
    const validPassword = await bcrypt.compare(currentPassword, user.password);
    if (!validPassword) return res.status(400).json({ error: 'Password attuale errata.' });
    const pwValidation = validatePassword(newPassword);
    if (!pwValidation.valid) {
      return res.status(400).json({ error: 'Password non sicura', details: pwValidation.errors });
    }
    const hashed = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await prisma.user.update({ where: { id: user.id }, data: { password: hashed } });
    // Revoca tutti i refresh token attivi (sicurezza: forza rilogin ovunque)
    await prisma.refreshToken.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await audit({ action: 'PASSWORD_CHANGE', userId: user.id, req });
    res.json({ success: true });
  } catch (err: any) {
    logger.error('Errore cambio password', { err: err.message });
    res.status(500).json({ error: 'Errore cambio password' });
  }
});

// ==========================================
// PUT /auth/profile — modifica il proprio nome
// ==========================================
router.put('/profile', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const rawIn = typeof req.body?.name === 'string' ? req.body.name : '';
    // Pulizia: no caratteri di controllo, no emoji/simboli (solo lettere, numeri, spazio, . ' -),
    // spazi multipli collassati in uno solo, trim.
    const name = rawIn
      .replace(/[\x00-\x1f\x7f]/g, '')
      .replace(/[^\p{L}\p{N} .'’-]/gu, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (name.length < 2 || name.length > 20) {
      return res.status(400).json({ error: 'Il nome deve avere tra 2 e 20 caratteri (nome e cognome ok).' });
    }

    // Niente nomi doppi tra i soci dello STESSO magazzino: crea confusione nella ripartizione.
    const myWh = await prisma.membership.findMany({ where: { userId: req.user!.userId }, select: { warehouseId: true } });
    const whIds = myWh.map(m => m.warehouseId);
    if (whIds.length > 0) {
      const clash = await prisma.membership.findFirst({
        where: {
          warehouseId: { in: whIds },
          userId: { not: req.user!.userId },
          user: { name: { equals: name, mode: 'insensitive' } },
        },
        select: { userId: true },
      });
      if (clash) return res.status(409).json({ error: 'Un socio di un tuo magazzino usa già questo nome. Scegline uno diverso.' });
    }

    const user = await prisma.user.update({
      where: { id: req.user!.userId },
      data: { name },
    });
    await audit({ action: 'PROFILE_UPDATE', userId: user.id, req, metadata: { field: 'name' } });
    res.json({ user: { id: user.id, name: user.name, email: user.email } });
  } catch (err: any) {
    logger.error('Errore modifica profilo', { err: err.message });
    res.status(500).json({ error: 'Errore modifica profilo' });
  }
});

// ==========================================
// DELETE /auth/delete-account — elimina account con verifica password
// ==========================================
router.delete('/delete-account', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'Password richiesta.' });

    const user = await prisma.user.findUnique({ where: { id: req.user!.userId } });
    if (!user) return res.status(404).json({ error: 'Utente non trovato.' });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Password errata.' });

    // Elimina tutto in cascata (Prisma gestisce le relazioni)
    await prisma.user.delete({ where: { id: user.id } });

    await audit({ action: 'ACCOUNT_DELETE', userId: user.id, req, metadata: { email: user.email } });

    // Pulisci i cookies
    res.clearCookie('access_token');
    res.clearCookie('refresh_token', { path: '/auth/refresh' });
    res.json({ success: true });
  } catch (err: any) {
    logger.error('Errore eliminazione account', { err: err.message });
    res.status(500).json({ error: 'Errore eliminazione account.' });
  }
});

// ==========================================
// FACE ID / PASSKEY (WebAuthn) — login senza password con Face ID/Touch ID/Windows Hello.
// ==========================================
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} from '@simplewebauthn/server';

// Ricava rpID (dominio) e origin DAL DOMINIO REALE della richiesta (così combacia sempre con
// quello su cui sta navigando l'utente), con fallback su APP_URL. La CORS allow-list protegge
// comunque da origini non autorizzate.
function rpInfo(req?: Request) {
  let base = (req?.headers?.origin || '').toString();
  if (!base && req?.headers?.host) base = `https://${req.headers.host}`;
  if (!base) base = process.env.APP_URL || 'http://localhost:5173';
  let rpID = 'localhost', origin = base;
  try { const u = new URL(base); rpID = u.hostname; origin = u.origin; } catch { /* base malformato */ }
  return { rpID, origin };
}

// 1) Opzioni di REGISTRAZIONE passkey (utente loggato che attiva il Face ID).
router.post('/webauthn/register/options', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { rpID } = rpInfo(req);
    const user = await prisma.user.findUnique({ where: { id: req.user!.userId }, include: { webauthnCreds: true } });
    if (!user) return res.status(404).json({ error: 'Utente non trovato.' });
    const options = await generateRegistrationOptions({
      rpName: 'HQVault', rpID,
      userName: user.email,
      userID: new TextEncoder().encode(user.id),
      attestationType: 'none',
      excludeCredentials: user.webauthnCreds.map(c => ({ id: c.credentialId })) as any,
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
    });
    await prisma.user.update({ where: { id: user.id }, data: { webauthnChallenge: options.challenge } });
    res.json(options);
  } catch (err: any) {
    logger.error('webauthn register options', { err: err.message });
    res.status(500).json({ error: 'Errore Face ID.' });
  }
});

// 2) Verifica REGISTRAZIONE → salva la credenziale.
router.post('/webauthn/register/verify', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { rpID, origin } = rpInfo(req);
    const user = await prisma.user.findUnique({ where: { id: req.user!.userId } });
    if (!user || !user.webauthnChallenge) return res.status(400).json({ error: 'Sessione Face ID scaduta, riprova.' });
    const verification = await verifyRegistrationResponse({
      response: req.body.response,
      expectedChallenge: user.webauthnChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
    });
    if (!verification.verified || !verification.registrationInfo) return res.status(400).json({ error: 'Verifica Face ID fallita.' });
    // Estrazione difensiva: v13 usa registrationInfo.credential.{id,publicKey,counter}; versioni
    // precedenti usano credentialID/credentialPublicKey/counter.
    const ri: any = verification.registrationInfo;
    const cred: any = ri.credential || {};
    const credentialId: string = cred.id || ri.credentialID;
    const publicKeyRaw: any = cred.publicKey || ri.credentialPublicKey;
    const counterVal: number = cred.counter ?? ri.counter ?? 0;
    const transportsArr: any = cred.transports || req.body?.response?.response?.transports;
    if (!credentialId || !publicKeyRaw) return res.status(400).json({ error: 'Verifica Face ID fallita (dati credenziale).' });
    await prisma.webAuthnCredential.create({
      data: {
        userId: user.id,
        credentialId,
        publicKey: Buffer.from(publicKeyRaw),
        counter: BigInt(counterVal || 0),
        transports: transportsArr ? JSON.stringify(transportsArr) : null,
        deviceName: (req.headers['user-agent'] || '').toString().slice(0, 80) || null,
      },
    });
    await prisma.user.update({ where: { id: user.id }, data: { webauthnChallenge: null } });
    res.json({ ok: true });
  } catch (err: any) {
    logger.error('webauthn register verify', { err: err.message });
    res.status(500).json({ error: 'Errore registrazione Face ID.' });
  }
});

// 3) Opzioni di LOGIN con Face ID (utente NON loggato, fornisce l'email).
router.post('/webauthn/auth/options', authLimiter, async (req: Request, res: Response) => {
  try {
    const { rpID } = rpInfo(req);
    const email = (req.body?.email || '').toString().trim().toLowerCase();
    const user = await prisma.user.findUnique({ where: { email }, include: { webauthnCreds: true } });
    if (!user || !user.webauthnCreds.length) return res.status(400).json({ error: 'Face ID non configurato per questo account.' });
    const options = await generateAuthenticationOptions({
      rpID,
      allowCredentials: user.webauthnCreds.map(c => ({ id: c.credentialId, transports: c.transports ? JSON.parse(c.transports) : undefined })) as any,
      userVerification: 'preferred',
    });
    await prisma.user.update({ where: { id: user.id }, data: { webauthnChallenge: options.challenge } });
    res.json(options);
  } catch (err: any) {
    logger.error('webauthn auth options', { err: err.message });
    res.status(500).json({ error: 'Errore Face ID.' });
  }
});

// 4) Verifica LOGIN Face ID → emette i cookie e logga l'utente.
router.post('/webauthn/auth/verify', authLimiter, async (req: Request, res: Response) => {
  try {
    const { rpID, origin } = rpInfo(req);
    const email = (req.body?.email || '').toString().trim().toLowerCase();
    const user = await prisma.user.findUnique({
      where: { email },
      include: { webauthnCreds: true, memberships: { include: { warehouse: true } } },
    });
    if (!user || !user.webauthnChallenge) return res.status(400).json({ error: 'Sessione Face ID scaduta, riprova.' });
    const cred = user.webauthnCreds.find(c => c.credentialId === req.body?.response?.id);
    if (!cred) return res.status(400).json({ error: 'Credenziale Face ID non riconosciuta.' });
    const verification = await verifyAuthenticationResponse({
      response: req.body.response,
      expectedChallenge: user.webauthnChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: { id: cred.credentialId, publicKey: cred.publicKey as any, counter: Number(cred.counter), transports: cred.transports ? JSON.parse(cred.transports) : undefined },
    } as any);
    if (!verification.verified) return res.status(400).json({ error: 'Face ID non valido.' });
    await prisma.webAuthnCredential.update({ where: { id: cred.id }, data: { counter: BigInt(verification.authenticationInfo.newCounter) } });
    await prisma.user.update({ where: { id: user.id }, data: { webauthnChallenge: null, lastLoginAt: new Date(), lastLoginIp: req.ip, failedLoginCount: 0, lockedUntil: null } });
    await issueTokens(res, user, req);
    await audit({ action: 'LOGIN_SUCCESS', success: true, userId: user.id, req, metadata: { via: 'webauthn' } });
    res.json({ user: userResponse(user) });
  } catch (err: any) {
    logger.error('webauthn auth verify', { err: err.message });
    res.status(500).json({ error: 'Errore login Face ID.' });
  }
});

// Stato: l'utente ha già un Face ID configurato? (per Impostazioni)
router.get('/webauthn/status', authenticate, async (req: AuthRequest, res: Response) => {
  const count = await prisma.webAuthnCredential.count({ where: { userId: req.user!.userId } });
  res.json({ enabled: count > 0, count });
});

// Rimuove tutte le passkey dell'utente (disattiva Face ID).
router.delete('/webauthn', authenticate, async (req: AuthRequest, res: Response) => {
  await prisma.webAuthnCredential.deleteMany({ where: { userId: req.user!.userId } });
  res.json({ ok: true });
});

export default router;
