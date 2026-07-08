#!/usr/bin/env bash
# End-to-end demo: boots a real Silvio server on a throwaway database and
# drives the full lifecycle through the CLI — operator bootstrap, group
# provisioning with an initial admin, applications, approvals, payments,
# invoices, credit limits. Every command is echoed. Nothing persists.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERVER="$ROOT/server/dist/src/index.js"
CLI="$ROOT/cli/dist/index.js"
PORT="${PORT:-1862}"
TMP="$(mktemp -d)"
DB="$TMP/demo.sqlite"

say()  { printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }
run() { # run <profile> <cli args...> — echoes, then runs with that profile's dotfile
  local profile="$1"; shift
  printf '\033[1;33m%s$\033[0m silvio %s\n' "$profile" "$*"
  SILVIO_CONFIG="$TMP/$profile.json" node "$CLI" "$@"
}

say "Building"
(cd "$ROOT/server" && npm run build >/dev/null)
(cd "$ROOT/cli" && npm run build >/dev/null)

say "Booting server on port $PORT (temp db, operator bootstrapped from env)"
SILVIO_DB="$DB" SILVIO_PORT="$PORT" \
  SILVIO_OPERATOR_EMAIL=op@demo.org SILVIO_OPERATOR_PASSWORD=operator-pass \
  node "$SERVER" &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null; rm -rf "$TMP"' EXIT
for _ in $(seq 1 50); do
  curl -sf -o /dev/null "http://127.0.0.1:$PORT/api/v1/openapi.json" && break
  sleep 0.2
done
URL="http://127.0.0.1:$PORT"

say "Operator provisions 'Demo LETS' with founding admin Grace"
run op op login -s "$URL" -e op@demo.org -p operator-pass
run op op groups create --slug demo --name "Demo LETS" \
  --currency-code DEM --currency-name Demos --scale 2 \
  --admin-name "Grace" --admin-person "Grace Founder" \
  --admin-email grace@demo.org --admin-password grace-password
run op op groups

say "Alice and Bob apply to join"
run alice apply -s "$URL" -g demo --name "Alice" --person "Alice Smith" \
  -e alice@demo.org -p alice-password
run bob apply -s "$URL" -g demo --name "Bob" --person "Bob Jones" \
  -e bob@demo.org -p bob-password

say "Grace reviews the queue and approves them"
run grace login -s "$URL" -g demo -e grace@demo.org -p grace-password
run grace admin members --status applied
QUEUE="$(SILVIO_CONFIG=$TMP/grace.json node "$CLI" admin members --status applied --json)"
ALICE_ID="$(echo "$QUEUE" | node -pe 'JSON.parse(require("fs").readFileSync(0)).find(m => m.displayName === "Alice").id')"
BOB_ID="$(echo "$QUEUE" | node -pe 'JSON.parse(require("fs").readFileSync(0)).find(m => m.displayName === "Bob").id')"
run grace admin approve "$ALICE_ID"
run grace admin approve "$BOB_ID"

say "Members log in and trade: Alice buys a veg box from Bob"
run alice login -s "$URL" -g demo -e alice@demo.org -p alice-password
run bob login -s "$URL" -g demo -e bob@demo.org -p bob-password
run alice members
run alice pay '#3' 500 -d "veg box"
run alice statement
run alice me

say "Bob invoices Alice for hedge trimming; Alice checks pending and accepts"
run bob invoice '#2' 300 -d "hedge trimming"
run alice pending
INVOICE_ID="$(SILVIO_CONFIG=$TMP/alice.json node "$CLI" pending --json | node -pe 'JSON.parse(require("fs").readFileSync(0))[0].id')"
run alice tx accept "$INVOICE_ID"
run alice me
run bob me

say "Grace sets a hard debit limit of -10.00; Alice hits it"
run grace admin policies add --currency DEM --type hard_limit --min -1000
printf '\033[1;33m%s$\033[0m silvio %s   \033[2m(expected to fail)\033[0m\n' \
  alice "pay '#3' 500 -d 'too much'"
SILVIO_CONFIG=$TMP/alice.json node "$CLI" pay '#3' 500 -d "too much" || true
run alice pay '#3' 100 -d "within the limit"
run alice me

say "Demo complete — server log above, database was $DB (deleted on exit)"
