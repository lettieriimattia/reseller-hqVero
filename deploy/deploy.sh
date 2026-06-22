#!/usr/bin/env bash
# ============================================================
# HQ — Build & avvio dell'app (Hetzner)
# Usalo per il PRIMO avvio e per ogni AGGIORNAMENTO futuro:
#   cd /opt/hq && bash deploy/deploy.sh
# Fa: git pull → installa dipendenze → build → (ri)avvia con pm2.
# Richiede: codice già clonato in /opt/hq e file .env già compilato (vedi README).
# ============================================================
set -e

APP_DIR="/opt/hq"
cd "$APP_DIR"

echo "==> Scarico ultime modifiche dal repo"
git pull

echo "==> Installo dipendenze (incluse dev, servono per la build)"
npm install --include=dev

echo "==> Build (prisma + frontend + backend)"
npm run build

echo "==> Avvio/riavvio con pm2"
# 'npm start' fa: prisma db push + node dist/server.js
pm2 describe hq >/dev/null 2>&1 && pm2 restart hq --update-env || pm2 start npm --name hq -- start
pm2 save

echo "==> FATTO. Stato:"
pm2 status
