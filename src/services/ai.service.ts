// src/services/ai.service.ts
import Groq from 'groq-sdk';
import { PrismaClient } from '@prisma/client';
import { logger } from '../utils/logger';

const prisma = new PrismaClient();
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const VISION_MODEL = 'meta-llama/llama-4-scout-17b-16e-instruct';
const TEXT_MODEL = 'llama-3.3-70b-versatile';

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
  score: number;
  verdict: 'LIKELY_AUTHENTIC' | 'SUSPICIOUS' | 'NEEDS_VERIFICATION';
  redFlags: string[];
  greenFlags: string[];
  disclaimer: string;
}

// ==========================================
// SCAN PROMPTS
// ==========================================
const SCAN_PROMPTS: Record<string, string> = {
  Pokemon: `Sei un esperto di carte Pokémon TCG. Analizza questa carta e rispondi SOLO in JSON valido (senza markdown, senza testo extra):
{
  "name": "nome esatto del Pokémon",
  "cardNumber": "numero della carta (es: 4/102)",
  "setName": "set se riconoscibile, altrimenti null",
  "rarity": "Common|Uncommon|Rare|Holo|Ultra Rare|Secret Rare|null",
  "condition": "Mint|Near Mint|Played|Damaged|null"
}
Se non riesci a leggere un campo metti null. NON inventare dati. Rispondi SOLO con il JSON.`,

  Scarpe: `Sei un autenticatore e identificatore di sneakers e scarpe di lusso di livello professionale, con conoscenza equivalente a un venditore StockX/GOAT verificato.

Analizza questa scarpa con attenzione maniacale a OGNI dettaglio: logo, suola, tomaia, cuciture, etichette, colori, texture, hardware.

GUIDA IDENTIFICAZIONE PER BRAND:

NIKE / AIR JORDAN:
- Air Jordan 1 High/Mid/Low: identifica il colorway esatto (es: Chicago=rosso/bianco/nero, Bred=nero/rosso, Royal=blu/nero, Shadow=grigio/nero, Mocha=marrone/bianco, Lost & Found, Satin Snake, Midnight Navy, Trophy Room)
- Air Force 1: Low/Mid/High, colore suola, materiale (pelle/canvas/suede), eventuali collaborazioni
- Nike Dunk: Low/High/SB, colorway (Panda=bianco/nero, Paisley, Cacao Wow, Fog, Mystic Red)
- Air Max: modello (90/95/97/270/2090/Plus TN), colorway
- Style code Nike formato: XXXXXX-XXX (6 cifre, trattino, 3 cifre) — leggilo se visibile sull'etichetta
- Sacai, Off-White, Travis Scott: cerca dettagli collaborazione (reverse Swoosh, zip ties, Cactus Jack)

ADIDAS / YEEZY:
- Yeezy Boost 350 V2: identifica il colorway (Zebra=bianco/nero, Bred=nero, Static=grigio, Clay=beige/rosa, Beluga=arancio, Onyx=nero totale, Natural, MX Rock, Sulfur)
- Yeezy 700: V1/V2/V3, colorway (Wave Runner=multicolor, Mauve, Salt, Inertia, Analog)
- Yeezy 500: colorway (Blush=deserto, Utility Black, Bone White, Enflame)
- Yeezy Foam Runner: colorway (Ararat=verde, MX Cream/Bone, Stone Sage, Vermilion)
- Adidas Samba: OG/Vegan/collab, colorway
- Adidas Gazelle: colore
- Codice articolo Adidas: 6 caratteri alfanumerici (es: FZ5421)

NEW BALANCE:
- 990: v1/v2/v3/v4/v5/v6, colore (Grey/Navy/Black/Green)
- 992: colorway (Grey, Navy, Teal, Made in USA)
- 993: grigio/viola
- 2002R: colorway (Protection Pack, Sea Salt, Rain Cloud, Phantom)
- 550: colorway (White/Red, White/Navy, Cream, Green)
- 574: colore
- 1906: colore
- 530: colore
- Collaborazioni: Joe Freshgoods, Aime Leon Dore, Teddy Santis, Casablanca

SALOMON:
- XT-6: colorway (Black/Alloy, Vanilla Ice, Plein Air)
- ACS Pro: colorway
- Speedcross 3/5: colorway
- Sense Ride: colore

SCARPE DI LUSSO:
- Louis Vuitton: pattern monogramma LV (canvas marrone/beige), Damier Ebene/Azur/Graphite, Epi leather, hardware dorato/argentato con logo LV. Modelli: LV Skate Sneaker, LV Runner Tatic, LV Trainer, LV Archlight, LV Frontrow, LV Time Out (donna), LV Boombox, Stellar
- Gucci: pattern GG canvas (doppia G intrecciata), strisce rosse/verdi Web, Horsebit. Modelli: Ace (con ape/tigre/cuore ricamato), Rhyton (logo Gucci grande), New Ace, Tennis 1977
- Balenciaga: Triple S (tre suole sovrapposte, logo sul tallone), Speed Trainer (calzino elasticizzato), Track (multisuola tecnica), Triple White, 3XL, Le Cagole
- Dior: pattern Dior Oblique (CD obliquo), B23/B27 Sneaker, Walk'n'Dior
- Prada: logo triangolare Prada, America's Cup (gommata), Monolith (lug sole)
- Bottega Veneta: Puddle Boot, Speedster, tessuto intrecciato Intrecciato
- Alexander McQueen: Oversole chunky bianca, piattaforma alta
- Off-White: zip ties, freccia, virgolette, testo OFFWHITE
- Maison Margiela: Replica (suola tennis con strisce), painted logo

Rispondi SOLO in JSON valido (senza markdown):
{
  "brand": "brand esatto o null",
  "model": "modello preciso o null",
  "colorway": "nome colorway ufficiale o descrizione colori precisa",
  "styleCode": "codice articolo visibile su etichetta/suola, altrimenti null",
  "size": "taglia visibile su etichetta interna o scatola, altrimenti null",
  "condition": "DS|VNDS|Used|Worn|null",
  "collaboration": "nome collaborazione se presente (es: Travis Scott, Sacai, ALD), altrimenti null",
  "luxuryMarkers": "dettagli identificativi visibili del brand di lusso, altrimenti null",
  "notes": "note aggiuntive utili per la valutazione"
}
NON inventare brand o modelli. Se non riconosci metti null. Rispondi SOLO JSON.`,

  Vestiti: `Sei un esperto autenticatore e identificatore di streetwear e abbigliamento di lusso di livello professionale.

Analizza questo capo in ogni dettaglio: logo, grafica, costruzione, etichette, hardware, materiali, colori, silhouette.

GUIDA PER BRAND:

SUPREME:
- Box Logo: font Futura Heavy Oblique, colore uniforme e piatto (rosso/bianco/nero/altri drop), proporzioni precise. Tee/Hoodie/Crewneck/Cap
- Collaborazioni: Louis Vuitton, Nike, The North Face, Burberry, Oreo
- Season: cerca il tag interno con stagione (FW23, SS24, ecc.)
- Accessori: cintura box logo, skateboard deck, bucket hat

STONE ISLAND:
- Patch bussola: ricamata sul braccio sinistro (non stampata), colori vividi, badge rimovibile con ago
- Badge varieties: nylon, metal, reflective, ice, data corrosion
- Etichetta interna: "Stone Island" in font preciso
- Compass Rose logo: simbolo bussola stilizzata

STÜSSY:
- Font corsivo Stüssy (firma di Shawn Stüssy), Stock logo (S stilizzata)
- Collaborazioni: Nike, Dior, Comme des Garçons, Our Legacy

PALACE:
- Logo tri-ferg (P triangolare), Palace Skateboards font
- Box logo simile a Supreme ma con "PALACE"

BAPE (A BATHING APE):
- Pattern camouflage Ape (1st Camo): simmetrico e dettagliato
- Shark Hoodie: zip fino alla testa con bocca squalo, occhi sulla hood
- Gorilla testa stilizzata, font BAPE

OFF-WHITE (Virgil Abloh):
- Virgolette " " grandi su ogni pezzo
- Industrial belt con testo "FOR WALKING" o citazione
- Zip ties pendenti con testo
- Font helvetica preciso

FEAR OF GOD / ESSENTIALS:
- Logo "ESSENTIALS" in gomma sul petto o retro
- Fog branding, materiali pesanti oversize

C.P. COMPANY:
- Goggles integrati nel cappuccio (Goggle Jacket)
- Logo Lente sul braccio, scritta C.P. COMPANY

TRAPSTAR:
- Logo Trapstar, "IT'S A SECRET" slogan
- Irongate font, London streetwear

MONCLER:
- Logo patch triangolare aquila stilizzata con ricamo dettagliato
- Tessuto nylon lucido trapuntato (quilted)
- Zip YKK, etichette precise

CANADA GOOSE:
- Patch circolare artico con lupo stilizzato e scritta Arctic Program
- Cerniere YKK, logo Canada Goose su zip

LUSSO (Louis Vuitton, Gucci, Prada, Balenciaga, Dior):
- Monogramma/pattern preciso, qualità costruttiva, etichette interne

Rispondi SOLO in JSON valido (senza markdown):
{
  "brand": "brand esatto o null",
  "model": "nome pezzo/collezione preciso (es: Box Logo Tee, Shark Hoodie, Compass Crewneck) o null",
  "type": "tipo capo (Tee, Hoodie, Crewneck, Jacket, Bomber, Parka, Pants, Shorts, Cap, Shirt, ecc.)",
  "color": "colore principale con variante (es: Black, White, Heather Grey, Military Green)",
  "season": "stagione su etichetta (es: SS24, FW23) o null",
  "logoDescription": "descrizione precisa del logo/grafica visibile",
  "size": "taglia se visibile su etichetta",
  "collaboration": "nome collab se presente, altrimenti null",
  "notes": "dettagli aggiuntivi utili"
}
NON inventare brand o modelli. Rispondi SOLO JSON.`,

  Orologi: `Sei un orologiaio esperto e autenticatore certificato con conoscenza equivalente a un rivenditore Chrono24/Watchfinder autorizzato.

Analizza questo orologio in ogni dettaglio visibile: quadrante, testo sul quadrante, cassa, corona, bracciale, lunetta, lancette, indici, data.

GUIDA IDENTIFICAZIONE BRAND E MODELLI:

ROLEX:
- Submariner: lunetta rotante (nera=Sub No Date/126610LV verde=Hulk/Kermit, blu=BluSub), quadrante nero/verde/blu, 40mm o 41mm (ref 124060=No Date, 126610LN=Data nero, 126610LV=Data verde)
- Datejust: lunetta (Oyster/Jubilee/fluted), quadrante (colori infinite varietà), bracciale Jubilee o Oyster, finestra data con Cyclop. Ref 126334/126300/126233 (41mm), 126204/126200 (36mm)
- Day-Date: solo oro/platino, finestra giorno (in esteso) e data, bracciale President. Ref 228238/228235 (40mm)
- GMT-Master II: lancetta GMT supplementare, lunetta bicolore (Pepsi=rosso-blu ref 126710BLRO, Batman=nero-blu ref 126710BLNR, Root Beer=nero-marrone ref 126711CHNR)
- Daytona: cronografo (3 contatori), lunetta tachimetrica, ref 116500LN (nero) 116500 (bianco)
- Explorer: quadrante nero pulito con 3-6-9 arabi e lunetta liscia, ref 124270 (36mm) 226570 (42mm)
- Yacht-Master: lunetta in metallo/gomma, ref 126622 (acciaio-Rolesor)

OMEGA:
- Speedmaster Moonwatch: quadrante nero, cronografo con 3 sotto-quadranti (ore/min/sec), lunetta tachimetrica nera, bracciale Speedmaster, ref 310.30.42.50.01.001
- Seamaster Diver 300M: quadrante ondulato (blu/nero/verde), lunetta unidirezionale, ref 210.30.42.20.03.001
- Aqua Terra: quadrante a "teak" (righe orizzontali), ref 220.10.43.22.03.001
- De Ville Tresor: minimalista, quadrante bianco/sivory, nessuna complicazione

TUDOR:
- Black Bay: corona a fungo grande, lunetta snowflake, quadrante (bordeaux/nero/blu), ref 79230 (heritage) 79230B (blu) M79230R (bordeaux)
- Pelagos: titanio, lunetta girevole, ref 25600TB
- Ranger: quadrante con triangolo a 12, ref 79950

AUDEMARS PIGUET:
- Royal Oak: lunetta ottagonale con 8 viti esagonali perfettamente visibili, quadrante Grande Tapisserie (pattern mattoncini), bracciale integrato. Ref 15202 (39mm acciaio) 15400 (41mm) 15500 (41mm nuovo) 26240 (Chronograph)
- Royal Oak Offshore: più grande, lunetta più pronunciata, "OFFSHORE" sul quadrante

PATEK PHILIPPE:
- Nautilus: porthole design (cassa rotonda appiattita con lunetta orizzontale), quadrante (blu/nero/grigio) con righe orizzontali. Ref 5711 (40mm) 5726 (complicato)
- Calatrava: ref 5227 (39mm) semplicissimo, quadrante bianco/avorio
- Aquanaut: ref 5168 (42mm)

IWC:
- Portugieser: quadrante bianco con indici romani, grande cassa, ref IW500401/IW371446
- Pilot Mark: design aviazione, corona grande, ref IW327001
- Big Pilot: corona enorme a "pulsante", ref IW500901 (46mm)
- Portofino: ref IW356401, elegante

BREITLING:
- Navitimer: lunetta con regolo scorrevole (calcoli di navigazione), ref AB0137 (41mm)
- Superocean: diving watch, ref A10370 (46mm)

TAG HEUER:
- Carrera: cronografo classico, ref CBN201A/CBN2A1A
- Monaco: cassa quadrata iconica (famosa Steve McQueen), ref CAW211P
- Aquaracer: diver, ref WAY111A

CARTIER:
- Santos: cassa quadrata con viti esagonali, ref WSSA0029/WSSA0030
- Tank: rettangolare classico, ref WSTA0030 (Must) WGTA0011 (Solo)
- Panthere: bracciale maglia quadrata
- Ballon Bleu: cassa rotonda con corona protetta, ref W69012Z4

SEIKO / GRAND SEIKO:
- Seiko: Prospex Diver (SPB143/SBDC), Presage (SPB), 5 Sports (SNKL)
- Grand Seiko: quadranti ispirati alla natura giapponese (Snowflake SBGA211, Shunbun SBGA413), ZARATSU polishing

CASIO:
- G-Shock: modello (GA-2100 CasiOak, DW-5600, GW-M5610, GMW-B5000, MTG-B3000)
- Edifice: ref EFR-571

Rispondi SOLO in JSON valido (senza markdown):
{
  "brand": "brand esatto o null",
  "model": "modello preciso (es: Submariner Date, Royal Oak, Nautilus) o null",
  "reference": "reference number completo se leggibile sul quadrante o se identificabile con certezza, altrimenti null",
  "year": "anno approssimativo se identificabile da design/reference, altrimenti null",
  "caseSize": "diametro stimato in mm o null",
  "caseMaterial": "Acciaio Oystersteel|Oro giallo 18k|Oro rosa 18k|Oro bianco|Bicolore Rolesor|Titanio|Ceramica|Altro|null",
  "dialColor": "colore e finitura quadrante (es: Nero lucido, Blu sunburst, Verde oliva)",
  "dialText": "testo ESATTO visibile sul quadrante (brand, modello, materiale, Swiss Made) — trascrivi fedelmente",
  "bezel": "tipo lunetta preciso o null",
  "bracelet": "tipo bracciale (Jubilee/Oyster/President/Integrated/Leather/Rubber/Mesh) o null",
  "complications": "complicazioni visibili (Data, GMT, Cronografo, ecc.) o null",
  "notes": "dettagli aggiuntivi per identificazione precisa"
}
NON inventare reference number non visibili. Trascrivi FEDELMENTE il testo sul quadrante. Rispondi SOLO JSON.`,
};

// ==========================================
// UTILITY
// ==========================================
function safeParseJSON(text: string): any | null {
  try {
    const cleaned = text
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/, '')
      .replace(/\s*```\s*$/, '')
      .trim();
    return JSON.parse(cleaned);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch { return null; }
    }
    return null;
  }
}

// ==========================================
// SCAN PRODOTTO
// ==========================================
export async function scanProduct(imageBase64: string, category: string): Promise<ScanResult> {
  const prompt = SCAN_PROMPTS[category];
  if (!prompt) throw new Error(`Categoria non supportata dall'IA: ${category}`);

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
      temperature: 0.05,
      max_tokens: 900,
    });
  } catch (err) {
    logger.error('Errore Groq vision API', { err, category });
    throw new Error('Servizio IA temporaneamente non disponibile.');
  }

  const rawText = completion.choices[0]?.message?.content?.trim() || '';
  const parsed = safeParseJSON(rawText);

  if (!parsed) {
    return {
      category, confidence: 'LOW', rawText,
      warnings: ['IA non ha restituito una risposta strutturata. Compila manualmente.'],
    };
  }

  const result: ScanResult = { category, rawText, confidence: 'MEDIUM', details: parsed };

  switch (category) {
    case 'Pokemon': {
      if (parsed.name && parsed.cardNumber) {
        result.brand = 'Pokémon';
        result.model = `${parsed.name} - ${parsed.cardNumber}${parsed.setName ? ` (${parsed.setName})` : ''}`;
        result.confidence = parsed.setName ? 'HIGH' : 'MEDIUM';
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
        } catch { /* fallback */ }
      } else {
        result.confidence = 'LOW';
      }
      break;
    }
    case 'Scarpe': {
      if (parsed.brand && parsed.model) {
        result.brand = parsed.brand;
        const parts = [parsed.model, parsed.colorway, parsed.collaboration].filter(Boolean);
        result.model = parts.join(' – ');
        result.confidence = (parsed.styleCode || parsed.collaboration) ? 'HIGH' : parsed.colorway ? 'MEDIUM' : 'LOW';
      } else {
        result.confidence = 'LOW';
      }
      break;
    }
    case 'Vestiti': {
      if (parsed.brand && (parsed.model || parsed.type)) {
        result.brand = parsed.brand;
        result.model = [parsed.model || parsed.type, parsed.season, parsed.collaboration].filter(Boolean).join(' – ');
        result.confidence = parsed.model ? 'MEDIUM' : 'LOW';
      } else {
        result.confidence = 'LOW';
      }
      break;
    }
    case 'Orologi': {
      if (parsed.brand && parsed.model) {
        result.brand = parsed.brand;
        result.model = [parsed.model, parsed.reference].filter(Boolean).join(' ');
        result.confidence = parsed.reference ? 'HIGH' : parsed.dialText ? 'MEDIUM' : 'LOW';
      } else {
        result.confidence = 'LOW';
      }
      break;
    }
  }

  return result;
}

// ==========================================
// STIMA PREZZO
// ==========================================
export async function estimateMarketPrice(params: {
  category: string;
  brand: string;
  modelName: string;
  size?: string;
  condition?: string;
}): Promise<PriceEstimate> {
  const { category, brand, modelName, size, condition } = params;

  const cacheKey = { category, brand, modelName, size: size || '' };
  const cached = await prisma.marketPrice.findUnique({
    where: { category_brand_modelName_size: cacheKey },
  }).catch(() => null);

  if (cached && cached.expiresAt > new Date()) {
    return {
      minPrice: cached.minPrice, maxPrice: cached.maxPrice, avgPrice: cached.avgPrice,
      confidence: cached.sampleSize > 10 ? 'HIGH' : 'MEDIUM',
      reasoning: `Da cache (${cached.sampleSize} ref, source: ${cached.source})`,
      cached: true,
    };
  }

  const isLuxuryWatch = ['Rolex', 'Patek Philippe', 'Audemars Piguet', 'Richard Mille', 'A. Lange', 'F.P. Journe'].some(b => brand.toLowerCase().includes(b.toLowerCase()));
  const isMidWatch = ['Omega', 'IWC', 'Breitling', 'Panerai', 'Tudor', 'Grand Seiko', 'Cartier', 'Jaeger'].some(b => brand.toLowerCase().includes(b.toLowerCase()));
  const isLuxuryFashion = ['Louis Vuitton', 'Gucci', 'Balenciaga', 'Dior', 'Prada', 'Hermès', 'Chanel', 'Bottega', 'Moncler', 'Canada Goose'].some(b => brand.toLowerCase().includes(b.toLowerCase()));
  const isSneaker = ['Nike', 'Adidas', 'Jordan', 'Yeezy', 'New Balance', 'Salomon', 'Vans', 'Converse', 'Asics', 'Samba', 'Dunk', 'Air Force'].some(b => brand.toLowerCase().includes(b.toLowerCase()) || modelName.toLowerCase().includes(b.toLowerCase()));

  let contextPrices = '';

  if (isLuxuryWatch) {
    contextPrices = `PREZZI MERCATO USATO OROLOGI LUSSO (€, riferimento Chrono24/Watchfinder 2024-2025):
- Rolex Submariner No Date (124060): 9.500-12.500€
- Rolex Submariner Data Nero (126610LN): 11.000-14.500€
- Rolex Submariner Data Verde Hulk (116610LV): 14.000-18.000€
- Rolex Datejust 41 (126334): 7.000-10.000€
- Rolex Day-Date 40 Oro (228238): 28.000-38.000€
- Rolex GMT-Master II Pepsi (126710BLRO): 15.000-20.000€
- Rolex GMT-Master II Batman (126710BLNR): 13.000-17.000€
- Rolex Daytona Acciaio (116500LN): 20.000-28.000€
- Audemars Piguet Royal Oak 41mm (15500ST): 28.000-38.000€
- Audemars Piguet Royal Oak 39mm (15202ST): 35.000-50.000€
- Patek Philippe Nautilus 5711: 95.000-130.000€
- Patek Philippe Calatrava 5227: 25.000-35.000€
- Richard Mille RM11-03: 120.000-200.000€`;
  } else if (isMidWatch) {
    contextPrices = `PREZZI MERCATO USATO OROLOGI MID-RANGE (€, riferimento Chrono24/eBay 2024-2025):
- Omega Speedmaster Moonwatch (310.30.42.50.01.001): 4.500-6.500€
- Omega Seamaster Diver 300M Blu (210.30.42.20.03.001): 3.000-4.500€
- IWC Portugieser Chronograph (IW371446): 5.000-7.000€
- IWC Big Pilot (IW500901): 6.500-9.000€
- Breitling Navitimer B01 (AB0137): 4.500-6.500€
- Tudor Black Bay 41 (M79230N): 2.800-3.800€
- Tudor Black Bay 58 (M79030N): 2.500-3.500€
- Cartier Santos Medium (WSSA0029): 4.500-6.000€
- Grand Seiko Snowflake (SBGA211): 4.000-6.000€
- TAG Heuer Monaco (CAW211P): 3.000-4.500€`;
  } else if (isLuxuryFashion) {
    contextPrices = `PREZZI MERCATO USATO MODA LUSSO/STREETWEAR (€, Vestiaire Collective/StockX 2024-2025):
- LV Skate Sneaker DS: 650-1100€ | Usate: 400-700€
- LV Trainer DS: 750-1400€ | Usate: 500-900€
- LV Archlight DS: 850-1600€
- Gucci Ace DS: 350-700€ | Gucci Rhyton: 400-800€
- Balenciaga Triple S DS: 300-600€ | Speed Trainer: 200-450€
- Dior B23 DS: 600-900€
- Supreme Box Logo Tee DS: 200-600€ (colore/size dipendente)
- Supreme Box Logo Hoodie DS: 500-1500€
- Moncler Maya Jacket: 800-1400€ usata | 1200-2000€ DS
- Stone Island Shadow Project Jacket: 600-1200€`;
  } else if (isSneaker) {
    contextPrices = `PREZZI MERCATO SNEAKER (€, StockX/GOAT/Klekt 2024-2025):
JORDAN:
- Air Jordan 1 High Chicago/Bred Toe/Royal Reimagined: 250-450€
- Air Jordan 1 High Lost & Found (FD4580-461): 180-280€
- Air Jordan 1 High Mocha/Satin Snake: 200-350€
- Air Jordan 1 Mid: 90-180€
- Air Jordan 4 (Military Black, Bred Reimagined): 200-400€
- Air Jordan 3 (White Cement Reimagined): 180-280€
NIKE DUNK:
- Nike Dunk Low Panda (DD1391-100): 90-150€
- Nike Dunk Low Cacao Wow: 100-160€
- Nike SB Dunk Low (Travis Scott, Ben & Jerry's): 400-900€
YEEZY:
- Yeezy 350 V2 Zebra: 150-250€
- Yeezy 350 V2 Bred: 200-350€
- Yeezy 350 V2 Onyx: 140-200€
- Yeezy 700 Wave Runner: 200-350€
- Yeezy Foam Runner: 80-150€
NEW BALANCE:
- New Balance 2002R: 100-200€
- New Balance 550: 90-160€
- New Balance 990v3/v4/v5: 120-220€
- New Balance 993: 150-250€
SALOMON:
- Salomon XT-6: 120-200€
- Salomon ACS Pro: 130-200€`;
  }

  const prompt = `Sei un analista esperto del mercato del resell. Stima il prezzo di mercato attuale in EURO (€) per:
- Categoria: ${category}
- Brand: ${brand}
- Modello: ${modelName}
${size ? `- Taglia: ${size}` : ''}
${condition ? `- Condizioni: ${condition}` : ''}

${contextPrices ? `RIFERIMENTI PREZZI DI MERCATO AGGIORNATI:\n${contextPrices}\n` : ''}

Usa questi riferimenti per stimare il prezzo del prodotto specifico. Considera taglia (per sneaker, taglie US 9-11 sono più liquide), condizioni (DS/VNDS = massimo, Worn = -30/40%), e anno/edizione.

Rispondi SOLO con un JSON valido (senza markdown):
{
  "minPrice": numero (€ minimo realistico),
  "maxPrice": numero (€ massimo per DS/ottime condizioni),
  "avgPrice": numero (€ medio di mercato),
  "confidence": "HIGH" | "MEDIUM" | "LOW",
  "reasoning": "1-2 frasi sulla stima e il mercato di riferimento (in italiano)"
}
Se non conosci abbastanza il prodotto, metti confidence "LOW" e prezzi a 0.`;

  let completion;
  try {
    completion = await groq.chat.completions.create({
      messages: [{ role: 'user', content: prompt }],
      model: TEXT_MODEL,
      temperature: 0.1,
      max_tokens: 400,
    });
  } catch (err) {
    logger.error('Errore Groq text API prezzi', { err });
    return { minPrice: 0, maxPrice: 0, avgPrice: 0, confidence: 'LOW', reasoning: 'Servizio non disponibile.', cached: false };
  }

  const raw = completion.choices[0]?.message?.content?.trim() || '';
  const parsed = safeParseJSON(raw);

  if (!parsed || parsed.avgPrice === undefined) {
    return { minPrice: 0, maxPrice: 0, avgPrice: 0, confidence: 'LOW', reasoning: 'Stima non disponibile.', cached: false };
  }

  try {
    await prisma.marketPrice.upsert({
      where: { category_brand_modelName_size: cacheKey },
      create: {
        category, brand, modelName, size: size || '',
        minPrice: parsed.minPrice || 0, maxPrice: parsed.maxPrice || 0, avgPrice: parsed.avgPrice || 0,
        sampleSize: 1, source: 'GROQ_AI',
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
      update: {
        minPrice: parsed.minPrice || 0, maxPrice: parsed.maxPrice || 0, avgPrice: parsed.avgPrice || 0,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });
  } catch (err) { logger.warn('Cache prezzo non salvata', { err }); }

  return {
    minPrice: parsed.minPrice || 0, maxPrice: parsed.maxPrice || 0, avgPrice: parsed.avgPrice || 0,
    confidence: parsed.confidence || 'MEDIUM', reasoning: parsed.reasoning || '', cached: false,
  };
}

// ==========================================
// LEGIT CHECK PROMPTS
// ==========================================
const LEGIT_CHECK_PROMPTS: Record<string, string> = {
  Scarpe: `Sei un autenticatore di scarpe certificato (livello CheckCheck/Legit App/StockX Verification). Analizza OGNI dettaglio visibile per determinare autenticità.

SNEAKER (Nike/Jordan/Adidas/New Balance):
Nike/Jordan:
- Swoosh: curvatura naturale, spessore uniforme, non troppo grande/piccolo
- Air Jordan Wings logo: proporzioni ali precise, "NIKE AIR" sul tallone corretto
- Jumpman: silhouette precisa, proporzionata, non deformata
- Suola: pattern incisioni profonde e uniformi, materiale consistente
- Tag interno: font preciso, codice articolo formato corretto (XXXXXX-XXX), paese origine corretto
- Adidas: tre strisce parallele equidistanti, trifoglio/trefoil proporzionato
- Yeezy 350: Primeknit pattern uniforme e denso, scritta SPLY-350 (se presente) font corretto, suola Boost capsule uniformi e dense
- New Balance: "N" proporzionata e precisa, Made in USA tag se applicabile

SCARPE DI LUSSO:
Louis Vuitton:
- Monogramma LV: pattern perfettamente simmetrico, LV mai tagliato storto alle cuciture, dimensioni uniformi
- Hardware: logo LV inciso IN RILIEVO (mai stampato piatto), colore oro/argento uniforme
- Stamp interno: "LOUIS VUITTON PARIS MADE IN FRANCE/ITALY" — font preciso, spaziatura corretta
- Suola: LV molded/stampato sulla suola, qualità materiale

Gucci:
- Doppia G: specchiata e precisa, mai storta, dimensioni uniformi
- Canvas GG: pattern uniforme senza variazioni di colore
- Strisce Web: rosse/verdi precise e parallele
- Cuciture a contrasto: regolari e uniformi

Balenciaga Triple S:
- Logo "BALENCIAGA" sul tallone: font corretto, non pixelato
- Tre strati suola: distinti e ben definiti, qualità materiale
- Upper: materiali distinti e di qualità per ogni sezione

Rispondi SOLO in JSON valido (senza markdown):
{
  "score": numero 0-100 (100=autentico certo, 50=non verificabile, 0=fake evidente),
  "verdict": "LIKELY_AUTHENTIC" | "SUSPICIOUS" | "NEEDS_VERIFICATION",
  "redFlags": ["lista di problemi specifici rilevati con dettagli precisi"],
  "greenFlags": ["lista di segnali positivi di autenticità con dettagli precisi"]
}
Foto scarsa qualità o dettagli non visibili → score 50, verdict "NEEDS_VERIFICATION".`,

  Vestiti: `Sei un autenticatore esperto di streetwear e lusso (livello professionista). Analizza questa foto per autenticità.

Supreme:
- Box Logo: font Futura Heavy Oblique PERFETTO — proporzioni H/W del box precise, lettere equidistanti, colore piatto senza variazioni, cuciture hood precise, qualità cotone pesante (non si vede attraverso)
- Tag interno: font Supreme preciso, taglia in formato S/M/L/XL/XXL, country of manufacture corretto

Stone Island:
- Patch bussola: RICAMATA (non stampata) — fili singoli visibili, colori vividi e precisi, badge rimovibile con ago che non lascia segni
- Badge internal lining: font Stone Island preciso

Off-White:
- Stampa testo: bordi NETTI senza sfalcio o pixel, font Helvetica preciso
- Zip ties: testo leggibile e corretto, materiale plastica rigida
- Virgolette " ": dimensioni e posizione precise

Moncler:
- Patch aquila: ricamo DETTAGLIATO (singoli fili visibili), colori precisi, non stampata
- Tessuto: nylon lucido di qualità, quilting uniforme
- Zip YKK: incisione YKK sulla zip visibile

BAPE:
- Camouflage: pattern SIMMETRICO e dettagliato, colori vividi
- Logo gorilla: proporzionato, non deformato

Rispondi SOLO in JSON valido (senza markdown):
{
  "score": numero 0-100,
  "verdict": "LIKELY_AUTHENTIC" | "SUSPICIOUS" | "NEEDS_VERIFICATION",
  "redFlags": ["problemi specifici rilevati"],
  "greenFlags": ["segnali positivi di autenticità"]
}`,

  Orologi: `Sei un orologiaio esperto e autenticatore certificato di orologi di lusso. Analizza questa foto.

ROLEX:
- Corona a 5 punte: incisa sul rehaut (bordo interno quadrante) — precisa e in rilievo, mai piatta
- Fondello corona di carica: scritta ROLEX in miniatura
- Ciclope (lente data): ingrandimento 2.5x preciso, bordi netti
- Lancette: Chromalight/Luminova verde brillante, forma perfetta (foglia, Mercedes, Baton secondo il modello)
- Testo quadrante: font Rolex helvetica senza sbavature, "Swiss Made" in basso
- Bracciale: maglie impeccabili, clasp Oysterclasp/Glidelock con logo inciso
- Rehaut: scritta ROLEX OYSTER ripetuta in cerchio (modelli recenti dal 2002)

AUDEMARS PIGUET Royal Oak:
- ESATTAMENTE 8 viti esagonali sulla lunetta ottagonale — allineate perfettamente
- Quadrante Grande Tapisserie: pattern mattoncini UNIFORME e preciso
- Bracciale integrato: giunzioni cassa-bracciale impeccabili
- Caseback AP: AP Coat of Arms (scudo con chiavi)

PATEK PHILIPPE:
- Logo Calatrava (croce con ansa): proporzioni perfette, incisione precisa
- Scritta GENEVE: font preciso
- Finitura perlage/côtes de Genève: impeccabile anche su caseback
- Qualità generale: la migliore al mondo

OMEGA:
- Logo Ω: proporzionato, base dritta, simmetrico
- Quadrante sunburst: riflessi radiali UNIFORMI (falsi hanno riflessi irregolari)
- Co-Axial escapement text sul quadrante: font preciso

VERIFICA GENERALE:
- Testo sul quadrante: NO sbavature, NO font irregolari, NO allineamenti storti
- Indici/indici: ben fissati, luminova uniforme
- Corona di carica: incisione logo precisa, nessun gioco eccessivo
- Lancette secondi automatico: sweep fluido continuo (quarzo = ticchettio = attenzione su orologi dichiarati automatici)

Rispondi SOLO in JSON valido (senza markdown):
{
  "score": numero 0-100,
  "verdict": "LIKELY_AUTHENTIC" | "SUSPICIOUS" | "NEEDS_VERIFICATION",
  "redFlags": ["problemi specifici rilevati con dettagli tecnici precisi"],
  "greenFlags": ["segnali positivi di autenticità con dettagli tecnici precisi"]
}`,
};

// ==========================================
// LEGIT CHECK
// ==========================================
export async function checkAuthenticity(imageBase64: string, category: string): Promise<AuthenticityCheck> {
  if (!['Scarpe', 'Vestiti', 'Orologi'].includes(category)) {
    return { score: 50, verdict: 'NEEDS_VERIFICATION', redFlags: [], greenFlags: [], disclaimer: 'Legit check non supportato per questa categoria.' };
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
      temperature: 0.1,
      max_tokens: 900,
    });
  } catch (err) {
    logger.error('Errore Groq legit check', { err });
    return { score: 50, verdict: 'NEEDS_VERIFICATION', redFlags: [], greenFlags: [], disclaimer: 'Servizio legit check non disponibile.' };
  }

  const raw = completion.choices[0]?.message?.content?.trim() || '';
  const parsed = safeParseJSON(raw);
  const disclaimer = '⚠️ Valutazione automatica basata sull\'immagine. NON sostituisce un autenticatore professionista. Per acquisti importanti usa Legit App, CheckCheck o un esperto.';

  if (!parsed) {
    return { score: 50, verdict: 'NEEDS_VERIFICATION', redFlags: [], greenFlags: [], disclaimer: 'IA non ha potuto valutare. ' + disclaimer };
  }

  return {
    score: Math.max(0, Math.min(100, parsed.score || 50)),
    verdict: parsed.verdict || 'NEEDS_VERIFICATION',
    redFlags: Array.isArray(parsed.redFlags) ? parsed.redFlags.slice(0, 10) : [],
    greenFlags: Array.isArray(parsed.greenFlags) ? parsed.greenFlags.slice(0, 10) : [],
    disclaimer,
  };
}
