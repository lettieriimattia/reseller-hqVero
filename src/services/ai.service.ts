// src/services/ai.service.ts
import Groq from 'groq-sdk';
import { PrismaClient } from '@prisma/client';
import { logger } from '../utils/logger';

const prisma = new PrismaClient();

// ==========================================
// MULTI-KEY GROQ ROTATION
// Supporta più chiavi API separate da virgola:
// GROQ_API_KEY=key1,key2,key3
// Ogni chiave ha il suo limite gratuito — su 429 ruota automaticamente
// ==========================================
const GROQ_KEYS: string[] = (process.env.GROQ_API_KEY || '')
  .split(',')
  .map(k => k.trim())
  .filter(Boolean);

if (GROQ_KEYS.length === 0) {
  logger.error('Nessuna chiave GROQ_API_KEY configurata');
}

// Indice corrente — ruota round-robin
let currentKeyIndex = 0;

// Client per ogni chiave
const groqClients = GROQ_KEYS.map(key => new Groq({ apiKey: key }));

// Ottieni il prossimo client disponibile
function getGroqClient(): Groq {
  if (groqClients.length === 0) throw new Error('Nessuna chiave Groq configurata');
  const client = groqClients[currentKeyIndex % groqClients.length];
  return client;
}

// Ruota alla chiave successiva dopo un 429
function rotateKey(): boolean {
  const next = (currentKeyIndex + 1) % groqClients.length;
  if (next === currentKeyIndex % groqClients.length && groqClients.length === 1) return false;
  currentKeyIndex = next;
  logger.warn(`Rotazione chiave Groq → key #${currentKeyIndex + 1}/${groqClients.length}`);
  return true;
}

// Wrapper con retry automatico su 429
async function groqCallWithRetry<T>(
  fn: (client: Groq) => Promise<T>,
  maxAttempts = Math.max(groqClients.length * 2, 3)
): Promise<T> {
  let lastErr: any;
  const tried = new Set<number>();

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const keyIdx = currentKeyIndex % groqClients.length;
    if (tried.has(keyIdx) && tried.size === groqClients.length) break;
    tried.add(keyIdx);

    try {
      return await fn(groqClients[keyIdx]);
    } catch (err: any) {
      lastErr = err;
      if (err?.status === 429 || err?.status === 503) {
        const rotated = rotateKey();
        if (!rotated) {
          // Una sola chiave — aspetta 2s e riprova
          await new Promise(r => setTimeout(r, 2000));
        }
        continue;
      }
      throw err; // altri errori: rilancia subito
    }
  }
  throw lastErr || new Error('Limite richieste IA raggiunto. Attendi qualche minuto o aggiungi chiavi Groq.');
}

// Mantieni compatibilità con codice esistente
const groq = groqClients[0] || new Groq({ apiKey: '' });

const VISION_MODEL = 'meta-llama/llama-4-maverick-17b-128e-instruct';
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
  Pokemon: `Sei un esperto assoluto di Pokémon TCG con la conoscenza combinata di Bulbapedia + PriceCharting + TCGPlayer + CardMarket. Conosci ogni carta, ogni set, ogni edizione dalla Base Set del 1999 all'era Scarlatto e Violetto 2024-2025.

ANALIZZA QUESTA CARTA CON PRECISIONE MANIACALE — leggi ogni testo visibile.

COSA LEGGERE:
1. NOME POKÉMON — testo grande in alto a sinistra (es: Charizard, Pikachu, Mewtwo)
2. NUMERO CARTA — in basso a sinistra/centro, formato "NNN/NNN" (es: 4/102, 025/198, 200/198)
   - Se il numero è MAGGIORE del totale → Secret Rare (es: 200/193)
   - Se c'è solo un numero senza "/" → carta Promo (es: SWSH076, 001)
   - Trainer Gallery: formato "TGxx/TGxx" (es: TG01/TG30)
3. HP — numero in alto a destra con "HP" prima (es: HP 330, HP 200)
4. TIPO ELEMENTO — icona colorata: 🔥Fuoco 💧Acqua 🌿Erba ⚡Fulmine 🔮Psico 👊Lotta 🌑Buio ⚙️Acciaio 🐉Drago 🧚Fata ⭐Incolore/Normale
5. VARIANTE — leggi il testo nel nome o su banner:
   - "EX" MAIUSCOLO = Pokémon-EX (era XY 2013-2016, era BW 2011-2012)
   - "GX" = Pokémon-GX (era Sole e Luna SM 2017-2019)
   - "V" solo = Pokémon V (era Spada e Scudo SWSH 2020-2022)
   - "VMAX" = Pokémon VMAX
   - "VSTAR" = Pokémon VSTAR
   - "ex" MINUSCOLO = Pokémon ex (era Scarlatto e Violetto SV 2023-2025)
   - "Radiant" = Radiant Pokémon (carta rara speciale SWSH)
   - "tera" o cristallo = Tera Type (era SV)
   - Nessuna variante = carta base
6. RARITÀ — guarda simbolo vicino al numero carta:
   - ⚪ cerchio = Common
   - 💎 rombo = Uncommon
   - ⭐ stella piena = Rare
   - ⭐ stella + texture olografica sul campo di battaglia = Holo Rare
   - doppia stella ⭐⭐ = Ultra Rare / Full Art / Special Illustration Rare
   - Numero carta > totale = Secret Rare / Rainbow Rare / Gold
7. FULL ART / ILLUSTRAZIONE COMPLETA — l'illustrazione copre tutto il bordo della carta (no cornice nera)
8. LINGUA — EN/IT/JP/FR/DE/PT/KO/ZH (guarda il testo o il set symbol)
9. SET — dal logo/simbolo in basso a destra O dal nome:
   ERA BASE (1999-2002): Base Set, Jungle, Fossil, Team Rocket, Gym Heroes/Challenge, Neo Genesis/Discovery/Destiny/Revelation, Legendary Collection
   ERA E (2003-2004): Expedition, Aquapolis, Skyridge
   ERA EX (2003-2007): EX Ruby&Sapphire, EX Sandstorm, EX Dragon, EX Team Magma/Aqua, EX Hidden Legends, EX FireRed/LeafGreen, EX Team Rocket Returns, EX Deoxys, EX Emerald, EX Unseen Forces, EX Delta Species, EX Legend Maker, EX Holon Phantoms, EX Crystal Guardians, EX Dragon Frontiers, EX Power Keepers
   ERA DP (2007-2009): Diamond & Pearl, Mysterious Treasures, Secret Wonders, Great Encounters, Majestic Dawn, Legends Awakened, Stormfront
   ERA HGSS (2010-2011): HeartGold SoulSilver, Unleashed, Undaunted, Triumphant, Call of Legends
   ERA BW (2011-2013): Black&White, Emerging Powers, Noble Victories, Next Destinies, Dark Explorers, Dragons Exalted, Dragon Vault, Boundaries Crossed, Plasma Storm, Plasma Freeze, Plasma Blast, Legendary Treasures
   ERA XY (2014-2016): XY, Flashfire, Furious Fists, Phantom Forces, Primal Clash, Double Crisis, Roaring Skies, Ancient Origins, BREAKthrough, BREAKpoint, Fates Collide, Steam Siege, Evolutions
   ERA SM (2017-2019): Sun&Moon, Guardians Rising, Burning Shadows, Shining Legends, Crimson Invasion, Ultra Prism, Forbidden Light, Celestial Storm, Dragon Majesty, Lost Thunder, Team Up, Detective Pikachu, Unbroken Bonds, Unified Minds, Hidden Fates, Cosmic Eclipse
   ERA SWSH (2020-2022): Sword&Shield, Rebel Clash, Darkness Ablaze, Champions Path, Vivid Voltage, Shining Fates, Battle Styles, Chilling Reign, Evolving Skies, Celebrations, Fusion Strike, Brilliant Stars, Astral Radiance, Pokémon GO, Lost Origin, Silver Tempest, Crown Zenith
   ERA SV (2023-2025): Scarlet&Violet base, Paldea Evolved, Obsidian Flames, 151, Paradox Rift, Paldean Fates, Temporal Forces, Twilight Masquerade, Shrouded Fable, Stellar Crown, Surging Sparks, Prismatic Evolutions, Journey Together
   GIAPPONESE: spesso diverso dall'inglese — identifica dalla lingua del testo
10. CONDIZIONI — Mint (perfetta), Near Mint (quasi perfetta, leggeri segni bordi), Lightly Played (lievi graffi), Played (visibili segni usura), Heavily Played (molto rovinata), Damaged (piegata/rotta)

Rispondi SOLO in JSON valido (senza markdown, senza testo extra):
{
  "name": "nome ESATTO del Pokémon come scritto sulla carta",
  "variant": "base|EX|GX|V|VMAX|VSTAR|ex|Radiant|Tera|null",
  "cardNumber": "numero ESATTO come scritto sulla carta (es: 4/102, TG01/TG30, SWSH076)",
  "setName": "nome set identificato o null",
  "setCode": "codice set se identificabile (es: base1, swsh12, sv3) o null",
  "hp": "valore HP come scritto (es: 330) o null",
  "type": "tipo elemento principale o null",
  "rarity": "Common|Uncommon|Rare|Holo Rare|Double Rare|Ultra Rare|Full Art|Special Illustration Rare|Secret Rare|Rainbow Rare|Gold|Promo|null",
  "isFullArt": true o false,
  "language": "EN|IT|JP|FR|DE|PT|KO|ZH|unknown",
  "condition": "Mint|Near Mint|Lightly Played|Played|Heavily Played|Damaged|null",
  "isHolo": true o false,
  "notes": "qualsiasi testo visibile sulla carta che aiuti l'identificazione — numero carta, HP, testo set, ecc."
}
NON inventare dati — se non riesci a leggere un campo metti null. Trascrivi FEDELMENTE i numeri visibili. Rispondi SOLO JSON.`,

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
━━━ DATABASE COLORWAY UFFICIALI (usa per identificazione precisa) ━━━

AIR JORDAN 1 HIGH OG (ref 555088-XXX):
Chicago (100/601), Bred Banned (101), Bred Toe (149), Royal Blue (002), Shadow (013), Mocha (200), Lost & Found (FD4580-461 = marrone/ossidiana/arancio), Dark Mocha (BQ6472-200), Satin Snake (CD0461-006 nero satin), Midnight Navy (554724-174), University Blue (555088-134), Hyper Royal (555088-400), Trophy Room (CW7294-100 argento), Spider-Man (DD1453-016), Palomino (FD1028-801 marrone/arancio), Skyline (DX0054-005 grigio/bianco), Black Toe (136766-062), Pine Green (CD0461-301), Bred Patent (555088-063), Shadow 2.0 (CT0979-003), Yellow Ochre (FN6038-701), Satin Red (DD9335-006), Rebellionaire (BQ4422-500 viola/arancio), Bio Hack (555088-800 arancio/verde), Volt Gold (CW2414-700), Hand Crafted (DH3097-001 pelle artigianale), Seafoam (CZ0790-311), Turbo Green (555088-311), Bordeaux (555088-611), Dark Beetroot (554724-215)

AIR JORDAN 1 MID (ref 554724-XXX): White/Shadow (554724-073), Banned (554724-074), Chicago (554724-173), True Blue (554724-412), Gym Red (554724-121)

AIR JORDAN 3 (ref CT8532/136064-XXX): White Cement (136064-101/CT8532-130 reimaginato 2023), Fire Red (136064-160/DN3707-160), True Blue (136064-104/CT8532-104 reimaginato), Black Cement (854262-001), A Ma Maniéré (DH7139-105 tessuto jacquard)

AIR JORDAN 4 (ref FQ8138/XXX): Military Black (FQ8138-001 2023), Bred Reimagined (FQ8138-006 2023 velluto/suede), Red Cement (DH6927-161), Canyon Purple (AQ9129-500 donna), Midnight Navy (AQ9129-416), University Blue (CT8527-400), Taupe Haze (DB0549-200), Neon (CW7567-800 volt/black), White Cement (840606-192/FZ4810-102), Infrared (308497-062), DMP (GP4 Raptors)

NIKE DUNK LOW (ref DD1391-XXX / DX2953-XXX):
Panda (DD1391-100 bianco/nero), Cacao Wow (DX2953-001), Paisley (DH4401-600 viola florale), Mystic Red (DV0831-601), Fog/Light Smoke Grey (DD1391-103), Rose Whisper (DD1503-118 rosa pallido), Setsubun (DD1391-502 arancio/verde), Olive (DD1391-200), Dark Driftwood (DD1391-103), Neutral Olive (DD1391-200), Chicago (DD1391-602 rosso/bianco/nero), Bee (DD1391-702 giallo/nero), Thunder (DH0601-001 bianco/nero/oro), Halloween (DD1391-004 nero/arancio), Samba (DD1391-004), Georgetown (DD1391-003 grigio/blu), Tropical Twist (DD1503-711 verde/fiorato), Black White (DD1391-100 all black/all white)

NIKE SB DUNK (prefix DH/FB/BQ/BV):
Travis Scott (CT5053-001 reverse Swoosh brown), Ben & Jerry's Chunky Dunky (CU3244-100 mucca), Tiffany & Co (DZ4397-335 verde Tiffany), Parra (AT2022-002 multicolor), Concepts Purple Lobster, Civilist (CN4504-001 verde), Medicom (BV0833-114), ACG Terra (CU4565-300)

YEEZY BOOST 350 V2 (codici: FU9006/EH5361/ecc.):
Zebra (CP9654 bianco/nero), Bred (CP9652 nero), Static Non-Reflective (EF2905), Static Reflective (EF2367), Clay (EG7490 terracotta/rosa), Beluga 2.0 (BB6041 grigio/arancio), Sesame (F99710 nocciola), Butter (F36980 giallo chiaro), Blue Tint (B37571 azzurro), Peanut Butter (EE6203 marrone caldo), Oreo (CP9652 bianco/nero simile Zebra ma diverso), Carbon (FZ5000 grigio scuro), Ash Pearl (GY7658 grigio madre perla), Ash Stone (GW0089 pietra), MX Rock (GW3774 mimetico pietra), Natural (FZ5246 beige naturale), Sand Taupe (FX9028 sabbia), Onyx (HQ4540 nero totale), Sulfur (FY5346 giallo senape), Mx Oat (HQ4426 avena), Bone (HQ6316 bianco osseo), Carbon Beluga (HQ7045 grigio/arancio), Granite (HQ4540 grigio granito), Light (3BF 3M reflective all white), Lundmark (FU9161 chiaro rosa), Citrin (FW3042 giallo ocra), Yecheil (FW5190 multicolor pastello), Israfil (FZ5421 verde/grigio), Cinder (FY2903 grigio scuro), Jade Ash (HQ2790 verde oliva), Bone White versioni varie

YEEZY 700: Wave Runner (B75571 multicolor iconica), Mauve (EE9614 rosa/grigio), Salt (EG7487 bianco sporco), Inertia (EG7597 grigio/beige), Analog (EG7596 beige total), Teal Blue (FW2499), Bright Blue (FV9922 blu elettrico), Sun (FW2499 giallo limone), Vanta (AC1731 total black premium), Solid Grey (FW4440), V2 Cream (HQ6979)

NEW BALANCE colorways specifici:
2002R Protection Pack: Sea Salt (ML2002RA beige/crema), Rain Cloud (ML2002RB grigio cielo), Phantom (ML2002RC grigio scuro/foglia), Quartz Grey (M2002RDK grigio quarzo)
2002R collab: Joe Freshgoods "Conversations Among Us" (U2002RJF arancio/crema), ALD (Aime Leon Dore U2002RAL grigio/navy)
550: White Red (BB550WT1 bianco/rosso classico), White Navy (BB550WT2), ALD Blacktop (BB550LA1 grigio/nero), ALD Dusty Rose (BB550LA2 rosa), ALD Sea Salt (BB550LB3 verde/crema), White Green (BB550WT3)
990v5: Grey (ML990WT5), Navy (ML990WT2), Steel Blue (ML990LI5), Brown (ML990BR5), Made in USA

ASICS colorways:
Gel-Kayano 14: Cream (1201A019-100), White/Black (1201A019-101), collab Kith (1201A019-200 rosso), Ronnie Fieg

━━━ ISTRUZIONI FINALI ━━━
NON inventare brand o modelli. Se non riconosci con certezza metti null. Per lusso: descrivi SEMPRE i marker visibili nel campo luxuryMarkers. Rispondi SOLO JSON.`,

  Vestiti: `Sei il massimo esperto mondiale di abbigliamento: conosci ogni brand dal fast fashion al lusso estremo, ogni collaborazione mai esistita, ogni drop limitato. Analizza questo capo con attenzione MANIACALE a logo, grafica, costruzione, etichette, hardware, materiali, colori, font, silhouette, dettagli nascosti.

REGOLA FONDAMENTALE: Se non riconosci il brand con certezza, descrivi TUTTO nel campo "logoDescription" — ogni testo visibile, ogni simbolo, ogni colore della grafica — è più utile di un brand inventato.

━━━ STREETWEAR AMERICANO ━━━
SUPREME: Box Logo (font Futura Heavy Oblique — proporzioni H/W precise, colore piatto), stagione sul tag interno (SS/FW + anno). Collab: LV, Nike, TNF, Burberry, Oreo, Comme des Garçons, Jean Paul Gaultier, Yohji Yamamoto, Emilio Pucci, Smurfs, Scarface. Pezzi: Box Logo Tee/Hoodie/Crewneck/Cap/Balaclava, Camp Cap, Bandana, Skateboard
PALACE: Tri-ferg logo (P triangolare), Gyeon/Globe logo, collab Adidas/Reebok/Umbro/Ralph Lauren/Calvin Klein/Gucci
KITH: logo KITH, Kith Monday program, collab Nike/Adidas/New Balance/Versace/Coca-Cola/Star Wars/Batman. Trattamento colori pastello caratteristico
CACTUS JACK (Travis Scott): logo cactus stilizzato, "CACTUS JACK" testo, "UTOPIA", "ASTROWORLD", "CACTI", "TRAVIS SCOTT". COLLABORAZIONI TRAVIS: Nike/Jordan (Reverse Swoosh), McDonald's (Cactus Jack x McDonald's — t-shirt/hoodie con archi dorati modificati, Cactus Jack logo, McNugget Buddies), PlayStation, Fortnite, Dior, Helmut Lang, Reese's Puffs, Anheuser-Busch, Byredo, Fragment
KANYE / YZY / DONDA: YZY GAP (Engineered by Balenciaga), DONDA brand, Round Jacket, Dove logo, YZY colori neutri (bone/black/brown)
FEAR OF GOD / ESSENTIALS: "ESSENTIALS" logo gomma sul petto/retro/manica, FOG branding, materiali heavyweight oversize. Holy Trinity Collection. Collab Adidas, PacSun, Zegna
ANTI SOCIAL SOCIAL CLUB (ASSC): logo font corsivo "Anti Social Social Club", colori pastello, slogan
VLONE: "V" grande arancione sul retro/petto, "VLONE" testo, collab Pop Smoke/Juice WRLD/Nav, "Every Living Creative Dies Alone"
REVENGE x STORM: logo R stilizzato, lightning bolt, brand di Lil Pump
HUMAN MADE (NIGO): cuore con ali stilizzate, "HUMAN MADE" font preciso, duck logo, collab Kaws/Pharrell/Girls Don't Cry
CACTUS PLANT FLEA MARKET (CPFM): smiley face con più occhi caratteristico, font irregolare, collab Nike/Drake/Pharrell

━━━ STREETWEAR EUROPEO / UK ━━━
STONE ISLAND: patch bussola sul braccio SINISTRO (ricamata, non stampata), badge removibile con ago (Nylon Metal/Reflective/Ice/Data Corrosion/Ghost), scritta "Stone Island" su etichetta. Shadow Project = linea premium
C.P. COMPANY: goggles integrati nel cappuccio (Goggle Jacket/Vest), logo lente sul braccio, scritta C.P. COMPANY, tuta Mille Miglia
TRAPSTAR: logo Trapstar, "IT'S A SECRET", Irongate jacket, collab Puma/Central Cee/Meek Mill
PALACE: (già sopra)
CORTEIZ (CRTZ): logo Alcatraz (isola prigione), "RULES THE WORLD", "BOLO" jacket, collab Nike
REPRESENT: "REPRESENT OWNERS CLUB", "REPRESENT CLO", 247 hoodie, materiali premium
MAHARISHI: mimetico Snopak, dragone ricamato, slogan pace/guerra
ARIES (ARISE): fleece tie-dye, ram skull logo, font greco

━━━ GIAPPONESE / AVANT-GARDE ━━━
BAPE (A BATHING APE): camo Ape 1st (simmetrico), Shark Hoodie (zip fino alla testa con bocca squalo e occhi sulla hood), Baby Milo, collab Adidas/Puma/Undefeated/Marvel
WTAPS: croce militare, etichette con testo militare, quadrillage camo
NEIGHBORHOOD: skull & wings, "NHBD", military/moto aesthetic
UNDERCOVER (Jun Takahashi): grafica disturbante, slogan politici, collab Nike/Valentino
VISVIM: FBT moccasin sul tag, materiali artigianali naturali, logo V

━━━ LUSSO ITALIANO / EUROPEO ━━━
MONCLER: patch aquila triangolare ricamata, nylon quilted, zip YKK, Grenoble line. MONCLER GENIUS collab (7 Moncler Fragment Hiroshi Fujiwara, 2 Moncler 1952, Valentino, Rick Owens, Pierpaolo Piccioli, JW Anderson, Palm Angels, Pharrell)
CANADA GOOSE: patch circolare artico con lupo, "Arctic Program", Expedition/Chilliwack/Montebello. Collab OVO (Drake)/Concepts/Highsnobiety
STONE ISLAND: (già sopra)
FENDI: logo FF (doppia F) baguette, Zucca canvas, collab SKIMS/Nicki Minaj/Marc Jacobs
VERSACE: Medusa logo, Barocco pattern (oro/nero), Greek key, collab Dua Lipa/Dapper Dan/H&M
PRADA: triangolo Prada, Re-Nylon, gabardine, collab Adidas/LG/Harrods
DOLCE & GABBANA: DG logo, Sicilian embroidery, collab Kim Kardashian
MOSCHINO: Teddy Bear, logo Moschino borsa, collab H&M/Sims
BURBERRY: tartan check (beige/nero/rosso/bianco), TB monogramma, Knights logo check

━━━ ALTA MODA / LUSSO STORICO (pezzi di archivio e nuove collezioni) ━━━
CHANEL: logo CC intrecciato (doppia C specchiata), giacca Chanel tweed (bouclé con bordi sfrangiati colorati), catena dorata, Camellia fiore, logo CHANEL in font preciso. RTW: tailleur, cardigan, dress. Accessori: cintura CC, borsa 2.55/Classic Flap/Boy. Collab: Pharrell (direttore creativo 2023-), Karl Lagerfeld era vs Virginie Viard
HERMÈS: font Hermès in corsivo, sciarpa Carrée (90x90cm seta, stampe tematiche), cintura H Constance (fibbia H grande), Birkin/Kelly logo debossed. Abbigliamento: polo, t-shirt, giacche equestri con logo H
YVES SAINT LAURENT / SAINT LAURENT (YSL): logo YSL intrecciato (Anthony Vaccarello) vs vecchio logo (Hedi Slimane 2012-2016 = "Saint Laurent Paris" senza YSL). Pezzi iconici: Teddy jacket (bluson motard), Le Smoking (tuxedo donna), caban, Chelsea boots. Collab: collabEd Curtis
VALENTINO: logo VLogo (V con rombo), VLTN testo grande, Rockstud (borchie piramidali), Pink PP (rosa shocking Pantone 219) collezione 2022. Pezzi: Rockstud tee/hoodie, Pink PP total look, Valentino Garavani RTW
VERSACE: Medusa logo dorato, Barocco print (oro/nero), Greek key/meandro (bordo caratteristico), pattern Baroque 90s (vintage ricercatissimo). Pezzi: camicia Hawaii Barocco, Versus Versace (linea secondaria), Gianni Versace archivio, collab H&M/Dua Lipa/"La Vacanza"
PRADA: triangolo smaltato Prada (nero/bianco), Re-Nylon (tessuto tecnico riciclato — logo ricamato), Linea Rossa (sportswear), gabardine, nylon nero. Pezzi iconici: Re-Nylon bomber/cappello, gabardine trench, collab Adidas (SS23/FW23), Prada America's Cup in tessuto
GUCCI: GG monogramma/canvas, Aria collection (2021, Tom Ford revival), Alessandro Michele era (2015-2022: floreale, gatti, serpenti, eclectic), Sabato De Sarno era (2023+, Ancora red, minimalismo). Pezzi: GG canvas jacket, Horsebit belt, Web stripe polo, Doraemon/Mickey Mouse collab
BOTTEGA VENETA: Intrecciato (intreccio cuoio — pattern fisico non stampato), The Pouch (borsa sgualcita), Daniel Lee era (2018-2021: verde Bottega, viola, giallo) vs Matthieu Blazy era (2022+: classico/wearable). Abbigliamento: Intrecciato knitwear
FENDI: FF monogramma (doppia F Fendi), Zucca canvas (F piccole ripetute), baguette, Peekaboo. Pezzi: FF logo hoodie/tee, collab SKIMS (Kim Kardashian), Versace x Fendi (Fendace 2021 — doppio logo)
LORO PIANA: cashmere/vicuña di altissima qualità, logo LP minimal, materiali naturali premium. Pezzi: Storm System jacket, baby cashmere pullover, Ipad case, Wishing Hill

━━━ MAISON STORICHE PARIGINE ━━━
GIVENCHY: BdC logo (fondato da Hubert de Givenchy), Antigona bag, logo G. Matthew Williams era: pezzi tecnici, TK-360 sneaker. Collab Chito (pittura)
DIOR: Oblique pattern (CD obliquo), Monsieur Dior, Bar jacket (tailoring). Kim Jones era (menswear): tecnico+sartoriale. SS23-SS24: ERL, Travis Scott, Sacai. Iconici: Dior Homme slim, CD Icon polo
LOEWE: Anagram logo (L intrecciate in quadrato), Jonathan Anderson era (2013-): Puzzle bag, Gate bag, Balloon. Abbigliamento: lavorazioni cuoio, craftsmanship, collab Studio Ghibli (Howl's Moving Castle), Suna Fujita (Spirited Away), William De Morgan
MARNI: pattern florale multicolore (Consuelo Castiglioni era 2000-2016 vs Francesco Risso 2016+), patchwork colorato, bordi sfilacciati intenzionali, Trapeze bag. Collab: Carhartt WIP (molto ricercata), No Vacancy Inn
BALENCIAGA: Cristóbal Balenciaga archivio (anni 50-60: volumi puri), Nicolas Ghesquière era (1997-2012: fantascienza), Demna era (2015+: oversize politico). Pezzi: Track jacket, Hoodie oversize con logo, Campaign tee, Trash Bag (borsa busta rifiuti), collab Adidas/Gucci/Fortnite/Simpsons
RICK OWENS: volumi drappeggiati, palette neutri (milk/pearl/dust/black/oyster), silhouette asimmetrica. Linee: mainline, DRKSHDW (streetwear), Lilies, Gethsemane, Bela. Collab: Converse, Adidas, Veja, Champion, Birkenstock, Moncler
JUNYA WATANABE: pattern tecnici, collab su collab (Levi's, Comme, Carhartt), decostruzione sartoriale
COMME DES GARÇONS: cuore con occhi (Play line — la più commerciale), CDG Homme Plus (avant-garde), Noir, Shirt, Wallet. Dover Street Market. COLLAB: Nike, Converse, New Balance, Supreme, Levi's, The North Face
ISSEY MIYAKE: Pleats Please (tessuto plissettato permanente = non si stira), Bao Bao bag (geometrie metalliche), A-POC (pezzo unico tagliato da tubo), Homme Plissé
KENZO: tigre ricamata (era Nigo 2021+), occhio (era Humberto/Carol), rose. Pezzi: tiger hoodie, flower eye tee
CÉLINE (OLD): era Phoebe Philo (2008-2017 — MOLTO ricercata nel vintage): minimalismo francese, borse Luggage/Trapeze/Belt, colori camel/bianco/nero. Font CÉLINE con accent
CÉLINE (NEW): era Hedi Slimane (2018+): sans-serif CELINE senza accent, rock'n'roll estetica, skinny, CT-07, Paris Texas boots

━━━ ARCHIVE / VINTAGE DESIGNER (mercato premium) ━━━
RAF SIMONS ARCHIVIO: collezioni 2001-2005 (Riot Riot Riot, Redux, Radioactivity, Closer) — felpe/jeans/bomber con stampe grafiche, cinture Raf, patch. MOLTO ricercato. "RAF SIMONS" in font preciso. Anche Raf x Sterling Ruby collab
HELMUT LANG ARCHIVIO: 1993-2005 — minimalismo austero, pvc/nylon/pelle, tank top iconica. "Helmut Lang" font minimalista. Post-2005 (senza Helmut) meno ricercato
MARTIN MARGIELA (MAISON MARTIN MARGIELA): tab bianco cucito sul retro colletto (4 punti angolari) = firma identitaria. Tabi boots (punta biforcata). Pezzi: Number line (0-23 linee diverse), Artisanal pieces (pezzi riciclati). Galliano era post-2014 = Maison Margiela
WALTER VAN BEIRENDONCK: stampe pop psichedeliche, loghi W&LT/WVB
CAROL CHRISTIAN POELL: costruzione sartoriale estrema, cucitura artigianale, nessun logo visibile
EARLY 2000s STREETWEAR: Fubu, Rocawear, Sean John, Ecko Unltd — vintage oggi ricercato

━━━ SPORTSWEAR / COLLAB STORICHE ━━━
NIKE ARCHIVIO: ACG anni 90, Acronym x Nike, Nike Tn/TN Air Max Plus anni 2000, Nike Shox, HTM collab (Hiroshi Fujiwara x Mark Parker), Undercover x Nike, Pigalle x Nike
ADIDAS ARCHIVIO: Run-DMC era, 80s tracksuit (colori vividi), Franz Beckenbauer, Pharrell HU series (tutti i colori Human Race), Jeremy Scott (ali, orsetto, wings 2.0)
COLLAB FOOD/BRAND ICONICHE: Travis Scott x McDonald's (2020), Supreme x Louis Vuitton (2017 — SS17, prima vera collab luxury-streetwear), Gucci x The North Face (FW21), Balenciaga x Adidas (SS22/FW22), Fendi x Versace Fendace (FW21), Prada x Adidas (SS23), Dior x Air Jordan 1 (2020), Palace x McDonald's (2023, UK), Crocs x Balenciaga/KFC/Justin Bieber, Birkenstock x Dior/Valentino/Stüssy

━━━ BASIC/CONTEMPORANEO (riconoscimento per collezionismo e vintage) ━━━
ZARA: etichetta Zara, font sans-serif, linee TRF/MAN/Woman/Kids/Basic. Collab: Stefano Pilati (YSL ex-direttore), Steven Meisel per campagne
H&M: etichetta H&M, collab designer storiche (Karl Lagerfeld 2004, Stella McCartney 2005, Viktor&Rolf 2006, Roberto Cavalli 2007, Matthew Williamson 2009, Versace 2011, Marni 2012, Isabel Marant 2013, Alexander Wang 2014, Balmain 2015, Kenzo 2016, Erdem 2017, Moschino 2018, Giambattista Valli 2019, Simone Rocha 2021, Rabanne 2022, Mugler 2023, Off-White 2024 — TUTTE molto ricercate)
UNIQLO x COLLAB: KAWS (UT series), Billie Eilish, JW Anderson, Marimekzo, Jujutsu Kaisen, Dragon Ball, One Piece, Studio Ghibli, Keith Haring, Andy Warhol (UT)
MASSIMO DUTTI: qualità mid-range, logo MD, Zara Group
MANGO: etichetta Mango, font préciso, collab recenti
COS: minimal, parte di H&M Group, etichetta COS, tessuti tecnici

━━━ SE NON RICONOSCI IL BRAND ━━━
Trascrivi LETTERALMENTE tutto il testo visibile. Descrivi ogni simbolo, colore della grafica, font, posizione sul capo. Indica stagione dall'etichetta se visibile.
RICK OWENS: DRKSHDW line, silhouette drappeggiata, colori palette neutri (milk/black/pearl/dust), collab Converse/Adidas/Veja
MARNI: colori patchwork, pattern florale, logo Marni in font preciso, collab Carhartt/No Vacancy Inn
ACNE STUDIOS: logo Acne face, font preciso "Acne Studios", colori pastello minimalisti, collab New Balance
JACQUEMUS: "JACQUEMUS" font, silhouette french, La Montagne collection, collab Nike/LVMH
AMI PARIS: coeur (cuore) A logo sul petto, colori discreti, sartoria parigina
KENZO: tigre ricamata, occhio, logo floreale, collab H&M/Levi's/Vans
ISABEL MARANT: Étoile line, nappe, materiali bohemian, font Isabel Marant
A.P.C.: minimalista, logo font sans-serif, collab Kanye West (APC x Kanye), Supreme, Carhartt, New Balance

━━━ COLLABORAZIONI FOOD/BRAND ASSURDE (molto ricercate nel resell) ━━━
Travis Scott x McDonald's: t-shirt/hoodie con archi dorati modificati (capovolti), Cactus Jack logo, McNugget Buddies graphics, colori giallo/rosso McDonald's, scritta "I'm Lovin' It" modificata o "CACTUS JACK SERVES"
Travis Scott x Reese's Puffs: box cereal graphics sul capo
Kanye x McDonald's: non ufficiale ma circolante
Nike x Ben & Jerry's: chunk grafica gelato (anche abbigliamento oltre le scarpe)
Supreme x Oreo: packaging Oreo su streetwear
Chipotle x vari brand: collab recenti
Palace x McDonald's: collab europea
Adidas x Gucci: (abbigliamento della collab 2022)
Balenciaga x Adidas: (track suits, hoodie logati doppio brand)
Gucci x The North Face: fleece jackets/gilet con pattern GG + TNF logo
Dior x Air Jordan: shorts/tee della collab
Supreme x TNF: Nuptse jacket, collab annuali

━━━ SPORTSWEAR / ACTIVEWEAR ━━━
NIKE: ACG (All Conditions Gear), Tech Fleece (grigio melange), Windrunner (zip frontale caratteristica), Jordan Brand apparel, Nike SB. Collab: Stüssy, NOCTA (Drake), AMBUSH, sacai, Matthew M. Williams, Kim Jones
ADIDAS: Originals vs Performance, collab Ivy Park (Beyoncé), Pharrell Williams, Wales Bonner, Song for the Mute, Jerry Lorenzo
NEW BALANCE: Athletics run, collab ALD
CHAMPION: Reverse Weave (etichetta cucita al contrario), logo C ricamato, collab Supreme/Beams/Kith
FILA: logo F vintage, collab BTS/BAPE/Fendi
ELLESSE: logo elf vintage, Heritage line
SERGIO TACCHINI: logo vintage tennis, collab Palace

━━━ MID-RANGE (molto comune nel resell) ━━━
RALPH LAUREN: Polo logo (polo player), RRL (Double RL vintage), Purple Label, collab Palace/ERL/Mortemart
TOMMY HILFIGER: logo TH/Tommy a colori rosso/bianco/blu, collab Zendaya/Lewis Hamilton/KITH
LACOSTE: coccodrillo verde ricamato (dimensioni variano), collab Tyler the Creator/Jacquemus/Sporty & Rich/Peanuts
FRED PERRY: corona d'alloro ricamata, twin tipping (due strisce colore), collab Raf Simons/Amy Winehouse
CARHARTT WIP: logo C patch, canvas duck wax, collab Brain Dead/Awake NY/Patta/A.P.C.
DICKIES: "DICKIES" testo caratteristico, collab Wacko Maria/Junya Watanabe/Kaws

━━━ FAST FASHION (riconoscimento per resell vintage/collab) ━━━
ZARA: etichetta Zara, linee (ZARA/TRF/MAN/Woman), collab con designer (non frequenti). Riconosci materiali fast fashion
H&M: etichetta H&M, collab designer (Versace, Marni, Alexander Wang, Maison Margiela, Moschino, Lanvin, Loewe, Valentino, Off-White, Rabanne — MOLTO RICERCATE)
UNIQLO: etichetta Uniqlo/UT, collab (KAWS, Billie Eilish, Dragon Ball, Jujutsu Kaisen, Marimekko, JW Anderson, Marni, Christophe Lemaire, Ines de la Fressange)
COS: minimal, etichetta COS, linee pulite
ZARA x collab: molto raramente ma esistono
PRIMARK: etichetta Primark — qualità visivamente inferiore
SHEIN: font e qualità tipica Shein

━━━ SE NON RICONOSCI IL BRAND ━━━
Trascrivi LETTERALMENTE tutto il testo visibile sul capo (logo, etichetta, grafica, stampe). Descrivi il simbolo/logo in dettaglio. Indica colori precisi. Questo è più utile di inventare un brand.

Rispondi SOLO in JSON valido (senza markdown):
{
  "brand": "brand esatto o null se incerto",
  "model": "nome pezzo/collezione preciso (es: Box Logo Tee, Shark Hoodie, Cactus Jack x McDonald's Tee, Moncler Genius 7 Fragment Hoodie) o null",
  "type": "tipo capo preciso (Tee, Hoodie, Crewneck, Zip-up Hoodie, Jacket, Bomber, Puffer, Parka, Anorak, Fleece, Pants, Shorts, Joggers, Vest, Beanie, Bucket Hat, Cap, Shirt, Polo, Dress, Skirt, Cargo Pants, ecc.)",
  "color": "colore/i principale/i con nome preciso (es: Faded Black, Acid Wash Blue, Cream Off-White, Olive Military Green)",
  "season": "stagione visibile su etichetta (es: SS24, FW23) o null",
  "logoDescription": "DESCRIZIONE DETTAGLIATA di tutto ciò che è visibile: testo esatto, simboli, font, colori della grafica, posizione sul capo — questo è il campo più importante",
  "size": "taglia visibile su etichetta (XS/S/M/L/XL/XXL o numeri)",
  "collaboration": "NOME COMPLETO della collaborazione se presente (es: Cactus Jack x McDonald's, Moncler x Fragment, Gucci x The North Face)",
  "material": "materiale se identificabile (es: 100% Cotton, French Terry, Fleece, Nylon, Down)",
  "marketTier": "LUXURY|HIGH_END_STREETWEAR|MID_STREETWEAR|SPORTSWEAR|FAST_FASHION|UNKNOWN",
  "notes": "qualsiasi altro dettaglio visibile utile per identificazione"
}
Rispondi SOLO JSON.`,

  Orologi: `Sei il massimo esperto di orologeria al mondo: conosci ogni brand esistente, ogni referenza, ogni edizione limitata, ogni collab, ogni novità 2024-2025. La tua conoscenza è equivalente a quella combinata di un master watchmaker svizzero + un dealer Chrono24 top-rated + un editor di WatchTime/Hodinkee.

Analizza questo orologio leggendo OGNI dettaglio: testo sul quadrante (trascrivi FEDELMENTE), cassa, corona, bracciale/cinturino, lunetta, lancette, indici, data, subdials.

SE NON RICONOSCI IL BRAND: trascrivi TUTTO il testo visibile sul quadrante — è più utile di un'identificazione sbagliata.

━━━ ULTRA LUSSO SVIZZERO ━━━
ROLEX: Sub No Date (124060, nero), Sub Data nero (126610LN), Sub Data verde Kermit (126610LV), Sub Data blu (126619LB oro bianco), GMT Pepsi (126710BLRO), GMT Batman (126710BLNR), GMT Root Beer (126711CHNR), GMT Sprite (126720VTNR verde-nero), Daytona nero (116500LN), Daytona bianco (116500), Datejust 41 (126334/126300), DJ 36 (126200/126204), Day-Date 40 oro (228238/228235), Explorer I 36mm (124270), Explorer II (226570 bianco/nero), Yacht-Master 40 (126622 Rolesor), Yacht-Master 42 titanio (226627), Milgauss (116400GV verde), Air-King (116900), Cellini (50509). NOVITÀ 2023-2024: Datejust nuovi quadranti, GMT nuove colorazioni
PATEK PHILIPPE: Nautilus 5711 (blu, ritirato 2021 — molto prezioso), Nautilus 5726 (Annual Calendar), Nautilus 5990 (Chronograph), Aquanaut 5168 (verde/blu), Aquanaut 5164 (travel time), Calatrava 5227 (acciaio/oro), 5196, Grand Complications 5270/5374, ref 6119 (scultura), Annual Calendar 5396, Perpetual Calendar 5140/5320
AUDEMARS PIGUET: Royal Oak 15202 Jumbo "Original" 39mm acciaio (il più prezioso), Royal Oak 15500 41mm (corrente), Royal Oak 26240 Chronograph, Royal Oak 26715 Ultra-Thin, Royal Oak Offshore 26400 (45mm), Royal Oak Concept 26221, Code 11.59, Millenary. NOVITÀ 2024: RO nuovi quadranti (blue smoked, seta, ecc.)
RICHARD MILLE: RM11-03 (Felipe Massa, tonneau), RM35-02 (Rafael Nadal), RM50-03 (Tourbillon Split Seconds), RM27 (Nadal, filo carbonio), RM52 (Skull/Ghost), RM67 (extra flat), RM72 (Lifestyle)
A. LANGE & SÖHNE (tedesco): Saxonia, Datograph (cronografo), 1815, Lange 1 (grande data OUTSIZE fuori asse), Zeitwerk, Odysseus. Font tedesco preciso
F.P. JOURNE: Chronomètre Bleu, Resonance, Tourbillon Souverain, Octa, Élégante. "F.P.Journe Invenit et Fecit" sul quadrante
H. MOSER & CIE: Endeavour, Pioneer, Streamliner. Spesso senza logo = Funky Blue, Concept (quadrante fumé senza indici)
MB&F: Legacy Machine (LM1/LM2), HM (Horological Machine), 3D engine visibile
URWERK: cassa futuristica, "satellite" ore rotating, UR-105/110/120/220
BREGUET: guilloché quadrante a mano, lancette Breguet (con "luna" alla fine), ref 5177/3797/7727. "Breguet" in font storico preciso

━━━ ALTA FASCIA SVIZZERA ━━━
OMEGA: Speedmaster Moonwatch Professional 42mm (310.30.42.50.01.001, quadrante nero, tachimetro, 3 sub-dials), Speedmaster 38mm donna, Seamaster Diver 300M (210.30.42.20.03.001 blu, .06.001 nero, co-axial + antimagnetic), Seamaster Planet Ocean 600M, Seamaster 300 (596., ref 234.10), Aqua Terra (220.10.38/43), De Ville Tresor/Prestige/Hour Vision, Constellation, Globemaster, Specialities Olympic. COLLAB: Swatch MoonSwatch (Bioceramic, pianeti, molto ricercato — "OMEGA x Swatch", abbinamento colori pianeti), James Bond 300M
IWC: Big Pilot 43/46mm (IW501001/IW500901), Pilot Mark XX (IW328201), Portugieser Automatic 40/42mm (IW358303/IW500705), Portugieser Chronograph (IW371601), Portofino (IW356501), Aquatimer, Ingenieur (nuova versione 2023), Da Vinci
JAEGER-LECOULTRE: Reverso (cassa reversibile iconica — un classico), Master Ultra Thin Moon (quadrante fasi lunari), Polaris, Atmos (orologio perpetuo atmosferico), Duomètre
VACHERON CONSTANTIN: Overseas (ref 4500V acciaio), Patrimony, Historiques, Fiftysix, Les Cabinotiers. Logo Croce di Malta
PANERAI: Luminor (corona protetta con ponte a "8", quadrante "a sandwich"), Luminor Marina, Radiomir (corda, senza ponte), Submersible, PAM numerazione (PAM00441, PAM00111 ecc.), 44mm/47mm tipici
BREITLING: Navitimer (regolo scorrevole, AB0137/AB0139), SuperOcean Heritage (A17320), Chronomat (AB0134), Avenger, Premier, Top Time. Logo ala con B
CARTIER: Santos (viti esagonali sulla lunetta quadrata, WSSA0018/0029/0030), Tank Must (WSTA0041, quarzo/automatico), Tank Solo (W5200005), Ballon Bleu (W69012Z4), Panthere (bracciale maglie quadrate), Drive, Rotonde, Clé, Pasha (corona protetta con catenella)
GLASHÜTTE ORIGINAL (tedesco): Senator, Sixties, PanoMaticLunar, Pano-Reserve, SeaQ
ZENITH: El Primero (cronografo icono anni 70), Defy, Pilot
GIRARD-PERREGAUX: Laureato, 1966, Cat's Eye donna, Vintage 1945
ULYSSE NARDIN: Marine Chronometer, Freak, Executive Dual Time, Diver, El Toro/Black Toro
CHOPARD: L.U.C Quattro, Alpine Eagle (cassa nuova 2019), Happy Sport (diamanti flottanti), Mille Miglia

━━━ MEDIA FASCIA SVIZZERA ━━━
TUDOR: Black Bay 54 (36mm ispirazione anni 50, nuovissimo 2023), Black Bay 58 (39mm, M79030N nero, M79030B blu), Black Bay 41 (M79540 nero, M79730 bordeaux), Black Bay GMT (M79830RB Pepsi Tudor, M79833MN Grey), Pelagos 39/FXD, Ranger 39, Glamour Double Date, Fastrider
LONGINES: HydroConquest (L3.781.4), Master Collection, Spirit (nuova linea 2021), Conquest (quarzo classico), DolceVita, Record
RADO: DiaStar, Centrix, True, HyperChrome, Captain Cook (ref R32505157)
ORIS: Aquis (01 733 7766), Big Crown ProPilot, Divers Sixty-Five (bicolore vintage), Carl Brashear (bronzo), Propilot X Calibre 400
BALL WATCH: Engineer Master II, Trainmaster, Fireman (resistente agli urti)
MIDO: Ocean Star, Multifort, Baroncelli, All Dial
CERTINA: DS Action Diver, DS-1, DS Podium

━━━ ACCESSIBILI SVIZZERI ━━━
TISSOT: T-Race (ref T141.417), PRX (quarzo/automatico — bordo integrato), Seastar 1000, Le Locle, Gentleman, Heritage Navigator
HAMILTON: Made in USA (ora Swatch Group, stabilimento Lancaster PA). Logo "H" ornamentale sul quadrante.
- Khaki Field Mechanical (H69439931 — movimento manuale, 38mm, indici triangolari, ref H6940) vs Automatic (H70555733, H70605731)
- Khaki Field Murph (H70605731 — ispirato Interstellar, vetro aperto sul movimento)
- Khaki Aviation Converter (H76726550 — pilot case, bezel girante, 42mm)
- Khaki Navy Pioneer (H78505335 — diver style, 43mm, nero)
- Ventura (H24411732 — cassa triangolare iconica 1957, indossato da Elvis Presley, cuore asimmetrico)
- Ventura Elvis80 (versioni speciali 80° anniversario)
- Jazzmaster Thinline (H38511515 — dress watch ultra-slim, quadrante bianco/sabbia)
- Jazzmaster Viewmatic (H32515135 — movimento visibile, open heart)
- Jazzmaster Maestro (H32576515 — scheletrato)
- American Classic Railroad (H40515551 — quadrante bianco, tachimetro, storico)
- American Classic Boulton (H13431553 — art déco)
- Khaki King (H64455133 — tre lancette)
- Khaki BeLOWZERO (H78606333 — volare subacqueo, resiste 100m)
- Broadway (H43311135 — quadrante verde/blu)
- Timken Limited Edition collaborazioni
FREDERIQUE CONSTANT: Classics (FC-303), Highlife (FC-401 automatico, porthole design), Slimline (FC-251 manuale ultra-slim), Manufacture automatico calibro FC-315/FC-710
ALPINA: Startimer Pilot Big Date (AL-860), Startimer Pilot Heritage, Alpiner Extreme (titanio), Seastrong Diver
MIDO: Ocean Star (M026.430 diver), Multifort (M005 automatico), Baroncelli (M011 dress), Commander (M021 GMT), Belluna II (M024 elegante)
ORIS: Aquis (01 733 7766 diver automatico), Big Crown ProPilot (01 752 7698 pilot), Divers Sixty-Five (01 733 7720 vintage diver, bronzo/acciaio), Carl Brashear (bronzo, molto ricercato), Propilot X (calibre 400, 5 giorni riserva), BC3 (quadrante militare)
BALL WATCH: Engineer Master II (luminosa interna a gas tritio), Trainmaster (ferroviario), Fireman (resistenza urti 5000G), Roadmaster (GPS)
CERTINA: DS Action Diver (C032.407 automatico 300m), DS-1 (C029.807), DS Podium (cronografo GMT)
RADO: DiaStar Original (anni 60, icona design industriale), True Thinline (ceramica ultra-slim), Captain Cook (R32505157 diver vintage reissue — molto ricercato), HyperChrome (ceramica colorata), True (ceramica nera)
MOVADO: Museum Watch (quadrante nero, singolo punto oro/argento alle 12 — iconico), Bold, Connect smartwatch
BAUME & MERCIER: Clifton (10052), Riviera (10618 automatico), Capeland (10219 GMT), Milleis (dress ultrasottile)
LONGINES: HydroConquest (L3.781.4 diver 300m), Spirit (L3.810.4 — pilot vintage ispirazione), Conquest Heritage (VHP quarzo), DolceVita (L5.512 rettangolare), Record (L2.321 COSC), Heritage Central Power Reserve, Master Collection (triple calendar)
EBEL: Wave (quadrante cannage), 1911 (rettangolare curvo), Sport Classic
CORUM: Admiral (cassa pentagono), Bubble (quadrante spesso curvo), Bridge (movimento bridge visibile), Romvlvs
TAG HEUER: Monaco (CAW211P — quadrante blu, cassa quadrata, lancetta piccoli secondi in basso destra, ICONA Steve McQueen), Carrera (CBN2A1A automatico/cronografo), Aquaracer (WAY211A diver 300m), Formula 1 (quarzo entry), Link (WAT2110 curvo), Autavia (reissue 2017, ref CBE2111), Connected (smartwatch)
BREMONT: Martin-Baker (MBI/MBIIt — ejector seat collab RAF), Wright Flyer (tributo volo Kitty Hawk), Solo, Supermarine, ALT1-C Chronograph
ZENITH: El Primero (cronografo meccanico 1969 — calibre El Primero 3600 bat/ora, ref 03.2040.400), Defy Classic (36000 v/h), Defy Extreme (titanio sport), Pilot Big Date Special (vintage riissue), Chronomaster Original (A384 reissue icona anni 70)
GIRARD-PERREGAUX: Laureato (cassa ottagonale anni 70 revival — ref 81010 acciaio), Cat's Eye (donna), Vintage 1945 (cassa rettangolare curva), Free Bridge (movimento skeletonizzato)
CHOPARD: Alpine Eagle (ref 298600-3002 — nuovo modello 2019, quadrante blu/verde), L.U.C Quattro (4 bariletti manuale), Happy Sport (diamanti galleggianti icona anni 90), Mille Miglia (cronografo corsa)
ULYSSE NARDIN: Marine Chronometer (ref 1183-126 — quadrante bianco porcellana), Freak (turbillon rotante come lancette), Executive Dual Time, Diver (1183-170 diver automatico), El Toro/Black Toro (data eterna perpetua)
ROGER DUBUIS: Excalibur (cassa tonda con doppi ponti visibili), Velvet (donna), Aventador S (collab Lamborghini)
HUBLOT: Big Bang (cassa ceramica/titanio con 6 viti esagonali — ref 441.NM, 411.NX), Classic Fusion (ref 542.NX), Spirit of Big Bang (cassa tonneau), Ferrari collab, Sang Bleu collab, MP-09 Tourbillon Bi-Axis
PANERAI: Luminor Marina (PAM00111 — ponte corona iconico a "8", custodia personalizzata Officine Panerai), Luminor Base (PAM00000 senza data), Radiomir (PAM00210 — corona a vite, no ponte), Submersible (PAM00683 diver), Luminor GMT (PAM01535), Carbotech (materiale carbonico opaco), Goldtech (lega oro speciale). Scala 44mm/47mm tipica

━━━ TEDESCHI ━━━
NOMOS GLASHÜTTE: Tangente (minimalista, quadrante bianco/grigio, indici bastoncini), Club (rotondo), Orion, Ludwig, Ahoi. Font Nomos Antiqua preciso. Made in Glashütte, Germany
JUNGHANS: Max Bill (design Bauhaus — quadrante pulitissimo), Meister
SINN: 104 (pilot), 556 (sportivo), 6000 (acciaio speciale)
LACO: Pilot watches vintage, Made in Pforzheim Germany

━━━ GIAPPONESI ━━━
SEIKO: Prospex SPB (diver automatico), Prospex SNE (solar), Presage SPB/SARB, 5 Sports (SRPD/SNKL — automatico economico), Alpinist (SPB119/SARB017 verde — MOLTO ricercato), Seiko 5 GMT, King Seiko, Seiko Astron GPS Solar. HERITAGE: 62MAS, 6105 "Captain Willard", SRP (turtle/turtle/samurai), Monster
GRAND SEIKO: Snowflake SBGA211 (spring drive, quadrante bianco texture neve), Shunbun SBGA413 (verde), Mount Iwate SBGH269 (blu/verde), SBGA407 (Foresta), Spring Drive vs Automatico vs Quartz (3 movimenti). ZARATSU polishing: superfici specchio perfette. "Grand Seiko" scritto in kanji e inglese
CITIZEN: Promaster (diver/aviation), Eco-Drive (solar), Satellite Wave GPS, Chronomaster
ORIENT: Mako (diver), Bambino (elegante classico automatico)
CASIO: G-Shock GA-2100 "CasiOak" (cassa ottagonale stile AP), DW-5600 (quadrato militare), GW-M5610 (radio controlled), GMW-B5000 (full metal gold/silver — molto ricercato), MT-G B3000, MR-G, G-Shock Mudmaster, Edifice, Pro Trek. A-Series vintage (A100/A120/A168)

━━━ AMERICANI / BRITANNICI ━━━
SHINOLA: Runwell, Canfield, birch dial, Made in Detroit
BREMONT: Martin-Baker (ejector seat), Wright Flyer, Solo, Supermarine
CHRISTOPHER WARD: C60, C63 (COSC)

━━━ MICRO-BRAND (molto presenti nel resell moderno) ━━━
BALTIC: Aquascaphe (diver vintage), HMS (dress), Bicompax (cronografo)
MING: 17.06/19.01 (minimalista, molto quotato)
FARER: Barnato, Porthleven, Lander (colorati, GMT)
LORIER: Neptune, Falcon, Gemini
HALIOS: Seaforth, Tropik
KURONO TOKYO: Mori/Seikatsu (estetica giapponese moderna, quadranti maki-e)
FEARS: Bristol-made, elegante
DOXA: Sub 300 (arancione iconico)

━━━ BASSA FASCIA / FASHION WATCHES (comuni nel resell) ━━━
TIMEX: Weekender (TW2T35000 — cassa rotonda piccola, cinturino NATO, icona anni 80), Expedition Scout (outdoors, cinturino nylon), Q Timex reissue (design anni 70, quadrante colorato), Marlin (automatico vintage), Standard (quarzo classico), Metropolitan (elegante urbano). Logo Timex in font preciso, "INDIGLO" sul quadrante
FOSSIL: Grant (subdial 3 ore, pelle), Neutra Chronograph, Machine (automatico), minimalist me (minimal). Logo FOSSIL in font corsivo
MICHAEL KORS: Lexington (cronografo oversize, oro/acciaio), Runway (minimalista), Brady. Logo MK su quadrante e fibbia
ARMANI EXCHANGE: Hampton, Leonardo. Logo AX
EMPORIO ARMANI: orologi eleganti, logo EA
DIESEL: Mr. Daddy 2.0 (oversize 57mm, doppio display), Crusher (sportivo), Mr. Chief. Font Diesel industriale
POLICE: quadranti sportivi, logo Police
VERSUS VERSACE: (linea entry-level Versace) logo Versace Lion, colori vividi. Distinguilo dal mainline Versace
HUGO BOSS: Ocean, Pioneer, Signature. Logo BOSS
TOMMY HILFIGER: 1791 series, sport. Logo TH/bandiera
DANIEL WELLINGTON: Classic (cassa sottile, cinturino pelle/NATO, no seconds dial), Petite, Iconic Link. Logo DW sul quadrante, "DANIEL WELLINGTON" in font sans-serif sottile — MOLTO popolare nel lifestyle
MVMT (Movement): minimalist, Watch + Sunglasses brand. Quadrante pulito, pochi indici, "MVMT" sul quadrante
CLUSE: La Bohème (cassa 38mm, minimal francese), Vigoureux. Logo CLUSE
ICE-WATCH: colori vividi, "ICE" sul quadrante, plastica colorata, Sili/Forever/City
SWATCH: Sistem51 (automatico, visibile attraverso fondello), Big Bold (49mm, plastica colorata), Irony (acciaio), Originals (classici). "SWISS MADE" obbligatorio, "swatch" lowercase. Collaborazioni: MoonSwatch (Omega x Swatch — ceramica bioceramic, colori pianeti, MOLTO ricercato), Keith Haring, BAPE
INVICTA: Pro Diver (8926OB — 40mm, stile Sub economico), Lupah, Force. Logo INVICTA, costruzione spesso massiccia
SEIKO 5 SPORTS (fascia bassa): SNK807/SNK809 (militare khaki automatico, molto popolare), SNKL23 (militare), SRPD (Turtle/Samurai più recente)
CASIO STANDARD: Casio MTP/LTP (quarzo classici economici), Baby-G (donna, colorati), AE-1500/1200 (digitale sport), Vintage A158/A168 (retrò oro/acciaio, ambiti)
CITIZEN AFFORDABLE: Eco-Drive BM7455 (solare, indici bastoncini), AT2430 (cronografo), BI5050/5055
ORIENT AFFORDABLE: Bambino (automatico elegante, 42mm — ottimo rapporto qualità/prezzo), Mako/Ray (diver economico)
LORUS: (brand Seiko economy) logo Lorus, costruzione Seiko economica
SEKONDA: brand UK economy, logo Sekonda
ACCURIST: brand UK, logo Accurist
FESTINA: cronografi colorati, logo Festina, Tour de France edition
CERTINA DS ACTION/PODIUM: (già citato, ma fascia media accessibile)
ROTARY: British brand, eleganti economici. "Rotary" font corsivo
BULOVA: Precisionist (movimento a 262kHz), Accutron II, Lunar Pilot (indossato sulla Luna). Logo Bulova font corsivo

━━━ NOVITÀ 2024-2025 ━━━
Rolex Watches & Wonders 2024: nuovi Oyster Perpetual "Celebration" (quadranti con decorazioni), Datejust nuovi colori
Omega: nuovi Seamaster 300M colori speciali, Speedmaster Anniversary editions
AP Royal Oak: nuovi quadranti fumé e texture, RO Perpetual Calendar nuove versioni
Tudor Black Bay 54 (2023): ispirazione Submariner originale anni 50, 37mm, cassa piccola
Swatch MoonSwatch nuove uscite: Mission to Moonshine Gold, Mission to the Moonphase
Seiko nuovi Presage Sharp Edged, nuovi Grand Seiko quadranti stagionali

Rispondi SOLO in JSON valido (senza markdown):
{
  "brand": "brand esatto o null",
  "model": "modello preciso o null",
  "reference": "reference number se leggibile o identificabile con certezza, altrimenti null",
  "year": "anno o periodo approssimativo (es: 2020-2023, post-2019) o null",
  "caseSize": "mm stimati o null",
  "caseMaterial": "materiale preciso o null",
  "dialColor": "colore e finitura esatta (es: Blu sunburst, Verde oliva fumé, Grigio meteorite, Bianco smaltato)",
  "dialText": "TRASCRIZIONE FEDELE di tutto il testo sul quadrante — brand, modello, certificazioni, materiale, paese",
  "bezel": "tipo lunetta con dettagli (es: Lunetta Cerachrom nera, Lunetta tachimetrica nera, Lunetta fluted oro, Lunetta liscia acciaio) o null",
  "bracelet": "tipo bracciale/cinturino preciso (Jubilee/Oyster/President/Integrated/Pelle marrone/NATO/Rubber/Mesh/Maglia Milanese) o null",
  "complications": "lista complicazioni visibili o null",
  "movement": "Automatico|Manuale|Quarzo|Solar|Spring Drive|GPS|null — se visibile sul quadrante",
  "limited": "edizione limitata o collab se identificabile (es: MoonSwatch Mission to Mars, Omega x Swatch, James Bond) o null",
  "notes": "QUALSIASI dettaglio visibile aggiuntivo — indici (bastoncini/arabi/romani), colore lancette, logo corona, texture quadrante, etc."
}
━━━ IDENTIFICAZIONE CALIBRO/MOVIMENTO DAL QUADRANTE ━━━
Se sul quadrante è scritto il calibro o il tipo di movimento, riportalo nel campo "movement":
- "Automatic" o "Automatique" o "Swiss Made" (senza quarzo) = automatico
- "Quartz" o "Quartz Crystal" = quarzo
- "Co-Axial" o "Co-Axial Master Chronometer" = Omega automatico (cal. 8500/8800/3861 ecc.)
- "Superlative Chronometer" = Rolex automatico certificato COSC+
- "Chronometer" o "Officially Certified" = certificato COSC
- "Spring Drive" = Grand Seiko meccanismo ibrido
- "Kinetic" = Seiko ibrido quarzo/automatico
- "Eco-Drive" = Citizen solare
- "Solar" = orologio solare
- "Radio Controlled" o "Multiband" = Casio/Citizen con segnale radio orario
- Calibro visibile (es: "Cal. 3135", "Calibre 321", "Calibre de Manufacture") = meccanismo specifico

CALIBRI ICONICI DA RICONOSCERE:
- Rolex Cal. 3135 (Sub/DJ), 3186 (GMT), 4130 (Daytona), 3255 (nuovi), 3235 (nuovi DJ/Explorer) — visibili sul fondello trasparente se presente
- Omega Cal. 3861 (Speedmaster moonwatch Hesalite/Sapphire), 8800 (Seamaster 300M), 8900 (Aqua Terra)
- AP Cal. 3120 (Royal Oak automatico), 2385 (Royal Oak Offshore chrono)
- Patek Cal. 240 (ultra-thin PP), 324 SC (Nautilus)
- ETA 2824/2892 (movimento svizzero comune in orologi mid-range)
- Miyota 9015 (movimento giapponese comune in micro-brand/mid-range)
- Sellita SW200/SW300 (alternativo ETA, comune)

NON inventare reference number non visibili. TRASCRIVI FEDELMENTE il testo sul quadrante. Rispondi SOLO JSON.`,
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
// Prompt generico per categorie personalizzate (Borse, Gioielli, Elettronica, ecc.)
function buildGenericPrompt(category: string): string {
  return `Sei un esperto rivenditore e autenticatore di ${category}. Analizza questo oggetto con attenzione maniacale a OGNI dettaglio visibile: logo, materiale, texture, hardware, etichette, colori, dimensioni, condizioni.

Identifica con precisione:
- Brand: cerca loghi, testi, simboli identificativi
- Modello: nome specifico del prodotto se visibile
- Materiale: pelle, canvas, nylon, metallo, plastica, ecc.
- Dimensione/Taglia: misure visibili, tag, etichette
- Colore: colore principale e secondario
- Condizione: stato di usura visibile

Rispondi SOLO in JSON valido (senza markdown):
{
  "brand": "brand esatto o null",
  "model": "modello o nome prodotto preciso o null",
  "material": "materiale principale o null",
  "size": "dimensione/taglia se visibile (es: MM, 30cm, 42, Small) o null",
  "color": "colore principale o null",
  "condition": "DS|VNDS|Used|Worn|null",
  "notes": "qualsiasi dettaglio identificativo visibile — testi, logo, hardware, ecc."
}
NON inventare dati. Se non riconosci metti null. Rispondi SOLO JSON.`;
}

export async function scanProduct(imageBase64: string, category: string): Promise<ScanResult> {
  const prompt = SCAN_PROMPTS[category] || buildGenericPrompt(category);

  // Pokemon usa Scout diretto (più veloce, sufficiente per leggere testo da carta)
  // Scarpe/Vestiti/Orologi usano Maverick con chain-of-thought (più preciso per identificazione visiva)
  const isPokemon = category === 'Pokemon';

  const finalPrompt = isPokemon ? prompt : `STEP 1 — ANALISI VISIVA (3-5 righe max):
Descrivi brevemente cosa vedi: brand visibile, elementi distintivi, colori, logo/hardware/suola/quadrante.

STEP 2 — IDENTIFICAZIONE JSON:
${prompt}`;

  const finalModel = isPokemon
    ? 'meta-llama/llama-4-scout-17b-16e-instruct'  // Scout: più veloce per OCR carta
    : VISION_MODEL;                                  // Maverick: più preciso per oggetti

  const maxTok = isPokemon ? 700 : category === 'Orologi' ? 1400 : category === 'Vestiti' ? 1200 : 1300;

  let completion;
  try {
    completion = await groqCallWithRetry(client =>
      client.chat.completions.create({
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: finalPrompt },
            { type: 'image_url', image_url: { url: imageBase64 } },
          ],
        }],
        model: finalModel,
        temperature: 0.02,
        max_tokens: maxTok,
      })
    );
  } catch (err: any) {
    // Fallback a Scout se Maverick non disponibile
    if (err?.status === 400 || err?.status === 404) {
      try {
        completion = await groqCallWithRetry(client =>
          client.chat.completions.create({
            messages: [{
              role: 'user',
              content: [
                { type: 'text', text: prompt },
                { type: 'image_url', image_url: { url: imageBase64 } },
              ],
            }],
            model: 'meta-llama/llama-4-scout-17b-16e-instruct',
            temperature: 0.05,
            max_tokens: maxTok,
          })
        );
      } catch (fallbackErr: any) {
        logger.error('Errore modello fallback vision', { fallbackErr, category });
        throw new Error('Servizio IA non disponibile. Riprova tra poco.');
      }
    } else {
      logger.error('Errore Groq vision API', { err, category });
      throw new Error(err?.message || 'Servizio IA non disponibile. Riprova tra poco.');
    }
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
      result.brand = 'Pokémon';

      const pokeVariant = parsed.variant && parsed.variant !== 'base' ? ` ${parsed.variant}` : '';
      const pokeLang = parsed.language && parsed.language !== 'EN' ? ` [${parsed.language}]` : '';
      const pokeRarity = parsed.rarity ? ` — ${parsed.rarity}` : '';

      if (parsed.name) {
        result.model = `${parsed.name}${pokeVariant}${parsed.cardNumber ? ` ${parsed.cardNumber}` : ''}${parsed.setName ? ` (${parsed.setName})` : ''}${pokeLang}${pokeRarity}`;
        result.confidence = parsed.cardNumber ? 'MEDIUM' : 'LOW';

        // Arricchimento via pokemontcg.io — tutte le query IN PARALLELO per velocità
        try {
          const numRaw = parsed.cardNumber?.split('/')[0].trim() || '';
          const numNoZero = numRaw.replace(/^0+/, '') || numRaw;
          const totalRaw = parsed.cardNumber?.split('/')[1]?.trim() || '';

          // Costruisci le query da eseguire in parallelo
          const queries: Promise<any>[] = [];

          // Q1: nome + numero (più precisa)
          if (parsed.name && numNoZero) {
            queries.push(
              fetch(`https://api.pokemontcg.io/v2/cards?q=${encodeURIComponent(`name:"${parsed.name}" number:"${numNoZero}"`)}&pageSize=5`)
                .then(r => r.json()).catch(() => null)
            );
          } else queries.push(Promise.resolve(null));

          // Q2: numero + totale (fallback se nome sbagliato)
          if (numNoZero) {
            const q2 = totalRaw
              ? `number:"${numNoZero}" set.printedTotal:"${totalRaw}"`
              : `number:"${numNoZero}"`;
            queries.push(
              fetch(`https://api.pokemontcg.io/v2/cards?q=${encodeURIComponent(q2)}&pageSize=10`)
                .then(r => r.json()).catch(() => null)
            );
          } else queries.push(Promise.resolve(null));

          // Q3: solo nome (ultimo fallback)
          if (parsed.name) {
            queries.push(
              fetch(`https://api.pokemontcg.io/v2/cards?q=${encodeURIComponent(`name:"${parsed.name}"`)}&pageSize=10`)
                .then(r => r.json()).catch(() => null)
            );
          } else queries.push(Promise.resolve(null));

          // Esegui tutte in parallelo
          const [d1, d2, d3] = await Promise.all(queries);

          const buildDetails = (card: any) => ({
            ...parsed,
            tcgId: card.id,
            tcgImage: card.images?.large || card.images?.small,
            tcgSet: card.set.name,
            tcgSetId: card.set.id,
            tcgRarity: card.rarity,
            tcgNumber: card.number,
            tcgPrintedTotal: card.set.printedTotal,
            marketPrice: card.cardmarket?.prices?.averageSellPrice || card.tcgplayer?.prices?.holofoil?.market || null,
          });

          if (d1?.data?.length > 0) {
            const card = d1.data[0];
            result.model = `${card.name} — ${card.set.name} ${card.number}/${card.set.printedTotal}${pokeLang}`;
            result.confidence = 'HIGH';
            result.details = buildDetails(card);
          } else if (d2?.data?.length > 0) {
            const best = d2.data.find((c: any) => c.name.toLowerCase().includes((parsed.name || '').toLowerCase())) || d2.data[0];
            result.model = `${best.name} — ${best.set.name} ${best.number}/${best.set.printedTotal}${pokeLang}`;
            result.confidence = 'HIGH';
            result.details = buildDetails(best);
          } else if (d3?.data?.length > 0) {
            const card = d3.data[0];
            result.model = `${card.name} — ${card.set.name} ${card.number}/${card.set.printedTotal}${pokeLang} (da nome)`;
            result.confidence = 'MEDIUM';
            result.details = buildDetails(card);
          }
        } catch (tcgErr) {
          logger.warn('TCG API non raggiungibile', { tcgErr });
        }
      } else {
        // Nessun nome trovato — prova comunque per numero
        if (parsed.cardNumber) {
          result.model = `Carta #${parsed.cardNumber}${parsed.setName ? ` (${parsed.setName})` : ''}`;
          result.confidence = 'LOW';
          result.warnings = ['Nome Pokémon non leggibile. Modifica manualmente.'];
        } else {
          result.confidence = 'LOW';
          result.warnings = ['Carta non identificata. Assicurati che sia ben illuminata e a fuoco.'];
        }
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
    default: {
      // Categoria personalizzata (Borse, Gioielli, ecc.)
      if (parsed.brand || parsed.model) {
        result.brand = parsed.brand || category;
        const parts = [parsed.model, parsed.material, parsed.size, parsed.color].filter(Boolean);
        result.model = parts.join(' — ') || parsed.notes || 'N/D';
        result.confidence = (parsed.brand && parsed.model) ? 'HIGH' : parsed.brand || parsed.model ? 'MEDIUM' : 'LOW';
        if (parsed.size) result.details = { ...parsed };
      } else {
        result.confidence = 'LOW';
        result.warnings = [`Oggetto non identificato nella categoria "${category}". Compila i campi manualmente.`];
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
    completion = await groqCallWithRetry(client =>
      client.chat.completions.create({
        messages: [{ role: 'user', content: prompt }],
        model: TEXT_MODEL,
        temperature: 0.1,
        max_tokens: 400,
      })
    );
  } catch (err) {
    logger.error('Errore Groq text API prezzi', { err });
    return { minPrice: 0, maxPrice: 0, avgPrice: 0, confidence: 'LOW', reasoning: 'Stima non disponibile, riprova tra poco.', cached: false };
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

HAMILTON:
- Logo "H" ornamentale in alto sul quadrante: font preciso, simmetrico — sui fake è pixelato o storto
- Khaki Field: indici triangolari alle 12, ore applicate precise, quadrante matte di qualità
- Ventura: cassa triangolare asimmetrica — linee geometriche PRECISE, nessun angolo irregolare
- "HAMILTON" in basso sul quadrante: font Swiss precisissimo
- Caseback: "HAMILTON" inciso + "ETA" o "H-10" o ref movement
- Swatch Group Made in Switzerland: "SWISS MADE" in basso obbligatorio sui modelli automatici

TAG HEUER:
- Monaco: cassa quadrata con angoli precisi e smussature regolari, subdial piccoli secondi in basso destra
- Carrera: indici applicati precisi, font cronografo su subdial uniformi
- Logo TAG Heuer: carattere sans-serif specifico, non pixelato
- Cinturino: qualità acciaio o pelle impeccabile, fibbia con logo inciso

BREITLING:
- Logo ala con B: simmetria delle ali perfetta
- Navitimer: regolo scorrevole con scala PRECISA — i fake hanno scale stampate male
- Quadrante: testo piccolo leggibile, numero marchio certificazione COSC visibile

TISSOT / LONGINES / MIDO (Swatch Group):
- "SWISS MADE" obbligatorio
- Logo preciso (croce svizzera Tissot, L calligrafico Longines, M stilizzato Mido)
- Longines: font "Longines" in corsivo storico preciso — molto imitato sui marketplace

TUDOR:
- Corona fungo: caratteristica — deve essere prominente e precisa
- Logo scudo Tudor: forme geometriche precise
- Bracciale: maglie rifinite con qualità Rolex-adjacent
- "TUDOR" sul quadrante: font identico Rolex ma con nome diverso

ZENITH:
- El Primero: lancetta cronografo fa 5 giri al minuto (non 6 come altri). Quadrante tri-colore (nero/argento/grigio) con 3 subdial colorati

PANERAI:
- Ponte corona: deve avere la chiusura a "8" PRECISA — è il marker più identificativo
- "OFFICINE PANERAI" in rilievo sul fondello in acciaio
- "LUMINOR MARINA" o modello inciso sul fondello
- Quadrante a sandwich: due layer visibili ai bordi (backlight + superficie)

CASIO G-SHOCK:
- CasiOak (GA-2100): cassa ottagonale con angoli smussati precisi
- "G-SHOCK" in rilievo sulla lunetta in resina
- Pulsanti laterali funzionanti, non decorativi
- Retroilluminazione interna visibile

GENERAL WATCHES — CRITERI UNIVERSALI (applicabili a QUALSIASI orologio):
- TESTO QUADRANTE: font uniformi, nessuna sbavatura o pixel visibile, allineamento centrato
- LANCETTE: finitura uniforme, luminova (se presente) applicata con precisione senza sbordature
- INDICI: tutti allo stesso livello, fissati solidamente, stessa dimensione
- CORONA: logo del brand inciso con profondità (non stampato superficialmente), resistenza regolare
- CASEBACK: incisioni profonde e nette (seriale, modello, movimento)
- CINTURINO/BRACCIALE: qualità materiale congruente con fascia prezzo, fibbia con logo
- SWEEP SECONDI: automatico = fluido continuo; quarzo = ticchettio regolare
- Se dichiarato automatico ma fa ticchettio = SOSPETTO
- Peso: un orologio di qualità si sente pesante in mano — i fake sono spesso troppo leggeri
- Per orologi NON nell'elenco sopra: valuta in base ai criteri universali e assegna NEEDS_VERIFICATION se non puoi verificare specificamente

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
  } catch (err: any) {
    // Fallback Scout su rate limit o modello non disponibile
    if (err?.status === 429 || err?.status === 400 || err?.status === 404 || err?.status === 503) {
      try {
        const fallback = await groq.chat.completions.create({
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: imageBase64 } },
            ],
          }],
          model: 'meta-llama/llama-4-scout-17b-16e-instruct',
          temperature: 0.1,
          max_tokens: 900,
        });
        const raw2 = fallback.choices[0]?.message?.content?.trim() || '';
        const p2 = safeParseJSON(raw2);
        const d = '⚠️ Valutazione automatica basata sull\'immagine. NON sostituisce un autenticatore professionista.';
        if (!p2) return { score: 50, verdict: 'NEEDS_VERIFICATION', redFlags: [], greenFlags: [], disclaimer: d };
        return {
          score: Math.max(0, Math.min(100, p2.score || 50)),
          verdict: p2.verdict || 'NEEDS_VERIFICATION',
          redFlags: Array.isArray(p2.redFlags) ? p2.redFlags.slice(0, 10) : [],
          greenFlags: Array.isArray(p2.greenFlags) ? p2.greenFlags.slice(0, 10) : [],
          disclaimer: d,
        };
      } catch {
        /* fall through */
      }
    }
    if (err?.status === 429) {
      return { score: 50, verdict: 'NEEDS_VERIFICATION', redFlags: [], greenFlags: [], disclaimer: 'Limite richieste IA raggiunto. Attendi qualche minuto e riprova.' };
    }
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

// ==========================================
// GENERA CONFIG CATEGORIA (per reparti personalizzati)
// ==========================================
export interface CategoryConfig {
  categoryType: string;
  emoji: string;
  expertDescription: string;
  fields: Array<{
    name: string;
    label: string;
    type: 'text' | 'select' | 'number';
    placeholder?: string;
    options?: string[];
    required: boolean;
  }>;
  scanPrompt: string;
  conditionOptions: string[];
  legitPrompt?: string;
}

export async function generateCategoryConfig(categoryName: string): Promise<CategoryConfig | null> {
  const prompt = `Sei un architetto di sistemi per app di reselling professionale. È stata creata una nuova categoria chiamata "${categoryName}".

Genera una configurazione completa e ultra-specifica per questa categoria. Analizza il nome e crea tutto su misura.

ESEMPI DI RIFERIMENTO:
- "Elettronica" → fields: brand, model, storage (select: 64GB/128GB/256GB/512GB/1TB/2TB), ram (select: 4GB/6GB/8GB/12GB/16GB), color, batteryHealth (es: 100%, 87%), condition (select: Nuovo/Come Nuovo/Ottimo/Buono/Discreto/Da Riparare), imei/serial (opzionale)
- "Gioielli" → fields: brand (es: Cartier/Bulgari/Tiffany/No Brand), type (select: Anello/Collana/Bracciale/Orecchini/Orologio/Altro), material (select: Oro 18k/Oro 14k/Oro 9k/Argento 925/Platino/Acciaio/Altro), caratage, weight (es: 5.2g), size (es: 14 per anelli, 40cm per collane), gemstone (Diamante/Rubino/Smeraldo/Nessuna), condition
- "Fumetti/Manga" → fields: title, volume/issue, publisher, year, language (select: IT/JP/EN/FR), edition (Prima/Ristampa/Variant), condition (select: Mint/Near Mint/Very Fine/Fine/Good/Fair/Poor)
- "Vinili/Musica" → fields: artist, album, year, label, format (select: LP 33/EP 45/Single 45/Single 78), condition (select: Mint/Near Mint/VG+/VG/G), coverCondition
- "Arte" → fields: artist, title, technique (select: Olio/Acrilico/Acquerello/Stampa/Fotografia/Scultura/Altro), dimensions (es: 50x70cm), year, signed (select: Sì/No), certificateOfAuthenticity (select: Sì/No), condition
- "Sneakers Vintage" → come scarpe ma con campi anno/modello storico in più
- "Trading Cards" → come Pokemon ma generico: cardName, setName, cardNumber, rarity, language, condition, graded, grade

ISTRUZIONI:
1. I fields devono essere SPECIFICI per la categoria — niente "Taglia" per Elettronica, niente "Storage" per Gioielli
2. Il scanPrompt deve essere un prompt completo per fare AI-scan di un prodotto di quella categoria — includi: come riconoscere il brand, come leggere il modello, come valutare condizioni, specifiche tecniche da estrarre. Deve essere lungo e dettagliato (almeno 300 parole)
3. Includi SEMPRE brand come primo campo required
4. Le conditionOptions devono essere specifiche per la categoria
5. Il legitPrompt deve spiegare come verificare autenticità per quella categoria

Rispondi SOLO in JSON valido (senza markdown, nessun testo extra):
{
  "categoryType": "tipo categoria",
  "emoji": "UN SOLO emoji che rappresenta perfettamente questa categoria (es: 📱 per Elettronica, 💍 per Gioielli, 👜 per Borse, 📚 per Libri, 🎮 per Videogiochi, 🎸 per Strumenti musicali, 🚗 per Auto, 🎨 per Arte, 🍷 per Vino, 💎 per Lusso generico)",
  "expertDescription": "Sei un esperto di [categoria] con [specificità]. Conosci [cosa conosce l'esperto]",
  "fields": [
    {"name": "brand", "label": "Brand", "type": "text", "placeholder": "es. Apple, Samsung", "required": true},
    {"name": "model", "label": "Modello", "type": "text", "placeholder": "es. iPhone 13 Pro", "required": true}
    // ... altri campi specifici
  ],
  "scanPrompt": "prompt completo per scan IA di questa categoria...",
  "conditionOptions": ["Opzione1", "Opzione2", "Opzione3", "Opzione4", "Opzione5"],
  "legitPrompt": "come verificare autenticità per questa categoria..."
}`;

  try {
    const completion = await groqCallWithRetry(client =>
      client.chat.completions.create({
        messages: [{ role: 'user', content: prompt }],
        model: TEXT_MODEL,
        temperature: 0.3,
        max_tokens: 2000,
      })
    );

    const raw = completion.choices[0]?.message?.content?.trim() || '';
    const config = safeParseJSON(raw) as CategoryConfig | null;

    if (!config || !config.fields || !config.scanPrompt) {
      logger.warn('Config categoria non valida per', { categoryName });
      return null;
    }

    return config;
  } catch (err: any) {
    logger.error('Errore generazione config categoria', { err: err.message, categoryName });
    return null;
  }
}
