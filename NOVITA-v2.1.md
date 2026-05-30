# 🎯 NOVITÀ in questa versione (v2.1)

## ✨ Funzionalità nuove

### 🔔 Notifiche prodotti fermi
- Avviso automatico quando hai prodotti in magazzino oltre la soglia personalizzabile
- Calcolo automatico dello sconto suggerito (5-20%) basato su giorni di giacenza
- Prezzo consigliato calcolato dall'IA (usa il `marketPriceAvg` se disponibile, altrimenti markup 30% sul costo)
- Sezione dedicata in **Impostazioni** con elenco completo dei prodotti fermi
- Notifica di riepilogo in-app (massimo 1 ogni 24h, no spam)

### Logica sconti
- **0-30 giorni oltre soglia**: -5%
- **30-60 giorni oltre soglia**: -10%
- **60-90 giorni oltre soglia**: -15%
- **Oltre 90 giorni oltre soglia**: -20%

---

## 🚀 Come usarlo

### Se è la prima volta che installi (NUOVA installazione)

Segui le istruzioni del file `SETUP-FACILE.md` (se ce l'hai) oppure questi passi:

1. Estrai lo ZIP in `C:\reseller-hq-pronto\`
2. Apri la cartella in VS Code
3. Apri terminale (Ctrl+ò) e lancia:
   ```
   npm install
   ```
4. Crea il file `.env` (vedi `.env.example` come riferimento) e genera i segreti
5. Configura SQLite nello `schema.prisma` (cambia `postgresql` in `sqlite` se vuoi locale)
6. Lancia:
   ```
   npx prisma generate
   npx prisma migrate dev --name init
   npm run dev
   ```
7. In un altro terminale:
   ```
   cd frontend
   npm install
   npm install lucide-react recharts
   npm install -D tailwindcss@3 postcss autoprefixer
   npx tailwindcss init -p
   ```
8. Configura Tailwind e CSS (vedi guida originale)
9. `npm run dev` nella cartella frontend

### Se invece HAI GIÀ il progetto e vuoi solo aggiornare

Devi sostituire questi file con quelli dello ZIP:

**Backend:**
- `src/services/stale.service.ts` ← NUOVO file, va creato
- `src/routes/notifications.ts` ← AGGIORNATO

**Frontend:**
- `frontend/src/App.tsx` ← AGGIORNATO

Dopo aver copiato:
1. Ferma il backend (Ctrl+C sul terminale)
2. Rilancialo: `npm run dev`
3. Ricarica forzata browser: Ctrl+Shift+R

---

## 🧪 Come testare le notifiche prodotti fermi

### Test rapido

1. Login nell'app
2. Vai su **Impostazioni** (icona ingranaggio in alto, oppure tab "Settings" su desktop)
3. Vedrai la nuova sezione **"Notifiche Prodotti Fermi"** in alto
4. **Imposta la soglia a 1 giorno** (temporaneamente, per fare il test)
5. Aggiungi un nuovo prodotto adesso, poi aspetta un giorno
6. Oppure più semplicemente: clicca **"Ricontrolla ora"** — se hai prodotti vecchi vedrai l'elenco

### Per uso reale
- Imposta la soglia a **60 giorni** (consigliato) o quello che preferisci
- L'app controllerà automaticamente:
  - All'avvio dell'app
  - Ogni 1 ora di sessione attiva
- Quando ci sono prodotti fermi vedrai:
  - La sezione in **Impostazioni** con elenco e sconti suggeriti
  - Una **notifica nella campanella** in alto a destra (riepilogo)

---

## 📂 Struttura del progetto

```
reseller-hq-pronto/
├── server.ts                    # Entry point backend
├── package.json
├── tsconfig.json
├── .env.example
├── README.md
├── NOVITA-v2.1.md              # Questo file
├── prisma/
│   └── schema.prisma
├── src/                         # Backend
│   ├── middleware/
│   │   ├── auth.ts
│   │   ├── rateLimit.ts
│   │   └── validate.ts
│   ├── routes/
│   │   ├── auth.ts
│   │   ├── products.ts
│   │   ├── team.ts
│   │   ├── ai.ts
│   │   └── notifications.ts    # ← aggiornato con endpoint /stale
│   ├── services/
│   │   ├── ai.service.ts
│   │   ├── audit.service.ts
│   │   ├── notification.service.ts
│   │   └── stale.service.ts    # ← NUOVO
│   └── utils/
│       ├── logger.ts
│       └── security.ts
└── frontend/
    └── src/
        └── App.tsx              # ← aggiornato
```

---

## 🆘 Problemi comuni

**"Cannot find module '../services/stale.service'"**
→ Hai dimenticato di copiare `stale.service.ts` dentro `src/services/`. Verifica.

**Le notifiche non appaiono**
→ Devi avere prodotti con `createdAt` più vecchio della soglia. Per test, abbassa temporaneamente la soglia a 1 giorno.

**"Errore controllo prodotti fermi"**
→ Controlla i log del backend. Probabilmente è un errore nel database. Prova `npx prisma generate` e riavvia.

Buon resell! 🚀
