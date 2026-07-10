# Plan: Merkle checkpoints, inclusion proofs & Witness plugins

Parked from [server/todo.md](../server/todo.md) Payments & ledger. Decision
#10 specifies this feature; this plan sequences it. Also: #1 (monthly
cadence), #2 (cross-group witnessing on a multi-tenant instance).

## Why

The hash chain makes history tamper-evident *if you can see the whole
journal* — only admins can. Checkpoints published to outside witnesses make
the operator themselves unable to rewrite history ("you don't have to trust
the host", #10 — the white-label differentiator), and inclusion proofs let a
member verify their own balance without seeing anyone else's. Federation
(#4) expects chained/witnessed ledgers too.

## Current state

- Per-group journal hash chain: `ledger/hash.ts` (hash_version 1, canonical
  JSON over ids/type/seq/committedAt/entries), computed inside the atomic
  commit that assigns `seq`.
- `verify()` runs on every scheduler tick for every group
  (`services/scheduler.ts`), recomputing balances + chain, alerting loudly.
- `checkpoint` and `witness_receipt` tables already sketched *(planned)* in
  data-model §3, with the interface additions (`checkpoint()`,
  `inclusionProof()`) sketched in data-model's storage interface.
- Digest emails (#17), brochure/news (#12/#13), and multi-tenant groups
  (#2) exist — the first witness channels are live infrastructure.

## Proposed design

- **checkpoint table** (per data-model §3): `id, group_id, period
  ("YYYY-MM", unique per group), journal_head_hash, merkle_root,
  prev_checkpoint_hash, created_at`. Built monthly by the scheduler
  (alongside the demurrage run, #1's cadence); a group's first checkpoint
  has prev ''.
- **Merkle tree**: leaves = canonical encoding of every account's
  `(account_id, balance, last_entry_seq)` sorted by account_id, plus one
  leaf for the journal head hash; sha256 pairwise, duplicate-last for odd
  levels. Same canonical-serialisation discipline as hash.ts — version it
  (`merkle_version`), spec once, test vectors in the repo. Tree is
  recomputable from the journal; only the root is stored.
- **verify() extension**: recompute each checkpoint's root from journal
  state as-of its period end and the checkpoint chain; mismatch alerts
  like any corruption (#6 posture: no silent option).
- **Witness plugin interface**: `interface Witness { kind: string;
  publish(checkpoint): Promise<ref> }`, receipts recorded in
  `witness_receipts (checkpoint_id, witness_kind, ref, published_at)`.
  Initial plugins, cheapest first:
  1. **digest_email** — root fingerprint in the digest footer ("ledger
     seal: ab12…ef") — every member inbox an independent witness; near-free
     on #17's pathway.
  2. **git** — append root to a file in a configured public repo (operator
     config; plain `git` CLI, no service dependency).
  3. **peer_group** — cross-group witnessing on the instance: group A
     stores B's root in its own witness table and vice versa (#10 called
     this free on multi-tenant).
  4. newsletter/flyer is a *manual* witness: admin page shows the root in a
     print-me form; receipt recorded by hand. Blockchain anchor stays a
     someday-plugin.
- **Member-facing inclusion proof**: `GET /me/proof?checkpointId=` → the
  Merkle path from their account leaf to the published root; app renders
  "your balance of X is sealed in checkpoint 2026-07, root ab12…, published
  in the July digest" with a verify button (client-side hash walk).
  Independent verification instructions in docs (the point is *not*
  trusting our UI).
- **Non-repudiation extension (Later, #10)**: passkey-signed payment
  authorisations — payer's WebAuthn assertion over the transaction
  canonical form stored alongside it, so even the operator can't forge
  member *consent*, not just history. Depends on plan-passkeys.md; the
  chain/checkpoint layer is where the signature gets sealed. Pointer only —
  design when passkeys are in.

## Implementation sketch (TDD slices)

1. Merkle module (`ledger/merkle.ts`): pure functions, test vectors,
   proof generation + verification.
2. Storage: checkpoint + witness_receipt tables; `checkpoint(groupId,
   period)` building root atomically from committed state; idempotent per
   period (demurrage_run pattern).
3. Scheduler: monthly checkpoint step; verify() extension covering roots
   and checkpoint chaining.
4. Witness framework + digest_email footer plugin (receipt = the dedup key
   of the digest batch).
5. git + peer_group plugins; operator/admin config surface.
6. Inclusion proof endpoint + member app verify screen.

## Open questions

- Checkpoint scope: per group (one tree over all its currencies' accounts)
  or per currency? (Per group leans simpler; balances are per-account
  anyway.)
- Digest footer wording/length — full 64-hex root or truncated fingerprint
  (truncation weakens the witness; full hex is ugly in email)?
- Is the manual newsletter witness worth a receipt-entry admin UI in v1?
- Do suspended groups (#20, scheduler skipped) still checkpoint? verify()
  already keeps running for them — leaning yes, checkpoints too.

## Dependencies / parked until

Builds only on shipped pieces (hash chain, scheduler, digests). Parked as
post-pilot hardening: valuable once real groups hold real balances, not
before. Passkey-signed authorisations additionally wait on
plan-passkeys.md.

Referenced from server/todo.md's parked list.
