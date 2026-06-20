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
import { logger } from '../utils/logger';

const router = Router();

const BCRYPT_ROUNDS = 12;
const MAX_LOGIN_FAILS = 5;
const LOCK_DURATION_MS = 15 * 60 * 1000; // 15 minuti

// ==========================================
// HELPER: setta cookies access + refresh
// ==========================================
async function issueTokens(res: Response, user: { id: string; email: string }, req: Request) {
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
      await prisma.$transaction(async (tx) => {
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
        
        await tx.user.create({
          data: {
            email, password: hashedPassword, name,
            marketingConsent: marketingConsent === true,
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
      return res.json({ message: 'Sei entrato nel team con successo! Effettua il login.' });
    }
    
    // CASO 2: Nuovo utente → parte con UN SOLO magazzino base "Il mio magazzino"
    // (da solo, senza soci). Le categorie sono trasversali e si creano al volo
    // dopo (foto/IA o a mano), non più legate al magazzino.
    await prisma.user.create({
      data: {
        email, password: hashedPassword, name,
        marketingConsent: marketingConsent === true,
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
    
    // Password OK - verifica 2FA se abilitato
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
    const otpauth = authenticator.keyuri(user.email, 'Reseller HQ', secret);
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

export default router;
