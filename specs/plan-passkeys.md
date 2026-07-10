# Plan: Passkeys (WebAuthn) + 2FA

Parked from [server/todo.md](../server/todo.md) Membership & identity. Decisions
referenced: #2 (global user identity), #7 (minimal-VPS posture), #10 (future
passkey-signed payment authorisations).

## Why

Passwords guarding money accounts deserve better than passwords alone. The plan
always listed 2FA/passkeys (first-review §4.4 Security), and #10 explicitly
leaves the door open for passkey-signed payment authorisations — that future
needs credentials registered now. Phishing-resistant, nothing to remember,
works on the phones the member PWA targets.

## Current state

- `users.password_hash` — argon2id via `server/src/services/auth.ts`; login is
  email + password, global identity (#2).
- `sessions` table: opaque tokens sha256-hashed at rest, revocable.
- `one_time_tokens` (purpose: password_reset | email_verify | invite) — the
  single-use-token pattern to reuse for anything ceremony-shaped.
- Login throttling: sliding window in `services/ratelimit.ts` (10/email,
  30/IP per 15 min).
- Data-model §1 already plans the `passkey` table and `users.totp_secret`.

## Proposed design

- **New table `passkeys`** (per data-model §1): `id, user_id, credential_id
  (unique), public_key, sign_count, transports?, label, created_at,
  last_used_at`. A user may have several (phone + laptop).
- **Library: @simplewebauthn/server.** Pure TypeScript, no native deps, fits
  the minimal-VPS posture (#7); it pulls a small cbor/asn1 dependency tree —
  audit it once at adoption, pin versions. RP ID is the group hostname —
  **but users are global (#2) while hostnames are per-group**: a credential
  registered on group A's domain is invisible on group B's. Options: (a)
  accept per-hostname credentials (a passkey row gains `rp_id`), (b) register
  on a canonical instance domain only. Leaning (a) — honest about how
  WebAuthn scopes credentials; multi-group users are rare enough.
- **Ceremonies**: `POST /auth/passkeys/register-options` + `/register`
  (logged-in only), `POST /auth/passkeys/login-options` + `/login`
  (discoverable-credential flow, no email typed). Challenges are single-use
  server state — reuse `one_time_tokens` with a new `webauthn_challenge`
  purpose (short expiry) rather than adding in-memory state.
- **Passwords remain mandatory in v1.** Passkey is an additional login
  method, not a replacement; `password_hash` stays non-null. Passkey-only
  accounts (nullable hash, per data-model) are a later step once recovery is
  proven — recovery for a passkey-only user is email reset re-purposed to
  "add a new passkey", which is only as strong as email anyway.
- **Recovery interplay**: password reset (existing flow) does NOT delete
  passkeys; users manage/revoke passkeys from their profile (list with
  label + last-used, delete). Deleting the last passkey is fine while
  passwords are mandatory.
- **2FA/TOTP: don't build it.** Passkeys give stronger MFA with less
  machinery than TOTP (`totp_secret` stays a planned column, unused). If a
  group demands step-up on password logins later, TOTP slots in then.
  Decide: is that acceptable, or do committee/admin roles warrant forced
  second factor from day one?

## Implementation sketch (TDD slices)

1. Storage: `passkeys` table + CRUD on the Storage interface; migration.
2. Registration ceremony: options + verify routes, challenge via
   one_time_tokens; tests with @simplewebauthn's test vectors / mock
   authenticator.
3. Login ceremony: options + verify, sign_count update, session issue —
   same session machinery as password login; throttle by IP.
4. Profile UI (member app More → Security): list/add/label/delete passkeys.
5. Login UI: "Sign in with passkey" button beside the password form.
6. Later phase: passkey-only accounts (nullable password_hash); later still,
   passkey-signed payment authorisations (see plan-checkpoints.md §non-repudiation).

## Open questions

- Per-hostname credentials (rp_id column) vs canonical-domain registration?
- Force any second factor for admin-role logins, or ship passkeys-optional?
- Conditional UI (autofill-style passkey prompt) in v1 or plain button?
- Does the operator console (`/operator/`, separate principal) get passkeys
  in the same slice or later?

## Dependencies / parked until

No hard dependencies — could ship any time. Parked because a pilot group's
device mix should inform the recovery story before we harden it.
Passkey-signed payment authorisations (#10) additionally wait on Merkle
checkpoints (plan-checkpoints.md).

Referenced from server/todo.md's parked list.
