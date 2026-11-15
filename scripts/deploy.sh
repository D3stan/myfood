#!/bin/sh
# Build here, copy to the VM, install production dependencies there, restart.
# Usage: scripts/deploy.sh [ssh-target]   (default myfood@192.168.2.32)
set -eu
cd "$(dirname "$0")/.."
T="${1:-myfood@192.168.2.32}"
npm run build
rsync -az --delete --exclude node_modules --exclude data --exclude .git --exclude tests --exclude docs \
  dist src scripts deploy package.json package-lock.json "$T:/opt/myfood/"
ssh "$T" 'set -e
cd /opt/myfood
npm ci --omit=dev --silent
sudo install -m 755 scripts/run-agy.sh /usr/local/bin/run-agy
sudo install -m 755 scripts/backup-r2.mjs /usr/local/bin/myfood-backup-r2
sudo install -m 644 deploy/myfood.env /etc/myfood.env
sudo install -m 644 deploy/myfood.service deploy/myfood-backup.service deploy/myfood-backup.timer /etc/systemd/system/
sudo install -d -m 755 /etc/systemd/system/myfood-backup.service.d
sudo install -m 644 deploy/myfood-backup-r2.conf /etc/systemd/system/myfood-backup.service.d/r2.conf
sudo systemctl daemon-reload
sudo systemctl enable --now myfood.service myfood-backup.timer >/dev/null
sudo systemctl restart myfood.service
sleep 2
curl -fsS http://127.0.0.1:3000/api/health'
echo
