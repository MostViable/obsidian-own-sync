#!/usr/bin/env bash
set -euo pipefail

binary=${1:?usage: server-smoke.sh <own-sync-server>}
workdir=$(mktemp -d)
server_pid=''
restore_pid=''
cleanup() {
  if [[ -n "$server_pid" ]]; then kill "$server_pid" 2>/dev/null || true; wait "$server_pid" 2>/dev/null || true; fi
  if [[ -n "$restore_pid" ]]; then kill "$restore_pid" 2>/dev/null || true; wait "$restore_pid" 2>/dev/null || true; fi
  rm -rf "$workdir"
}
trap cleanup EXIT

mkdir -m 700 "$workdir/data" "$workdir/credentials" "$workdir/backups"
db="$workdir/data/sync.sqlite"
owner="$workdir/credentials/owner.json"
device="$workdir/credentials/device.json"
backup="$workdir/backups/sync.sqlite"

"$binary" bootstrap "$db" "$owner"
"$binary" provision "$db" "$owner" "$device"
vault_id=$(jq -er '.vault_id' "$owner")
token=$(jq -er '.token' "$owner")
device_token=$(jq -er '.token' "$device")
[[ "$token" != "$device_token" ]]

OWN_SYNC_EXPERIMENTAL_API=1 OWN_SYNC_DB="$db" OWN_SYNC_BIND=127.0.0.1:18787 \
  "$binary" >"$workdir/server.log" 2>&1 &
server_pid=$!
for _ in $(seq 1 50); do
  if curl --silent --show-error --fail http://127.0.0.1:18787/healthz >/dev/null; then break; fi
  sleep 0.1
done
curl --silent --show-error --fail http://127.0.0.1:18787/healthz | grep -F '"status":"ok"'
curl --silent --show-error --fail http://127.0.0.1:18787/api/v0/capabilities | \
  jq -e '.protocol_version == 0 and .packet_format_version == 1 and .max_packet_bytes == 1048576' >/dev/null

auth="Authorization: Bearer $token"
head_url="http://127.0.0.1:18787/api/v0/vaults/$vault_id/head"
commit_url="http://127.0.0.1:18787/api/v0/vaults/$vault_id/operations/00000000000000000000000000000001"
curl --silent --show-error --fail -H "$auth" "$head_url" | jq -e '.current_revision == 0' >/dev/null
curl --silent --show-error --fail -X POST -H "$auth" -H 'X-Expected-Revision: 0' \
  --data-binary 'smoke-packet' "$commit_url" | jq -e '.result == "applied" and .revision == 1' >/dev/null
curl --silent --show-error --fail -X POST -H "$auth" -H 'X-Expected-Revision: 0' \
  --data-binary 'smoke-packet' "$commit_url" | jq -e '.result == "replayed" and .revision == 1' >/dev/null

"$binary" backup "$db" "$backup"
kill "$server_pid"
wait "$server_pid" 2>/dev/null || true
server_pid=''
cp "$backup" "$workdir/restored.sqlite"

OWN_SYNC_EXPERIMENTAL_API=1 OWN_SYNC_DB="$workdir/restored.sqlite" OWN_SYNC_BIND=127.0.0.1:18788 \
  "$binary" >"$workdir/restored.log" 2>&1 &
restore_pid=$!
for _ in $(seq 1 50); do
  if curl --silent --show-error --fail http://127.0.0.1:18788/healthz >/dev/null; then break; fi
  sleep 0.1
done
curl --silent --show-error --fail -H "$auth" \
  "http://127.0.0.1:18788/api/v0/vaults/$vault_id/head" | jq -e '.current_revision == 1' >/dev/null
echo 'server smoke passed'
