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

  Scarpe: `Sei il massimo esperto mondiale di calzature: conosci ogni sneaker streetwear E ogni scarpa di lusso come un autenticatore StockX + un personal shopper dei migliori department store di Parigi e Milano. Analizza questa scarpa con attenzione assoluta a OGNI dettaglio visibile: logo, suola, tomaia, cuciture, etichette, colori, texture, hardware, pattern, silhouette.

━━━ SNEAKER / STREETWEAR ━━━

NIKE / AIR JORDAN:
- Air Jordan 1 High: Chicago (rosso/bianco/nero), Bred Banned/Toe/Reimagined (nero/rosso), Royal/Reimagined (blu/nero), Shadow (grigio/nero), Mocha (marrone/bianco), Lost & Found (marrone vintage), Satin Snake, Midnight Navy, Trophy Room, Rookie of the Year, Spider-Man, Volt Gold, Electro Orange, Dark Mocha, University Blue, Hyper Royal, Canary Yellow, Tie-Dye, Seafoam, Washed Heritage
- Air Jordan 1 Mid: colore + materiale
- Air Jordan 1 Low: colore + eventuali collab
- Air Jordan 3: White Cement Reimagined, Fire Red, Black Cement, True Blue, Wizards, A Ma Maniére
- Air Jordan 4: Military Black, Bred Reimagined, White Thunder, Red Thunder, Cool Grey, University Blue, Taupe Haze, Canyon Purple, Neon, Off-White Sail
- Air Jordan 11: Concord, Bred, Space Jam, Legend Blue, Win Like 96, Jubilee
- Air Jordan 6: Carmine, Infrared, DMP, Washed Denim, Georgetown
- Nike Dunk Low: Panda (bianco/nero), Cacao Wow, Paisley, Mystic Red, Fog, Rose Whisper, Setsubun, Olive, Black White, Wheat Mocha, SB Travis Scott, SB Ben & Jerry's, SB Chunky Dunky, SB Civilist, SB Medicom
- Nike Air Force 1 Low/Mid/High: colore + eventuali collab (Travis Scott, Off-White, Tiffany, Supreme)
- Nike Air Max 90/95/97/270/Plus TN: colorway preciso
- Style code Nike: formato XXXXXX-XXX (es: 555088-711) — leggi da etichetta interna/scatola se visibile

ADIDAS / YEEZY:
- Yeezy Boost 350 V2: Zebra (bianco/nero), Bred (nero totale), Static (grigio), Clay (beige/rosa), Beluga (arancio), Onyx (nero), Natural (beige), MX Rock, MX Oat, Sulfur, Ash Stone, Ash Pearl, Bone, Fade, Carbon, Salt, Oreo, Lundmark, Citrin, Yecheil, Israfil, Cinder
- Yeezy Boost 700: Wave Runner (multicolor), Mauve (rosa/grigio), Salt (bianco sporco), Inertia (grigio/beige), Analog (beige), Teal Blue, Azareth, Vanta (nero total), Bright Blue, Sun
- Yeezy 500: Blush (sabbia/deserto), Utility Black, Bone White, Enflame, Stone, Granite, Taupe, Ash Grey
- Yeezy Foam Runner: Ararat (verde oliva), MX Cream/Bone, Stone Sage, Vermilion (rosso), Sand, Mist, Onyx
- Yeezy Slide: Pure (beige), Onyx (nero), Bone, Azure, MX Sand Grey, Flax, Slate Marine, Core
- Adidas Samba: OG Classic (bianco-nero-verde), Pony Hair, Black Gum, White/Silver, Hazy Green, collab (Wales Bonner, Sporty & Rich, Notitle)
- Adidas Gazelle: Indoor, Bold, colore
- Adidas Campus 00s: colore
- Codice Adidas: 6 caratteri (es: FZ5421, IE3452)

NEW BALANCE:
- 990v3/v4/v5/v6: Grey/Navy/Black/Green (Made in USA)
- 992: Grey/Navy/Teal/Steel/Tan (Made in USA)
- 993: Grey/Brown/Marblehead
- 2002R: Protection Pack (Sea Salt, Rain Cloud, Phantom), Mirage Grey, Quartz Grey, Moonrock, Orb Grey, collab (Joe Freshgoods Conversations, ALD, Casablanca, Stray Rats)
- 550: White/Red, White/Navy, Aime Leon Dore (bianco/verde/blu/panna), Cream, White/Green
- 574: colore base
- 1906R/D: Protection Pack, colore
- 530: White/Silver, Munsell White, colore
- 327: colore + eventuali collab
- Collaborazioni: Joe Freshgoods, Aime Leon Dore, Teddy Santis, Casablanca, Bodega, SNS

SALOMON:
- XT-6: Black/Alloy/Ebony, Vanilla Ice/Almond Milk, Plein Air/Lunar Rock, Taos Taupe, collab (Kith, Auralee, And Wander, Sporty & Rich)
- ACS Pro/Advanced: colorway
- Speedcross 3/5: colorway
- Sense Ride 5: colorway
- XA Pro 3D: colorway

ASICS:
- Gel-Kayano 14: Cream/White, collab (Kith, Ronnie Fieg)
- Gel-1130/Nimbus 9/GT-2160: colorway
- Gel-Lyte III/V: colorway, collab

━━━ SCARPE DI LUSSO — ANALISI MANIACALE ━━━

LOUIS VUITTON (priorità massima — è il brand più comune nel resell di lusso):
PATTERN RICONOSCIMENTO:
- Monogramma Canvas: pattern LV (L e V intrecciati) su fondo marrone/beige caldo — SIMMETRICO e UNIFORME
- Damier Ebene: scacchiera marrone/beige scuro con "Louis Vuitton Paris" nelle caselle
- Damier Azur: scacchiera bianco/beige/blu chiaro
- Damier Graphite: scacchiera grigio scuro/nero
- Epi Leather: pelle con texture a grana fine con striature, colori vividi (nero, rosso, blu, verde, bianco)
- Monogramma Giant: monogramma ingrandito in vari colori (nero/grigio, bianco/grigio, arancio/nero, giallo, rosa)
- Vernis: pelle verniciata lucidissima, monogramma in rilievo
MODELLI LV SNEAKER (identifica quale):
- LV Skate Sneaker: silhouette bassa tipo skate, suola vulcanizzata, patch LV sul lato, canvas monogramma o pelle — colorway: Monogram Brown, Damier Graphite, nero/bianco, bianco/bianco
- LV Runner Tatic: runner tecnico, tomaia mesh/tessuto con overlay LV, suola chunky multicolore/bicolore — riconosci il logo LV sulla linguetta e tallone
- LV Trainer #54: sneaker robusta, overlay in pelle, logo LV grande in rilievo sul lato, disponibile in molti colori
- LV Archlight 2.0: suola chunky curva futuristica, tomaia mesh, LV sul tallone e laterale
- LV Time Out (principalmente donna): stile tennis low-top, bordo suola colorato, LV sul fianco
- LV Frontrow: runner femminile, monogramma in evidenza
- LV Stellar: stile sportivo, logo sul lato
- LV Boombox: silhouette chunky alta, logo laterale
- LV Escape Sneaker: tessuto leggero, suola gomma, colorato
- LV Rivoli: pelle classica con logo LV inciso, stile oxford/derby
HARDWARE LV: logo LV inciso in rilievo su fibbie/zip/occhielli — mai stampato piatto

GUCCI:
PATTERN:
- GG Canvas (beige/marrone, grigio/nero): doppia G intrecciata perfettamente simmetrica e specchiata
- Strisce Web: rosso-verde-rosso o blu-rosso-blu, parallele e uniformi
- GG Supreme: simile a GG Canvas ma su fondo diverso
- Interlocking G: due G intrecciate in metallo dorato su fibbia/dettagli
MODELLI GUCCI SNEAKER:
- Gucci Ace: low-top pelle bianca, spesso con patch ricamato (ape, tigre, cuore, serpente, farfalla, fiore), striscia Web sul fianco, logo GUCCI in verde/rosso
- Gucci Rhyton: chunky con logo GUCCI grande stampato, disponibile in canvas GG o pelle, suola oversize
- Gucci Tennis 1977: canvas GG, striscia Web, low-top stile vintage
- Gucci Run: runner tecnico, GG canvas, suola multicolore
- Gucci Ultrapace: pelle/suede, suola chunky, logo laterale
- Gucci Screener: stile vintage, GG canvas/pelle, strisce rosse/verdi
- Gucci New Ace: evoluzione Ace con platform
- Gucci Flashtrek: trekking-inspired, logo laterale
- Gucci Basket: pelle, logo sul fianco, alta/bassa

BALENCIAGA:
- Triple S: TRE strati suola sovrapposti (colori diversi), logo BALENCIAGA sul tallone in font preciso Balenciaga, upper multi-materiale. Colorway: Triple White, Grey/Pink, Black/Red, Blue Yellow, Speed Hunters, Clear Sole, ecc.
- Speed Trainer/Runner: calzino elasticizzato senza suola tradizionale, logo laterale
- Track/Track.2: suola tecnica con elementi multipli, mesh upper, logo laterale
- 3XL: chunky estremo, logo piccolo, silhouette futuristica
- Defender: suola altissima con borchie, logo testa
- Phantom: runner tecnico, logo sul tallone
- Cargo Sneak: stile cargo militare
- Drive: stile sportivo pulito

DIOR:
- Pattern Dior Oblique: CD obliquo ripetuto (C e D sovrapposte) — beige/marrone, nero/grigio, blu
- Logo "Christian Dior" o "DIOR" in font serif elegante
MODELLI:
- B23 High/Low: canvas Dior Oblique, suola con "DIOR" scritto, alta/bassa
- B27: bicolore, pelle+canvas Oblique, "DIOR" laterale
- B22: runner tecnico, mesh + overlay, logo laterale
- Explorer: suola chunky, canvas Oblique
- Walk'n'Dior: stile platform, canvas Oblique o pelle
- Dior-ID: runner futuristico

PRADA:
- Logo triangolare PRADA in metallo/smalto (proporzioni precise, font serif classico)
- Re-Nylon: nylon riciclato tecnico con logo
MODELLI:
- America's Cup: gomma/pelle, logo laterale, silhouette chunky classica anni 90
- Monolith: suola lug enorme, pelle spazzolata, logo frontale o laterale
- Wheel: suola rotonda oversize, logo
- Downtown: sneaker pulita, logo sul fianco
- Macro Re-Nylon: suola big, tessuto Re-Nylon
- Cloudbust Thunder: knit upper, suola chunky

BOTTEGA VENETA:
- Pattern Intrecciato: intreccio di strisce di pelle (NON una stampa — strisce REALI intrecciate a mano)
- MODELLI: Puddle Boot (stivale gomma lucida), Speedster (runner con Intrecciato), Tire (sandalo piattaforma), Stretch mule

VALENTINO:
- VLTN: lettera V stilizzata con LTN, logo VLogo
- Garavani Open: sneaker con vstrap/borchie
- Rockstud: borchie piramidali metalliche su tomaia o suola
- Roman Stud: borchie quadrate più grandi

CELINE:
- Logo CELINE in font sans-serif (senza accent sulla E dal 2018 con Slimane)
- MODELLI: Triomphe (canvas monogramma Triomphe), CT-07, Block/Runner, Asics collab

LOEWE:
- Logo L stilizzato, Anagram canvas (L intrecciate in pattern)
- MODELLI: Flow Runner, Flex Sneaker, Ballet Runner

COMMON PROJECTS (Achilles):
- Numero di serie dorato sul tallone in formato: [codice colore]-[taglia]-[anno] (es: 0506 44 09)
- Pelle liscia bianca/nera/colorata, suola Margom bianca, ZERO logo visibile — SOLO il numero dorato
- Modelli: Achilles Low/High/Retro, Bball High/Low, Track, Resort Runner

GOLDEN GOOSE (GGDB):
- Stella argentata/glitterata sul fianco (in varie forme), aspetto volutamente invecchiato/used
- Pelle/suede consumata intenzionalmente, lacci colorati, suola spessa
- Modelli: Superstar (stella classica), Slide, Ball Star, Mid Star, Hi Star, Running Sole

MAISON MARGIELA:
- Replica: suola da scarpa da tennis (Court), strisce laterali, logo MM6 o numero romano (esempio: MM6) sul insole, paint brushstroke sul logo
- Tabi: punta biforcata (pollice separato), caratteristico unico al mondo
- Future: sneaker futuristica, logo MM in rilievo

RICK OWENS:
- Silhouette estrema, spesso platform alta
- Ramones: low-top pelle, suola carro armato, logo RA sul tallone
- Geobasket: alta, silhouette geometrica
- DRKSHDW: linea più streetwear, logo DRKSHDW
- Turbowpn/Woven: costruzione particolare

LANVIN:
- Curb: suola chunky ondulata caratteristica, logo LANVIN sul tallone, silhouette chunky ma elegante. Colorway: bianco/arancio, nero, bianco/rosso, multicolor

ALEXANDER MCQUEEN:
- Oversole: suola chunky bianca altissima, platform esagerata, logo AM McQ sul tallone, pelle liscia
- Tread Slick: suola con tread pattern, piattaforma

OFF-WHITE (Virgil Abloh):
- Zip ties pendenti con testo (es: "FOR WALKING", "SHOELACES")
- Virgolette " " su ogni pezzo
- Freccia diagonale, testo OFFWHITE, Industrial strap
- Collab Nike: costruzione speciale, zip tie caratteristica

LORO PIANA:
- Materiali premium (cashmere, lana, pelle pregiata), branding minimalista, logo LP
- Modelli: LP BB (bicolor bassa), Walk & Wander, Summer Walk

Rispondi SOLO in JSON valido (senza markdown):
{
  "brand": "brand esatto o null",
  "model": "modello preciso o null",
  "colorway": "nome colorway ufficiale o descrizione colori precisa",
  "styleCode": "codice articolo visibile su etichetta/suola, altrimenti null",
  "size": "taglia visibile su etichetta interna o scatola, altrimenti null",
  "condition": "DS|VNDS|Used|Worn|null",
  "collaboration": "nome collaborazione se presente, altrimenti null",
  "luxuryMarkers": "descrivi ESATTAMENTE i dettagli di lusso visibili: pattern, hardware, testo, suola, costruzione — null se non lusso",
  "priceRange": "fascia prezzo stimata (es: 200-400€, 600-1200€, 12000-16000€) basata sul brand/modello",
  "notes": "qualsiasi altro dettaglio utile per identificazione e valutazione"
}
NON inventare brand o modelli. Se non riconosci con certezza metti null. Per lusso: descrivi SEMPRE i marker visibili nel campo luxuryMarkers. Rispondi SOLO JSON.`,

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
    contextPrices = `PREZZI MERCATO SCARPE/ABBIGLIAMENTO LUSSO (€, Vestiaire Collective/StockX/Chrono24 2024-2025):
LOUIS VUITTON SNEAKER:
- LV Skate Sneaker DS: 650-1100€ | Usate buone: 400-700€
- LV Runner Tatic DS: 700-1200€ | Usate: 450-800€
- LV Trainer #54 DS: 750-1400€ | Usate: 500-950€
- LV Archlight 2.0 DS: 900-1600€
- LV Time Out DS: 600-1000€
- LV Frontrow DS: 500-900€
GUCCI SNEAKER:
- Gucci Ace (semplice) DS: 350-600€ | Gucci Ace (patch raro) DS: 500-900€
- Gucci Rhyton DS: 400-800€ | Usate: 250-500€
- Gucci Tennis 1977 DS: 500-800€
- Gucci Run DS: 600-900€
BALENCIAGA:
- Balenciaga Triple S DS: 300-550€ | Usate: 180-350€
- Balenciaga Speed Trainer DS: 250-450€
- Balenciaga Track DS: 350-600€
- Balenciaga 3XL DS: 400-700€
DIOR:
- Dior B23 High DS: 700-1000€ | Low DS: 600-900€
- Dior B27 DS: 700-1100€
COMMON PROJECTS:
- Achilles Low (white) DS: 350-500€ | Usate: 200-350€
- Achilles colori rari DS: 450-700€
GOLDEN GOOSE:
- GGDB Superstar DS: 400-600€ | Usate: 250-400€
ALTRI LUSSO:
- Alexander McQueen Oversole DS: 300-500€
- Maison Margiela Replica DS: 350-600€
- Valentino Garavani Rockstud DS: 500-800€
- Lanvin Curb DS: 600-900€
- Loro Piana LP BB DS: 500-800€
- Rick Owens Ramones DS: 500-900€
ABBIGLIAMENTO:
- Supreme Box Logo Tee DS: 200-600€ | Supreme Box Logo Hoodie DS: 500-1500€
- Stone Island Jacket: 400-900€ usata
- Moncler Maya Jacket DS: 1200-2000€ | Usata: 800-1400€
- Canada Goose Expedition DS: 700-1200€`;
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
  Scarpe: `Sei il massimo autenticatore di calzature al mondo (certificato CheckCheck, Legit App, StockX Verification, con esperienza in case d'asta di lusso). Analizza OGNI dettaglio visibile per determinare autenticità con precisione assoluta.

━━━ SNEAKER STREETWEAR ━━━

NIKE / AIR JORDAN:
- Swoosh: curvatura naturale e fluida, spessore uniforme dal tallone alla punta — fake hanno Swoosh troppo grande, storto o con angolo sbagliato
- Air Jordan 1 Wings logo: proporzioni ali esatte, "NIKE AIR" sul tallone in font corretto
- Jumpman: silhouette Jordan precisa — fake hanno testa troppo grande o gambe storte
- Tag interno: font Nike preciso, codice articolo formato XXXXXX-XXX (6+3), "Made in Vietnam/Indonesia/China" — caratteri uniformi
- Suola: pattern incisioni PROFONDE e uniformi, non superficiali — fake hanno pattern appiattito
- Cuciture: regolari, distanza uniforme, filo non sfrangiato
- Air bubble (se visibile): trasparente, uniforme

ADIDAS / YEEZY:
- Yeezy 350 V2 Primeknit: trama densa e uniforme, pattern geometrico preciso — fake hanno trama rada o irregolare
- SPLY-350 (modelli con scritta): font e spaziatura precisi, color contrasto corretto
- Boost: capsule (bolle) uniformi, dense, elastiche visivamente — fake hanno capsule irregolari o piatte
- Yeezy 700: mesh strutturato con layer precisi — fake hanno mesh irregolare
- Tre strisce Adidas: equidistanti e parallele PERFETTAMENTE

NEW BALANCE:
- "N" embroidered: ricamo uniforme, proporzioni corrette per il modello
- Made in USA tag: specifico formato, font corretto
- Suola: durometer corretto, flessibilità visiva

━━━ SCARPE DI LUSSO — VERIFICA PROFESSIONALE ━━━

LOUIS VUITTON (verifica più importante):
- Monogramma Canvas: pattern LV SIMMETRICO — il motivo non deve mai essere tagliato storto alle cuciture, le LV devono essere IDENTICHE tra loro come dimensioni
- Hardware (fibbie, zip, occhielli): logo LV inciso IN RILIEVO con profondità — sui fake il logo è STAMPATO piatto o superficiale. Hardware deve avere colore uniforme senza macchie o sbavature
- Stamp interno: "LOUIS VUITTON PARIS MADE IN FRANCE" o "MADE IN ITALY" — font helvetica condensato PRECISO, spaziatura uniforme. Sui fake le lettere sono troppo sottili/spesse o storte
- Suola: LV molded in gomma — lettere in rilievo uniformi, non sbavate
- Cuciture: filo colore preciso (beige/marrone per canvas), distanza uniformissima — i fake hanno cuciture irregolari
- Qualità materiale canvas: texture uniforme, colore profondo — i fake usano canvas più sottile/lucido

GUCCI:
- Doppia G: SPECULARE e perfettamente simmetrica — una G è il riflesso dell'altra. Su fake una G è più grande o le proporzioni sono diverse
- Canvas GG: pattern uniforme senza variazioni di tono o dimensione — fake hanno GG di dimensioni diverse
- Strisce Web (rosse/verdi): PARALLELE e larghezza uniforme — fake hanno strisce storte o di larghezza variabile
- Cuciture: filo a contrasto regolare, mai sfrangiato
- Insole: font GUCCI preciso, logo Horsebit se presente

BALENCIAGA:
- Triple S — Logo "BALENCIAGA" sul tallone: font Balenciaga SANS-SERIF specifico, lettere equidistanti e perfettamente allineate — fake hanno font sbagliato o pixel visibili
- Tre strati suola: DISTINTI con linee di separazione nette, materiali diversi visibili — fake fondono i layer
- Upper: ogni sezione ha materiale e texture distinti — mesh, suede, pelle ben separati
- 3XL — logo: font minuscolo preciso sul tallone
- Speed Trainer: elastan uniforme, nessuna grinza irregolare

DIOR:
- Canvas Oblique: CD obliquo UNIFORME — dimensioni identiche in tutto il canvas, mai sbavato
- "DIOR" sul tallone o laterale: font serif elegante preciso
- B23: costruzione pulita, cuciture impeccabili

COMMON PROJECTS:
- Numero dorato sul tallone: CODICE IN ORO REALE — formato preciso [colore]-[UK size]-[anno] (4 cifre + 2 + 2), stampigliatura profonda uniforme — fake hanno stampa sbiadita o formato sbagliato
- Pelle: qualità pieno fiore liscia, nessuna irregolarità
- Suola Margom: bianca uniforme, no altri loghi

GOLDEN GOOSE:
- Stella: applicata (non stampata), cucita o incollata con qualità — sui fake la stella è piatta o stampata
- Invecchiamento: naturale e artistico — non eccessivo o regolare (paradossalmente i fake TROPPO consumati sono fake)
- Suola: vulcanizzata di qualità

MAISON MARGIELA REPLICA:
- Strisce court sulla suola: precisione e uniformità colore
- Insole: numero di linea MM (es: MM6) in font Maison Margiela preciso

VALENTINO ROCKSTUD:
- Borchie piramidali: metallo SOLIDO, base quadrata uniforme, non traballanti — su fake le borchie sono cave e leggere
- Pelle: qualità vitello morbida e uniforme

LANVIN CURB:
- Suola ondulata: flessibile e di qualità, ondulazioni regolari
- Logo LANVIN: font preciso sul tallone

Rispondi SOLO in JSON valido (senza markdown):
{
  "score": numero 0-100 (100=autentico certo, 50=non verificabile da foto, 0=fake evidente),
  "verdict": "LIKELY_AUTHENTIC" | "SUSPICIOUS" | "NEEDS_VERIFICATION",
  "redFlags": ["problemi SPECIFICI e DETTAGLIATI rilevati — es: 'Logo LV sul hardware piatto invece che in rilievo', 'Font BALENCIAGA con spaziatura irregolare'"],
  "greenFlags": ["segnali SPECIFICI e DETTAGLIATI di autenticità — es: 'Pattern monogramma LV simmetrico e uniforme', 'Numero dorato Common Projects in formato corretto'"]
}
Foto di bassa qualità o dettagli non visibili → score 50, verdict "NEEDS_VERIFICATION". Sii SPECIFICO nei flag, non generico.`,

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
