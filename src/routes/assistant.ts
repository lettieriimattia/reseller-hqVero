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
import { groqAssistantChat, isGroqConfigured, groqTranscribe, summarizeTaskText } from '../services/ai.service';
import { searchStockXCandidates, getStockXValuation, isStockXConfigured, getStockXImage } from '../services/stockx.service';
import { kicksSearch, isKicksConfigured } from '../services/kicksdb.service';
import { addTracking, CARRIERS } from '../services/tracking.service';
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
          prezzo: { type: ['number', 'string'], description: 'Prezzo d\'acquisto in euro (facoltativo, default 0). Di DEFAULT è PER UNITÀ; se è il totale pagato per più pezzi imposta anche "prezzo_totale": true.' },
          prezzo_totale: { type: 'boolean', description: 'true se "prezzo" è il totale pagato per TUTTE le unità insieme ("2 a 25000 in totale"), false se è per UNA ("25000 l\'una"). Default false.' },
          condizione: { type: 'string', description: 'Condizione, es. "Nuovo" (facoltativo)' },
          categoria: { type: 'string', description: 'Reparto/categoria, es. "Scarpe" (facoltativo)' },
          quantita: { type: ['number', 'string'], description: 'Quante unità IDENTICHE aggiungere (default 1). Es. "aggiungi 4 Jordan 4 uguali" → 4.' },
          fornitore: { type: 'string', description: 'Da CHI ho comprato: nome/@social del venditore o socio (facoltativo). Es. "da Marco" → "Marco".' },
          data_acquisto: { type: 'string', description: 'Quando l\'ho comprato (facoltativo). Passa la data COSÌ COME DETTA dall\'utente: "ieri", "12 giugno", "10/06", "3 giorni fa". NON convertirla tu.' },
        },
        required: ['brand', 'nome'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'crea_lotto',
      description: 'Crea un LOTTO d\'acquisto (più articoli comprati insieme a un prezzo totale). Il lotto diventa una card nel magazzino; dentro ci sono i singoli pezzi. Usalo quando l\'utente dice "crea un lotto", "ho comprato uno stock", "bundle", ecc.',
      parameters: {
        type: 'object',
        properties: {
          nome_lotto: { type: 'string', description: 'Nome del lotto, es. "Stock Milano 12/06"' },
          categoria: { type: 'string', description: 'Reparto/categoria dei pezzi (facoltativo, es. "Scarpe")' },
          prezzo_totale: { type: ['number', 'string'], description: 'Prezzo TOTALE pagato per tutto il lotto in euro (facoltativo). Solo cifre.' },
          fornitore: { type: 'string', description: 'Da CHI ho comprato il lotto (facoltativo). Es. "da Luca" → "Luca".' },
          data_acquisto: { type: 'string', description: 'Quando ho comprato il lotto (facoltativo). Passa la data COSÌ COME DETTA: "ieri", "12 giugno", "10/06". NON convertirla tu.' },
          articoli: {
            type: 'array',
            description: 'Righe del lotto. Ogni riga: {nome, taglia?, quantita?, fornitore?}. "quantita" = quante paia IDENTICHE di quella riga (es. "20 paia di Jordan 4" → quantita 20). Se una parte è di un fornitore e una parte di un altro, crea DUE righe (es. 10 da Luca + 10 da Marco). Il costo totale si divide su TUTTI i pezzi.',
            items: {
              type: 'object',
              properties: {
                nome: { type: 'string', description: 'Nome/modello del pezzo' },
                taglia: { type: 'string', description: 'Taglia (facoltativo)' },
                quantita: { type: ['number', 'string'], description: 'Quante paia IDENTICHE di questa riga (default 1)' },
                fornitore: { type: 'string', description: 'Da chi arriva questa riga (facoltativo)' },
              },
              required: ['nome'],
            },
          },
        },
        required: ['nome_lotto', 'articoli'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'aggiungi_task',
      description: 'Aggiunge una NOTA/promemoria (task) per l\'utente. Usalo quando dice "ricordami…", "segna…", "aggiungi nota…", "devo…". Il testo viene salvato e riassunto in poche parole.',
      parameters: {
        type: 'object',
        properties: {
          testo: { type: 'string', description: 'Il contenuto della nota/promemoria da salvare.' },
        },
        required: ['testo'],
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
          prezzo_svendita: { type: ['number', 'string'], description: 'Prezzo di SVENDITA / liquidazione (sell panic): quanto lo daresti per venderlo SUBITO. È SOLO un valore stimato, NON registra una vendita. Usalo quando l\'utente dice "prezzo di svendita", "a quanto lo svenderei/svendo", "quanto per venderlo subito", "prezzo di liquidazione".' },
          svendita_totale: { type: 'boolean', description: 'true se "prezzo_svendita" è per TUTTE le unità insieme ("in totale/tutte assieme"), false se è PER UNITÀ ("ciascuna/l\'una"). Default false.' },
        },
        required: ['nome'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'aggiungi_tracking',
      description: 'Aggiunge/aggiorna il NUMERO DI TRACCIAMENTO (spedizione) di un prodotto già in magazzino. Usalo quando l\'utente dà un codice di tracking o dice "traccia", "spedizione", "il pacco di X è YYY", "tracking di X". Individua il prodotto per marca+nome (e taglia se serve).',
      parameters: {
        type: 'object',
        properties: {
          brand: { type: 'string', description: 'Marca per individuare il prodotto (facoltativo)' },
          nome: { type: 'string', description: 'Nome del modello a cui aggiungere la spedizione' },
          taglia: { type: 'string', description: 'Taglia per individuarlo (facoltativo)' },
          codice_tracking: { type: 'string', description: 'Il numero/codice di tracciamento della spedizione (obbligatorio)' },
          corriere: { type: 'string', description: 'Corriere (facoltativo): BRT, GLS, Poste Italiane, SDA, DHL, UPS, FedEx, TNT, Amazon Logistics, Nexive. Se non detto, lascia vuoto (auto-rilevamento).' },
        },
        required: ['nome', 'codice_tracking'],
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
          prezzo_vendita: { type: ['number', 'string'], description: 'Prezzo di vendita in euro. Di DEFAULT è PER UNITÀ; se è il totale di più pezzi imposta anche "prezzo_totale": true.' },
          prezzo_totale: { type: 'boolean', description: 'true se "prezzo_vendita" è il totale per TUTTE le unità vendute insieme ("tutte a X/in totale"), false se è per UNA ("ciascuna/l\'una"). Default false.' },
          piattaforma: { type: 'string', description: 'Dove l\'hai venduto: Vinted/StockX/eBay/Subito/Privato (facoltativo)' },
          quantita: { type: ['number', 'string'], description: 'Quante unità vendere (default 1)' },
          cliente: { type: 'string', description: 'A CHI ho venduto: nome/@social del cliente (facoltativo). Es. "a Giulia" → "Giulia".' },
          data_vendita: { type: 'string', description: 'Quando l\'ho venduto (facoltativo). Passa la data COSÌ COME DETTA: "ieri", "oggi", "12 giugno", "10/06". NON convertirla tu.' },
        },
        required: ['nome', 'prezzo_vendita'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cerca_magazzino',
      description: 'ELENCA / CERCA i prodotti che l\'utente HA già in magazzino. Usalo quando chiede "cosa ho", "elenca le mie scarpe", "quante X ho", "mostrami il magazzino", ecc. Senza filtri elenca tutto lo stock.',
      parameters: {
        type: 'object',
        properties: {
          brand: { type: 'string', description: 'Filtra per marca (facoltativo)' },
          nome: { type: 'string', description: 'Filtra per nome/modello (facoltativo)' },
          taglia: { type: 'string', description: 'Filtra per taglia (facoltativo)' },
          categoria: { type: 'string', description: 'Filtra per reparto/categoria (facoltativo)' },
          stato: { type: 'string', enum: ['in_stock', 'venduto', 'tutti'], description: 'Stato: in stock (default), venduti, o tutti' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'riepilogo_magazzino',
      description: 'Dà un RIEPILOGO del magazzino: pezzi in stock, valore dello stock, numero venduti, profitto totale. Usalo per "come va il magazzino", "quanto vale lo stock", "riepilogo".',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'elimina_prodotto',
      description: 'ELIMINA un articolo dal magazzino (individua per marca+nome+taglia). Usalo solo se l\'utente chiede esplicitamente di rimuovere/cancellare un prodotto.',
      parameters: {
        type: 'object',
        properties: {
          brand: { type: 'string', description: 'Marca (facoltativo)' },
          nome: { type: 'string', description: 'Nome del modello da eliminare' },
          taglia: { type: 'string', description: 'Taglia (facoltativo)' },
          quantita: { type: ['number', 'string'], description: 'Quante unità eliminare (default 1)' },
        },
        required: ['nome'],
      },
    },
  },
];

const SYSTEM_PROMPT = `Sei "HQ", l'assistente di HQVault (gestionale per reseller di sneaker/streetwear).
Aiuti l'utente a GESTIRE il suo magazzino: elencare/cercare ciò che ha, riepilogo, aggiungere, modificare, vendere, eliminare prodotti, e valutarne il prezzo.
Regole:
- Rispondi nella STESSA LINGUA in cui scrive l'utente: se scrive in inglese rispondi in inglese, se scrive in italiano rispondi in italiano. Sempre breve e amichevole. (Reply in the SAME language the user writes in — English or Italian.)
- MAGAZZINO = ciò che l'utente POSSIEDE davvero. CATALOGO = database di modelli in vendita nel mondo (NON è roba sua).
- Per domande su cosa HA/possiede ("cosa ho", "che taglie di X ho", "quante X ho in magazzino", "ho le Y?") usa SOLO "cerca_magazzino". Se non trova nulla, rispondi CHIARO e BREVE: "Non hai [X] in magazzino." e FERMATI. NON cercare nel catalogo e NON elencare modelli del catalogo per queste domande: sarebbe fuorviante (l'utente crederebbe di averli). HAI ACCESSO ai dati: non dire mai che non puoi vederli.
- Per i totali ("quanto vale lo stock", "come va") usa "riepilogo_magazzino".
- Usa "cerca_catalogo" SOLO quando l'utente vuole AGGIUNGERE un prodotto e non sei sicuro del modello esatto (per proporre la variante giusta). MAI per rispondere a "cosa ho".
- Per ELIMINARE un prodotto usa "elimina_prodotto" (solo se richiesto esplicitamente).
- Per INSERIRE un prodotto usa "aggiungi_prodotto" con i dati che ti dà; se manca la taglia o il prezzo va bene (li metterà dopo).
- Se l'utente aggiunge un articolo IDENTICO a uno che ha già (stessa marca+nome+taglia), aggiungilo lo stesso: il sistema riconosce il duplicato e AUMENTA lo stock (non serve dire che esiste già).
- Se l'utente dice un numero di unità uguali (es. "aggiungi 4 Jordan 4 uguali"), imposta "quantita".
- Se l'utente indica FORNITORI o DATE DIVERSI per unità diverse dello STESSO prodotto (es. "aggiungi 2 Amiri taglia M, uno da Riccardo e l'altro da Marco"), NON fare una sola chiamata con quantita 2: fai UNA chiamata "aggiungi_prodotto" PER ogni fornitore, con la quantità giusta per ciascuno (qui: 1 con fornitore Riccardo, 1 con fornitore Marco). Idem se cambia la data.
- Nel "crea_lotto": "20 paia di X" → una riga con quantita 20; se una parte del lotto è di un fornitore e una parte di un altro ("metà a Luca, metà a Marco"), spezza in due righe con le rispettive quantità e "fornitore". Il prezzo_totale è quello di TUTTO il lotto: il sistema divide sui pezzi totali.
- Per MODIFICARE un articolo già in magazzino (prezzo, taglia, condizione, categoria) usa "modifica_prodotto".
- Per VENDERE un articolo già in magazzino usa "vendi_prodotto" col prezzo di vendita (e quantità se più di una).
- ⚠️ SVENDITA ≠ VENDITA: "prezzo di svendita", "a quanto lo svenderei/svendo", "quanto per venderlo SUBITO", "prezzo di liquidazione" NON è una vendita reale → è solo il PREZZO STIMATO di svendita rapida (un campo). Usa "modifica_prodotto" con "prezzo_svendita". NON usare "vendi_prodotto" per questo. Usa "vendi_prodotto" SOLO per vendite VERE già avvenute ("ho venduto", "venduta a", "vendi X a Y euro").
- ⚠️ PREZZO TOTALE vs PER UNITÀ: quando la quantità è >1 distingui se il prezzo è per TUTTE le unità insieme o per UNA. "in totale", "tutte assieme", "tutte a X", "X in tutto", "all together" → è il TOTALE: imposta il flag "prezzo_totale"/"svendita_totale" a true. "ciascuna", "l'una", "a testa", "cada", "each" → è PER UNITÀ: flag false. Nel dubbio ("comprate a X", "le vendo a X" senza altro) → PER UNITÀ. Vale per acquisto (aggiungi/crea_lotto), vendita e svendita.
- FORNITORE e DATA in ACQUISTO: se l'utente dice DA CHI ha comprato ("me le ha vendute Marco", "comprate da Luca", "bought from Marco", "from @tizio") passa "fornitore". Se dice QUANDO ("ieri", "il 12 giugno", "3 giorni fa", "10/06", "yesterday", "June 12", "3 days ago") passa "data_acquisto". Vale sia per "aggiungi_prodotto" che per "crea_lotto".
- CLIENTE e DATA in VENDITA: se dice A CHI ha venduto ("venduta a Giulia", "sold to Giulia", "to @cliente") passa "cliente". Se dice QUANDO l'ha venduta passa "data_vendita".
- Le date passale ESATTAMENTE come le dice l'utente (es. "ieri"/"yesterday", "12 giugno"/"June 12", "10/06"): NON convertirle tu in un altro formato, ci pensa il sistema.
- Per PROMEMORIA/note ("ricordami…", "segna…") usa "aggiungi_task".
- Usa UN SOLO tool per richiesta quando basta (più veloce): non incatenare ricerche inutili.
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

// Cerca la FOTO ufficiale come fa il catalogo: due fonti (KicksDB + StockX), SOLO risultati
// CON immagine, e sceglie quello che combacia MEGLIO col nome (colore incluso) — così "Canary",
// "Bred", "Chicago" ecc. prendono la colorway giusta invece del primo risultato a caso.
async function findCatalogPhoto(query: string): Promise<{ image: string | null; styleId: string | null }> {
  const q = (query || '').trim();
  if (q.length < 2) return { image: null, styleId: null };
  const cands: { title: string; image: string | null; styleId: string | null; productId: string | null }[] = [];
  try {
    if (isKicksConfigured()) {
      const k = await kicksSearch(q, { limit: 8 });
      for (const c of k) cands.push({ title: c.title, image: c.image, styleId: c.styleId, productId: c.productId });
    }
    if (isStockXConfigured()) {
      const s = await searchStockXCandidates(q, { limit: 8 });
      for (const c of s) cands.push({ title: c.title, image: c.image, styleId: c.styleId, productId: c.productId });
    }
  } catch { /* foto facoltativa */ }
  if (!cands.length) return { image: null, styleId: null };
  // Scelgo quello che combacia MEGLIO col nome (colore incluso), anche se la ricerca non ha portato la foto.
  const words = q.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 1);
  const score = (t: string) => { const n = (t || '').toLowerCase(); let s = words.reduce((acc, w) => acc + (n.includes(w) ? 1 : 0), 0); if (s === words.length) s += 2; return s; };
  cands.sort((a, b) => score(b.title) - score(a.title));
  const best = cands[0];
  let image = best.image;
  // La ricerca StockX non include la foto: la recupero dal DETTAGLIO col productId.
  if (!image && best.productId) image = await getStockXImage(best.productId).catch(() => null);
  return { image: image || null, styleId: best.styleId };
}

// ---- Esecuzione di un singolo tool ----
// Interpreta una data scritta in linguaggio naturale italiano (ciò che dice l'utente in chat) e
// la trasforma in Date. Gestisce: "oggi/ieri/avantieri", "N giorni/settimane/mesi fa",
// ISO (2025-06-12), gg/mm[/aaaa] e "12 giugno [2025]". Ritorna null se non riconosce nulla.
const IT_MONTHS: Record<string, number> = {
  gennaio: 0, febbraio: 1, marzo: 2, aprile: 3, maggio: 4, giugno: 5,
  luglio: 6, agosto: 7, settembre: 8, ottobre: 9, novembre: 10, dicembre: 11,
  gen: 0, feb: 1, mar: 2, apr: 3, mag: 4, giu: 5, lug: 6, ago: 7, set: 8, ott: 9, nov: 10, dic: 11,
  // Inglese (l'utente può scrivere in EN)
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5, july: 6,
  august: 7, september: 8, october: 9, november: 10, december: 11,
  jan: 0, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, dec: 11,
};
function parseItDate(input?: string | null): Date | null {
  if (!input) return null;
  const s = String(input).toLowerCase().trim();
  if (!s) return null;
  const at = (d: Date) => { d.setHours(12, 0, 0, 0); return d; };
  const now = new Date();
  if (/\boggi\b|\btoday\b/.test(s)) return at(new Date());
  if (/\b(l'altro\s*ieri|altro\s*ieri|avantieri|avant'ieri|day before yesterday)\b/.test(s)) return at(new Date(Date.now() - 2 * 864e5));
  if (/\bieri\b|\byesterday\b/.test(s)) return at(new Date(Date.now() - 864e5));
  let m = s.match(/(\d+)\s*(?:giorn|days?)/);          if (m) return at(new Date(Date.now() - (+m[1]) * 864e5));
  m = s.match(/(\d+)\s*(?:settiman|weeks?)/);           if (m) return at(new Date(Date.now() - (+m[1]) * 7 * 864e5));
  m = s.match(/(\d+)\s*(?:mes[ei]|months?)/);           if (m) { const d = new Date(); d.setMonth(d.getMonth() - (+m[1])); return at(d); }
  // ISO 2025-06-12
  m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/); if (m) return at(new Date(+m[1], +m[2] - 1, +m[3]));
  // gg/mm[/aaaa] (o con - o .)
  m = s.match(/\b(\d{1,2})[\/.\-](\d{1,2})(?:[\/.\-](\d{2,4}))?\b/);
  if (m) {
    let y = m[3] ? +m[3] : now.getFullYear(); if (y < 100) y += 2000;
    const d = new Date(y, +m[2] - 1, +m[1]);
    if (!m[3] && d.getTime() > Date.now() + 864e5) d.setFullYear(y - 1); // "10/06" nel futuro → anno scorso
    return at(d);
  }
  // "12 giugno [2025]" / "12 giu" / "12 June 2025" (giorno prima del mese)
  m = s.match(/\b(\d{1,2})\s*(?:°|º)?\s*(?:di\s+|of\s+)?([a-zà]{3,})\.?(?:\s+(\d{4}))?\b/);
  if (m && IT_MONTHS[m[2]] !== undefined) {
    const y = m[3] ? +m[3] : now.getFullYear();
    const d = new Date(y, IT_MONTHS[m[2]], +m[1]);
    if (!m[3] && d.getTime() > Date.now() + 864e5) d.setFullYear(y - 1);
    return at(d);
  }
  // "June 12[, 2025]" (formato inglese: mese prima del giorno)
  m = s.match(/\b([a-z]{3,})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b/);
  if (m && IT_MONTHS[m[1]] !== undefined) {
    const y = m[3] ? +m[3] : now.getFullYear();
    const d = new Date(y, IT_MONTHS[m[1]], +m[2]);
    if (!m[3] && d.getTime() > Date.now() + 864e5) d.setFullYear(y - 1);
    return at(d);
  }
  return null;
}

async function executeTool(name: string, args: any, ctx: { userId: string }): Promise<any> {
  try {
    if (name === 'aggiungi_task') {
      const text = String(args.testo || '').trim().slice(0, 2000);
      if (!text) return { error: 'Testo della nota mancante.' };
      const summary = await summarizeTaskText(text).catch(() => '');
      await prisma.task.create({ data: { userId: ctx.userId, text, summary: summary || null } });
      return { ok: true, nota: summary || text };
    }

    if (name === 'cerca_catalogo') {
      if (!isStockXConfigured()) return { error: 'Catalogo non disponibile (StockX non configurato).' };
      const query = String(args.query || '');
      const cands = await searchStockXCandidates(query, {
        sneakersOnly: args.tipo === 'sneakers', limit: 10,
      }).catch(() => []);
      // Ordina per PERTINENZA (parole della query, colore incluso) → "jordan 1 canary" propone la
      // Canary in cima, non una gialla a caso.
      const words = query.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 1);
      const score = (t: string) => { const n = (t || '').toLowerCase(); let s = words.reduce((acc, w) => acc + (n.includes(w) ? 1 : 0), 0); if (words.length && s === words.length) s += 2; return s; };
      const ranked = [...cands].sort((a, b) => score(b.title || '') - score(a.title || ''));
      return { risultati: ranked.slice(0, 6).map(c => ({ nome: c.title, sku: c.styleId, foto: c.image })) };
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
      let givenPrice = Number(args.prezzo) > 0 ? Number(args.prezzo) : null;
      // Prezzo indicato come TOTALE per più unità → riportalo a PER UNITÀ (il magazzino salva il
      // costo per pezzo). Es. "2 a 25000 in totale" con qty 2 → 12500 cad.
      if (givenPrice != null && args.prezzo_totale === true && qty > 1) givenPrice = Math.round((givenPrice / qty) * 100) / 100;
      const purchasePrice = givenPrice ?? (twin?.purchasePrice ?? 0);
      let resolvedSku: string | null = args.sku ? String(args.sku).trim() : (twin?.sku || null);

      // Foto: eredito dal gemello se c'è; altrimenti la cerco nel catalogo (KicksDB→StockX),
      // salvo il LINK diretto dell'immagine — niente Cloudinary, DB piccolo.
      let photo: string | null = null;
      if (twin?.photos) { try { photo = JSON.parse(twin.photos)?.[0] || null; } catch { /* foto gemello illeggibile */ } }
      if (!photo) {
        // Cerco prima per SKU (preciso), altrimenti per marca+nome — sempre color-aware e solo con foto.
        let found = await findCatalogPhoto(resolvedSku ? String(resolvedSku) : `${brand} ${nome}`);
        // Se lo SKU non ha dato foto, riprovo col nome esteso (a volte lo SKU in cache non ha immagine).
        if (!found.image && resolvedSku) found = await findCatalogPhoto(`${brand} ${nome}`);
        if (found.image) photo = found.image;
        if (!resolvedSku && found.styleId) resolvedSku = found.styleId;
      }

      const supplier = (args.fornitore ? String(args.fornitore).trim() : '') || twin?.supplier || null;
      const boughtOn = parseItDate(args.data_acquisto); // data d'acquisto se detta in chat
      const data: any = {
        category, brand, name: nome, size, condition, purchasePrice,
        status: 'IN STOCK',
        userId: ctx.userId, warehouseId,
        sku: resolvedSku || null,
        supplier,
        photos: photo ? JSON.stringify([photo]) : null,
        ...(boughtOn ? { createdAt: boughtOn } : {}),
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
      return { ok: true, aggiunto: `${brand} ${nome}`, taglia: size, prezzo: purchasePrice, foto: !!photo, quantita: qty, stock_totale: stockTotale, raggruppato: !!twin, fornitore: supplier || undefined, data_acquisto: boughtOn ? boughtOn.toLocaleDateString('it-IT') : undefined };
    }

    if (name === 'crea_lotto') {
      const lotName = String(args.nome_lotto || '').trim();
      const items: any[] = Array.isArray(args.articoli) ? args.articoli : [];
      // Ogni riga può avere una QUANTITÀ (es. "20 paia") → la espando in N pezzi. Il fornitore
      // può essere per riga (10 da Luca + 10 da Marco = due righe) o unico per tutto il lotto.
      const lotSupplier = (args.fornitore ? String(args.fornitore).trim() : '') || null;
      const rows = items
        .filter(it => it && String(it.nome || '').trim())
        .map(it => ({
          nome: String(it.nome).trim(),
          size: (it.taglia ? String(it.taglia) : '').trim() || '—',
          qty: Math.min(Math.max(Math.floor(Number(it.quantita) || 1), 1), 500),
          supplier: (it.fornitore ? String(it.fornitore).trim() : '') || lotSupplier,
        }));
      if (!lotName) return { error: 'Serve il nome del lotto.' };
      if (!rows.length) return { error: 'Serve almeno un articolo nel lotto.' };
      const totalPieces = rows.reduce((a, r) => a + r.qty, 0); // pezzi TOTALI (non righe)
      const quotaErr = await checkProductQuota(ctx.userId, totalPieces);
      if (quotaErr) return { error: 'Hai raggiunto il limite di prodotti del tuo piano.' };
      const warehouseId = await findTargetWarehouse(ctx.userId);
      if (!warehouseId) return { error: 'Nessun magazzino trovato per l\'utente.' };
      const category = await defaultCategory(ctx.userId, args.categoria);
      const total = Math.max(Number(args.prezzo_totale) || 0, 0);
      const unit = Math.round((total / totalPieces) * 100) / 100; // costo diviso su TUTTI i pezzi
      const lotBoughtOn = parseItDate(args.data_acquisto);
      let withPhoto = 0;
      for (const r of rows) {
        const found = await findCatalogPhoto(r.nome).catch(() => ({ image: null as string | null }));
        const photos = found.image ? JSON.stringify([found.image]) : null;
        if (found.image) withPhoto += r.qty;
        const base: any = {
          category, brand: '', name: r.nome, size: r.size, condition: '—',
          purchasePrice: unit, status: 'IN STOCK', userId: ctx.userId, warehouseId,
          lotName, notes: `Lotto "${lotName}"`, supplier: r.supplier, photos,
          ...(lotBoughtOn ? { createdAt: lotBoughtOn } : {}),
        };
        if (r.qty > 1) await prisma.product.createMany({ data: Array.from({ length: r.qty }, () => ({ ...base })) });
        else await prisma.product.create({ data: base });
      }
      return { ok: true, lotto: lotName, pezzi: totalPieces, righe: rows.length, prezzo_totale: total, costo_cad: unit, foto_trovate: withPhoto, data_acquisto: lotBoughtOn ? lotBoughtOn.toLocaleDateString('it-IT') : undefined };
    }

    if (name === 'modifica_prodotto') {
      const prods = await findUserStock(ctx.userId, { brand: args.brand, nome: args.nome, taglia: args.taglia });
      if (!prods.length) return { error: 'Non ho trovato quel prodotto in magazzino.' };
      const upd: any = {};
      if (Number(args.nuovo_prezzo) > 0) upd.purchasePrice = Number(args.nuovo_prezzo);
      if (args.nuova_taglia && String(args.nuova_taglia).trim()) upd.size = String(args.nuova_taglia).trim();
      if (args.nuova_condizione && String(args.nuova_condizione).trim()) upd.condition = String(args.nuova_condizione).trim();
      if (args.nuova_categoria && String(args.nuova_categoria).trim()) upd.category = String(args.nuova_categoria).trim();
      // Prezzo di SVENDITA (sell panic) → campo quickSalePrice. NON è una vendita. Se dato come
      // totale per più pezzi, riportalo a per-unità (il campo è per pezzo).
      if (Number(args.prezzo_svendita) > 0) {
        let sv = Number(args.prezzo_svendita);
        if (args.svendita_totale === true && prods.length > 1) sv = Math.round((sv / prods.length) * 100) / 100;
        upd.quickSalePrice = sv;
      }
      if (!Object.keys(upd).length) return { error: 'Dimmi cosa modificare: prezzo, prezzo di svendita, taglia, condizione o categoria.' };
      await prisma.product.updateMany({ where: { id: { in: prods.map(p => p.id) } }, data: upd });
      return { ok: true, modificati: prods.length, prodotto: `${prods[0].brand} ${prods[0].name}`, modifiche: upd };
    }

    if (name === 'aggiungi_tracking') {
      const code = String(args.codice_tracking || '').trim().toUpperCase();
      if (code.length < 4) return { error: 'Mi serve un numero di tracciamento valido (almeno 4 caratteri).' };
      // Cerca il prodotto SIA in stock (pacco in arrivo) SIA venduto (spedizione al cliente).
      const where: any = { userId: ctx.userId, deletedAt: null };
      if (args.brand) where.brand = { contains: String(args.brand).trim(), mode: 'insensitive' };
      if (args.nome) where.name = { contains: String(args.nome).trim(), mode: 'insensitive' };
      if (args.taglia && String(args.taglia).trim() !== '—') where.size = String(args.taglia).trim();
      const prods = await prisma.product.findMany({ where, orderBy: { createdAt: 'desc' }, take: 5 });
      if (!prods.length) return { error: 'Non ho trovato quel prodotto in magazzino a cui aggiungere la spedizione.' };
      const p = prods[0];
      // Corriere → chiave valida (altrimenti Auto-detect).
      const carrierKey = args.corriere && CARRIERS[String(args.corriere).trim()] ? String(args.corriere).trim() : 'Auto';
      const direction = p.status === 'VENDUTO' ? 'OUTBOUND' : 'INBOUND';
      const r = await addTracking(p.id, code, carrierKey, direction);
      if (!r.success) return { error: r.error || 'Non sono riuscito a salvare la spedizione.' };
      return { ok: true, prodotto: `${p.brand} ${p.name}`, taglia: p.size, codice: code, corriere: carrierKey, verso: direction === 'INBOUND' ? 'in arrivo' : 'in uscita' };
    }

    if (name === 'vendi_prodotto') {
      const prezzo = Number(args.prezzo_vendita);
      if (!(prezzo > 0)) return { error: 'Mi serve il prezzo di vendita.' };
      const sellQty = Math.min(Math.max(Math.floor(Number(args.quantita) || 1), 1), 50);
      const all = await findUserStock(ctx.userId, { brand: args.brand, nome: args.nome, taglia: args.taglia });
      if (!all.length) return { error: 'Non ho trovato quel prodotto disponibile in magazzino.' };
      const prods = all.slice(0, sellQty);
      const platform = (args.piattaforma ? String(args.piattaforma).trim() : '') || 'Privato';
      const customer = (args.cliente ? String(args.cliente).trim() : '') || null;
      const soldOn = parseItDate(args.data_vendita) || new Date(); // se non detta → adesso
      // Prezzo indicato come TOTALE per più unità → prezzo PER PEZZO = totale / n. venduti.
      const unitPrice = (args.prezzo_totale === true && prods.length > 1) ? Math.round((prezzo / prods.length) * 100) / 100 : prezzo;
      for (const p of prods) {
        await prisma.product.update({ where: { id: p.id }, data: { salePrice: unitPrice, platform, status: 'VENDUTO', customer, soldAt: soldOn } });
      }
      return { ok: true, venduti: prods.length, prodotto: `${prods[0].brand} ${prods[0].name}`, taglia: prods[0].size, prezzo: unitPrice, prezzo_totale: unitPrice * prods.length, piattaforma: platform, cliente: customer || undefined, data_vendita: soldOn.toLocaleDateString('it-IT') };
    }

    if (name === 'valuta_prezzo') {
      const val = await getStockXValuation({
        query: String(args.query || ''), size: args.taglia ? String(args.taglia) : undefined,
        sku: args.sku ? String(args.sku) : undefined,
      });
      return { valore: val.value, fonte: val.source, modello: val.itemName };
    }

    if (name === 'cerca_magazzino') {
      const stato = String(args.stato || 'in_stock');
      const where: any = { userId: ctx.userId, deletedAt: null };
      if (stato === 'in_stock') where.status = 'IN STOCK';
      else if (stato === 'venduto') where.status = 'VENDUTO';
      if (args.brand) where.brand = { contains: String(args.brand).trim(), mode: 'insensitive' };
      if (args.nome) where.name = { contains: String(args.nome).trim(), mode: 'insensitive' };
      if (args.taglia && String(args.taglia).trim() !== '—') where.size = String(args.taglia).trim();
      if (args.categoria) where.category = { contains: String(args.categoria).trim(), mode: 'insensitive' };
      const prods = await prisma.product.findMany({ where, orderBy: { createdAt: 'desc' }, take: 60 });
      // raggruppa per modello+taglia per non elencare 20 righe uguali
      const groups = new Map<string, any>();
      for (const p of prods) {
        const k = `${p.brand}|${p.name}|${p.size}|${p.status}`;
        const g = groups.get(k) || { brand: p.brand, nome: p.name, taglia: p.size, stato: p.status, quantita: 0, prezzo: p.purchasePrice, prezzo_vendita: p.salePrice || null };
        g.quantita++; groups.set(k, g);
      }
      const lista = Array.from(groups.values());
      return { totale_pezzi: prods.length, modelli: lista.length, prodotti: lista.slice(0, 40) };
    }

    if (name === 'riepilogo_magazzino') {
      const all = await prisma.product.findMany({ where: { userId: ctx.userId, deletedAt: null }, select: { status: true, purchasePrice: true, salePrice: true, fees: true } });
      const inStock = all.filter(p => p.status === 'IN STOCK');
      const sold = all.filter(p => p.status === 'VENDUTO');
      const valoreStock = inStock.reduce((a, p) => a + (p.purchasePrice || 0), 0);
      const profitto = sold.reduce((a, p) => a + ((p.salePrice || 0) - (p.purchasePrice || 0) - (p.fees || 0)), 0);
      const ricavi = sold.reduce((a, p) => a + (p.salePrice || 0), 0);
      return { pezzi_in_stock: inStock.length, valore_stock: Math.round(valoreStock), venduti: sold.length, ricavi: Math.round(ricavi), profitto: Math.round(profitto) };
    }

    if (name === 'elimina_prodotto') {
      const qty = Math.min(Math.max(Math.floor(Number(args.quantita) || 1), 1), 50);
      const all = await findUserStock(ctx.userId, { brand: args.brand, nome: args.nome, taglia: args.taglia });
      if (!all.length) return { error: 'Non ho trovato quel prodotto in magazzino.' };
      const prods = all.slice(0, qty);
      await prisma.product.updateMany({ where: { id: { in: prods.map(p => p.id) } }, data: { deletedAt: new Date() } });
      return { ok: true, eliminati: prods.length, prodotto: `${prods[0].brand} ${prods[0].name}`, taglia: prods[0].size };
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
    const from = result.fornitore ? ` da ${result.fornitore}` : '';
    const when = result.data_acquisto ? ` (${result.data_acquisto})` : '';
    return `✅ Aggiunto: ${result.aggiunto}${qty}${taglia}${from}${when}${result.foto ? ' (con foto)' : ''}${stock}.`;
  }
  if (name === 'crea_lotto' && result?.ok) {
    const righe = result.righe > 1 ? ` (${result.righe} righe)` : '';
    return `📦 Lotto creato: ${result.lotto} — ${result.pezzi} pezzi${righe}, ${result.costo_cad}€ cad.`;
  }
  if (name === 'modifica_prodotto' && result?.ok) {
    const parti: string[] = [];
    if (result.modifiche?.purchasePrice != null) parti.push(`prezzo ${result.modifiche.purchasePrice}€`);
    if (result.modifiche?.quickSalePrice != null) parti.push(`prezzo svendita ${result.modifiche.quickSalePrice}€`);
    if (result.modifiche?.size) parti.push(`taglia ${result.modifiche.size}`);
    if (result.modifiche?.condition) parti.push(`condizione ${result.modifiche.condition}`);
    if (result.modifiche?.category) parti.push(`categoria ${result.modifiche.category}`);
    const n = result.modificati > 1 ? ` (${result.modificati} pezzi)` : '';
    return `✏️ Modificato ${result.prodotto}${n}: ${parti.join(', ')}.`;
  }
  if (name === 'aggiungi_tracking' && result?.ok) {
    const corr = result.corriere && result.corriere !== 'Auto' ? ` (${result.corriere})` : '';
    return `📦 Spedizione ${result.verso} salvata su ${result.prodotto}: tracking ${result.codice}${corr}.`;
  }
  if (name === 'vendi_prodotto' && result?.ok) {
    const taglia = result.taglia && result.taglia !== '—' ? ` (taglia ${result.taglia})` : '';
    const n = result.venduti > 1 ? ` ×${result.venduti}` : '';
    const to = result.cliente ? ` a ${result.cliente}` : '';
    const when = result.data_vendita ? ` (${result.data_vendita})` : '';
    return `💰 Venduto: ${result.prodotto}${taglia}${n}${to} a ${result.prezzo}€ su ${result.piattaforma}${when}.`;
  }
  if (name === 'valuta_prezzo' && result?.valore != null) return `💶 ${result.modello || 'Valore'}: circa ${result.valore}€ (${result.fonte}).`;
  if (name === 'cerca_magazzino' && result?.prodotti) {
    if (!result.prodotti.length) return 'Non hai prodotti che corrispondono.';
    const righe = result.prodotti.slice(0, 15).map((p: any) =>
      `• ${p.brand} ${p.nome}${p.taglia && p.taglia !== '—' ? ` (${p.taglia})` : ''}${p.quantita > 1 ? ` ×${p.quantita}` : ''} — ${p.prezzo}€`).join('\n');
    return `📦 ${result.totale_pezzi} pezzi (${result.modelli} modelli):\n${righe}`;
  }
  if (name === 'riepilogo_magazzino' && result?.pezzi_in_stock != null) {
    return `📊 In stock: ${result.pezzi_in_stock} pezzi (valore ${result.valore_stock}€) · Venduti: ${result.venduti} · Ricavi ${result.ricavi}€ · Profitto ${result.profitto}€.`;
  }
  if (name === 'elimina_prodotto' && result?.ok) {
    const taglia = result.taglia && result.taglia !== '—' ? ` (taglia ${result.taglia})` : '';
    return `🗑️ Eliminato: ${result.prodotto}${taglia}${result.eliminati > 1 ? ` ×${result.eliminati}` : ''}.`;
  }
  return '✅ Fatto.';
}

// POST /api/assistant/message — { messages: [{role:'user'|'assistant', content}] }
// Tool che MODIFICANO i dati (vanno confermati prima di eseguire, quando richiesto es. da Telegram).
export const MUTATING_TOOLS = new Set(['aggiungi_prodotto', 'crea_lotto', 'modifica_prodotto', 'vendi_prodotto', 'elimina_prodotto', 'aggiungi_task']);
export { executeTool };

// Loop tool-calling (max 3 round) RIUSABILE: dall'app e da Telegram. Ritorna testo + azioni.
// interceptTool: se fornito e ritorna un valore ≠ undefined, quel valore è usato AL POSTO
// dell'esecuzione reale (serve al flusso Telegram "proponi → conferma": le azioni che modificano
// non vengono eseguite subito, ma proposte).
export async function runAssistant(
  history: { role: string; content: string }[],
  userId: string,
  interceptTool?: (name: string, args: any) => Promise<any> | any,
): Promise<{ reply: string; actions: any[] }> {
  const msgs: any[] = [{ role: 'system', content: SYSTEM_PROMPT }, ...history];
  const actions: any[] = [];
  const ctx = { userId };
  const run = async (name: string, args: any) => {
    if (interceptTool) { const r = await interceptTool(name, args); if (r !== undefined) return r; }
    return executeTool(name, args, ctx);
  };
  for (let round = 0; round < 3; round++) {
    let m: any;
    try {
      m = await groqAssistantChat({ messages: msgs, tools: TOOLS });
    } catch (err: any) {
      const failed = err?.status === 400 ? parseFailedToolCall(err) : null;
      if (!failed) throw err;
      const result = await run(failed.name, failed.args);
      actions.push({ tool: failed.name, args: failed.args, result });
      return { reply: summarizeToolResult(failed.name, result), actions };
    }
    if (!m) break;
    if (m.tool_calls && m.tool_calls.length) {
      msgs.push({ role: 'assistant', content: m.content || '', tool_calls: m.tool_calls });
      for (const tc of m.tool_calls) {
        let args: any = {};
        try { args = JSON.parse(tc.function?.arguments || '{}'); } catch {}
        const result = await run(tc.function?.name, args);
        actions.push({ tool: tc.function?.name, args, result });
        msgs.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
      }
      continue;
    }
    return { reply: m.content || '', actions };
  }
  return { reply: 'Fatto.', actions };
}

// Esegue il loop di tool-calling (max 3 round) e ritorna la risposta finale + azioni.
router.post('/message', async (req: AuthRequest, res: Response) => {
  if (!isGroqConfigured()) return res.status(503).json({ error: 'Assistente non disponibile (Groq non configurato).' });
  try {
    const clientMessages = Array.isArray(req.body?.messages) ? req.body.messages : [];
    const history = clientMessages
      .filter((m: any) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .slice(-12)
      .map((m: any) => ({ role: m.role, content: m.content.slice(0, 2000) }));
    if (!history.length) return res.status(400).json({ error: 'Messaggio vuoto.' });
    const out = await runAssistant(history, req.user!.userId);
    return res.json(out);
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
