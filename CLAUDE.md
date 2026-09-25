# HQVault — note per Claude

- Prima di qualsiasi modifica alla pagina Analytics/analitiche, consulta `REMOVED_SECTIONS.md`: elenca le sezioni rimosse o spostate, dove si trova il loro codice e quali vanno reintegrate.

## Architettura informazioni

Regola da rispettare in tutti gli step futuri:

- **DASHBOARD = SOLO RICAVI E PROFITTI.** Serve a capire in 3 secondi come sta andando il mese. Nient'altro: niente magazzino, niente reparti, niente clienti, niente fornitori, niente tracking.
- **ANALYTICS = tutte le analisi**: magazzino, reparti, diagramma a torta, migliori prodotti, prodotti da migliorare, migliori clienti, fornitori, migliori canali di vendita, brand, percentuali. Il riordino di Analytics si farà in uno step futuro: finché non viene chiesto, non toccarla.

## Liquidità (Magazzino › scheda "Liquidità")

Bilancio **personale** dei soldi dell'utente: i soci non lo vedono, perché tutto è filtrato per `userId`.
- **Conti** (`LiquidityAccount`): nome, tipo (Contanti, Conto corrente, Crypto, Saldo piattaforma, Altro). Il valore delle crypto si inserisce a mano in €.
- **Persone** (`LiquidityPerson`): hanno un solo saldo netto. Positivo = mi deve (credito, verde); negativo = le devo (debito, rosso).
- **Movimenti** (`LiquidityMovement`): ogni operazione sposta `amountCents` (centesimi interi) DA una sorgente A una destinazione. Sorgente e destinazione possono essere un conto, una persona o "l'esterno" (null).
- **TOTALE** = somma dei conti + somma dei saldi delle persone (crediti − debiti).

**REGOLA: i saldi derivano SEMPRE dai movimenti, non si scrivono mai a mano.**
- Saldo (di un conto o di una persona) = somma dei movimenti in entrata − somma di quelli in uscita.
- Il saldo iniziale di un conto è anch'esso un movimento (OPENING / OPENING_NEG).
- Per correggere un errore si elimina il movimento: il saldo si ricalcola da solo.
- Non aggiungere mai campi "saldo" alle tabelle.

Tipi di operazione (`kind`):
- DEPOSIT / WITHDRAW / TRANSFER: movimenti tra conti o con l'esterno;
- CREDIT / DEBT: crediti e debiti, anche "dal nulla", cioè senza passare da un conto;
- SETTLE_IN / SETTLE_OUT: saldo di un credito o di un debito, anche parziale o superiore al dovuto (in quel caso il saldo della persona si inverte);
- PERSON_TRANSFER: una persona ne paga un'altra per conto dell'utente.

Server: `src/routes/liquidity.ts`. App: `frontend/src/components/Liquidity.tsx`.

### Collegamento con acquisti e vendite (step 11)
- Aggiungi prodotto → **"Pagato con"** obbligatorio; Vendi → **"Incassato su"** obbligatorio (entra il netto: prezzo − fee). Opzioni: un conto, una persona (debito/credito) oppure "Dividi" su più fonti (la somma deve essere uguale al totale, altrimenti non si salva). Default = ultima scelta (localStorage `hq-liq-last-PURCHASE/SALE`).
- Un acquisto o una vendita (anche di più pezzi insieme) = un **gruppo**: `LiquidityLink` (pezzo ↔ gruppo, ruolo PURCHASE/SALE, quota mia `factor`) + movimenti con lo stesso `groupId` e kind PURCHASE/SALE.
- **Importi sempre con la MIA quota**: PURCHASE = Σ round(prezzo acquisto × quota × 100); SALE = Σ round((prezzo vendita − fee) × quota × 100). Li calcola il server, il client non decide l'importo.
- Modifica / elimina / ripristina / reso di un pezzo → `recalcForProducts` / `unlinkSale` ricalcolano il gruppo: le parti si ridistribuiscono in proporzione (`weightCents`). Un pezzo eliminato o non più venduto esce dal totale, quindi il movimento si annulla da solo.
- I movimenti collegati NON si eliminano dalla Liquidità: si cambiano dalla scheda del pezzo ("Cambia", `PUT /liquidity/links/:groupId`).
- Acquisti e vendite fatti prima dello step 11 non sono collegati (niente retroattivo). Si possono collegare a mano dalla scheda ("Collega").
- NON collegati (per ora): lotti, scambi, chat, marketplace, Shopify, vendite automatiche.

Servizio: `src/services/liquidityLink.service.ts`. App: `components/PaymentPicker.tsx`, `components/LinkedPayments.tsx`.
