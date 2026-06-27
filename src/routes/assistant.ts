// src/routes/assistant.ts
// CHATBOX assistente (BETA · solo admin). Chat testuale con Groq + TOOL-CALLING:
// l'utente scrive in linguaggio naturale ("aggiungi le Jordan 4 taglia 42 a 180")
// e l'assistente esegue azioni reali (cerca nel catalogo, aggiunge il prodotto, valuta).
//
// Niente chiavi nuove: usa la GROQ_API_KEY già configurata.

import { Router, Response } from 'express';
import { prisma } from '../lib/prisma';
import { authenticate, AuthRequest } from '../middleware/auth';
import { apiLimiter } from '../middleware/rateLimit';
import { isAdminEmail } from '../config/admins';
import { groqAssistantChat, isGroqConfigured, groqTranscribe } from '../services/ai.service';
import { searchStockXCandidates, getStockXValuation, isStockXConfigured } from '../services/stockx.service';
import { kicksSearch, isKicksConfigured } from '../services/kicksdb.service';
import { checkProductQuota } from '../middleware/plan';
import { logger } from '../utils/logger';

const router = Router();
router.use(authenticate, apiLimiter);

function adminOnly(req: AuthRequest, res: Response, next: any) {
  if (!isAdminEmail(req.user?.email)) return res.status(403).json({ error: 'Assistente in beta (solo admin).' });
  next();
}

// ---- Definizione dei TOOL esposti al modello ----
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'cerca_catalogo',
      description: 'Cerca un modello (sneaker o abbigliamento) nel catalogo StockX per nome o SKU. Usalo per trovare il prodotto giusto prima di aggiungerlo.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Nome modello o SKU, es. "Jordan 4 Bred" o "DV1748-100"' },
          tipo: { type: 'string', enum: ['sneakers', 'apparel'], description: 'Filtra per tipo (facoltativo)' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'aggiungi_prodotto',
      description: 'Aggiunge un prodotto al magazzino dell\'utente. Usa i dati forniti dall\'utente; prezzo/taglia possono mancare (si mettono dopo).',
      parameters: {
        type: 'object',
        properties: {
          brand: { type: 'string', description: 'Marca, es. "Jordan", "Nike", "Palace"' },
          nome: { type: 'string', description: 'Nome del modello, es. "Jordan 4 Retro Bred"' },
          sku: { type: 'string', description: 'Style code/SKU (facoltativo)' },
          taglia: { type: 'string', description: 'Taglia, es. "42" o "M" (facoltativo)' },
          // Union number|string: i modelli Groq a volte emettono "200" (stringa) e la
          // validazione tool fallirebbe con 400. executeTool fa comunque Number(...).
          prezzo: { type: ['number', 'string'], description: 'Prezzo d\'acquisto in euro (facoltativo, default 0). Solo cifre, es. 200.' },
          condizione: { type: 'string', description: 'Condizione, es. "Nuovo" (facoltativo)' },
          categoria: { type: 'string', description: 'Reparto/categoria, es. "Scarpe" (facoltativo)' },
        },
        required: ['brand', 'nome'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'valuta_prezzo',
      description: 'Stima il valore di mercato di un prodotto su StockX per nome/SKU e taglia.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Nome o SKU del prodotto' },
          taglia: { type: 'string', description: 'Taglia (facoltativo)' },
          sku: { type: 'string', description: 'SKU (facoltativo)' },
        },
        required: ['query'],
      },
    },
  },
];

const SYSTEM_PROMPT = `Sei "HQ", l'assistente di ResellerHQ (gestionale per reseller di sneaker/streetwear).
Aiuti l'utente a: cercare modelli nel catalogo, aggiungere prodotti al magazzino, valutarne il prezzo.
Regole:
- Rispondi SEMPRE in italiano, in modo breve e amichevole.
- Quando l'utente vuole inserire un prodotto, usa il tool "aggiungi_prodotto" con i dati che ti dà; se manca la taglia o il prezzo va bene lo stesso (li metterà dopo).
- Se non sei sicuro del modello esatto, usa "cerca_catalogo" e proponi i risultati.
- Dopo un'azione, conferma in una riga cosa hai fatto (es. "✅ Aggiunto: Jordan 4 Bred, taglia 42").
- Non inventare prezzi: se servono usa "valuta_prezzo".`;

// Trova il magazzino di destinazione dell'utente (OWNER top-level, altrimenti il primo).
async function findTargetWarehouse(userId: string): Promise<string | null> {
  const memberships = await prisma.membership.findMany({ where: { userId }, include: { warehouse: true } });
  if (!memberships.length) return null;
  const owner = memberships.find(m => m.role === 'OWNER' && !m.warehouse.parentId);
  return (owner || memberships[0]).warehouseId;
}

// Categoria di default se l'utente/modello non la specifica: riusa una categoria già presente.
async function defaultCategory(userId: string, hint?: string): Promise<string> {
  if (hint && hint.trim()) return hint.trim();
  const existing = await prisma.product.findFirst({
    where: { userId, deletedAt: null }, select: { category: true }, orderBy: { createdAt: 'desc' },
  });
  return existing?.category || 'Scarpe';
}

// ---- Esecuzione di un singolo tool ----
async function executeTool(name: string, args: any, ctx: { userId: string }): Promise<any> {
  try {
    if (name === 'cerca_catalogo') {
      if (!isStockXConfigured()) return { error: 'Catalogo non disponibile (StockX non configurato).' };
      const cands = await searchStockXCandidates(String(args.query || ''), {
        sneakersOnly: args.tipo === 'sneakers', limit: 6,
      }).catch(() => []);
      return { risultati: cands.map(c => ({ nome: c.title, sku: c.styleId, foto: c.image })) };
    }

    if (name === 'aggiungi_prodotto') {
      const brand = String(args.brand || '').trim();
      const nome = String(args.nome || '').trim();
      if (!brand || !nome) return { error: 'Servono almeno marca e nome.' };
      const quotaErr = await checkProductQuota(ctx.userId, 1);
      if (quotaErr) return { error: 'Hai raggiunto il limite di prodotti del tuo piano.' };
      const warehouseId = await findTargetWarehouse(ctx.userId);
      if (!warehouseId) return { error: 'Nessun magazzino trovato per l\'utente.' };
      const category = await defaultCategory(ctx.userId, args.categoria);

      // Foto ufficiale dal catalogo (come fa la schermata Catalogo): cerca per SKU o nome e
      // salva il LINK diretto dell'immagine — niente Cloudinary, DB piccolo. KicksDB primario,
      // StockX fallback. Se trovo lo style code lo aggancio anch'esso al prodotto.
      let photo: string | null = null;
      let resolvedSku: string | null = args.sku ? String(args.sku).trim() : null;
      const q = resolvedSku || `${brand} ${nome}`;
      try {
        let best: { image: string | null; styleId: string | null } | undefined;
        if (isKicksConfigured()) {
          const k = await kicksSearch(q, { limit: 5 });
          best = k.find(c => c.image) || k[0];
        }
        if ((!best || !best.image) && isStockXConfigured()) {
          const s = await searchStockXCandidates(q, { limit: 5 });
          best = s.find(c => c.image) || s[0] || best;
        }
        if (best?.image) photo = best.image;
        if (!resolvedSku && best?.styleId) resolvedSku = best.styleId;
      } catch { /* foto facoltativa: se il catalogo non risponde, aggiungo comunque */ }

      const product = await prisma.product.create({
        data: {
          category, brand, name: nome,
          size: (args.taglia ? String(args.taglia) : '').trim() || '—',
          condition: (args.condizione ? String(args.condizione) : '').trim() || '—',
          purchasePrice: Number(args.prezzo) > 0 ? Number(args.prezzo) : 0,
          status: 'IN STOCK',
          userId: ctx.userId, warehouseId,
          sku: resolvedSku || null,
          photos: photo ? JSON.stringify([photo]) : null,
        },
      });
      return { ok: true, id: product.id, aggiunto: `${brand} ${nome}`, taglia: product.size, prezzo: product.purchasePrice, foto: !!photo };
    }

    if (name === 'valuta_prezzo') {
      const val = await getStockXValuation({
        query: String(args.query || ''), size: args.taglia ? String(args.taglia) : undefined,
        sku: args.sku ? String(args.sku) : undefined,
      });
      return { valore: val.value, fonte: val.source, modello: val.itemName };
    }

    return { error: 'Tool sconosciuto.' };
  } catch (e: any) {
    logger.error('executeTool', { name, err: e.message });
    return { error: 'Errore esecuzione azione.' };
  }
}

// Recupero da "tool_use_failed" di Groq: quando il modello genera una tool-call che
// non passa la validazione schema, Groq risponde 400 con il testo grezzo dentro
// `failed_generation` (formato <function=nome>{...}</function>). La estraiamo ed eseguiamo
// a mano, così una singola generazione sbagliata non fa fallire tutta la chat.
function parseFailedToolCall(err: any): { name: string; args: any } | null {
  try {
    const fg = err?.error?.error?.failed_generation ?? err?.error?.failed_generation;
    if (typeof fg !== 'string') return null;
    const mt = fg.match(/<function=([^>\s]+)\s*>([\s\S]*?)<\/function>/);
    if (!mt) return null;
    return { name: mt[1].trim(), args: JSON.parse(mt[2]) };
  } catch { return null; }
}

// Risposta sintetica per una tool-call eseguita in recupero (senza un altro giro di modello).
function summarizeToolResult(name: string, result: any): string {
  if (result?.error) return `⚠️ ${result.error}`;
  if (name === 'aggiungi_prodotto' && result?.ok) {
    const taglia = result.taglia && result.taglia !== '—' ? `, taglia ${result.taglia}` : '';
    return `✅ Aggiunto: ${result.aggiunto}${taglia}${result.foto ? ' (con foto)' : ''}.`;
  }
  if (name === 'valuta_prezzo' && result?.valore != null) return `💶 ${result.modello || 'Valore'}: circa ${result.valore}€ (${result.fonte}).`;
  return '✅ Fatto.';
}

// POST /api/assistant/message — { messages: [{role:'user'|'assistant', content}] }
// Esegue il loop di tool-calling (max 3 round) e ritorna la risposta finale + azioni.
router.post('/message', adminOnly, async (req: AuthRequest, res: Response) => {
  if (!isGroqConfigured()) return res.status(503).json({ error: 'Assistente non disponibile (Groq non configurato).' });
  try {
    const clientMessages = Array.isArray(req.body?.messages) ? req.body.messages : [];
    // Igienizza: solo role/content testuali, ultimi 12 messaggi.
    const history = clientMessages
      .filter((m: any) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .slice(-12)
      .map((m: any) => ({ role: m.role, content: m.content.slice(0, 2000) }));
    if (!history.length) return res.status(400).json({ error: 'Messaggio vuoto.' });

    const msgs: any[] = [{ role: 'system', content: SYSTEM_PROMPT }, ...history];
    const actions: any[] = [];
    const ctx = { userId: req.user!.userId };

    for (let round = 0; round < 3; round++) {
      let m: any;
      try {
        m = await groqAssistantChat({ messages: msgs, tools: TOOLS });
      } catch (err: any) {
        // Groq ha rifiutato la tool-call (validazione schema): eseguila a mano e rispondi.
        const failed = err?.status === 400 ? parseFailedToolCall(err) : null;
        if (!failed) throw err;
        const result = await executeTool(failed.name, failed.args, ctx);
        actions.push({ tool: failed.name, args: failed.args, result });
        return res.json({ reply: summarizeToolResult(failed.name, result), actions });
      }
      if (!m) break;

      if (m.tool_calls && m.tool_calls.length) {
        msgs.push({ role: 'assistant', content: m.content || '', tool_calls: m.tool_calls });
        for (const tc of m.tool_calls) {
          let args: any = {};
          try { args = JSON.parse(tc.function?.arguments || '{}'); } catch {}
          const result = await executeTool(tc.function?.name, args, ctx);
          actions.push({ tool: tc.function?.name, args, result });
          msgs.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
        }
        continue; // lascia che il modello risponda con i risultati dei tool
      }

      // Risposta finale (niente altri tool)
      return res.json({ reply: m.content || '', actions });
    }
    // Esauriti i round: ultima risposta best-effort
    return res.json({ reply: 'Fatto.', actions });
  } catch (e: any) {
    logger.error('POST /assistant/message', { err: e.message });
    res.status(500).json({ error: 'Errore assistente' });
  }
});

// Estensione file dal mime dell'audio del browser (Whisper accetta webm/m4a/mp4/ogg/wav/mp3).
function extFromMime(mime?: string): string {
  const m = (mime || '').toLowerCase();
  if (m.includes('webm')) return 'webm';
  if (m.includes('ogg')) return 'ogg';
  if (m.includes('wav')) return 'wav';
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  if (m.includes('mp4') || m.includes('m4a') || m.includes('aac') || m.includes('x-m4a')) return 'm4a';
  return 'webm';
}

// POST /api/assistant/transcribe — { audioBase64: string, mime?: string } → { text }
// Trascrive con Whisper (Groq) l'audio registrato dal browser. Serve perché Safari iOS
// non ha lo speech-to-text nativo: mic manuale e wake-word "Ehy HQ" passano da qui.
router.post('/transcribe', adminOnly, async (req: AuthRequest, res: Response) => {
  if (!isGroqConfigured()) return res.status(503).json({ error: 'Trascrizione non disponibile (Groq non configurato).' });
  try {
    const { audioBase64, mime } = req.body || {};
    if (typeof audioBase64 !== 'string' || !audioBase64) return res.status(400).json({ error: 'Audio mancante.' });
    // Limite ~8MB base64 (~6MB audio): la chatbox registra clip di pochi secondi.
    if (audioBase64.length > 8 * 1024 * 1024) return res.status(413).json({ error: 'Audio troppo lungo (max ~30s).' });
    const b64 = audioBase64.includes(',') ? audioBase64.split(',')[1] : audioBase64;
    const buf = Buffer.from(b64, 'base64');
    if (!buf.length) return res.status(400).json({ error: 'Audio non valido.' });
    const text = await groqTranscribe(buf, `audio.${extFromMime(mime)}`, { language: 'it' });
    res.json({ text });
  } catch (e: any) {
    logger.error('POST /assistant/transcribe', { err: e.message });
    res.status(500).json({ error: 'Errore trascrizione' });
  }
});

export default router;
