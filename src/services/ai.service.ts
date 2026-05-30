// src/services/ai.service.ts
// Servizio IA centralizzato.
// Funzioni:
//   - scanProduct(): riconosce un prodotto da una foto in base alla categoria
//   - estimateMarketPrice(): stima il prezzo di mercato
//   - checkAuthenticity(): valutazione di autenticità (con disclaimer onesti)

import Groq from 'groq-sdk';
import { PrismaClient } from '@prisma/client';
import { logger } from '../utils/logger';

const prisma = new PrismaClient();

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Modello vision (rapido e gratuito su Groq)
const VISION_MODEL = 'meta-llama/llama-4-scout-17b-16e-instruct';
// Modello testo per stime prezzi / analisi
const TEXT_MODEL = 'llama-3.3-70b-versatile';

// ==========================================
// TIPI
// ==========================================
export interface ScanResult {
  category: string;
  brand?: string;
  model?: string;
  details?: Record<string, any>;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  rawText: string;
  warnings?: string[];
}

export interface PriceEstimate {
  minPrice: number;
  maxPrice: number;
  avgPrice: number;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  reasoning: string;
  cached: boolean;
}

export interface AuthenticityCheck {
  score: number; // 0-100
  verdict: 'LIKELY_AUTHENTIC' | 'SUSPICIOUS' | 'NEEDS_VERIFICATION';
  redFlags: string[];
  greenFlags: string[];
  disclaimer: string;
}

// ==========================================
// PROMPT PER CATEGORIA
// ==========================================
const SCAN_PROMPTS: Record<string, string> = {
  Pokemon: `Sei un esperto di carte Pokémon TCG. Analizza questa carta e rispondi SOLO in JSON valido (senza markdown, senza testo extra) con questo schema:
{
  "name": "nome esatto del Pokémon",
  "cardNumber": "numero della carta (es: 4/102, oppure solo 4)",
  "setName": "set se riconoscibile, altrimenti null",
  "rarity": "Common|Uncommon|Rare|Holo|Ultra Rare|Secret Rare|null",
  "condition": "Mint|Near Mint|Played|Damaged|null"
}
Se non riesci a leggere un campo metti null. NON inventare dati. Rispondi SOLO con il JSON.`,

  Scarpe: `Sei un esperto di calzature con conoscenza sia del mondo sneaker/streetwear che della moda di lusso. Analizza questa scarpa con attenzione a TUTTI i dettagli visibili: logo, texture, hardware, pattern, suola, cuciture, etichette.

Rispondi SOLO in JSON valido (senza markdown, senza testo extra):
{
  "brand": "brand esatto — considera TUTTI i possibili brand: Nike, Adidas, Jordan, New Balance, Vans, Converse, Asics, Salomon, ma ANCHE marchi di lusso come Louis Vuitton, Gucci, Balenciaga, Dior, Prada, Bottega Veneta, Alexander McQueen, Off-White, Valentino, Maison Margiela, Hermès, Loro Piana, Celine, Loewe — null se non riconosci",
  "model": "modello preciso — per Nike es: Air Jordan 1, Air Force 1, Dunk; per LV es: LV Skate Sneaker, LV Runner Tatic, LV Trainer, LV Archlight; per Gucci es: Ace, Rhyton; per Balenciaga es: Triple S, Track, Speed Trainer; null se non riconosci",
  "colorway": "colorway o palette colori principale (es: Monogram Brown/White, Black/Red, Triple White)",
  "styleCode": "codice articolo visibile su cartellino o suola, altrimenti null",
  "condition": "DS|VNDS|Used|Worn|null",
  "luxuryMarkers": "dettagli visibili che identificano il brand di lusso (es: monogramma LV canvas, hardware dorato con logo LV, tela Damier, doppia G Gucci, motivo Dior Oblique, Triple S sole, ecc.) — null se non lusso"
}

REGOLE IMPORTANTI:
- Louis Vuitton: cerca il pattern LV monogramma (L e V intrecciati) o Damier, hardware con logo, tela caratteristica, tipica silhouette delle LV Skate (suola vulcanizzata con overlay LV)
- Balenciaga: guarda la suola spessa chunky del Triple S o la silhouette sleek dello Speed/Track
- Gucci: cerca doppia G o pattern GG canvas, strisce rosse/verdi
- Off-White: zip ties, virgolette, stampe grafiche tipiche
- Se il brand è di lusso europeo, NON cambiare in brand americani anche se la forma è simile
- NON inventare brand o modelli non visibili. Se incerto su modello specifico descrivi ciò che vedi.
Rispondi SOLO JSON.`,

  Vestiti: `Sei un esperto di streetwear, abbigliamento di lusso e moda contemporanea. Analizza questo capo in ogni dettaglio visibile: logo, grafica, costruzione, etichette, hardware, materiali.

Rispondi SOLO in JSON valido (senza markdown, senza testo extra):
{
  "brand": "brand esatto — considera streetwear: Supreme, Stone Island, Stüssy, Palace, Carhartt WIP, A Bathing Ape (BAPE), Kith, Off-White, Fear of God, Essentials, Represent, Trapstar, C.P. Company, The North Face; MA ANCHE lusso: Louis Vuitton, Gucci, Balenciaga, Prada, Moncler, Canada Goose, Maison Margiela, Acne Studios, Rick Owens, Bottega Veneta — null se non riconosci",
  "model": "nome preciso del pezzo o collezione (es: Box Logo Hoodie, Rose Tee, Compass Sweatshirt, Diagonal Fleece Zip, Industrial Belt Tee) — null se non identificabile",
  "type": "tipo preciso (Hoodie, Crewneck, T-shirt, Jacket, Bomber, Parka, Pants, Shorts, Vest, Beanie, Cap, Shirt, ecc.)",
  "color": "colore/colorway principale con sfumature (es: Black, White, Heather Grey, Military Green)",
  "season": "stagione se visibile su etichetta o grafica (es: SS24, FW23) — null se non visibile",
  "logoDescription": "descrizione precisa del logo o grafica (es: box logo rosso su fondo nero, bussola ricamata sul braccio sinistro, zip tie con testo OFF-WHITE) — null se non visibile"
}

REGOLE IMPORTANTI:
- Supreme: font Futura Heavy Oblique sul box logo, colore uniforme (rosso/bianco/nero), cuciture precise
- Stone Island: patch bussola sul braccio sinistro (ricamata) o logo sul petto, badge removibile
- BAPE: pattern camouflage Ape o testa gorilla stilizzata, font BAPE
- Off-White: virgolette " " su ogni pezzo, industrial belt con testo, zip ties pendenti
- Moncler: patch triangolare con aquila stilizzata, qualità tessuto trapuntato
- Canada Goose: patch circolare artico con logo lupo
- Se vedi un logo o grafica NON ignorarla — è l'identificativo più importante
- NON inventare brand o modelli non visibili
Rispondi SOLO JSON.`,

  Orologi: `Sei un esperto orologiaio e autenticatore di orologi di lusso. Analizza questo orologio in ogni dettaglio visibile: quadrante, cassa, corona, bracciale, lunetta, lancette, scritta sul quadrante.

Rispondi SOLO in JSON valido (senza markdown, senza testo extra):
{
  "brand": "brand esatto (es: Rolex, Omega, Patek Philippe, Audemars Piguet, IWC, Breitling, TAG Heuer, Cartier, Tudor, Seiko, Grand Seiko, Casio G-Shock, Hublot, Richard Mille) — null se non riconosci",
  "model": "modello preciso (es: Submariner Date, Speedmaster Moonwatch Professional, Royal Oak Offshore, Datejust 41, Day-Date 40, Nautilus 5711, Santos de Cartier, Aquaracer) — null se non riconosci",
  "reference": "reference number completo se visibile sul quadrante o cassa (es: 126610LN, 126334, OP8542X1) — null se non visibile",
  "caseSize": "diametro stimato in mm (es: 36, 40, 41, 42, 44) — null se non stimabile",
  "dialColor": "colore e finitura quadrante (es: Nero lucido, Blu sunburst, Verde oliva, Argento guilloché, Champagne)",
  "material": "materiale cassa e bracciale (Acciaio Oystersteel, Oro giallo 18k, Oro rosa 18k, Oro bianco, Bicolore Rolesor, Titanio, Ceramica, ecc.)",
  "bezel": "tipo lunetta (es: Cerachrom nera, Cerachrom blu-nera bicolore, Tachimetro, Lunetta con diamanti, Liscia) — null se non visibile",
  "complications": "complicazioni visibili (Data, GMT, Cronografo, Fasi lunari, Perpetuo, Tourbillon, Small seconds) — null se nessuna"
}

REGOLE IMPORTANTI:
- Rolex: cerca corona a 5 punte sul rehaut, testo ROLEX OYSTER PERPETUAL sul quadrante, texture bracciale (Jubilee/Oyster/President)
- Omega: logo Ω greco, finitura sunburst del quadrante Speedmaster, bracciale bracelet Omega
- Audemars Piguet: otto viti esagonali sulla lunetta ottagonale = Royal Oak
- Patek Philippe: logo Calatrava (croce con ansa) e scritta GENEVE, finitura impeccabile
- Richard Mille: cassa tonneau in materiali high-tech, scheletrato visibile
- Trascrivere FEDELMENTE ogni testo visibile sul quadrante — è fondamentale per il riconoscimento
- NON inventare reference number non visibili
Rispondi SOLO JSON.`,
};

// ==========================================
// UTILITY: parsing JSON robusto
// ==========================================
function safeParseJSON(text: string): any | null {
  try {
    // Rimuovi eventuali backtick / markdown
    const cleaned = text
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/, '')
      .replace(/\s*```\s*$/, '')
      .trim();
    return JSON.parse(cleaned);
  } catch {
    // Prova a estrarre la prima struttura JSON con regex
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch { return null; }
    }
    return null;
  }
}

// ==========================================
// SCAN PRODOTTO (categorie multiple)
// ==========================================
export async function scanProduct(imageBase64: string, category: string): Promise<ScanResult> {
  const prompt = SCAN_PROMPTS[category];
  if (!prompt) {
    throw new Error(`Categoria non supportata dall'IA: ${category}`);
  }
  
  let completion;
  try {
    completion = await groq.chat.completions.create({
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: imageBase64 } },
        ],
      }],
      model: VISION_MODEL,
      temperature: 0.1,
      max_tokens: category === 'Scarpe' || category === 'Orologi' ? 700 : 500,
    });
  } catch (err) {
    logger.error('Errore Groq vision API', { err, category });
    throw new Error('Servizio IA temporaneamente non disponibile.');
  }
  
  const rawText = completion.choices[0]?.message?.content?.trim() || '';
  const parsed = safeParseJSON(rawText);
  
  if (!parsed) {
    return {
      category,
      confidence: 'LOW',
      rawText,
      warnings: ['IA non ha restituito una risposta strutturata. Compila manualmente.'],
    };
  }
  
  // Estrai i campi e calcola confidence
  const result: ScanResult = {
    category,
    rawText,
    confidence: 'MEDIUM',
    details: parsed,
  };
  
  switch (category) {
    case 'Pokemon': {
      if (parsed.name && parsed.cardNumber) {
        result.brand = 'Pokémon';
        result.model = `${parsed.name} - ${parsed.cardNumber}${parsed.setName ? ` (${parsed.setName})` : ''}`;
        result.confidence = parsed.setName ? 'HIGH' : 'MEDIUM';
        
        // Arricchimento via API pokemontcg.io (open source, gratis)
        try {
          const num = parsed.cardNumber.split('/')[0].replace(/^0+/, '');
          const query = encodeURIComponent(`name:"${parsed.name}" number:"${num}"`);
          const tcgRes = await fetch(`https://api.pokemontcg.io/v2/cards?q=${query}`);
          const tcgData = await tcgRes.json() as any;
          if (tcgData.data?.length > 0) {
            const card = tcgData.data[0];
            result.model = `${card.name} - ${card.set.name} (${card.number}/${card.set.printedTotal})`;
            result.confidence = 'HIGH';
            result.details = { ...parsed, tcgData: { setId: card.set.id, image: card.images?.small } };
          }
        } catch {
          // Fallback al risultato IA puro
        }
      } else {
        result.confidence = 'LOW';
      }
      break;
    }
    case 'Scarpe': {
      if (parsed.brand && parsed.model) {
        result.brand = parsed.brand;
        result.model = parsed.colorway ? `${parsed.model} "${parsed.colorway}"` : parsed.model;
        result.confidence = (parsed.styleCode || parsed.luxuryMarkers) ? 'HIGH' : 'MEDIUM';
      } else {
        result.confidence = 'LOW';
      }
      break;
    }
    case 'Vestiti': {
      if (parsed.brand && parsed.model) {
        result.brand = parsed.brand;
        result.model = parsed.season ? `${parsed.model} (${parsed.season})` : parsed.model;
        result.confidence = 'MEDIUM';
      } else {
        result.confidence = 'LOW';
      }
      break;
    }
    case 'Orologi': {
      if (parsed.brand && parsed.model) {
        result.brand = parsed.brand;
        result.model = parsed.reference ? `${parsed.model} ${parsed.reference}` : parsed.model;
        result.confidence = parsed.reference ? 'HIGH' : 'MEDIUM';
      } else {
        result.confidence = 'LOW';
      }
      break;
    }
  }
  
  return result;
}

// ==========================================
// STIMA PREZZO DI MERCATO
// ==========================================
// Usa cache nel DB (7 giorni) per ridurre chiamate IA.
export async function estimateMarketPrice(params: {
  category: string;
  brand: string;
  modelName: string;
  size?: string;
  condition?: string;
}): Promise<PriceEstimate> {
  const { category, brand, modelName, size, condition } = params;
  
  // Check cache
  const cacheKey = { category, brand, modelName, size: size || '' };
  const cached = await prisma.marketPrice.findUnique({
    where: { 
      category_brand_modelName_size: cacheKey,
    },
  }).catch(() => null);
  
  if (cached && cached.expiresAt > new Date()) {
    return {
      minPrice: cached.minPrice,
      maxPrice: cached.maxPrice,
      avgPrice: cached.avgPrice,
      confidence: cached.sampleSize > 10 ? 'HIGH' : 'MEDIUM',
      reasoning: `Stima da cache (${cached.sampleSize} riferimenti, source: ${cached.source})`,
      cached: true,
    };
  }
  
  // Chiama IA testuale per stima
  const isLuxury = ['Louis Vuitton', 'Gucci', 'Balenciaga', 'Dior', 'Prada', 'Hermès', 'Chanel', 'Bottega Veneta',
    'Alexander McQueen', 'Off-White', 'Maison Margiela', 'Valentino', 'Celine', 'Loewe',
    'Rolex', 'Omega', 'Patek Philippe', 'Audemars Piguet', 'IWC', 'Richard Mille'].some(b =>
    brand.toLowerCase().includes(b.toLowerCase()));

  const prompt = `Sei un analista esperto del mercato del resell con profonda conoscenza sia dei mercati sneaker/streetwear che del lusso.
Stima il prezzo di mercato attuale (in EURO €) per questo prodotto basandoti su dati reali di:
${isLuxury
  ? '- LUSSO: Vestiaire Collective, The RealReal, Chrono24, Watchfinder, Collector Square, eBay Luxury, Vinted (luxury section)'
  : '- STREETWEAR/SNEAKER: StockX, GOAT, Klekt, Restocks, eBay Sneakers, Vinted, Subito'}

Prodotto:
- Categoria: ${category}
- Brand: ${brand}
- Modello: ${modelName}
${size ? `- Taglia: ${size}` : ''}
${condition ? `- Condizioni: ${condition}` : ''}

${isLuxury ? `PREZZI DI RIFERIMENTO LUSSO (range tipici europei):
- LV Skate Sneaker: 600-1100€ (DS), 400-700€ (used)
- LV Trainer/Runner: 700-1400€ (DS), 500-900€ (used)
- LV Archlight: 800-1600€ (DS)
- Gucci Ace: 350-700€ | Gucci Rhyton: 400-800€
- Balenciaga Triple S: 300-600€ | Speed: 200-450€
- Rolex Submariner: 12.000-16.000€ | Datejust 41: 7.000-11.000€
- Omega Speedmaster Moonwatch: 4.500-7.000€
Usa questi come riferimento e adatta per il modello specifico.` : ''}

Rispondi SOLO con un JSON valido (senza markdown, senza altro testo):
{
  "minPrice": numero (€ minimo realistico),
  "maxPrice": numero (€ massimo per condizioni ottime/DS),
  "avgPrice": numero (€ medio realistico di mercato),
  "confidence": "HIGH" | "MEDIUM" | "LOW",
  "reasoning": "1-2 frasi che spiegano la stima e il mercato di riferimento (in italiano)"
}

Se non conosci abbastanza il prodotto, metti confidence "LOW" e prezzi a 0.`;

  let completion;
  try {
    completion = await groq.chat.completions.create({
      messages: [{ role: 'user', content: prompt }],
      model: TEXT_MODEL,
      temperature: 0.2,
      max_tokens: 400,
    });
  } catch (err) {
    logger.error('Errore Groq text API per prezzi', { err });
    return {
      minPrice: 0, maxPrice: 0, avgPrice: 0,
      confidence: 'LOW',
      reasoning: 'Servizio stima prezzi temporaneamente non disponibile.',
      cached: false,
    };
  }
  
  const raw = completion.choices[0]?.message?.content?.trim() || '';
  const parsed = safeParseJSON(raw);
  
  if (!parsed || parsed.avgPrice === undefined) {
    return {
      minPrice: 0, maxPrice: 0, avgPrice: 0,
      confidence: 'LOW',
      reasoning: 'Stima non disponibile per questo prodotto.',
      cached: false,
    };
  }
  
  // Salva in cache
  try {
    await prisma.marketPrice.upsert({
      where: { category_brand_modelName_size: cacheKey },
      create: {
        category, brand, modelName, size: size || '',
        minPrice: parsed.minPrice || 0,
        maxPrice: parsed.maxPrice || 0,
        avgPrice: parsed.avgPrice || 0,
        sampleSize: 1,
        source: 'GROQ_AI',
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
      update: {
        minPrice: parsed.minPrice || 0,
        maxPrice: parsed.maxPrice || 0,
        avgPrice: parsed.avgPrice || 0,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });
  } catch (err) {
    logger.warn('Cache prezzo non salvata', { err });
  }
  
  return {
    minPrice: parsed.minPrice || 0,
    maxPrice: parsed.maxPrice || 0,
    avgPrice: parsed.avgPrice || 0,
    confidence: parsed.confidence || 'MEDIUM',
    reasoning: parsed.reasoning || '',
    cached: false,
  };
}

// ==========================================
// PROMPT LEGIT CHECK PER CATEGORIA
// ==========================================
const LEGIT_CHECK_PROMPTS: Record<string, string> = {
  Scarpe: `Sei un autenticatore esperto di calzature di lusso e sneaker (certificato da CheckCheck, Legit App, StockX). Analizza questa foto cercando segnali precisi di autenticità o contraffazione.

VERIFICA SNEAKER (Nike/Adidas/New Balance/ecc.):
- Font e proporzioni del logo (Swoosh, tre strisce, "N")
- Qualità delle cuciture (regolari, distanza uniforme)
- Suola: pattern incisioni, materiale, flessibilità visiva
- Tag interno: font, spacing, formato del codice articolo
- Adidas Boost: capsule uniformi e dense
- Air Jordan: Wings logo, qualità del Jumpman

VERIFICA LUSSO (Louis Vuitton, Gucci, Balenciaga, ecc.):
- Louis Vuitton: allineamento PRECISO del monogramma LV (simmetrico, mai tagliato storto alle cuciture), hardware con logo LV inciso in rilievo (non stampato piatto), stamp interno "LOUIS VUITTON PARIS MADE IN FRANCE/ITALY" (font preciso), suola con LV molded, canvas di qualità con pattern uniforme
- Gucci: allineamento doppia G (specchiata e precisa), canvas GG uniforme, cuciture a contrasto regolari, hardware dorato lucido
- Balenciaga Triple S: tre layer della suola distinti e precisi, logo Balenciaga su tallone in font corretto, qualità del tessuto upper

Rispondi SOLO in JSON valido (senza markdown):
{
  "score": numero da 0 a 100 (100 = autentico certo, 50 = non verificabile, 0 = fake evidente),
  "verdict": "LIKELY_AUTHENTIC" | "SUSPICIOUS" | "NEEDS_VERIFICATION",
  "redFlags": [array di stringhe specifiche sui difetti rilevati],
  "greenFlags": [array di stringhe specifiche sui segnali di autenticità]
}
Foto di bassa qualità o dettagli non visibili → score 50, verdict "NEEDS_VERIFICATION".`,

  Vestiti: `Sei un autenticatore esperto di streetwear e abbigliamento di lusso. Analizza questa foto.

VERIFICA PER BRAND:
- Supreme: font Futura Heavy Oblique sul box logo (proporzioni esatte), colore piatto uniforme senza pixelature, cuciture hood precise, qualità cotone pesante
- Stone Island: patch bussola sul braccio sinistro con ricamo dettagliato (non stampato), colori vividi, etichetta Nylon Metal interna
- Off-White: qualità stampa testo (bordi netti), industrial belt con font Helvetica corretto, zip ties con testo "FOR WALKING" o simile
- Moncler: patch triangolare aquila con ricamo dettagliato (fili singoli visibili), tessuto nylon lucido di qualità, zip YKK
- Canada Goose: patch circolare artico con lupo, font Arctic Program preciso, cerniere YKK
- BAPE: pattern camouflage simmetrico e dettagliato, font BAPE preciso
- Luxury (LV/Gucci): qualità monogramma, etichette interne con font precisi, cuciture impeccabili

Rispondi SOLO in JSON valido (senza markdown):
{
  "score": numero da 0 a 100,
  "verdict": "LIKELY_AUTHENTIC" | "SUSPICIOUS" | "NEEDS_VERIFICATION",
  "redFlags": [array di stringhe specifiche],
  "greenFlags": [array di stringhe specifiche]
}`,

  Orologi: `Sei un orologiaio esperto e autenticatore certificato di orologi di lusso. Analizza questa foto con massima attenzione.

VERIFICA ROLEX:
- Corona a 5 punte incisa sul rehaut (bordo interno quadrante) — deve essere precisa e in rilievo
- Scritta ROLEX sul fondello della corona di carica
- Ciclope (lente data): deve ingrandire di 2.5x, bordi precisi
- Lancette: luminova verde brillante e preciso, forma perfetta
- Bracciale: ogni maglie impeccabile, clasp Oysterclasp con logo inciso
- Testo quadrante: font Rolex senza sbavature, "Swiss Made" in basso

VERIFICA OMEGA:
- Logo Ω proporzionato e preciso
- Finitura quadrante (sunburst reale: riflessi radiali uniformi)
- Lancette con Super-LumiNova preciso

VERIFICA AP ROYAL OAK:
- Esattamente 8 viti esagonali sulla lunetta ottagonale, perfettamente allineate
- Quadrante Grande Tapisserie (pattern quadri uniformi)

VERIFICA GENERALE:
- Il segundo sweep: automatici = sweep continuo fluido, quarzo = ticchettio
- Qualità delle incisioni (bordi netti, profondità uniforme)
- Testo sul quadrante senza sbavature o font irregolari

Rispondi SOLO in JSON valido (senza markdown):
{
  "score": numero da 0 a 100,
  "verdict": "LIKELY_AUTHENTIC" | "SUSPICIOUS" | "NEEDS_VERIFICATION",
  "redFlags": [array di stringhe specifiche sui difetti],
  "greenFlags": [array di stringhe specifiche sui segnali di autenticità]
}`,
};

// ==========================================
// LEGIT CHECK (controllo autenticità)
// ==========================================
// IMPORTANTE: dichiariamo onestamente i limiti — l'IA NON sostituisce un autenticatore professionista.
export async function checkAuthenticity(imageBase64: string, category: string): Promise<AuthenticityCheck> {
  if (!['Scarpe', 'Vestiti', 'Orologi'].includes(category)) {
    return {
      score: 50,
      verdict: 'NEEDS_VERIFICATION',
      redFlags: [],
      greenFlags: [],
      disclaimer: 'Legit check non supportato per questa categoria.',
    };
  }

  const prompt = LEGIT_CHECK_PROMPTS[category];

  let completion;
  try {
    completion = await groq.chat.completions.create({
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: imageBase64 } },
        ],
      }],
      model: VISION_MODEL,
      temperature: 0.2,
      max_tokens: 800,
    });
  } catch (err) {
    logger.error('Errore Groq legit check', { err });
    return {
      score: 50, verdict: 'NEEDS_VERIFICATION',
      redFlags: [], greenFlags: [],
      disclaimer: 'Servizio legit check non disponibile.',
    };
  }
  
  const raw = completion.choices[0]?.message?.content?.trim() || '';
  const parsed = safeParseJSON(raw);
  
  const disclaimer = '⚠️ Questa è una valutazione automatica basata sull\'immagine. NON sostituisce un autenticatore professionista. Per acquisti importanti rivolgersi a servizi specializzati (Legit App, CheckCheck, ecc.).';
  
  if (!parsed) {
    return {
      score: 50, verdict: 'NEEDS_VERIFICATION',
      redFlags: [], greenFlags: [],
      disclaimer: 'IA non ha potuto valutare l\'autenticità. ' + disclaimer,
    };
  }
  
  return {
    score: Math.max(0, Math.min(100, parsed.score || 50)),
    verdict: parsed.verdict || 'NEEDS_VERIFICATION',
    redFlags: Array.isArray(parsed.redFlags) ? parsed.redFlags.slice(0, 10) : [],
    greenFlags: Array.isArray(parsed.greenFlags) ? parsed.greenFlags.slice(0, 10) : [],
    disclaimer,
  };
}
