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
// 0 = thinking disattivato (più veloce). Solo per i modelli 2.5.
const THINKING_BUDGET = Number.isFinite(Number(process.env.GEMINI_THINKING_BUDGET))
  ? Number(process.env.GEMINI_THINKING_BUDGET)
  : 0;

// Indice corrente — ruota round-robin sulle chiavi (ognuna ha il suo limite gratuito)
let geminiKeyIndex = 0;

export function isGeminiConfigured(): boolean {
  return GEMINI_KEYS.length > 0;
}

// Conferma all'avvio (visibile nei log Railway): se non compare, la chiave non è stata letta.
if (GEMINI_KEYS.length > 0) {
  logger.info(`Gemini vision attivo — ${GEMINI_KEYS.length} chiave/i, modello ${GEMINI_VISION_MODEL}`);
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
  temperature?: number;
  maxTokens?: number;
  json?: boolean;        // forza output JSON valido (responseMimeType)
}

// Chiamata vision con rotazione chiavi su 429/503/errore di rete.
export async function geminiVision(opts: GeminiVisionOpts): Promise<string> {
  if (GEMINI_KEYS.length === 0) throw new Error('Nessuna chiave GEMINI_API_KEY configurata');
  const { mimeType, data } = parseImageData(opts.imageBase64);
  const body = {
    contents: [{
      parts: [
        { text: opts.prompt },
        { inline_data: { mime_type: mimeType, data } },
      ],
    }],
    generationConfig: {
      temperature: opts.temperature ?? 0.05,
      maxOutputTokens: opts.maxTokens ?? 1024,
      ...(opts.json ? { responseMimeType: 'application/json' } : {}),
      // I modelli 2.5 di default "ragionano" prima di rispondere: aggiunge molti
      // secondi. Per lo scan (classificazione visiva) il thinking non serve → lo
      // disattiviamo (budget 0). Override via GEMINI_THINKING_BUDGET se necessario.
      ...(GEMINI_VISION_MODEL.includes('2.5')
        ? { thinkingConfig: { thinkingBudget: THINKING_BUDGET } }
        : {}),
    },
  };

  let lastErr: any;
  // Un tentativo per chiave: se tutte falliscono, il chiamante ripiega su Groq.
  for (let attempt = 0; attempt < GEMINI_KEYS.length; attempt++) {
    const key = GEMINI_KEYS[geminiKeyIndex % GEMINI_KEYS.length];
    try {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_VISION_MODEL}:generateContent?key=${key}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      );
      if (r.status === 429 || r.status === 503) {
        logger.warn('Gemini limite/sovraccarico, ruoto chiave', { status: r.status, key: `#${(geminiKeyIndex % GEMINI_KEYS.length) + 1}/${GEMINI_KEYS.length}` });
        geminiKeyIndex = (geminiKeyIndex + 1) % GEMINI_KEYS.length;
        lastErr = new Error(`Gemini ${r.status}`);
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
