# Silvio server

The server for Silvio, a LETS (Local Exchange Trading System) platform with
Gesellian demurrage: multi-tenant community currencies backed by an
append-only, hash-chained double-entry ledger. It serves a versioned REST API
(`/api/v1`), the built member and admin web UIs when present, and an MCP
endpoint for AI agents.

## Dependencies

Runtime: Node 22 or newer (ESM, `NodeNext` modules, ES2022 target).

| Package | Role |
| --- | --- |
| `fastify` 5 (+ `@fastify/cookie`, `@fastify/static`, `@fastify/swagger`) | HTTP server, cookie sessions, UI serving, OpenAPI |
| `better-sqlite3` | SQLite storage backend (WAL mode) |
| `argon2` | Password hashing (argon2id) |
| `uuid` | UUIDv7 identifiers |
| `zod` | MCP tool input schemas |
| `@modelcontextprotocol/sdk` | MCP server over streamable HTTP |

Dev: TypeScript 5, Vitest.

## Build and run

```sh
npm install
npm run build        # tsc -> dist/
npm start            # node dist/src/index.js
npm test             # vitest run
npm run openapi      # dump the OpenAPI document (requires a prior build)
```

`npm run openapi` writes the generated OpenAPI document to
`../ui/shared/openapi.json` (a committed artifact, so UI builds never need a
running server). The live document is also served at `/api/v1/openapi.json`.

### Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `SILVIO_DB` | `silvio.sqlite` | SQLite database path |
| `SILVIO_PORT` | `1862` | Listen port (Silvio Gesell's year of birth) |
| `SILVIO_HOST` | `0.0.0.0` | Listen address |
| `SILVIO_OPERATOR_EMAIL` / `SILVIO_OPERATOR_PASSWORD` | — | First-boot operator bootstrap; on a TTY you are prompted instead |
| `SILVIO_MEMBER_UI` / `SILVIO_ADMIN_UI` | sibling `ui/*/dist` | Built UI directories served at `/app/` (the app renders its own chrome from `GET /shell`, #15) and `/admin/`; the group root `/` is the server-rendered brochure |
| `SILVIO_OPERATOR_UI` | sibling `ui/operator/dist` | Built operator console served at `/operator/` (#21) |
| `SILVIO_SMTP_URL` / `SILVIO_EMAIL_FROM` | — | Outbound email: nodemailer connection URL (e.g. `smtp://user:pass@mail.example.com:587`; query params pass transport options, e.g. `?tls.rejectUnauthorized=false` for a self-signed relay) and the From address. Unset, emails queue in `email_events` but are not sent |

On first boot with no operator account, the server bootstraps one from the
env vars, prompts interactively on a TTY, or warns loudly and continues.

## Structure

The code is layered: a thin entrypoint (`src/index.ts`) wires the REST API
(`src/api`) over domain services (`src/services`) and ledger logic
(`src/ledger`), all persisted behind a storage interface (`src/storage`).
The MCP endpoint at `{tenancy}/mcp` (e.g. `/api/v1/g/{slug}/mcp`), for
bearer-token agents, is a thin client of the same REST API. See
[architecture.md](architecture.md) for the full picture, and
`../specs/data-model.md` for the schema.

## License

AGPL-3.0-or-later — see [LICENSE.md](../LICENSE.md) at the repository root.
