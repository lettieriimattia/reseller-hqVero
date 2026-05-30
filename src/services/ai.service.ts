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

━━━ PARIGI LUSSO ━━━
LOUIS VUITTON: monogramma LV, Damier, Epi. Abbigliamento: giacche/felpe con logo LV, collab Nigo (Duck Tshirt, LV² collab), Virgil Abloh (Off-White x LV), Tyler the Creator (LV Spring 2023)
DIOR: cannage pattern (rombi quilted), CD oblique, Dior Oblique suit/jacket. Collab Travis Scott (Cactus Jack x Dior), ERL, Kenny Scharf, Sacai
BALENCIAGA: logo large, oversized silhouette, Demna aesthetic, collab Adidas/Gucci/Fortnite/Simpsons/Kim Kardashian. Track jacket/Hoodie/Political Campaign tee
GIVENCHY: logo G, Antigona, BdC logo, collab Chito
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
HAMILTON: Khaki Field (H70555733/H69439931), Intramatic, Ventura (cassa triangolare — indossato da Elvis), Jazzmaster, Broadway
FREDERIQUE CONSTANT: Classics, Highlife, Slimline
ALPINA: Startimer Pilot, Alpiner Comtesse

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

━━━ NOVITÀ 2024-2025 ━━━
Rolex Baseworld/Watches & Wonders 2024: nuovi Datejust quadranti, Oyster Perpetual nuovi colori, aggiornamenti vari
Omega MoonSwatch collab: nuove serie pianeti, colori speciali
AP Royal Oak nuove colorazioni 2024: nuovi quadranti fumé
Tudor Black Bay 54 2023: ispirazione Submariner anni 50, 37mm
Breguet nuove uscite, Zenith nuovi Defy

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
      max_tokens: category === 'Orologi' ? 1200 : category === 'Vestiti' ? 1000 : 900,
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
