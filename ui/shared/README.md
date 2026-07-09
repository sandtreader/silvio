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
- `src/types.ts` — hand-written response types matching the server's actual
  responses. The server's route schemas declare request bodies but almost no
  response schemas, so response shapes live here for now.
- `src/api-types.d.ts` — request/path types generated from `openapi.json`
  by `openapi-typescript`.

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
cd ../ui/shared && npm run generate  # openapi-typescript -> src/api-types.d.ts
npm run build
```

## Other scripts

```sh
npm run check   # typecheck only
npm test        # vitest run
```

## License

AGPL-3.0-or-later — see [LICENSE.md](../../LICENSE.md) at the repository root.
