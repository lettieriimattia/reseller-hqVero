#!/usr/bin/env bash
# ============================================================
# HQ — Setup server Hetzner (Ubuntu 22.04/24.04)
# Esegui UNA VOLTA come root, appena creato il server:
#   bash setup-server.sh
# Installa: Node 20, git, pm2 (process manager), Caddy (HTTPS automatico).
# ============================================================
set -e

echo "==> Aggiorno il sistema"
apt-get update -y && apt-get upgrade -y

echo "==> Installo Node.js 20 + git + strumenti di build (servono per moduli nativi es. bcrypt)"
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs git ufw build-essential python3

echo "==> Installo pm2 (mantiene l'app accesa e la riavvia ai crash/riavvii)"
npm install -g pm2

echo "==> Installo Caddy (reverse proxy + HTTPS automatico Let's Encrypt)"
apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
apt-get update -y
apt-get install -y caddy

echo "==> Firewall: apro SSH (22), HTTP (80), HTTPS (443)"
ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp
ufw --force enable

echo "==> FATTO. Node $(node -v), pm2 e Caddy installati."
echo "    Prossimo passo: clona il codice e lancia deploy.sh (vedi README)."
