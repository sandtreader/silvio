# @silvio/ui-shared

Shared TypeScript library for the Silvio LETS UIs (`ui/member` and
`ui/admin`). Deliberately free of React and MUI so both apps can consume it.

## Contents

- `src/client.ts` — `ApiClient`, a typed HTTP client over global `fetch` for
  the Silvio REST API. Same-origin cookie sessions (`credentials: 'include'`);
  supports hostname-based tenancy by default with the `/api/v1/g/{slug}` path
  prefix as a fallback (`group` option). Covers auth/profile, directory,
  payments/invoices, transaction actions, marketplace listings, categories,
  applications, the admin endpoints (members, policies, demurrage bands,
  restrictions, flags, reversals, categories) and platform operator endpoints.
  Every failure — HTTP error, network failure, malformed body — surfaces as
  `ApiError` (`code`, `message`, `status`).
- `src/money.ts` — `formatAmount` and `parseAmount`. Amounts are integer
  minor units; conversion to/from decimal text is pure string arithmetic,
  never float multiplication.
- `src/types.ts` — response types derived from the generated OpenAPI types:
  re-exports of `components['schemas']` (with a few renames the UIs use, e.g.
  `DirectoryMember` for the wire schema `PublicMember`) and unions projected
  from them (e.g. `TxState = Transaction['state']`). The server publishes
  full response schemas, so nothing here is hand-written.
- `src/api-types.ts` — request/path/response types generated from
  `openapi.json` by `openapi-typescript`.

## Build

```sh
npm install
npm run build     # tsc -> dist/ (consumed by member and admin via file:../shared)
```

Both apps depend on this package as `file:../shared`, so it must be built
before installing or building them.

## Regenerating the API types

The server emits `openapi.json` into this directory:

```sh
cd ../../server && npm run openapi   # writes ui/shared/openapi.json
cd ../ui/shared && npm run generate  # openapi-typescript -> src/api-types.ts
npm run build
```

## Other scripts

```sh
npm run check   # typecheck only
npm test        # vitest run
```

## License

AGPL-3.0-or-later — see [LICENSE.md](../../LICENSE.md) at the repository root.
