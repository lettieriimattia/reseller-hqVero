// src/utils/security.ts
// Utility crittografiche per Reseller HQ

import crypto from 'crypto';

// ==========================================
// CIFRATURA AES-256-GCM (per 2FA secrets)
// ==========================================
// Usata per cifrare i secret TOTP nel database. Anche se il DB è compromesso,
// senza ENCRYPTION_KEY i secret 2FA sono inutili.

const ALGORITHM = 'aes-256-gcm';

function getEncryptionKey(): Buffer {
  const key = process.env.ENCRYPTION_KEY;
  if (!key || key.length !== 64) {
    throw new Error('ENCRYPTION_KEY mancante o invalida (deve essere 64 char hex)');
  }
  return Buffer.from(key, 'hex');
}

export function encrypt(plaintext: string): string {
  const iv = crypto.randomBytes(12); // GCM raccomanda 12 byte
  const cipher = crypto.createCipheriv(ALGORITHM, getEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Formato: iv:authTag:ciphertext (tutto in base64)
  return `${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted.toString('base64')}`;
}

export function decrypt(ciphertext: string): string {
  const parts = ciphertext.split(':');
  if (parts.length !== 3) throw new Error('Formato cifrato non valido');
  
  const iv = Buffer.from(parts[0], 'base64');
  const authTag = Buffer.from(parts[1], 'base64');
  const encrypted = Buffer.from(parts[2], 'base64');
  
  const decipher = crypto.createDecipheriv(ALGORITHM, getEncryptionKey(), iv);
  decipher.setAuthTag(authTag);
  
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('utf8');
}

// ==========================================
// GENERATORE CODICI SICURI
// ==========================================
// Math.random() è prevedibile. Usiamo crypto per i codici invito e backup.

export function generateInviteCode(): string {
  // Esempio: "INV-7K2H9P4M3X8N"
  const bytes = crypto.randomBytes(8);
  const code = bytes.toString('base64')
    .replace(/[+/=]/g, '')
    .toUpperCase()
    .slice(0, 12);
  return `INV-${code}`;
}

export function generateBackupCodes(count = 10): string[] {
  // Codici di backup per 2FA: 10 codici da 8 caratteri ciascuno
  return Array.from({ length: count }, () => {
    const bytes = crypto.randomBytes(5);
    return bytes.toString('hex').toUpperCase().slice(0, 8);
  });
}

export function generateRefreshToken(): string {
  // Token opaco di 64 byte
  return crypto.randomBytes(64).toString('base64url');
}

export function hashRefreshToken(token: string): string {
  // Hashing veloce (non bcrypt) per i refresh token, dato che sono già ad alta entropia
  return crypto.createHash('sha256').update(token).digest('hex');
}

// ==========================================
// PASSWORD POLICY
// ==========================================
export interface PasswordValidation {
  valid: boolean;
  errors: string[];
}

export function validatePassword(password: string): PasswordValidation {
  const errors: string[] = [];
  
  if (password.length < 10) errors.push('Almeno 10 caratteri');
  if (password.length > 128) errors.push('Massimo 128 caratteri');
  if (!/[A-Z]/.test(password)) errors.push('Almeno una lettera maiuscola');
  if (!/[a-z]/.test(password)) errors.push('Almeno una lettera minuscola');
  if (!/[0-9]/.test(password)) errors.push('Almeno un numero');
  if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?`~]/.test(password)) {
    errors.push('Almeno un carattere speciale');
  }
  
  // Password comuni vietate
  const common = ['password', '12345678', 'qwerty', 'admin', 'reseller', 'pokemon'];
  if (common.some(c => password.toLowerCase().includes(c))) {
    errors.push('Password troppo comune o prevedibile');
  }
  
  return { valid: errors.length === 0, errors };
}

// ==========================================
// SANITIZZAZIONE
// ==========================================
export function sanitizeString(input: string, maxLen = 200): string {
  // Rimuove caratteri di controllo e tronca a maxLen
  return input
    .replace(/[\x00-\x1F\x7F]/g, '')
    .trim()
    .slice(0, maxLen);
}

// ==========================================
// CONFRONTO TIMING-SAFE
// ==========================================
// Per confrontare token/codici senza esporre timing attacks
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
