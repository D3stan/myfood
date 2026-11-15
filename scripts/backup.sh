#!/bin/sh
# Nightly copy of the database, 14 kept. Same disk as the data: it guards against a bad change, not a dead disk.
set -eu
D=/var/lib/myfood
mkdir -p "$D/backups"
sqlite3 "$D/myfood.db" ".backup '$D/backups/myfood-$(date +%F).db'"
ls -1t "$D"/backups/myfood-*.db | tail -n +15 | xargs -r rm --
