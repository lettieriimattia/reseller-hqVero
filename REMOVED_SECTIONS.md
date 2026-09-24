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

In attesa di conferma, **non ancora tolto**: l'elemento bianco della Dashboard, cioè l'"etichetta" di `components/HomeLedger.tsx`.
