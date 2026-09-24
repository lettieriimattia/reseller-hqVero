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
