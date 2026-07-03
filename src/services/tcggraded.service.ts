// src/services/tcggraded.service.ts
// Prezzi CARTE GRADATE (PSA/BGS/CGC) via TCG Price Lookup (tcgpricelookup.com).
// Piano con limite di 100 richieste/giorno → teniamo un contatore PERSISTENTE (tabella Setting,
// così i riavvii di Render non lo azzerano). Superato il limite → il chiamante fa fallback al
// prezzo RAW (non gradata), dichiarandolo.
//
// Chiave: TCGPRICELOOKUP_API_KEY  (Render → Environment, e in locale nel .env)
// Override opzionali: TCGPRICELOOKUP_BASE_URL, TCGPRICELOOKUP_DAILY_LIMIT
//
// NB: l'endpoint/formato esatti vanno confermati alla prima chiamata reale con la chiave:
// il parsing qui sotto è difensivo (cerca il prezzo del grado richiesto in vari punti del JSON).

import { prisma } from '../lib/prisma';
import { logger } from '../utils/logger';

const API_KEY = (process.env.TCGPRICELOOKUP_API_KEY || '').trim();
const BASE_URL = (process.env.TCGPRICELOOKUP_BASE_URL || 'https://api.tcgpricelookup.com/v1').replace(/\/$/, '');
const DAILY_LIMIT = Math.max(1, parseInt(process.env.TCGPRICELOOKUP_DAILY_LIMIT || '100', 10) || 100);
const USAGE_KEY = 'tcgpl_usage'; // Setting: { date: 'YYYY-MM-DD', count: number }

export function isGradedApiConfigured(): boolean {
  return !!API_KEY;
}

export interface GradedResult {
  value: number | null;     // prezzo della gradata richiesta
  currency: string;         // valuta (di norma USD dai venduti eBay/TCGplayer)
  grade: number | null;
  source: string;
  blocked?: boolean;        // true = limite giornaliero raggiunto (il chiamante fa fallback al raw)
}

// Legge/incrementa il contatore giornaliero. Ritorna true se c'è ancora quota (e la consuma).
async function consumeDailyQuota(): Promise<boolean> {
  const today = new Date().toISOString().slice(0, 10);
  try {
    const s = await prisma.setting.findUnique({ where: { key: USAGE_KEY } });
    let count = 0;
    if (s?.value) { try { const j = JSON.parse(s.value); if (j.date === today) count = Number(j.count) || 0; } catch { /* valore vecchio */ } }
    if (count >= DAILY_LIMIT) return false;
    const next = JSON.stringify({ date: today, count: count + 1 });
    await prisma.setting.upsert({ where: { key: USAGE_KEY }, create: { key: USAGE_KEY, value: next }, update: { value: next } });
    return true;
  } catch (e: any) {
    // Se il DB non risponde, per prudenza NON blocchiamo (una chiamata in più è meglio di zero valutazioni).
    logger.warn('tcggraded: quota check fallita', { err: e?.message });
    return true;
  }
}

// Quante richieste restano oggi (per mostrarlo eventualmente in admin).
export async function gradedQuotaLeft(): Promise<number> {
  const today = new Date().toISOString().slice(0, 10);
  try {
    const s = await prisma.setting.findUnique({ where: { key: USAGE_KEY } });
    let count = 0;
    if (s?.value) { try { const j = JSON.parse(s.value); if (j.date === today) count = Number(j.count) || 0; } catch {} }
    return Math.max(0, DAILY_LIMIT - count);
  } catch { return DAILY_LIMIT; }
}

// Cerca in profondità un numero plausibile per il grado richiesto (parsing difensivo finché non
// confermiamo il formato esatto della risposta). Es. chiavi tipo "psa10", "PSA 10", "psa_10".
function extractGradePrice(obj: any, grade: number | null): number | null {
  if (obj == null || grade == null) return null;
  const wantKeys = [`psa${grade}`, `psa ${grade}`, `psa_${grade}`, `bgs${grade}`, `cgc${grade}`, `${grade}`];
  const norm = (k: string) => k.toString().toLowerCase().replace(/[\s._-]/g, '');
  const targets = new Set(wantKeys.map(norm));
  let found: number | null = null;
  const visit = (node: any, keyHint = '') => {
    if (found != null || node == null) return;
    if (typeof node === 'number') { if (targets.has(norm(keyHint))) found = node; return; }
    if (typeof node === 'string') { const n = parseFloat(node.replace(',', '.')); if (!isNaN(n) && targets.has(norm(keyHint))) found = n; return; }
    if (Array.isArray(node)) { node.forEach(x => visit(x, keyHint)); return; }
    if (typeof node === 'object') {
      // caso {grade:'PSA 10', price: 900}
      const gradeStr = norm(node.grade || node.name || node.label || '');
      if (gradeStr && targets.has(gradeStr)) {
        const p = node.price ?? node.value ?? node.market ?? node.median ?? node.avg;
        const n = typeof p === 'string' ? parseFloat(p) : p;
        if (typeof n === 'number' && !isNaN(n)) { found = n; return; }
      }
      for (const k of Object.keys(node)) visit(node[k], k);
    }
  };
  visit(obj);
  return found;
}

// Prezzo della carta GRADATA. Ritorna { blocked:true } se il limite giornaliero è finito.
export async function getGradedCardValue(opts: { name?: string; number?: string; game?: string; grade: number | null }): Promise<GradedResult> {
  const none: GradedResult = { value: null, currency: 'USD', grade: opts.grade, source: 'TCG Price Lookup' };
  if (!API_KEY) return none;
  const ok = await consumeDailyQuota();
  if (!ok) return { ...none, blocked: true };

  try {
    const q = [opts.name, opts.number].filter(Boolean).join(' ').trim();
    const game = (opts.game || 'pokemon').toLowerCase();
    const url = `${BASE_URL}/cards?game=${encodeURIComponent(game)}&search=${encodeURIComponent(q)}&graded=1`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${API_KEY}`, Accept: 'application/json' } });
    if (!r.ok) { logger.warn('tcggraded: HTTP non ok', { status: r.status }); return none; }
    const data: any = await r.json().catch(() => null);
    if (!data) return none;
    // Log una tantum della forma, così affiniamo il parsing dopo il primo test reale.
    logger.info('tcggraded risposta', { keys: data && typeof data === 'object' ? Object.keys(data).slice(0, 8) : typeof data });
    const first = Array.isArray(data?.data) ? data.data[0] : (Array.isArray(data) ? data[0] : data?.card || data);
    const value = extractGradePrice(first, opts.grade);
    const cur = (first?.currency || data?.currency || 'USD').toString().toUpperCase();
    return { value: value != null ? Math.round(value * 100) / 100 : null, currency: cur, grade: opts.grade, source: `TCG Price Lookup${opts.grade != null ? ` · PSA ${opts.grade}` : ''}` };
  } catch (e: any) {
    logger.warn('tcggraded errore', { err: e?.message });
    return none;
  }
}
