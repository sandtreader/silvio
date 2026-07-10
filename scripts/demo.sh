#!/usr/bin/env bash
# End-to-end demo: boots a real Silvio server on a throwaway database and
# drives the full lifecycle — operator bootstrap, group provisioning with an
# initial admin, applications, approvals, payments, invoices, credit limits,
# then seeds a lived-in group: categories, market listings, a month of
# trading history, public balances, an about page and a news item. CLI where
# a command exists, curl for the rest. Every command is echoed. Nothing
# persists.
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
qapi() { # qapi <profile> <method> <path> [json-body] — silent group API call
  local profile="$1" method="$2" path="$3" data="${4:-}" cookie
  cookie="$(node -pe 'JSON.parse(require("fs").readFileSync(process.argv[1])).cookie' "$TMP/$profile.json")"
  if [ -n "$data" ]; then
    curl -sfS -X "$method" "$URL/api/v1/g/demo$path" \
      -H "cookie: silvio_session=$cookie" -H 'content-type: application/json' -d "$data"
  else
    curl -sfS -X "$method" "$URL/api/v1/g/demo$path" -H "cookie: silvio_session=$cookie"
  fi
}
api() { # as qapi, but echoed — for features the CLI has no command for
  printf '\033[1;33m%s$\033[0m curl -X %s /api/v1/g/demo%s %s\n' "$1" "$2" "$3" "${4:-}"
  qapi "$@"
  printf '\n'
}
pick() { # pick <js-expr> — pull a field out of JSON on stdin
  node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).$1"
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
run grace admin approve '#2'
run grace admin approve '#3'

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

say "Grace opens the group up: public balances, an about page, a news item"
api grace PATCH /admin/group '{"settings":{"transparency":"balances"}}'
api grace POST /admin/pages '{"slug":"about","title":"About Demo LETS","body":"We are a friendly local exchange trading system. One Demo is roughly a pound of ordinary effort — trade skills, produce and tool loans without sterling changing hands.","visibility":"public"}'
api grace POST /admin/news '{"title":"Trading fair — Saturday 25th","body":"Bring produce, tools and skills to the community hall from 10am. New members welcome; the membership desk can sign you up on the day."}'

say "Grace creates marketplace categories"
api grace POST /admin/categories '{"name":"Food & Garden"}'
api grace POST /admin/categories '{"name":"Home & DIY"}'
api grace POST /admin/categories '{"name":"Care & Wellbeing"}'
api grace POST /admin/categories '{"name":"Transport & Repairs"}'
api grace POST /admin/categories '{"name":"Skills & Learning"}'
cat_id() { # cat_id <name> — look a category id up by name
  qapi alice GET /categories \
    | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).categories.find((c) => c.name === process.argv[1]).id' "$1"
}
FOOD="$(cat_id 'Food & Garden')"; DIY="$(cat_id 'Home & DIY')"
CARE="$(cat_id 'Care & Wellbeing')"; TRANSPORT="$(cat_id 'Transport & Repairs')"
SKILLS="$(cat_id 'Skills & Learning')"
DEM="$(qapi alice GET /currencies | pick 'currencies[0].id')"

say "Members fill the market with offers and wants"
api bob POST /listings "{\"type\":\"offer\",\"title\":\"Weekly veg box\",\"description\":\"Seasonal organic veg from the allotment; collect Friday evenings.\",\"categoryId\":\"$FOOD\",\"priceAmount\":500,\"priceCurrencyId\":\"$DEM\"}"
api bob POST /listings "{\"type\":\"offer\",\"title\":\"Bike repair and servicing\",\"description\":\"Punctures, brakes, gears — most jobs turned round in a week.\",\"categoryId\":\"$TRANSPORT\",\"rateText\":\"5.00 DEM per job plus parts\"}"
api bob POST /listings "{\"type\":\"want\",\"title\":\"Lift to town on Thursdays\",\"description\":\"Market run, roughly 9am to noon; happy to share the errands.\",\"categoryId\":\"$TRANSPORT\"}"
api alice POST /listings "{\"type\":\"offer\",\"title\":\"Childcare after school\",\"description\":\"Experienced with ages 4 to 11, weekday afternoons.\",\"categoryId\":\"$CARE\",\"rateText\":\"4.00 DEM per hour\"}"
api alice POST /listings "{\"type\":\"offer\",\"title\":\"Jam and chutney\",\"description\":\"Plum jam and green tomato chutney from my own kitchen.\",\"categoryId\":\"$FOOD\",\"priceAmount\":200,\"priceCurrencyId\":\"$DEM\"}"
api alice POST /listings "{\"type\":\"want\",\"title\":\"Tool loan: hedge trimmer\",\"description\":\"A weekend loan now and then; returned charged and clean.\",\"categoryId\":\"$DIY\"}"
api grace POST /listings "{\"type\":\"offer\",\"title\":\"Conversational Spanish\",\"description\":\"One-to-one practice over coffee, all levels welcome.\",\"categoryId\":\"$SKILLS\",\"rateText\":\"4.50 DEM per hour\"}"
api grace POST /listings "{\"type\":\"offer\",\"title\":\"Sourdough starter and lesson\",\"description\":\"Take home a live starter and learn the weekly routine.\",\"categoryId\":\"$FOOD\",\"priceAmount\":250,\"priceCurrencyId\":\"$DEM\"}"

say "A busy month of trading"
run grace pay '#3' 750 -d "bike service and new brake pads"
run grace pay '#2' 400 -d "two jars of plum jam"
run bob pay '#2' 800 -d "saturday morning childcare"
run alice pay '#1' 250 -d "sourdough starter and lesson"
run bob pay '#1' 600 -d "spanish conversation, three sessions"
run alice pay '#3' 500 -d "veg box, week two"
run grace pay '#3' 500 -d "veg box"
run alice pay '#1' 450 -d "spanish lessons for the kids"
run bob invoice '#1' 350 -d "pressure washer loan, weekend"
run grace pending
LOAN_ID="$(SILVIO_CONFIG=$TMP/grace.json node "$CLI" pending --json | node -pe 'JSON.parse(require("fs").readFileSync(0))[0].id')"
run grace tx accept "$LOAN_ID"
run alice statement
run grace me
run bob me

say "Grace sets a hard debit limit of -10.00; Alice hits it"
run grace admin policies add --currency DEM --type hard_limit --min -1000
printf '\033[1;33m%s$\033[0m silvio %s   \033[2m(expected to fail)\033[0m\n' \
  alice "pay '#3' 500 -d 'too much'"
SILVIO_CONFIG=$TMP/alice.json node "$CLI" pay '#3' 500 -d "too much" || true
run alice pay '#3' 100 -d "within the limit"
run alice me

say "The lived-in group: market, published balances, dashboard flow"
printf '\033[1;33manon$\033[0m curl /api/v1/g/demo/listings\n'
curl -sfS "$URL/api/v1/g/demo/listings" \
  | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).listings.map((l) => `  ${l.type.padEnd(5)}  ${l.title}`).join("\n")'
printf '\033[1;33mgrace$\033[0m curl /api/v1/g/demo/balances\n'
qapi grace GET "/balances?currencyId=$DEM" \
  | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).balances.map((b) => `  ${b.displayName}: ${(b.balance / 100).toFixed(2)} (turnover ${(b.turnover / 100).toFixed(2)})`).join("\n")'
printf '\033[1;33mgrace$\033[0m curl /api/v1/g/demo/admin/stats\n'
qapi grace GET "/admin/stats?currencyId=$DEM" \
  | node -pe 'const s = JSON.parse(require("fs").readFileSync(0,"utf8")); `  velocity ${s.velocity}; ` + s.flow.map((f) => `${f.month}: ${(f.volume / 100).toFixed(2)} over ${f.trades} trades`).join(", ")'

say "Demo complete — server log above, database was $DB (deleted on exit)"
