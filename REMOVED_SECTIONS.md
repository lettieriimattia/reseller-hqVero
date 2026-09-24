# Sezioni rimosse dalla pagina Analytics

Pulizia fatta sul commit "cleanup analitiche". Lo stato di prima è nel commit "pre-cleanup analitiche": per tornare indietro in blocco, ripristinare quel commit.

Come sono state rimosse:
- Le sezioni erano scritte direttamente dentro `frontend/src/App.tsx`, non come componenti separati. Ogni blocco è stato copiato **identico** in `frontend/src/components/_archived/*.tsx.txt`. I file sono `.txt`, quindi non vengono compilati.
- Nel punto esatto da cui è stato tolto ogni blocco, App.tsx contiene un commento `{/* Rimosso: … */}`. Per reintegrare una sezione, basta ricopiarla lì.
- I calcoli e le chiamate ai dati **non sono stati toccati**: restano in App.tsx, e i dati sul server non sono cambiati.

| Sezione | Dove stava | Dove si trova ora il codice | Stato |
|---|---|---|---|
| Riquadri riassuntivi Profitto / Ricavi / Pezzi venduti / Margine / Acquistato | `components/AnalyticsExplorer.tsx` (sezione "Esplora i numeri") | `components/_archived/explorer-riquadri-riassuntivi.tsx.txt`. Il componente `MetricTile` e i calcoli restano in AnalyticsExplorer.tsx, senza essere mostrati | Rimosso, recuperabile. Da quando mancano i riquadri, il grafico mostra solo il profitto netto |
| Istogramma "Analisi" (Entrate / Uscite / Investimenti, ultimi 6 mesi) | `App.tsx`, pagina Analytics | `components/_archived/analytics-istogramma-entrate-uscite.tsx.txt` | Rimosso, recuperabile |
| Libro paga soci | `App.tsx`, pagina Analytics | `components/_archived/analytics-libro-paga-soci.tsx.txt` | Rimosso, recuperabile |
| Costi extra (inserimento e elenco delle spese) | `App.tsx`, pagina Analytics | `components/_archived/analytics-costi-extra.tsx.txt` | Rimosso, recuperabile. ⚠️ Era l'unico punto in cui inserire nuove spese: le spese già salvate restano nel database |
| Conto economico mensile (con export CSV del mese e profitto per reparto) | `App.tsx`, pagina Analytics | `components/_archived/analytics-conto-economico.tsx.txt` | Rimosso, recuperabile. Il pulsante "CSV commercialista" in alto resta |
| Margine medio / Giorni medi di vendita / Sell-through (riga di 3 riquadri) | `App.tsx`, pagina Analytics | `components/_archived/analytics-margine-giorni-sellthrough.tsx.txt` | Rimosso, recuperabile |
| Soci (quote e profitti per socio) | `App.tsx`, pagina Analytics, accanto a "Piattaforme" | `components/_archived/analytics-soci.tsx.txt` | **Rimosso temporaneamente, da reintegrare** |
| Top 3 vendite | `App.tsx`, pagina Analytics | `components/_archived/analytics-top3-vendite.tsx.txt` | **Rimosso temporaneamente, da riorganizzare in seguito** |

## Sezioni tenute con una nota

| Sezione | Nota |
|---|---|
| ROI % | Tenuto, ma **da raggruppare in futuro con altre metriche** (istruzioni in arrivo) |
| Vendite / Reparti | Mostrano ancora il sell-through: nel sottotitolo del riquadro Vendite e come colonna nella tabella Reparti. Lasciati invariati, come da istruzioni |

## Ritocchi alla griglia dopo la rimozione

- La sezione "Piattaforme" ora occupa tutta la larghezza, perché "Soci" non le sta più accanto.
- La riga Stock / Svendita occupa tutta la larghezza e non lascia più colonne vuote.

# Spostamenti — step 1 dashboard

Fatti nel commit "step1: esplora i numeri in dashboard". Punto di ripristino: il commit "pre-step1 dashboard".

| Sezione | Da | A | Note |
|---|---|---|---|
| "Esplora i numeri" (`components/AnalyticsExplorer.tsx`): grafico del periodo, filtri per reparto / piattaforma / brand, età del magazzino | Pagina Analytics, in alto | Dashboard, in alto, subito sotto il saluto | In Analytics, al suo posto, c'è il commento `{/* Spostato: … */}`. Il componente è lo stesso, non è stato duplicato. Nuove funzioni: opzione **Mese** (predefinita: dal giorno 1 all'ultimo del mese corrente, confrontato con tutto il mese precedente) e **Personalizzato** (date Da / A) |

# Step 2 — KPI in Dashboard

Fatto nel commit "step2: kpi dashboard". Punto di ripristino: il commit "pre-step2".

| Sezione | File del componente | Dove si trova ora il codice | Stato |
|---|---|---|---|
| Etichetta bianca della Dashboard (profitto netto in grande, 6 caselle ricavi / pezzi / ROI / prezzo medio / giorni medi / acquistato col confronto, codice a barre giornaliero) | `components/HomeLedger.tsx` | `components/_archived/home-etichetta-bianca.tsx.txt`. I calcoli restano in HomeLedger.tsx, senza essere mostrati | Rimosso, recuperabile. Il suo posto l'hanno preso il grafico di "Esplora i numeri" e i 3 KPI qui sotto |

Aggiunto: `components/DashboardKpis.tsx`, con 3 riquadri sotto a "Esplora i numeri":
- **Ricavo ultimi 3 mesi**: mese corrente + i 2 precedenti, contro i 3 mesi prima;
- **Ricavo del mese** e **Profitto del mese**: mese corrente, contro il mese precedente.

Riusano i calcoli dei riquadri tolti nella pulizia: `aggregate` e `valueOf`, spostati fuori dal componente in `AnalyticsExplorer.tsx` ed esportati, con la stessa logica. Se un periodo non ha vendite, mostrano "—".

Resta in HomeLedger il selettore Mese / Trimestre / Anno: ora guida solo l'obiettivo, la proiezione e le classifiche sotto.

# Step 3 — pulizia dei doppioni

Fatto nel commit "step3: pulizia analytics". Punto di ripristino: il commit "pre-step3".

La regola data dall'utente: ogni doppione va tolto, sia dentro la stessa pagina sia tra Dashboard e Analytics. Quale copia tenere l'ho deciso così:
- **reparti, piattaforme e brand**: resta la versione di "Esplora i numeri" (scelta esplicita dell'utente per i reparti);
- **compratori e fornitori**: restano in Analytics (regola di CLAUDE.md);
- **capitale in magazzino**: resta l'"Età del magazzino".

| Sezione | Dove stava | Dove si trova ora il codice | Stato |
|---|---|---|---|
| Tabella Reparti (totale, venduti, stock, **sell-through**, capitale, profitto, giorni per vendita) | `App.tsx`, Analytics | `components/_archived/analytics-tabella-reparti.tsx.txt` | Rimosso, recuperabile. Scelta dell'utente: tenute le barre "Per reparto". La colonna sell-through se n'è andata con la tabella |
| Piattaforme (vendite, ricavi, fee e profitto per piattaforma) | `App.tsx`, Analytics | `components/_archived/analytics-piattaforme.tsx.txt` | Rimosso, recuperabile: doppione delle barre "Per piattaforma". ⚠️ Conteneva il punto di reintegro di **Soci** (da reintegrare, vedi sopra) |
| Riquadro Stock + Svendita | `App.tsx`, Analytics | `components/_archived/analytics-riquadro-stock-svendita.tsx.txt` | Rimosso, recuperabile: doppione dello stock. Con lui è andato "Svendita" (valore di liquidazione), che non compare altrove |
| Riquadro KPI Stock (riga ROI / Profitto / Stock / Vendite) | `App.tsx`, Analytics | `components/_archived/analytics-kpi-stock.tsx.txt` | Rimosso, recuperabile: doppione dell'Età del magazzino. La riga ora ha 3 riquadri: ROI, Profitto netto, Vendite |
| Sottotitolo "· N% sell-through" del riquadro Vendite | `App.tsx`, Analytics | `components/_archived/analytics-vendite-sottotitolo-sellthrough.tsx.txt` (riga originale) | Rimosso: il sottotitolo ora è solo "Totali" |
| Insights (pezzi fermi, vendite della settimana, reparto migliore, sell-through rate) | `App.tsx`, Analytics | `components/_archived/analytics-insights.tsx.txt` | Rimosso, recuperabile: ogni voce ripeteva un dato presente altrove |
| Avviso pezzi fermi (dead stock) | `App.tsx`, Analytics | `components/_archived/analytics-avviso-pezzi-fermi.tsx.txt` | Rimosso, recuperabile: doppione di "Fermi da oltre 30 giorni" e dell'Età del magazzino |
| Migliori compratori / Migliori fornitori (solo telefono) | `App.tsx`, Dashboard | `components/_archived/dashboard-mobile-compratori-fornitori.tsx.txt` | Rimosso, recuperabile: doppione di Compratori / Fornitori in Analytics |
| Classifiche "Per piattaforma" e "Per reparto" | `components/HomeLedger.tsx`, Dashboard | `components/_archived/home-classifiche-piattaforma-reparto.tsx.txt` | Rimosso, recuperabile: doppione delle barre di "Esplora i numeri", nella stessa pagina. Resta "Pezzi più redditizi" |
| Riga "Capitale in magazzino" del "Da fare" | `components/HomeLedger.tsx`, Dashboard | `components/_archived/home-da-fare-capitale-magazzino.tsx.txt` | Rimosso, recuperabile: doppione del totale dell'Età del magazzino |

Sovrapposizioni lasciate apposta (non sono lo stesso dato):
- **"Fermi da oltre 30 giorni"** nel "Da fare": è un'azione da fare, non solo un numero.
- **Totale della torta 3D in "In magazzino"**: coincide col totale dell'Età del magazzino, ma divide il capitale per reparto invece che per età.
- **Profitto netto in Analytics**: è su tutto lo storico, mentre la Dashboard mostra il mese.

# Step 4 — Tracking: RIMOSSO DEFINITIVAMENTE

Fatto nel commit "step4: rimosso tracking". Punto di ripristino: il commit "pre-step4 rimozione tracking".
Tolta solo l'interfaccia: **dati e tabelle del database non sono stati toccati** (codici, stati e cronologie di tracciamento restano salvati). Tutto il codice tolto è in un unico file, `components/_archived/tracking-rimosso.tsx.txt`, un blocco per ogni pezzo.

| Pezzo tolto | Dove stava | Stato |
|---|---|---|
| Pagina Tracking (spedizioni attive, eccezioni/resi, consegnate, "aggiungi in arrivo", aggiorna tutti) | `App.tsx` | Rimosso definitivamente |
| Voce "Tracking" nella barra in alto e nella barra in basso (icona camion) | `App.tsx`, 3 barre di navigazione | Rimosso definitivamente. La barra in basso ora ha 4 icone (Dashboard, Magazzino, Catalogo, Analytics), distribuite in parti uguali |
| Riquadro "Spedizioni in corso" | `App.tsx`, Dashboard | Rimosso definitivamente |
| Riga "Da spedire" del "Da fare" (portava alla pagina Tracking) | `components/HomeLedger.tsx`, Dashboard | Rimosso definitivamente |
| Modale "Codice di tracciamento" | `App.tsx` | Rimosso definitivamente |
| Pulsanti "Track" / "Traccia" (scheda magazzino su computer, menu ⋯, dettaglio modello, dettaglio lotto, lista "Da spedire") | `App.tsx`, Magazzino | Rimosso definitivamente |
| Link al corriere col codice (schede su telefono e su computer, dettaglio lotto, lista "Da spedire") | `App.tsx`, Magazzino | Rimosso definitivamente |
| Etichette di stato "Transito" / "Consegnato" / "Eccezione" sulle schede | `App.tsx`, Magazzino | Rimosso definitivamente |
| Voce "Vai a Tracking" nella palette comandi | `App.tsx` | Rimosso definitivamente |
| Voce "Spedizioni & tracking" della guida (IT ed EN) | `App.tsx` | Rimosso definitivamente |

Restano, perché non sono il tracking:
- **"Spedisci"**: calcola le tariffe e crea l'etichetta di spedizione.
- **Il segno "Da spedire"** nel Magazzino.
- **L'etichetta "Spedito"** nella lista "Da spedire".

⚠️ Cose lato server rimaste attive (non toccate, perché lo step riguardava solo l'interfaccia):
- **Aggiornamento automatico del tracking**: in `src/services/tracking.service.ts`, sui pezzi che hanno già un codice. Quando un pacco risulta consegnato, invia la notifica "📦 Spedizione consegnata!" (tipo SALE) e l'email, e segna il pezzo come VENDUTO.
- **Strumento `aggiungi_tracking` dell'assistente in chat**: può ancora salvare un codice.

# Step 5 — Dashboard solo ricavi e profitti

Fatto nel commit "step5: dashboard solo ricavi e profitti". Punto di ripristino: il commit "pre-step5".

| Sezione | Dove stava | Dove si trova ora il codice | Stato |
|---|---|---|---|
| Età del magazzino, con il totale "In magazzino" (capitale per fasce 0–30 / 31–60 / 61–90 / 90+ giorni). In passato era stata tenuta, ora va tolta | `components/AnalyticsExplorer.tsx`, Dashboard | `components/_archived/dashboard-eta-magazzino.tsx.txt`. I calcoli (`aging`, `stockCap`) restano nel componente | Rimosso, recuperabile. Candidata per Analytics |

Correzione di un errore dello step 4: il blocco **"Dal catalogo"**, cioè la striscia di prodotti del catalogo in fondo alla Dashboard, era finito per sbaglio nel taglio di "Spedizioni in corso". Non è tracking, quindi è stato **ripristinato** in `App.tsx`. Nell'archivio del tracking resta solo come traccia, segnalato da una nota.

Migliorato nello stesso step, su richiesta dell'utente: l'elenco che compare toccando una barra di "Esplora i numeri" ora **raggruppa i prodotti identici** (stessa marca e stesso nome). Esempio: "20× Yeezy Boost 350 V2 Bone · 190 € cad. · totale 3.800 €". Se i prezzi sono diversi, mostra la media con minimo e massimo. Toccando la riga si aprono i singoli pezzi.

# IDEE FUTURE PER ANALYTICS

- "Valore magazzino al costo, cumulato mese per mese, per vedere la crescita del patrimonio (es. marzo 10k → giugno 15k). Da ricostruire con data acquisto/data vendita dei pezzi."

# Step 6 — Blocco unico Ricavi / Profitti

Fatto nel commit "step6: blocco ricavi e profitti". Punto di ripristino: il commit "pre-step6".

| Sezione | Dove stava | Dove si trova ora il codice | Stato |
|---|---|---|---|
| "Esplora i numeri" in Dashboard: titolo, selettore 7gg / 30gg / 90gg / 12 mesi / Anno / Tutto / Personalizzato, barre per reparto / piattaforma / brand | `App.tsx` → `components/AnalyticsExplorer.tsx` | Righe tolte: `components/_archived/dashboard-esplora-e-kpi.tsx.txt`. Il componente resta intero in `AnalyticsExplorer.tsx`, ma non è più usato in nessuna pagina | Rimosso dalla Dashboard, recuperabile. ⚠️ Le barre **per reparto, piattaforma e brand** ora non compaiono più da nessuna parte: vanno portate in Analytics quando se ne farà il riordino |
| 3 riquadri "Ricavo ultimi 3 mesi", "Ricavo del mese", "Profitto del mese" | `App.tsx` → `components/DashboardKpis.tsx` | Righe tolte: `components/_archived/dashboard-esplora-e-kpi.tsx.txt`. Il componente resta in `DashboardKpis.tsx`, non importato | Rimosso, recuperabile: sostituito dal blocco unico |

Aggiunto: `components/ProfitRevenueBlock.tsx`, il blocco unico in cima alla Dashboard.
- **Numero grande**: all'apertura il profitto del mese corrente, con il confronto sul mese precedente in € e in %.
- **Interruttore Profitto / Ricavo**: l'ultima scelta viene ricordata.
- **Viste**: "Mese" (una barra al giorno) e "3 mesi" (3 barre, una per mese di calendario).
- **Tocco su una barra**: mostra il valore del giorno o del mese, con l'altra metrica accanto.
- **Trascinamento**: mostra la somma dell'intervallo, con le date sotto.
- **Tocco fuori dal blocco**: si torna al totale del mese.
- Toccando una barra compare l'elenco dei pezzi, raggruppato come nello step 5.

Calcoli: riusano `aggregate` e `SelectionList`, esportati da `AnalyticsExplorer.tsx`. Verificati barra per barra con un calcolo indipendente sui dati grezzi, sia con dati di prova (casi limite di orario inclusi) sia con i dati veri dell'account demo: **0 differenze**.

# Step 7 — Torta Analytics: solo magazzino attuale

Fatto nel commit "step7: torta solo magazzino". Punto di ripristino: il commit "pre-step7 torta analytics".

| Sezione | Dove stava | Dove si trova ora il codice | Stato |
|---|---|---|---|
| Selettore "In magazzino / Tutti gli acquisti" della torta 3D (ambito "Tutti gli acquisti") | `components/AllocationPie3D.tsx`, Analytics | `components/_archived/torta-ambito-tutti-acquisti.tsx.txt` | Rimosso. **I dati di acquisti e vendite non sono stati toccati**: restano nel database per il resto delle Analytics |

Com'è ora la torta ("Magazzino per reparto"):
- **Cosa conta**: solo i pezzi IN STOCK oggi, divisi per reparto. Anche l'ordine dei colori e il gruppo "Altro" ora si calcolano sul magazzino.
- **Due torte**, a scelta dell'utente, che ha chiesto di tenerle entrambe:
  - **Capitale**: quanto ha pagato l'utente, cioè costo d'acquisto × la sua quota, non il costo pieno dei pezzi in società;
  - **Quantità**: numero di pezzi.
- **Al centro**: il totale del magazzino ("In magazzino 1.620 €" oppure "6 pezzi").
- **Toccando una fetta o la riga del reparto**: valore, numero di pezzi e % sul totale. Toccando fuori si chiude.
- Verificata sui dati grezzi dell'account demo: 0 differenze.

# Step 8 — Analytics panoramica (parte 1: punti 1 e 2 dell'utente)

Fatto nel commit "step8: analytics panoramica (parte 1)". Punto di ripristino: il commit "pre-step8 analytics".
Regola confermata dall'utente: **ogni cifra è sulla SUA quota**. Se un pezzo è in società al 50%, conta metà di ricavo, profitto e costo.

| Sezione | Dove stava | Dove si trova ora il codice | Stato |
|---|---|---|---|
| Riquadri ROI % / Profitto netto / Vendite | `App.tsx`, Analytics | `components/_archived/analytics-kpi-roi-profitto-vendite.tsx.txt` | Rimossi, sostituiti da "Dati totali". Nota: usavano i valori pieni dei pezzi e cambiavano col filtro reparto del Magazzino. Il ROI verrà sostituito dal ricarico per reparto |
| Avviso giallo "N prodotti fermi da oltre 30 giorni · Riprezza →" (apriva lo strumento Pro di riprezzamento) | `App.tsx`, **Magazzino** | `components/_archived/magazzino-banner-prodotti-fermi.tsx.txt` | Rimosso su richiesta dell'utente. Al suo posto, in alto a destra, c'è il collegamento **"Osserva i prodotti venduti →"**, che apre Analytics › Dati totali. ⚠️ Da qui non si arriva più allo strumento "Riprezza" |

Aggiunto:
- **`components/SalesTotals.tsx` — "Dati totali"**, in cima ad Analytics:
  - Ricavi totali e Profitto netto su tutte le vendite, dalla prima a oggi;
  - "Vendite totali": ogni mese con pezzi, ricavi e profitto; toccando un mese si aprono i pezzi, raggruppati per prodotto identico.
- **`components/DeptStats.tsx` — "Osserva le statistiche dei tuoi prodotti venduti"**, sotto la torta:
  - una riga per reparto, ordinate per ricavi, con ricavi, profitto e ricarico medio ponderato (profitto ÷ costo × 100, sulla quota);
  - toccando un reparto, o "Guarda nel dettaglio", si apre la classifica per modello o per brand, ordinata per pezzi venduti;
  - toccando un modello compaiono le singole vendite.
- **`lib/modelGroup.ts` — raggruppamento dei nomi**: regole fisse (Yeezy, Jordan, Dunk, New Balance, Rick Owens…). I nomi che le regole non riconoscono vanno all'AI **una volta sola** tramite `POST /ai/model-groups` (in `src/routes/ai.ts` e `src/services/ai.service.ts`).
  - Il risultato è salvato nella tabella `Setting` con chiavi `mg1:<marca>|<nome>`, senza modifiche al database, e anche nel browser.
  - ⚠️ La parte AI funziona solo **dopo la pubblicazione del server**. Fino ad allora si usano solo le regole fisse.

Verifiche:
- **Dati di prova**, con nomi scritti in modi diversi e un pezzo al 50%: 0 differenze tra la pagina e un calcolo indipendente su totali, mesi, reparti, ricarico e classifica. Per esempio le Yeezy 350, scritte in 3 modi diversi, finiscono in un solo gruppo da 22 pezzi.
- **App vera, account demo**: 0 differenze coi dati grezzi del server e 0 errori in console.


# Step 8 — parte 2

Fatto nel commit "step8: analytics panoramica (parte 2)". Punto di ripristino: il commit "pre-step8 parte 2". **In questa parte non è stato tolto niente.**

Aggiunto:
- **`components/BestProduct.tsx` — "Il tuo prodotto migliore"**, sotto le statistiche per reparto. Si può richiudere e l'app ricorda se è aperto o chiuso.
  - Mostra il modello, raggruppato come nelle statistiche, con il profitto totale più alto sulla quota dell'utente: pezzi venduti, profitto, ricarico % e una frase di spiegazione.
  - Il calcolo è fisso, senza AI: usa al massimo i raggruppamenti già salvati.
- **"Mesi precedenti" sommati ai "Dati totali"**:
  - ricavo inserito a mano e profitto (ricavo − costo) si **sommano** a Ricavi totali e Profitto netto;
  - nell'elenco "Vendite totali" il mese compare con l'etichetta "inserito a mano"; se ci sono anche vendite registrate nell'app, i valori si sommano;
  - nessun'altra parte dell'app è cambiata: Dashboard, statistiche per reparto, torta e prodotto migliore usano solo le vendite registrate.

Non fatto, perché l'utente ha detto che per ora restano come sono: **piattaforme e brand**. Il brand compare già nel dettaglio "Per brand".

Verifiche:
- **Dati di prova**, con 2 mesi a mano (uno senza vendite, uno sovrapposto a un mese con vendite): 0 differenze.
- **App vera, account demo**: 0 differenze e 0 errori in console.
