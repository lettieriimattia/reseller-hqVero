# 🔐 HQVault — Piano di Sicurezza completo

> Obiettivo: proteggere i dati delle persone, ridurre la probabilità di intrusione e sapere **esattamente cosa fare quando qualcuno entra**. Documento operativo: segui le checklist, spunta man mano.
> Stack: Node/Express + TypeScript + Prisma + PostgreSQL (Neon) · hosting Render · frontend React PWA · auth JWT in cookie httpOnly.

---

## 0. Stato attuale (cosa è GIÀ a posto ✅)
- `helmet` con **HSTS** (1 anno, includeSubDomains, preload).
- **CORS restrittivo** con allow-list di origin + `credentials`.
- Auth via **JWT in cookie httpOnly** (niente token in localStorage), access + refresh separati.
- Password con **bcrypt (12 round)** + mitigazione **timing-attack** sul login (compare dummy).
- **Rate limiting** su auth e API (`authLimiter`, `apiLimiter`).
- `trust proxy` per IP reale dietro Render.
- Dipendenze npm a **0 vulnerabilità** (mantienilo: `npm audit`).

### Lacune note da chiudere (dettaglio nelle sezioni sotto)
- [ ] **CSP disabilitata** (`contentSecurityPolicy: false`) → riattivare con policy mirata.
- [ ] **Segreti potenzialmente esposti** (password Neon citata in chat) → **RUOTARE SUBITO**.
- [ ] **Backup/Recovery** non verificati end-to-end.
- [ ] **Logging/alerting** di sicurezza minimale.
- [ ] **Piano di risposta agli incidenti** assente (questo documento lo crea).
- [ ] **Conformità GDPR** (informativa, registro trattamenti, notifica violazioni) da formalizzare.

---

## 1. PREVENZIONE — hardening

### 1.1 Identità & autenticazione
- [ ] Password: lunghezza minima 10, blocco password comuni (lista), bcrypt ≥ 12 (ok).
- [ ] **Lockout / throttling** progressivo dopo N tentativi falliti per account+IP (oltre al rate-limit globale).
- [ ] **2FA (TOTP)** almeno per gli account **admin** (priorità) e opzionale per tutti.
- [ ] Refresh token: **rotazione** ad ogni uso + **revoca** lato server (lista/contatore in DB) per poter "sloggare tutti".
- [ ] Logout reale: invalida il refresh token server-side, non solo cancella il cookie.
- [ ] Email di sicurezza: avvisa l'utente a **nuovo login da device sconosciuto** e a **cambio password**.

### 1.2 Sessioni & cookie
- [ ] `httpOnly` ✅, `secure` in prod ✅, `sameSite`: valuta **`strict`** per il cookie di sessione (oggi `lax`).
- [ ] **CSRF**: con `sameSite=lax/strict` sei coperto sui form classici, ma per le richieste state-changing verifica un **token CSRF** (double-submit) — l'header `X-CSRF-Token` è già previsto: assicurati che sia **validato** lato server, non solo accettato.

### 1.3 Header & superficie web
- [ ] **Riattivare CSP** (helmet) con policy esplicita: `default-src 'self'`, `img-src 'self' https://images.stockx.com https://api.kicks.dev data:`, `connect-src` per le tue API, `script-src 'self'` (no `unsafe-inline`; usa nonce se serve). Testa in `report-only` prima di forzarla.
- [ ] `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` minimale (camera/microphone solo `self`).
- [ ] Disabilita `x-powered-by` (helmet lo fa).

### 1.4 Input & dati
- [ ] **Validazione input** su TUTTE le route (zod/express-validator) — body, query, params. Mai fidarsi del client.
- [ ] Prisma protegge da SQL injection (query parametriche): **non** usare mai `$queryRawUnsafe` con input utente.
- [ ] **Autorizzazione per-risorsa**: ogni query filtra per `userId`/`warehouseId` dell'utente loggato (verifica che NON esista una route che restituisce dati di altri solo perché passi un id). È il rischio #1 (IDOR/Broken Access Control).
- [ ] **Limiti payload** (`express.json({ limit: '1mb' })`) e dimensione upload foto.
- [ ] **Rate-limit mirato** su endpoint costosi/sensibili (login, reset password, IA, catalogo esterno).

### 1.5 Segreti & configurazione
- [ ] Tutti i segreti **solo in env** (Render dashboard), mai nel repo. Verifica con `git log -p | grep -i secret` che non siano mai stati committati.
- [ ] **Rotazione segreti** programmata: `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `DATABASE_URL` (password Neon), chiavi API (Groq/KicksDB), VAPID push. Segreti **lunghi e casuali** (≥ 32 byte).
- [ ] **Principio del minimo privilegio** sul DB: l'utente applicativo Neon ha solo i permessi necessari (no superuser).
- [ ] `.gitignore` copre `.env`, certificati, dump DB.

### 1.6 Dipendenze & build
- [ ] `npm audit` in CI; **Dependabot/Renovate** per aggiornamenti.
- [ ] `npm ci` (lockfile) in build, non `npm install` libero.
- [ ] Nessun pacchetto inutile (riduci superficie). Controlla script post-install sospetti.

### 1.7 Infrastruttura (Render + Neon)
- [ ] **HTTPS forzato** ovunque (HSTS ok) + redirect 80→443.
- [ ] Neon: **SSL richiesto** nella connection string (`sslmode=require`).
- [ ] **IP allow-list / accesso DB** ristretto se Neon lo consente; comunque password forte.
- [ ] Accesso a Render/Neon/GitHub con **2FA obbligatoria** e password manager.
- [ ] Token/Deploy keys con scope minimo; rimuovi collaboratori non più attivi.

---

## 2. BACKUP & RECOVERY (resilienza dati)
> "Quando ci entrano" spesso significa **dati cancellati o cifrati (ransomware)**. Senza backup verificati, sei finito.

- [ ] **Neon PITR** (Point-in-Time Restore): verifica la **retention** attiva (es. 7 giorni) e **provala** facendo un restore di test.
- [ ] **Backup logici esportati FUORI da Neon**: `pg_dump` giornaliero schedulato → storage separato (es. bucket cifrato), **retention 30 giorni**. Un backup nello stesso provider non protegge da compromissione dell'account.
- [ ] **Cifratura at-rest** dei backup esportati + accesso ristretto.
- [ ] **Test di restore trimestrale** documentato (un backup non testato non esiste).
- [ ] **Immutable/versioned storage** se possibile (un attaccante con accesso non deve poter cancellare i backup).
- [ ] Documenta **RPO** (quanti dati puoi perdere, es. ≤ 24h) e **RTO** (in quanto torni operativo, es. ≤ 4h).

---

## 3. DETECTION — accorgersi che stanno/sono entrati
- [ ] **Audit log** delle azioni sensibili: login (ok/fail), cambio password, cambio email, esportazioni dati, azioni admin, cancellazioni in massa. Con userId, IP, timestamp, user-agent.
- [ ] **Alert automatici** su: picco di login falliti, login da IP/paese anomalo, troppe 401/403, spike di traffico, errori 500 anomali, uso anomalo delle API a pagamento (Groq/KicksDB = anche segnale di chiave rubata).
- [ ] **Log centralizzati** e **non cancellabili dall'app** (almeno copia esterna). Conserva ≥ 90 giorni.
- [ ] **Health/uptime monitor** esterno (già c'è il ping `/health`): aggiungi alert se va giù.
- [ ] **Canary**: un account/record civetta che, se toccato, fa scattare un alert.
- [ ] Rivedi i log **settimanalmente** (15 min) anche senza incidenti.

---

## 4. 🚨 INCIDENT RESPONSE — cosa fare QUANDO ci entrano
> Stampa/salva questa sezione. In un incidente si va nel panico: segui i passi in ordine. **Non distruggere prove** finché non hai capito cosa è successo.

### Ruoli (definiscili ORA, anche se sei solo)
- **Incident lead** (decide): _______
- **Tecnico** (esegue): _______
- **Comunicazione/legale** (utenti, autorità): _______

### Fase 1 — RILEVAZIONE & TRIAGE (minuti 0–30)
1. **Conferma** che è reale (non un falso positivo). Annota **ora di inizio**, cosa hai visto, dove.
2. Apri un **registro dell'incidente** (file con timestamp di ogni azione). Servirà per legge e per imparare.
3. Classifica la gravità:
   - **CRITICO**: accesso al DB/dati personali, account admin compromesso, dati esfiltrati/cancellati, ransomware.
   - **ALTO**: account utente compromesso, chiave API rubata, vulnerabilità sfruttabile attiva.
   - **MEDIO/BASSO**: scansioni, tentativi falliti, bug senza impatto dati.

### Fase 2 — CONTENIMENTO (fermare l'emorragia, prima ora)
- [ ] **Isola**: se serve, metti l'app in **maintenance mode** (già previsto: risposta 503) per bloccare l'attaccante senza spegnere tutto.
- [ ] **Revoca le sessioni**: ruota `JWT_ACCESS_SECRET` e `JWT_REFRESH_SECRET` → **sloggati tutti** all'istante (tutti i token diventano invalidi). Invalida i refresh token in DB.
- [ ] **Ruota i segreti compromessi/sospetti**: password Neon (`DATABASE_URL`), chiavi API (Groq, KicksDB), VAPID, qualsiasi token Render/GitHub.
- [ ] **Blocca l'account/IP** dell'attaccante; disabilita l'account admin compromesso.
- [ ] **NON** cancellare log/macchine: ti servono come prove. Fai **snapshot** dello stato (DB, log).
- [ ] Se **ransomware/cancellazione dati**: NON pagare di impulso; passa subito al **restore da backup** (sez. 2) su ambiente pulito.

### Fase 3 — ERADICAZIONE (rimuovere l'accesso e la causa)
- [ ] Trova **come** sono entrati (credenziali rubate? endpoint vulnerabile? dipendenza? segreto leakato?). Usa i log.
- [ ] **Chiudi la falla** (patch del bug, fix dell'autorizzazione, rimozione backdoor, aggiornamento dipendenza).
- [ ] **Reset password forzato** per gli utenti coinvolti (e admin).
- [ ] Verifica che non abbiano lasciato **persistenza** (nuovi utenti admin, chiavi, webhook, regole).
- [ ] Ricostruisci da sorgente fidata se sospetti compromissione del codice/deploy.

### Fase 4 — RIPRISTINO (tornare operativi in sicurezza)
- [ ] Ripristina dati da **backup pulito** (precedente all'intrusione), su infra con segreti nuovi.
- [ ] Riapri gradualmente; **monitoraggio intensivo** per 72h (l'attaccante spesso ritorna).
- [ ] Conferma integrità dati e che la falla sia chiusa (retest).

### Fase 5 — NOTIFICA (obblighi di legge — vedi sez. 5)
- [ ] Se ci sono **dati personali** coinvolti: parte il countdown **72 ore** per il Garante.
- [ ] Avvisa gli **utenti** se c'è rischio per loro (in modo chiaro: cosa è successo, cosa fare, cosa stai facendo).

### Fase 6 — POST-MORTEM (entro 1–2 settimane)
- [ ] Cronologia completa, causa radice, cosa ha funzionato/no.
- [ ] **Azioni correttive** con responsabile e scadenza → aggiungile alle checklist di questo file.
- [ ] Aggiorna i runbook (sez. 7).

---

## 5. DATI DELLE PERSONE — protezione & GDPR
> Tratti dati personali (email, password hashate, dati di business degli utenti, eventuali dati dei loro clienti). In UE si applica il **GDPR**: hai obblighi precisi, soprattutto in caso di violazione.

### 5.1 Principi (da applicare nel prodotto)
- [ ] **Minimizzazione**: raccogli solo i dati che servono. Niente campi inutili.
- [ ] **Cifratura**: in transito (HTTPS ✅) e at-rest (Neon cifra il disco; i **backup esportati** cifrali tu).
- [ ] **Password**: mai in chiaro (bcrypt ✅). Mai loggare password, token, numeri di carta.
- [ ] **Pseudonimizzazione** dove possibile nei log (non loggare PII completa).
- [ ] **Conservazione limitata**: definisci da quanto tempo cancelli account/dati inattivi.
- [ ] **Accessi minimi**: solo chi serve accede ai dati; ogni accesso loggato.

### 5.2 Diritti degli utenti (devono essere realizzabili)
- [ ] **Accesso/Export** dei propri dati (hai già export Excel: bene).
- [ ] **Cancellazione** ("diritto all'oblio"): un flusso che cancella davvero account + dati collegati (soft+hard delete pianificata).
- [ ] **Rettifica** dei dati.
- [ ] **Informativa privacy** chiara (cosa raccogli, perché, per quanto, con chi lo condividi).
- [ ] **Consenso** dove richiesto (es. notifiche push, marketing).

### 5.3 Fornitori (sub-responsabili) — firma i DPA
- [ ] **Neon** (DB), **Render** (hosting), **Groq** (IA), **KicksDB**, provider email/push: assicurati di avere un **DPA** (Data Processing Agreement) e che siano in regola GDPR. Tieni un **registro dei trattamenti** con la lista.
- [ ] Verifica **dove** sono ospitati i dati (UE/USA) e le garanzie di trasferimento.

### 5.4 Notifica di violazione (DATA BREACH) — tempistiche
- [ ] **Garante Privacy**: entro **72 ore** dalla scoperta, se la violazione comporta un rischio per i diritti delle persone. Se non riesci entro 72h, notifichi comunque spiegando il ritardo.
- [ ] **Interessati (utenti)**: "senza ingiustificato ritardo" se il rischio è **elevato**.
- [ ] Prepara **ORA** un **template di notifica** (cosa è successo, dati coinvolti, conseguenze probabili, misure prese, contatti) — sez. 7.
- [ ] Tieni un **registro delle violazioni** (anche di quelle non notificate, con motivazione).

---

## 6. PRIORITÀ (cosa fare e quando)

### 🔴 SUBITO (oggi/questa settimana)
- [ ] **Ruotare la password Neon** (`DATABASE_URL`) — citata in chat = consideratala compromessa.
- [ ] **Ruotare `JWT_ACCESS_SECRET` e `JWT_REFRESH_SECRET`** se mai esposti; impostarli lunghi/casuali.
- [ ] Verificare che **nessun segreto** sia nel repo/git history.
- [ ] Attivare/verificare **2FA** su GitHub, Render, Neon, email.
- [ ] Verificare **backup Neon** attivo + fare **1 restore di test**.
- [ ] Confermare che le route filtrano sempre per utente (**no IDOR**).

### 🟠 PRE-LANCIO (prima di aprire al pubblico/pagamenti)
- [ ] CSP attiva (report-only → enforce).
- [ ] Audit log + alert di base.
- [ ] Lockout login + 2FA admin.
- [ ] Validazione input completa su tutte le route.
- [ ] Backup esportati fuori-provider + cifrati + retention.
- [ ] Informativa privacy + flusso cancellazione account + DPA fornitori.
- [ ] Template incident + breach notification pronti.

### 🟢 CONTINUO
- [ ] `npm audit` + aggiornamenti dipendenze.
- [ ] Revisione log settimanale.
- [ ] Test restore trimestrale.
- [ ] Rotazione segreti periodica (es. ogni 6–12 mesi).
- [ ] Penetration test / review prima di milestone importanti.

---

## 7. RUNBOOK rapidi (per tipo di incidente)

### A) Segreto/chiave API trapelata
1. Ruota la chiave nel provider. 2. Aggiorna env su Render. 3. Redeploy. 4. Controlla i log per uso anomalo precedente. 5. Registra l'incidente.

### B) Account utente compromesso (account takeover)
1. Forza logout (revoca refresh) e **reset password** dell'utente. 2. Controlla cosa ha fatto l'attaccante (audit log). 3. Avvisa l'utente. 4. Se PII esposta → valuta notifica (sez. 5.4).

### C) Account ADMIN compromesso
1. Disabilita l'admin. 2. **Ruota JWT secrets** (slogga tutti). 3. Verifica nuovi admin/chiavi/backdoor creati. 4. Incident CRITICO → tutte le fasi sez. 4 + notifica.

### D) Accesso al Database / esfiltrazione dati
1. CRITICO. 2. Maintenance mode. 3. Ruota DATABASE_URL + JWT secrets. 4. Snapshot per prove. 5. Capisci l'estensione (quali tabelle/quanti utenti). 6. **Countdown 72h** → notifica Garante + utenti a rischio. 7. Restore se dati alterati.

### E) Ransomware / cancellazione dati
1. NON pagare d'impulso. 2. Isola. 3. **Restore da backup pulito** su infra nuova con segreti nuovi. 4. Trova e chiudi la falla prima di riaprire. 5. Notifica se PII coinvolta.

---

## 8. Contatti & riferimenti (compila)
- Incident lead / tecnico / legale: _______
- Provider e pannelli: Render ____ · Neon ____ · GitHub ____ · Email/Push ____
- **Garante Privacy** (notifica violazioni): garanteprivacy.it
- Hosting backup esterno: _______
- Password manager / cassaforte segreti: _______

---

_Ultimo aggiornamento: 2026-06-28. Rivedi questo piano ad ogni cambio di architettura e dopo ogni incidente._
