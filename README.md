# Silvio

A modern platform for Local Exchange Trading Systems (LETS) — closed
community currencies with Gesellian **demurrage**: balances carry a
small negative interest, posted monthly to a community account, to
discourage hoarding and keep the currency moving.

*(Narrative introduction to follow.)*

## Layout

| Directory | What it is |
|-----------|------------|
| [`server/`](server/) | REST API server: members, currencies, double-entry ledger, marketplace, demurrage, MCP endpoint (TypeScript/Node, Fastify, SQLite) |
| [`cli/`](cli/) | Command-line client for the API |
| [`ui/member/`](ui/member/) | Member-facing mobile-first PWA (React/MUI) |
| [`ui/admin/`](ui/admin/) | Group-admin desktop UI (React/MUI/Rafiki) |
| [`ui/shared/`](ui/shared/) | Shared UI library: typed API client generated from the server's OpenAPI doc |
| [`specs/`](specs/) | Plan, design decisions, data model, prior-art review |
| [`scripts/`](scripts/) | Demo/lifecycle scripts |

Each package has its own README with dependencies and build
instructions; the server's [architecture.md](server/architecture.md)
describes the internal structure with diagrams.

## Design in one paragraph

API-first and multi-tenant: one instance hosts many groups, and a
single REST API serves the web UIs, the CLI, and an MCP server for AI
agents (scoped API tokens; agent-proposed payments are confirmed by
the member in the web app by default). The ledger is an append-only,
hash-chained double-entry journal with per-currency zero-sum legs;
balances are derived, never stored authority. Design decisions are
recorded sequentially in [specs/decisions.md](specs/decisions.md).

## Quick start

```sh
cd server && npm install && npm run build && npm start
```

Then see [server/README.md](server/README.md) for configuration and
[scripts/demo.sh](scripts/demo.sh) for a full end-to-end demo.

## License

[AGPL-3.0-or-later](LICENSE.md). The Affero clause matters here: Silvio is
designed to be hosted (white-label SaaS is a target deployment), and AGPL
ensures that anyone offering a modified Silvio as a network service must
offer its users the modified source.
