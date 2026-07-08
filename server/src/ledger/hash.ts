// Journal hash chain (decision #10), hash_version 1: sha256 hex over a
// canonical JSON encoding with deterministic key order. Chained per group by
// the previous committed transaction's hash ('' for the first).
// This canonical encoding is domain logic, not a storage detail: every storage
// backend must produce identical hashes so a storage migration preserves the
// chain.

import { createHash } from 'node:crypto';
import type { Id, TxType } from '../storage/types.js';

export const HASH_VERSION = 1;

export interface HashInput {
  prev: string; // hash of the group's previous committed tx, or ''
  id: Id;
  groupId: Id;
  type: TxType;
  seq: number;
  committedAt: string;
  entries: { accountId: Id; amount: number }[];
}

export function txHash(input: HashInput): string {
  const canonical = JSON.stringify({
    v: HASH_VERSION,
    prev: input.prev,
    id: input.id,
    groupId: input.groupId,
    type: input.type,
    seq: input.seq,
    committedAt: input.committedAt,
    entries: [...input.entries]
      .sort((a, b) => (a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0))
      .map((e) => [e.accountId, e.amount]),
  });
  return createHash('sha256').update(canonical).digest('hex');
}
