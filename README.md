# Reseller HQ v2.0 🚀

Gestionale per resellers con team management, IA multi-categoria e sicurezza enterprise-grade.

## ✨ Cosa è cambiato dalla v1

### 🔐 Sicurezza (MAX)
- **httpOnly cookies** invece di localStorage (anti-XSS)
- **Refresh token rotation** in DB (sessioni revocabili)
- **2FA opzionale** con TOTP (Google Authenticator) + codici di backup
- **Rate limiting** differenziato (login: 5/15min, IA: 20/h, API: 100/15min)
- **Audit log** completo (chi-ha-fatto-cosa-quando) nel DB
- **Account lock** automatico dopo 5 tentativi login falliti
- **Anti-enumeration**: timing equalizzato anche per email inesistenti
- **Validazione Zod** rigorosa su tutti gli input
- **bcrypt rounds = 12** (era 10)
- **CORS strict** con whitelist domini via env
- **Helmet** per security headers
- **Password policy**: min 10 caratteri, complessità obbligatoria
- **JWT secrets validati all'avvio** (server non parte se mancanti/deboli)
- **Encryption AES-256-GCM** per 2FA secrets nel DB
- **Authorization per warehouse** (fix IDOR: prima qualsiasi utente poteva editare prodotti altrui)
- **Stack trace nascoste** in produzione

### 🤖 IA potenziata
- **Scanner multi-categoria**: ora funziona per **Scarpe, Vestiti, Pokémon, Orologi** (non solo Pokémon)
- **Stima prezzo di mercato**: l'IA suggerisce min/max/media basata su mercati italiani/europei
- **Legit check**: valutazione di autenticità con red/green flags (per scarpe/vestiti/orologi)
- **Cache prezzi (7 giorni)** per ridurre costi API
- **Prompt strutturati** che chiedono JSON valido + parser robusto
- **Disclaimer onesti**: l'app dichiara che il legit check non sostituisce un autenticatore professionista

### ✨ Feature "vendibili"
- **Notifiche in-app** real-time (vendita, nuovo socio, prodotto aggiunto, quote aggiornate)
- **Calcolatore prezzo consigliato** integrato nel form vendita
- **Polling automatico** ogni 30s per notifiche

### 🏗️ Architettura
- Backend modulare: routes/services/middleware separati invece di un unico Server.ts monolitico
- Database con **DB transactions** per operazioni multi-step
- Schema Prisma esteso con `warehouseId` su prodotti, `RefreshToken`, `AuditLog`, `Notification`, `MarketPrice`

---

## 📁 Struttura

```
reseller-hq/
├── backend/
│   ├── server.ts                    # Entry point
│   ├── package.json
│   ├── tsconfig.json
│   ├── .env.example                 # Template variabili d'ambiente
│   ├── prisma/
│   │   └── schema.prisma            # Schema DB completo
│   └── src/
│       ├── middleware/
│       │   ├── auth.ts              # JWT + authorization warehouse
│       │   ├── rateLimit.ts         # Rate limiting per endpoint
│       │   └── validate.ts          # Schemi Zod
│       ├── routes/
│       │   ├── auth.ts              # Login/register/refresh/logout/2FA
│       │   ├── products.ts          # CRUD prodotti
│       │   ├── team.ts              # Team, quote, warehouse
│       │   ├── ai.ts                # /scan, /price, /authenticity, /full-scan
│       │   └── notifications.ts     # Notifiche in-app + audit log
│       ├── services/
│       │   ├── ai.service.ts        # Logica IA (multi-categoria)
│       │   ├── audit.service.ts     # Audit log
│       │   └── notification.service.ts
│       └── utils/
│           ├── security.ts          # AES-256-GCM, password, token
│           └── logger.ts            # Winston
└── frontend/
    └── App.tsx                      # Frontend completo React
```

---

## 🛠️ Setup (sviluppo)

### 1. Backend

```bash
cd backend
npm install

# Genera segreti
echo "JWT_ACCESS_SECRET=\"$(openssl rand -base64 64)\"" >> .env
echo "JWT_REFRESH_SECRET=\"$(openssl rand -base64 64)\"" >> .env
echo "ENCRYPTION_KEY=\"$(openssl rand -hex 32)\"" >> .env

# Copia il resto da .env.example
cp .env.example .env.local
# (poi merge manuale)

# Configura DATABASE_URL nel .env, poi:
npx prisma migrate dev --name v2_security_ai
npx prisma generate

npm run dev
```

Il server parte su `http://localhost:3000`.

### 2. Frontend

Il file `App.tsx` è pronto per essere usato in un progetto Vite + React + Tailwind.

```bash
# Se non hai ancora un progetto frontend:
npm create vite@latest reseller-frontend -- --template react-ts
cd reseller-frontend
npm install
npm install lucide-react recharts
npm install -D tailwindcss postcss autoprefixer
npx tailwindcss init -p
```

Poi:
- Sostituisci `src/App.tsx` con il file fornito.
- Aggiungi a `tailwind.config.js`:
  ```js
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  ```
- In `src/index.css` aggiungi le direttive Tailwind:
  ```css
  @tailwind base;
  @tailwind components;
  @tailwind utilities;
  ```
- Opzionale: in `.env` del frontend:
  ```
  VITE_API_URL=http://localhost:3000
  ```

```bash
npm run dev
```

---

## 🚨 Checklist deploy in produzione

Prima di andare live, **verifica TUTTO** questo:

- [ ] `NODE_ENV=production` su tutti i servizi
- [ ] `COOKIE_SECURE=true` (richiede HTTPS reale)
- [ ] `COOKIE_DOMAIN` impostato al tuo dominio
- [ ] `ALLOWED_ORIGINS` ridotto al solo dominio del frontend
- [ ] HTTPS attivo (Let's Encrypt va benissimo)
- [ ] Reverse proxy (nginx) con header `X-Forwarded-For` corretto
- [ ] Database PostgreSQL gestito con backup automatici
- [ ] `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `ENCRYPTION_KEY` generati con `openssl` (mai i valori di esempio)
- [ ] File `.env` MAI committato (è in `.gitignore`)
- [ ] Monitoring: i log finiscono in `logs/error.log` e `logs/combined.log`
- [ ] Considera Sentry/Datadog per alerting su errori
- [ ] Considera Cloudflare/WAF davanti al server
- [ ] Test che il login si blocchi dopo 5 tentativi
- [ ] Test che un utente non possa vedere/modificare prodotti di altri team
- [ ] Test che il refresh token venga ruotato a ogni refresh
- [ ] Test che il 2FA funzioni con Google Authenticator + codici di backup

---

## 🧠 Note sull'IA

Il sistema usa **Groq** (gratis fino a certi limiti) con:
- **meta-llama/llama-4-scout-17b-16e-instruct** per vision (scan + legit check)
- **llama-3.3-70b-versatile** per stime prezzi

Le stime prezzo sono **euristiche basate sulla conoscenza generale del modello**, NON dati live di marketplace. Per accuratezza maggiore in futuro: integrare API di StockX, Vinted, eBay.

Il **legit check** è una valutazione approssimativa. Il disclaimer in-app è chiaro: per acquisti di valore alto consigliare comunque servizi specializzati (Legit App, CheckCheck).

---

## ⚠️ Possibili miglioramenti futuri

- Export Excel/PDF dei dati (puoi aggiungere `xlsx` o `pdfkit` lato backend)
- Audit trail UI completo per OWNER (l'endpoint c'è già: `GET /audit/:warehouseId`)
- Email transazionali per notifiche importanti
- Mobile app (React Native condivide buona parte della logica)
- Integrazione real-time via WebSocket invece di polling (per notifiche istantanee)
- A/B test su algoritmo di stima prezzi confrontandolo con dati storici reali

---

Made with ☕ e qualche imprecazione, come ogni codice scritto da Italiani.
