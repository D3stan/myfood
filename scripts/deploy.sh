#!/bin/sh
# Deploys one git commit (never the working folder) as its own release on the VM, switches to it
# in one step, and switches back if the new release does not come up healthy.
#
#   scripts/deploy.sh [ssh-target] [git-ref]   deploy (defaults: myfood@192.168.2.32 HEAD)
#   scripts/deploy.sh --rollback [ssh-target]  go back to the previous release
#
# VM layout: /opt/myfood/releases/<commit>/ (last 5 kept), /opt/myfood/current and
# /opt/myfood/previous are symlinks. systemd runs /opt/myfood/current.
set -eu
cd "$(dirname "$0")/.."
MODE=deploy
if [ "${1:-}" = --rollback ]; then MODE=rollback; shift; fi
T="${1:-myfood@192.168.2.32}"
APP=/opt/myfood
KEEP=5

# Shared by both modes on the VM: atomic switch + wait until /api/health reports the expected build.
REMOTE_LIB='
set -eu
switch() { ln -sfn "$1" "$APP/current.new" && mv -T "$APP/current.new" "$APP/current"; }
healthy() {
  i=0
  while [ $i -lt 30 ]; do
    sleep 1; i=$((i + 1))
    curl -fsS http://127.0.0.1:3000/api/health 2>/dev/null | grep -q "\"build\":\"$1\"" && return 0
  done
  return 1
}
'

if [ "$MODE" = rollback ]; then
  ssh "$T" "APP=$APP sh -s" <<EOF
$REMOTE_LIB
CUR=\$(readlink "\$APP/current" || true)
PREV=\$(readlink "\$APP/previous" || true)
[ -n "\$PREV" ] && [ -d "\$PREV" ] || { echo "no previous release to roll back to"; exit 1; }
switch "\$PREV"
ln -sfn "\$CUR" "\$APP/previous"
sudo systemctl restart myfood.service
if healthy "\$(cat "\$PREV/dist/web/build.txt")"; then echo "rolled back: live is \$(basename "\$PREV"), previous is \$(basename "\$CUR")"
else echo "rolled back to \$(basename "\$PREV") but it is not healthy"; sudo journalctl -u myfood.service -n 20 --no-pager; exit 1; fi
EOF
  exit 0
fi

REF="${2:-HEAD}"
SHA=$(git rev-parse --verify "$REF^{commit}")
ID=$(git rev-parse --short=10 "$SHA")
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "note: uncommitted changes in this folder are NOT deployed (deploying commit $ID)"
fi
if [ -z "$(git branch -r --contains "$SHA" 2>/dev/null)" ]; then
  echo "warning: $ID is not pushed to any remote branch yet"
fi

# Build and test the exact commit in a scratch folder.
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
git archive "$SHA" | tar -x -C "$TMP"
echo "building $ID ($(git log -1 --format=%s "$SHA"))"
(cd "$TMP" && npm ci --silent --no-audit --no-fund && npx vitest run --reporter=dot && BUILD_ID="$ID" npm run -s build >/dev/null)

R="$APP/releases/$ID"
ssh "$T" "mkdir -p $APP/releases && if [ \"\$(readlink $APP/current || true)\" = $R ]; then echo already-live; fi" | grep -q already-live \
  && { echo "$ID is already live; nothing to do"; exit 0; }
# Unchanged files are hard links to the live release, so the upload is small.
rsync -az --delete --link-dest="$APP/current/" \
  "$TMP/dist" "$TMP/src" "$TMP/scripts" "$TMP/deploy" "$TMP/package.json" "$TMP/package-lock.json" "$T:$R/"

ssh "$T" "APP=$APP R=$R ID=$ID KEEP=$KEEP sh -s" <<EOF
$REMOTE_LIB
cd "\$R"
npm ci --omit=dev --silent --no-audit --no-fund
if ! sudo cmp -s deploy/myfood.env /etc/myfood.env; then echo "/etc/myfood.env changes:"; sudo diff -u /etc/myfood.env deploy/myfood.env || true; fi
sudo install -m 755 scripts/run-agy.sh /usr/local/bin/run-agy
sudo install -m 755 scripts/backup-r2.mjs /usr/local/bin/myfood-backup-r2
sudo install -m 644 deploy/myfood.env /etc/myfood.env
sudo install -m 644 deploy/myfood.service deploy/myfood-backup.service deploy/myfood-backup.timer /etc/systemd/system/
sudo install -d -m 755 /etc/systemd/system/myfood-backup.service.d
sudo install -m 644 deploy/myfood-backup-r2.conf /etc/systemd/system/myfood-backup.service.d/r2.conf
sudo systemctl daemon-reload
sudo systemctl enable myfood.service myfood-backup.timer >/dev/null 2>&1

PREV=\$(readlink "\$APP/current" || true)
switch "\$R"
sudo systemctl restart myfood.service
if healthy "\$ID"; then
  [ -n "\$PREV" ] && ln -sfn "\$PREV" "\$APP/previous"
  echo "live: \$ID"
else
  echo "\$ID did not come up healthy:"; sudo journalctl -u myfood.service -n 20 --no-pager
  if [ -n "\$PREV" ]; then
    # shortcut: system files (units, /etc/myfood.env) stay from the new release; fine unless they changed incompatibly.
    switch "\$PREV"; sudo systemctl restart myfood.service
    echo "switched back to \$(basename "\$PREV")"
  fi
  exit 1
fi

# Keep the newest \$KEEP releases, and never the live or previous one.
cd "\$APP/releases"
for d in \$(ls -1t | tail -n +\$((KEEP + 1))); do
  case "\$APP/releases/\$d" in "\$(readlink "\$APP/current")"|"\$(readlink "\$APP/previous" || true)") ;; *) rm -rf "\$d" ;; esac
done
EOF
