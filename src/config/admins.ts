// src/config/admins.ts
// Account admin. Hard-coded (NON modificabili via env) così nessuna configurazione
// errata o variabile d'ambiente può concedere l'admin ad altri.
// Questi account sono anche i "beta tester": vedono le funzioni in beta prima di tutti.

export const ADMIN_EMAILS = ['noreply.hq.app@gmail.com', 'ciaociao@gmail.com'];
export const ADMIN_EMAIL = ADMIN_EMAILS[0]; // destinatario notifiche (es. feedback)

export function isAdminEmail(email?: string | null): boolean {
  return !!email && ADMIN_EMAILS.includes(email.toLowerCase());
}
