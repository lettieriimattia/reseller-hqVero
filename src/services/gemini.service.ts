// src/services/gemini.service.ts
// Vision tramite Google Gemini (free tier su aistudio.google.com).
// Fonte PRIMARIA per la vision (riconoscimento prodotto): qualità nettamente
// superiore a Llama sulle immagini. Fallback automatico a Groq nel chiamante.
// Multi-chiave separate da virgola, rotazione su 429/limiti — come Groq:
//   GEMINI_API_KEY=key1,key2,key3   (su Railway)
//   GEMINI_VISION_MODEL opzionale (default: gemini-2.5-flash)
import { logger } from '../utils/logger';

const GEMINI_KEYS: string[] = (process.env.GEMINI_API_KEY || '')
  .split(',')
  .map(k => k.trim())
  .filter(Boolean);

const GEMINI_VISION_MODEL = process.env.GEMINI_VISION_MODEL || 'gemini-2.5-flash';
const IS_GEMINI_25 = GEMINI_VISION_MODEL.includes('2.5');

// --- Controllo "thinking" (ragionamento prima della risposta) ---
// I 2.5 e i 3.x usano parametri DIVERSI e incompatibili tra loro:
//  - 2.5 → thinkingBudget (numero di token; 0 = spento, più veloce).
//  - 3.x → thinkingLevel ("LOW" | "MEDIUM" | "HIGH").
// NB: inviare entrambi insieme dà errore 400.
//
// Per lo scan (estrazione/classificazione visiva) "LOW" è il livello consigliato:
// risposte quasi istantanee ma con abbastanza ragionamento per riconoscere bene.
// 0 = thinking disattivato (più veloce). Solo per i modelli 2.5.
const THINKING_BUDGET = Number.isFinite(Number(process.env.GEMINI_THINKING_BUDGET))
  ? Number(process.env.GEMINI_THINKING_BUDGET)
  : 0;
// Livello per i 3.x: default LOW (veloce). Alzabile a MEDIUM/HIGH via env per più precisione.
const THINKING_LEVEL = (process.env.GEMINI_THINKING_LEVEL || 'LOW').toUpperCase();

// Restituisce il blocco thinkingConfig corretto per il modello in uso (o {} se non serve).
function thinkingConfigFor(): Record<string, any> {
  if (IS_GEMINI_25) return { thinkingConfig: { thinkingBudget: THINKING_BUDGET } };
  // 3.x e futuri: usa thinkingLevel.
  return { thinkingConfig: { thinkingLevel: THINKING_LEVEL } };
}

// Indice corrente — ruota round-robin sulle chiavi (ognuna ha il suo limite gratuito)
let geminiKeyIndex = 0;

export function isGeminiConfigured(): boolean {
  return GEMINI_KEYS.length > 0;
}

// Info diagnostica (senza esporre le chiavi): quante chiavi e quale modello.
export function getGeminiInfo(): { configured: boolean; keys: number; model: string } {
  return { configured: GEMINI_KEYS.length > 0, keys: GEMINI_KEYS.length, model: GEMINI_VISION_MODEL };
}

// Conferma all'avvio (visibile nei log): se non compare, la chiave non è stata letta.
if (GEMINI_KEYS.length > 0) {
  const thinkInfo = IS_GEMINI_25 ? `thinkingBudget=${THINKING_BUDGET}` : `thinkingLevel=${THINKING_LEVEL}`;
  logger.info(`Gemini vision attivo — ${GEMINI_KEYS.length} chiave/i, modello ${GEMINI_VISION_MODEL} (${thinkInfo})`);
} else {
  logger.info('Gemini non configurato — vision su Groq (Llama)');
}

// Estrae mime type + dati base64 da un data URL (data:image/jpeg;base64,...) o da base64 puro.
function parseImageData(imageBase64: string): { mimeType: string; data: string } {
  const m = imageBase64.match(/^data:([^;]+);base64,(.*)$/s);
  if (m) return { mimeType: m[1], data: m[2] };
  return { mimeType: 'image/jpeg', data: imageBase64 };
}

export interface GeminiVisionOpts {
  prompt: string;
  imageBase64: string;
  extraImages?: string[]; // immagini aggiuntive (es. foto dei candidati StockX da confrontare)
  temperature?: number;
  maxTokens?: number;
  json?: boolean;        // forza output JSON valido (responseMimeType)
}

// Chiamata vision con rotazione chiavi su 429/503/errore di rete.
export async function geminiVision(opts: GeminiVisionOpts): Promise<string> {
  if (GEMINI_KEYS.length === 0) throw new Error('Nessuna chiave GEMINI_API_KEY configurata');
  const { mimeType, data } = parseImageData(opts.imageBase64);
  const extraParts = (opts.extraImages || []).map(img => {
    const p = parseImageData(img);
    return { inline_data: { mime_type: p.mimeType, data: p.data } };
  });
  const body = {
    contents: [{
      parts: [
        { text: opts.prompt },
        { inline_data: { mime_type: mimeType, data } },
        ...extraParts,
      ],
    }],
    generationConfig: {
      temperature: opts.temperature ?? 0.05,
      maxOutputTokens: opts.maxTokens ?? 2048,
      ...(opts.json ? { responseMimeType: 'application/json' } : {}),
      // Thinking adeguato al modello (2.5 → budget · 3.x → level). Vedi thinkingConfigFor().
      ...thinkingConfigFor(),
    },
  };

  let lastErr: any;
  // Numero di tentativi: almeno 3, o quante chiavi se di più. Così anche con UNA
  // sola chiave ritentiamo su 503/429 (transitori) invece di ripiegare subito su Groq.
  const maxAttempts = Math.max(3, GEMINI_KEYS.length);
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const key = GEMINI_KEYS[geminiKeyIndex % GEMINI_KEYS.length];
    try {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_VISION_MODEL}:generateContent?key=${key}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      );
      // 503 = modello sovraccarico (lato Google, transitorio) · 429 = limite/quota.
      // In entrambi i casi ruotiamo chiave E aspettiamo un po' prima di riprovare:
      // il 503 spesso si risolve da solo in 1-2 secondi → evitiamo il fallback a Groq.
      if (r.status === 429 || r.status === 503) {
        const isLast = attempt === maxAttempts - 1;
        logger.warn('Gemini limite/sovraccarico, ritento', {
          status: r.status,
          key: `#${(geminiKeyIndex % GEMINI_KEYS.length) + 1}/${GEMINI_KEYS.length}`,
          attempt: `${attempt + 1}/${maxAttempts}`,
        });
        geminiKeyIndex = (geminiKeyIndex + 1) % GEMINI_KEYS.length;
        lastErr = new Error(`Gemini ${r.status}`);
        if (!isLast) await sleep(700 * (attempt + 1)); // backoff: 700ms, 1.4s, ...
        continue;
      }
      if (!r.ok) {
        const txt = await r.text().catch(() => '');
        throw new Error(`Gemini ${r.status}: ${txt.slice(0, 200)}`);
      }
      const json = await r.json() as any;
      const text = (json?.candidates?.[0]?.content?.parts || [])
        .map((p: any) => p?.text || '')
        .join('');
      return text.trim();
    } catch (err: any) {
      lastErr = err;
      geminiKeyIndex = (geminiKeyIndex + 1) % GEMINI_KEYS.length;
    }
  }
  throw lastErr || new Error('Gemini non disponibile');
}

// Pausa breve per il backoff tra i tentativi.
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
