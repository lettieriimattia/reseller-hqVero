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
import { groqAssistantChat, isGroqConfigured, groqTranscribe } from '../services/ai.service';
import { searchStockXCandidates, getStockXValuation, isStockXConfigured } from '../services/stockx.service';
import { kicksSearch, isKicksConfigured } from '../services/kicksdb.service';
import { checkProductQuota } from '../middleware/plan';
import { logger } from '../utils/logger';

const router = Router();
router.use(authenticate, apiLimiter);
// Chat assistente + catalogo ora APERTI a tutti gli utenti autenticati (non più solo admin).

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
          quantita: { type: ['number', 'string'], description: 'Quante unità IDENTICHE aggiungere (default 1). Es. "aggiungi 4 Jordan 4 uguali" → 4.' },
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
  {
    type: 'function',
    function: {
      name: 'modifica_prodotto',
      description: 'Modifica un prodotto GIÀ presente in magazzino (prezzo d\'acquisto, taglia, condizione o categoria). Individua il prodotto per marca+nome (e taglia se serve). Usalo quando l\'utente dice "cambia/modifica/correggi" un articolo che ha già.',
      parameters: {
        type: 'object',
        properties: {
          brand: { type: 'string', description: 'Marca per individuare il prodotto (facoltativo)' },
          nome: { type: 'string', description: 'Nome del modello da modificare' },
          taglia: { type: 'string', description: 'Taglia attuale per individuarlo (facoltativo)' },
          nuovo_prezzo: { type: ['number', 'string'], description: 'Nuovo prezzo d\'acquisto in euro (facoltativo)' },
          nuova_taglia: { type: 'string', description: 'Nuova taglia (facoltativo)' },
          nuova_condizione: { type: 'string', description: 'Nuova condizione, es. "Nuovo" (facoltativo)' },
          nuova_categoria: { type: 'string', description: 'Nuova categoria/reparto (facoltativo)' },
        },
        required: ['nome'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'vendi_prodotto',
      description: 'Vende uno o più articoli GIÀ in magazzino: li segna come VENDUTO col prezzo di vendita. Individua per marca+nome (e taglia). Usalo quando l\'utente dice "vendi/ho venduto X a Y euro".',
      parameters: {
        type: 'object',
        properties: {
          brand: { type: 'string', description: 'Marca per individuare il prodotto (facoltativo)' },
          nome: { type: 'string', description: 'Nome del modello venduto' },
          taglia: { type: 'string', description: 'Taglia per individuarlo (facoltativo)' },
          prezzo_vendita: { type: ['number', 'string'], description: 'Prezzo di vendita per unità, in euro' },
          piattaforma: { type: 'string', description: 'Dove l\'hai venduto: Vinted/StockX/eBay/Subito/Privato (facoltativo)' },
          quantita: { type: ['number', 'string'], description: 'Quante unità vendere (default 1)' },
        },
        required: ['nome', 'prezzo_vendita'],
      },
    },
  },
];

const SYSTEM_PROMPT = `Sei "HQ", l'assistente di HQVault (gestionale per reseller di sneaker/streetwear).
Aiuti l'utente a: cercare modelli nel catalogo, aggiungere/modificare/vendere prodotti del magazzino, valutarne il prezzo.
Regole:
- Rispondi SEMPRE in italiano, in modo breve e amichevole.
- Per INSERIRE un prodotto usa "aggiungi_prodotto" con i dati che ti dà; se manca la taglia o il prezzo va bene (li metterà dopo).
- Se l'utente aggiunge un articolo IDENTICO a uno che ha già (stessa marca+nome+taglia), aggiungilo lo stesso: il sistema riconosce il duplicato e AUMENTA lo stock (non serve dire che esiste già).
- Se l'utente dice un numero di unità uguali (es. "aggiungi 4 Jordan 4 uguali"), imposta "quantita".
- Per MODIFICARE un articolo già in magazzino (prezzo, taglia, condizione, categoria) usa "modifica_prodotto".
- Per VENDERE un articolo già in magazzino usa "vendi_prodotto" col prezzo di vendita (e quantità se più di una).
- Se non sei sicuro del modello esatto, usa "cerca_catalogo" e proponi i risultati.
- Dopo un'azione, conferma in una riga cosa hai fatto (es. "✅ Aggiunto: Jordan 4 Bred, taglia 42 — stock a 21").
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

// Trova i prodotti IN STOCK dell'utente che corrispondono a marca/nome(/taglia).
// Usato da "modifica_prodotto" e "vendi_prodotto" per individuare l'articolo dalla chat.
async function findUserStock(userId: string, q: { brand?: any; nome?: any; taglia?: any }) {
  const where: any = { userId, status: 'IN STOCK', deletedAt: null };
  const brand = q.brand ? String(q.brand).trim() : '';
  const nome = q.nome ? String(q.nome).trim() : '';
  const taglia = q.taglia ? String(q.taglia).trim() : '';
  if (brand) where.brand = { contains: brand, mode: 'insensitive' };
  if (nome) where.name = { contains: nome, mode: 'insensitive' };
  if (taglia && taglia !== '—') where.size = taglia;
  return prisma.product.findMany({ where, orderBy: { createdAt: 'asc' } });
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
      const qty = Math.min(Math.max(Math.floor(Number(args.quantita) || 1), 1), 50); // N unità identiche
      const quotaErr = await checkProductQuota(ctx.userId, qty);
      if (quotaErr) return { error: 'Hai raggiunto il limite di prodotti del tuo piano.' };
      const warehouseId = await findTargetWarehouse(ctx.userId);
      if (!warehouseId) return { error: 'Nessun magazzino trovato per l\'utente.' };
      const size = (args.taglia ? String(args.taglia) : '').trim() || '—';

      // DEDUP STOCK: se esiste già un articolo IDENTICO in stock (stessa marca+nome+taglia),
      // eredito foto/sku/categoria/prezzo così il magazzino lo RAGGRUPPA e il contatore sale
      // (es. stock da 20 + 1 identico → 21), invece di creare un doppione scollegato.
      const twin = await prisma.product.findFirst({
        where: {
          userId: ctx.userId, status: 'IN STOCK', deletedAt: null, size,
          brand: { equals: brand, mode: 'insensitive' },
          name: { equals: nome, mode: 'insensitive' },
        },
        orderBy: { createdAt: 'desc' },
      });

      const category = twin?.category || await defaultCategory(ctx.userId, args.categoria);
      const condition = (args.condizione ? String(args.condizione) : '').trim() || twin?.condition || '—';
      const givenPrice = Number(args.prezzo) > 0 ? Number(args.prezzo) : null;
      const purchasePrice = givenPrice ?? (twin?.purchasePrice ?? 0);
      let resolvedSku: string | null = args.sku ? String(args.sku).trim() : (twin?.sku || null);

      // Foto: eredito dal gemello se c'è; altrimenti la cerco nel catalogo (KicksDB→StockX),
      // salvo il LINK diretto dell'immagine — niente Cloudinary, DB piccolo.
      let photo: string | null = null;
      if (twin?.photos) { try { photo = JSON.parse(twin.photos)?.[0] || null; } catch { /* foto gemello illeggibile */ } }
      if (!photo) {
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
      }

      const data = {
        category, brand, name: nome, size, condition, purchasePrice,
        status: 'IN STOCK',
        userId: ctx.userId, warehouseId,
        sku: resolvedSku || null,
        photos: photo ? JSON.stringify([photo]) : null,
      };
      if (qty > 1) await prisma.product.createMany({ data: Array.from({ length: qty }, () => ({ ...data })) });
      else await prisma.product.create({ data });

      // Conteggio totale di questo identico articolo (per il messaggio "stock a N").
      const stockTotale = await prisma.product.count({
        where: {
          userId: ctx.userId, status: 'IN STOCK', deletedAt: null, size,
          brand: { equals: brand, mode: 'insensitive' },
          name: { equals: nome, mode: 'insensitive' },
        },
      });
      return { ok: true, aggiunto: `${brand} ${nome}`, taglia: size, prezzo: purchasePrice, foto: !!photo, quantita: qty, stock_totale: stockTotale, raggruppato: !!twin };
    }

    if (name === 'modifica_prodotto') {
      const prods = await findUserStock(ctx.userId, { brand: args.brand, nome: args.nome, taglia: args.taglia });
      if (!prods.length) return { error: 'Non ho trovato quel prodotto in magazzino.' };
      const upd: any = {};
      if (Number(args.nuovo_prezzo) > 0) upd.purchasePrice = Number(args.nuovo_prezzo);
      if (args.nuova_taglia && String(args.nuova_taglia).trim()) upd.size = String(args.nuova_taglia).trim();
      if (args.nuova_condizione && String(args.nuova_condizione).trim()) upd.condition = String(args.nuova_condizione).trim();
      if (args.nuova_categoria && String(args.nuova_categoria).trim()) upd.category = String(args.nuova_categoria).trim();
      if (!Object.keys(upd).length) return { error: 'Dimmi cosa modificare: prezzo, taglia, condizione o categoria.' };
      await prisma.product.updateMany({ where: { id: { in: prods.map(p => p.id) } }, data: upd });
      return { ok: true, modificati: prods.length, prodotto: `${prods[0].brand} ${prods[0].name}`, modifiche: upd };
    }

    if (name === 'vendi_prodotto') {
      const prezzo = Number(args.prezzo_vendita);
      if (!(prezzo > 0)) return { error: 'Mi serve il prezzo di vendita.' };
      const sellQty = Math.min(Math.max(Math.floor(Number(args.quantita) || 1), 1), 50);
      const all = await findUserStock(ctx.userId, { brand: args.brand, nome: args.nome, taglia: args.taglia });
      if (!all.length) return { error: 'Non ho trovato quel prodotto disponibile in magazzino.' };
      const prods = all.slice(0, sellQty);
      const platform = (args.piattaforma ? String(args.piattaforma).trim() : '') || 'Privato';
      for (const p of prods) {
        await prisma.product.update({ where: { id: p.id }, data: { salePrice: prezzo, platform, status: 'VENDUTO' } });
      }
      return { ok: true, venduti: prods.length, prodotto: `${prods[0].brand} ${prods[0].name}`, taglia: prods[0].size, prezzo, piattaforma: platform };
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
    const qty = result.quantita > 1 ? ` ×${result.quantita}` : '';
    const stock = result.raggruppato && result.stock_totale ? ` — stock a ${result.stock_totale}` : '';
    return `✅ Aggiunto: ${result.aggiunto}${qty}${taglia}${result.foto ? ' (con foto)' : ''}${stock}.`;
  }
  if (name === 'modifica_prodotto' && result?.ok) {
    const parti: string[] = [];
    if (result.modifiche?.purchasePrice != null) parti.push(`prezzo ${result.modifiche.purchasePrice}€`);
    if (result.modifiche?.size) parti.push(`taglia ${result.modifiche.size}`);
    if (result.modifiche?.condition) parti.push(`condizione ${result.modifiche.condition}`);
    if (result.modifiche?.category) parti.push(`categoria ${result.modifiche.category}`);
    const n = result.modificati > 1 ? ` (${result.modificati} pezzi)` : '';
    return `✏️ Modificato ${result.prodotto}${n}: ${parti.join(', ')}.`;
  }
  if (name === 'vendi_prodotto' && result?.ok) {
    const taglia = result.taglia && result.taglia !== '—' ? ` (taglia ${result.taglia})` : '';
    const n = result.venduti > 1 ? ` ×${result.venduti}` : '';
    return `💰 Venduto: ${result.prodotto}${taglia}${n} a ${result.prezzo}€ su ${result.piattaforma}.`;
  }
  if (name === 'valuta_prezzo' && result?.valore != null) return `💶 ${result.modello || 'Valore'}: circa ${result.valore}€ (${result.fonte}).`;
  return '✅ Fatto.';
}

// POST /api/assistant/message — { messages: [{role:'user'|'assistant', content}] }
// Esegue il loop di tool-calling (max 3 round) e ritorna la risposta finale + azioni.
router.post('/message', async (req: AuthRequest, res: Response) => {
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
router.post('/transcribe', async (req: AuthRequest, res: Response) => {
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
