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

// Modello di RISERVA: se il principale è sovraccarico (503) o a quota piena (429) su
// TUTTE le chiavi, prima di ripiegare su Groq proviamo questo modello (di solito meno
// congestionato del flash "di punta"). Disattivabile con GEMINI_FALLBACK_MODEL=off.
const GEMINI_FALLBACK_MODEL = (() => {
  const env = process.env.GEMINI_FALLBACK_MODEL;
  if (env === 'off') return '';
  const fb = env || 'gemini-2.5-flash';
  return fb === GEMINI_VISION_MODEL ? '' : fb; // inutile se uguale al principale
})();

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

// Restituisce il blocco thinkingConfig corretto per il modello DATO (i 2.5 e i 3.x
// usano parametri diversi e incompatibili → va calcolato sul modello effettivo).
function thinkingConfigFor(model: string): Record<string, any> {
  if (model.includes('2.5')) return { thinkingConfig: { thinkingBudget: THINKING_BUDGET } };
  // 3.x e futuri: usa thinkingLevel.
  return { thinkingConfig: { thinkingLevel: THINKING_LEVEL } };
}

// Indice corrente — ruota round-robin sulle chiavi (ognuna ha il suo limite gratuito)
let geminiKeyIndex = 0;

export function isGeminiConfigured(): boolean {
  return GEMINI_KEYS.length > 0;
}

// Info diagnostica (senza esporre le chiavi): quante chiavi e quale modello.
export function getGeminiInfo(): { configured: boolean; keys: number; model: string; fallbackModel: string } {
  return { configured: GEMINI_KEYS.length > 0, keys: GEMINI_KEYS.length, model: GEMINI_VISION_MODEL, fallbackModel: GEMINI_FALLBACK_MODEL };
}

// Conferma all'avvio (visibile nei log): se non compare, la chiave non è stata letta.
if (GEMINI_KEYS.length > 0) {
  const thinkInfo = IS_GEMINI_25 ? `thinkingBudget=${THINKING_BUDGET}` : `thinkingLevel=${THINKING_LEVEL}`;
  const fbInfo = GEMINI_FALLBACK_MODEL ? `, riserva ${GEMINI_FALLBACK_MODEL}` : '';
  logger.info(`Gemini vision attivo — ${GEMINI_KEYS.length} chiave/i, modello ${GEMINI_VISION_MODEL} (${thinkInfo})${fbInfo}`);
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

// Chiamata vision: prova il modello principale (rotazione chiavi + retry); se è
// sovraccarico/quota piena su tutte le chiavi, prova il modello di RISERVA prima di
// arrendersi (il chiamante poi ripiega su Groq).
export async function geminiVision(opts: GeminiVisionOpts): Promise<string> {
  if (GEMINI_KEYS.length === 0) throw new Error('Nessuna chiave GEMINI_API_KEY configurata');
  const { mimeType, data } = parseImageData(opts.imageBase64);
  const extraParts = (opts.extraImages || []).map(img => {
    const p = parseImageData(img);
    return { inline_data: { mime_type: p.mimeType, data: p.data } };
  });
  const contents = [{
    parts: [
      { text: opts.prompt },
      { inline_data: { mime_type: mimeType, data } },
      ...extraParts,
    ],
  }];

  try {
    return await callGeminiModel(GEMINI_VISION_MODEL, contents, opts);
  } catch (err: any) {
    if (GEMINI_FALLBACK_MODEL) {
      logger.warn('Gemini principale non disponibile, provo il modello di riserva', {
        principale: GEMINI_VISION_MODEL, riserva: GEMINI_FALLBACK_MODEL, err: err?.message,
      });
      return await callGeminiModel(GEMINI_FALLBACK_MODEL, contents, opts);
    }
    throw err;
  }
}

// Esegue la chiamata per UN modello: rotazione chiavi + retry con backoff su 429/503.
async function callGeminiModel(model: string, contents: any[], opts: GeminiVisionOpts): Promise<string> {
  const body = {
    contents,
    generationConfig: {
      temperature: opts.temperature ?? 0.05,
      maxOutputTokens: opts.maxTokens ?? 2048,
      ...(opts.json ? { responseMimeType: 'application/json' } : {}),
      // Thinking adeguato al modello (2.5 → budget · 3.x → level).
      ...thinkingConfigFor(model),
    },
  };

  let lastErr: any;
  // Almeno 3 tentativi, o quante chiavi se di più: anche con una sola chiave ritentiamo
  // su 503/429 (transitori) invece di arrenderci subito.
  const maxAttempts = Math.max(3, GEMINI_KEYS.length);
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const key = GEMINI_KEYS[geminiKeyIndex % GEMINI_KEYS.length];
    try {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      );
      // 503 = modello sovraccarico (lato Google, transitorio) · 429 = limite/quota.
      if (r.status === 429 || r.status === 503) {
        const isLast = attempt === maxAttempts - 1;
        logger.warn('Gemini limite/sovraccarico, ritento', {
          model,
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
