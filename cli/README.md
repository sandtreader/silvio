# Silvio CLI

Command-line client for [Silvio](../server), a LETS (Local Exchange Trading
System) platform. It talks to the server's REST API — group (tenant) routes via
`/api/v1/g/:slug`, platform-operator routes via `/api/v1/operator` — and covers
the member workflow (apply, log in, pay, invoice, accept/decline, statement),
group administration (approve members, roles, credit policies) and platform
operation (provision groups).

## Dependencies

- Node.js 22+ (uses global `fetch`; no HTTP library needed)
- [commander](https://www.npmjs.com/package/commander) — the only runtime dependency
- Dev: `typescript`, `vitest` (tests spin up the real server from `../server`, so its dependencies must be installed too)

## Build

```sh
npm install
npm run build     # tsc -> dist/
npm test          # vitest, drives the real server over HTTP
```

Run it either directly:

```sh
node dist/index.js --help
```

or install the `silvio` bin on your PATH:

```sh
npm link
silvio --help
```

## Configuration

State lives in a single JSON dotfile, `~/.silvio.json` by default; set
`SILVIO_CONFIG` to use another path. The CLI manages it for you:

- `silvio login` / `silvio op login` write `{server, group, email, cookie}`
  (group is omitted for operator sessions). The `cookie` is the live
  `silvio_session` value; the password is never stored. The file is written
  with mode `0600`.
- On later logins, `--server`, `--group` and `--email` default to the
  remembered values, so `silvio login -p <password>` is enough after the
  first time.
- `silvio logout` ends the session server-side and removes the cookie,
  keeping server/group/email for next time.

## Usage

Member commands (require `silvio login`):

| Command | Description |
| --- | --- |
| `silvio login -s <url> -g <slug> -e <email> -p <password>` | log in to a group as a member |
| `silvio logout` | end the session and clear the stored cookie |
| `silvio apply -s <url> -g <slug> --name <n> --person <n> -e <email> -p <pw>` | apply to join a group (no login required) |
| `silvio me` | show your profile and balances |
| `silvio members` | list the member directory |
| `silvio pay <member> <amount>` | pay another member |
| `silvio invoice <member> <amount>` | request payment from another member |
| `silvio pending` | list transactions awaiting action |
| `silvio tx accept\|decline\|cancel <id>` | act on a pending transaction |
| `silvio statement` | show your account statement |

Admin commands (require the admin role):

| Command | Description |
| --- | --- |
| `silvio admin members [--status <s>]` | list members, optionally by status (`applied\|active\|away\|suspended\|closed`) |
| `silvio admin role <member> <role>` | set a member's role (`member\|committee\|admin`) |
| `silvio admin approve\|suspend\|reinstate\|remove <member>` | change a member's status |
| `silvio admin policies` | list credit policies |
| `silvio admin policies add --currency <code> --type <t> [--min <n>] [--max <n>]` | add a credit policy (`soft_threshold\|hard_limit`) |

Platform operator commands:

| Command | Description |
| --- | --- |
| `silvio op login -s <url> -e <email> -p <password>` | log in as a platform operator |
| `silvio op groups` | list groups on the platform |
| `silvio op groups create --slug <s> --name <n> --currency-code <c> --currency-name <n> ...` | provision a new group with its currency |

Notes:

- Wherever a command takes `<member>`, pass a raw member id or `#<memberNo>`
  (e.g. `#12`), which is resolved via the directory.
- Amounts are integers in the currency's minor units.
- `-c, --currency <code>` selects the currency on `pay`, `invoice` and
  `statement`; it can be omitted when you hold only one account.
- Listing commands accept `--json` for raw JSON output.

### Examples

```sh
# first login remembers server/group/email; later just: silvio login -p ...
silvio login -s https://lets.example.org -g cam -e alice@example.com -p secret

# pay member #12 five units (500 minor units at scale 2) for veg
silvio pay '#12' 500 -d 'veg box'

# invoice member #7, then they accept it
silvio invoice '#7' 1200 -d 'bike repair'
silvio pending                # (as #7) shows the invoice id and actions
silvio tx accept <id>

# operator provisions a group
silvio op login -s https://lets.example.org -e op@example.com -p secret
silvio op groups create --slug cam --name CamLETS \
  --currency-code CAM --currency-name Cams --scale 2
```

## License

GPL-3.0
