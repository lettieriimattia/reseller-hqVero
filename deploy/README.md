# Trasloco su Hetzner — guida passo-passo

Server tuo a ~€4/mese con 4GB RAM. Il database (Neon) NON si tocca: si sposta solo l'app.
HTTPS gratis con un sottodominio DuckDNS (poi sostituibile col dominio vero).

---

## FASE 0 — Cose da preparare (5 min)
1. **Token GitHub** (per scaricare il codice privato sul server):
   - GitHub → in alto a destra avatar → **Settings** → in basso **Developer settings** →
     **Personal access tokens → Tokens (classic)** → **Generate new token (classic)**
   - Scadenza: No expiration (o 1 anno). Spunta solo **`repo`**. Genera e **copia il token** (inizia con `ghp_...`).
2. **Sottodominio gratis DuckDNS** (per l'HTTPS):
   - Vai su **duckdns.org** → accedi (Google/GitHub) → crea un sottodominio, es. **`hqcoresystem`** → diventa `hqcoresystem.duckdns.org`
   - Lascia la pagina aperta: dopo ci metti l'IP del server.

## FASE 1 — Crea il server Hetzner (5 min)
1. **hetzner.com → Cloud → Sign up** (verifica account; a volte ci vuole un po')
2. **New Project** → **Add Server**
   - Location: **Falkenstein/Nuremberg** (Germania, vicino)
   - Image: **Ubuntu 24.04**
   - Type: **CX22** (2 vCPU, 4GB RAM, ~€4/mese)
   - Auth: metti una **password root** (o SSH key se sai usarla)
   - Create & Buy
3. Copia l'**IP pubblico** del server (es. `203.0.113.45`)
4. Su **DuckDNS**: incolla l'IP nel campo del tuo sottodominio → **update ip**

## FASE 2 — Entra nel server
- Da Windows apri **PowerShell** e fai:
  ```
  ssh root@IP_DEL_SERVER
  ```
  (accetti la chiave con `yes`, poi metti la password root)

## FASE 3 — Scarica il codice
```
apt-get update -y && apt-get install -y git
git clone https://IL_TUO_TOKEN@github.com/lettieriimattia/reseller-hq.git /opt/hq
cd /opt/hq
```
(sostituisci `IL_TUO_TOKEN` col token GitHub `ghp_...`)

## FASE 4 — Installa tutto (un comando)
```
bash /opt/hq/deploy/setup-server.sh
```
Installa Node, pm2, Caddy e configura il firewall.

## FASE 5 — Crea il file .env (le variabili)
```
nano /opt/hq/.env
```
Incolla **TUTTE** le variabili che hai su Render (Environment), una per riga `NOME=valore`.
In più assicurati di avere:
```
NODE_ENV=production
PORT=3000
APP_URL=https://hqcoresystem.duckdns.org
```
Salva con **CTRL+O**, Invio, poi **CTRL+X**.
> Copiale dal pannello Render → Environment. Includi DATABASE_URL, DIRECT_URL, JWT_SECRET,
> STRIPE_*, CLOUDINARY_*, GROQ_API_KEY, BREVO_API_KEY, STOCKX_*, TRACKING_17TRACK_KEY, ecc.

## FASE 6 — Avvia l'app
```
cd /opt/hq && bash deploy/deploy.sh
pm2 startup    # esegui il comando che ti stampa (per ripartire dopo i riavvii)
pm2 save
```

## FASE 7 — HTTPS con Caddy
```
nano /etc/caddy/Caddyfile
```
Cancella tutto e incolla (con il TUO dominio):
```
hqcoresystem.duckdns.org {
    encode gzip
    reverse_proxy localhost:3000
}
```
Salva (CTRL+O, CTRL+X), poi:
```
systemctl reload caddy
```
Aspetta ~30 sec e apri **https://hqcoresystem.duckdns.org** → deve uscire l'app col lucchetto. ✅

## FASE 8 — Ultime cose
- **Stripe**: aggiorna l'URL del webhook col nuovo dominio (Dashboard Stripe → Webhooks).
- **Render**: quando il nuovo server funziona, puoi sospendere/spegnere il servizio Render.

---

## Aggiornamenti futuri (quando cambio il codice)
Sul server:
```
cd /opt/hq && bash deploy/deploy.sh
```
Fa pull + build + riavvio. Fine.

## Comandi utili
- `pm2 status` → stato app
- `pm2 logs hq` → log in tempo reale
- `pm2 restart hq` → riavvia
- `systemctl status caddy` → stato HTTPS
