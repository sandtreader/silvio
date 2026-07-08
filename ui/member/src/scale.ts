// Currency display scale. GET /me account summaries include currencyCode but
// not the currency's scale, so the UI assumes 2 decimal places everywhere.
// TODO: use the real per-currency scale once the server exposes it in /me
// (server todo: "expose currency scale in /me").
export const DEFAULT_SCALE = 2;
