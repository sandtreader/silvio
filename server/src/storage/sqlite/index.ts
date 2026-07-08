// SQLite storage implementation of the Storage contract
// (specs/data-model.md §3, decisions #2, #5, #6, #10).
// better-sqlite3 is synchronous; results are wrapped in resolved Promises.

import Database from 'better-sqlite3';
import { v7 as uuidv7 } from 'uuid';
import type {
  Actor,
  CreateAccountInput,
  CreateCurrencyInput,
  CreateGroupInput,
  Storage,
} from '../interface.js';
import type {
  Account,
  Channel,
  Currency,
  Entry,
  Group,
  Id,
  NewTransaction,
  StatementLine,
  Transaction,
  TxFlow,
  TxState,
  TxType,
  VerifyReport,
} from '../types.js';
import { StorageError } from '../types.js';
import { HASH_VERSION, txHash } from './hash.js';
import { SCHEMA } from './schema.js';

interface AccountRow {
  id: string;
  group_id: string;
  currency_id: string;
  type: string;
  member_id: string | null;
  counterparty_ref: string | null;
  created_at: string;
  closed_at: string | null;
}

interface TransactionRow {
  id: string;
  group_id: string;
  type: string;
  flow: string | null;
  state: string;
  seq: number | null;
  hash: string | null;
  hash_version: number | null;
  description: string | null;
  reference: string | null;
  created_by: string;
  channel: string;
  reverses_id: string | null;
  demurrage_run_id: string | null;
  remote_ref: string | null;
  api_token_id: string | null;
  idempotency_key: string | null;
  created_at: string;
  committed_at: string | null;
  expires_at: string | null;
}

interface EntryRow {
  id: string;
  transaction_id: string;
  account_id: string;
  amount: number;
}

function now(): string {
  return new Date().toISOString();
}

export class SqliteStorage implements Storage {
  private readonly db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    if (path !== ':memory:') {
      this.db.pragma('journal_mode = WAL');
    }
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA);
  }

  createGroup(input: CreateGroupInput): Promise<Group> {
    const group: Group = {
      id: uuidv7(),
      slug: input.slug,
      name: input.name,
      createdAt: now(),
    };
    this.db
      .prepare('INSERT INTO groups (id, slug, name, created_at) VALUES (?, ?, ?, ?)')
      .run(group.id, group.slug, group.name, group.createdAt);
    return Promise.resolve(group);
  }

  createCurrency(input: CreateCurrencyInput): Promise<Currency> {
    const currency: Currency = {
      id: uuidv7(),
      groupId: input.groupId,
      code: input.code,
      name: input.name,
      scale: input.scale ?? 0,
      createdAt: now(),
    };
    this.db
      .prepare(
        'INSERT INTO currencies (id, group_id, code, name, scale, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        currency.id,
        currency.groupId,
        currency.code,
        currency.name,
        currency.scale,
        currency.createdAt,
      );
    return Promise.resolve(currency);
  }

  createAccount(input: CreateAccountInput): Promise<Account> {
    const id = uuidv7();
    const createdAt = now();
    this.db
      .prepare(
        `INSERT INTO accounts (id, group_id, currency_id, type, member_id, counterparty_ref, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.groupId,
        input.currencyId,
        input.type,
        input.memberId ?? null,
        input.counterpartyRef ?? null,
        createdAt,
      );
    const account: Account = {
      id,
      groupId: input.groupId,
      currencyId: input.currencyId,
      type: input.type,
      createdAt,
    };
    if (input.memberId !== undefined) account.memberId = input.memberId;
    if (input.counterpartyRef !== undefined) account.counterpartyRef = input.counterpartyRef;
    return Promise.resolve(account);
  }

  post(tx: NewTransaction, idempotencyKey?: string): Promise<Transaction> {
    try {
      const result = this.db.transaction((): Transaction => {
        if (idempotencyKey !== undefined) {
          const existing = this.db
            .prepare('SELECT id FROM transactions WHERE group_id = ? AND idempotency_key = ?')
            .get(tx.groupId, idempotencyKey) as { id: string } | undefined;
          if (existing) return this.loadTransaction(existing.id);
        }

        this.validateEntries(tx);

        const id = uuidv7();
        const createdAt = now();
        const commit = tx.state === 'committed' ? this.nextCommit(tx.groupId) : undefined;
        const hash =
          commit === undefined
            ? null
            : txHash({
                prev: commit.prev,
                id,
                groupId: tx.groupId,
                type: tx.type,
                seq: commit.seq,
                committedAt: commit.committedAt,
                entries: tx.entries,
              });

        this.db
          .prepare(
            `INSERT INTO transactions (
               id, group_id, type, flow, state, seq, hash, hash_version,
               description, reference, created_by, channel, reverses_id,
               demurrage_run_id, remote_ref, api_token_id, idempotency_key,
               created_at, committed_at, expires_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            tx.groupId,
            tx.type,
            tx.flow ?? null,
            tx.state,
            commit?.seq ?? null,
            hash,
            commit === undefined ? null : HASH_VERSION,
            tx.description ?? null,
            tx.reference ?? null,
            tx.createdBy,
            tx.channel,
            tx.reversesId ?? null,
            tx.demurrageRunId ?? null,
            tx.remoteRef ?? null,
            tx.apiTokenId ?? null,
            idempotencyKey ?? null,
            createdAt,
            commit?.committedAt ?? null,
            tx.expiresAt ?? null,
          );
        this.insertEntries(id, tx.entries);
        return this.loadTransaction(id);
      })();
      return Promise.resolve(result);
    } catch (err) {
      return Promise.reject(err);
    }
  }

  transition(txId: Id, to: TxState, _actor: Actor): Promise<Transaction> {
    try {
      const result = this.db.transaction((): Transaction => {
        const row = this.db
          .prepare('SELECT * FROM transactions WHERE id = ?')
          .get(txId) as TransactionRow | undefined;
        if (!row) throw new StorageError('NOT_FOUND', `transaction ${txId} not found`);
        if (row.state !== 'pending' || to === 'pending') {
          throw new StorageError('INVALID_TRANSITION', `cannot transition ${row.state} -> ${to}`);
        }
        if (to === 'committed') {
          const commit = this.nextCommit(row.group_id);
          const entries = this.loadEntries(txId);
          const hash = txHash({
            prev: commit.prev,
            id: row.id,
            groupId: row.group_id,
            type: row.type as TxType,
            seq: commit.seq,
            committedAt: commit.committedAt,
            entries,
          });
          this.db
            .prepare(
              `UPDATE transactions
               SET state = 'committed', seq = ?, hash = ?, hash_version = ?, committed_at = ?
               WHERE id = ?`,
            )
            .run(commit.seq, hash, HASH_VERSION, commit.committedAt, txId);
        } else {
          this.db.prepare('UPDATE transactions SET state = ? WHERE id = ?').run(to, txId);
        }
        return this.loadTransaction(txId);
      })();
      return Promise.resolve(result);
    } catch (err) {
      return Promise.reject(err);
    }
  }

  getTransaction(txId: Id): Promise<Transaction> {
    try {
      return Promise.resolve(this.loadTransaction(txId));
    } catch (err) {
      return Promise.reject(err);
    }
  }

  balance(accountId: Id): Promise<number> {
    const account = this.db
      .prepare('SELECT id FROM accounts WHERE id = ?')
      .get(accountId) as { id: string } | undefined;
    if (!account) {
      return Promise.reject(new StorageError('NOT_FOUND', `account ${accountId} not found`));
    }
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(e.amount), 0) AS balance
         FROM entries e
         JOIN transactions t ON t.id = e.transaction_id
         WHERE e.account_id = ? AND t.state = 'committed'`,
      )
      .get(accountId) as { balance: number };
    return Promise.resolve(row.balance);
  }

  statement(accountId: Id): Promise<StatementLine[]> {
    const account = this.db
      .prepare('SELECT id FROM accounts WHERE id = ?')
      .get(accountId) as { id: string } | undefined;
    if (!account) {
      return Promise.reject(new StorageError('NOT_FOUND', `account ${accountId} not found`));
    }
    const rows = this.db
      .prepare(
        `SELECT t.seq AS seq, t.id AS transaction_id, t.type AS type,
                t.description AS description, t.reference AS reference,
                t.committed_at AS committed_at, SUM(e.amount) AS amount
         FROM entries e
         JOIN transactions t ON t.id = e.transaction_id
         WHERE e.account_id = ? AND t.state = 'committed'
         GROUP BY t.id
         ORDER BY t.seq`,
      )
      .all(accountId) as {
      seq: number;
      transaction_id: string;
      type: string;
      description: string | null;
      reference: string | null;
      committed_at: string;
      amount: number;
    }[];
    let running = 0;
    const lines = rows.map((row): StatementLine => {
      running += row.amount;
      const line: StatementLine = {
        seq: row.seq,
        transactionId: row.transaction_id,
        type: row.type as TxType,
        amount: row.amount,
        runningBalance: running,
        committedAt: row.committed_at,
      };
      if (row.description !== null) line.description = row.description;
      if (row.reference !== null) line.reference = row.reference;
      return line;
    });
    return Promise.resolve(lines);
  }

  verify(groupId: Id): Promise<VerifyReport> {
    const errors: string[] = [];

    // (a) committed entries sum to zero per currency across the group (#6).
    const sums = this.db
      .prepare(
        `SELECT a.currency_id AS currency_id, SUM(e.amount) AS total
         FROM entries e
         JOIN accounts a ON a.id = e.account_id
         JOIN transactions t ON t.id = e.transaction_id
         WHERE t.group_id = ? AND t.state = 'committed'
         GROUP BY a.currency_id`,
      )
      .all(groupId) as { currency_id: string; total: number }[];
    for (const sum of sums) {
      if (sum.total !== 0) {
        errors.push(`currency ${sum.currency_id}: committed entries sum to ${sum.total}, not 0`);
      }
    }

    // (b) + (c) hash chain and seq contiguity (#10).
    const committed = this.db
      .prepare(
        `SELECT * FROM transactions
         WHERE group_id = ? AND state = 'committed'
         ORDER BY seq`,
      )
      .all(groupId) as TransactionRow[];
    let prev = '';
    committed.forEach((row, i) => {
      const expectedSeq = i + 1;
      if (row.seq !== expectedSeq) {
        errors.push(`transaction ${row.id}: seq ${row.seq} but chain position ${expectedSeq}`);
      }
      if (row.seq === null || row.committed_at === null) {
        errors.push(`transaction ${row.id}: committed without seq/committed_at`);
        return;
      }
      const expectedHash = txHash({
        prev,
        id: row.id,
        groupId: row.group_id,
        type: row.type as TxType,
        seq: row.seq,
        committedAt: row.committed_at,
        entries: this.loadEntries(row.id),
      });
      if (row.hash !== expectedHash) {
        errors.push(
          `transaction ${row.id} (seq ${row.seq}): stored hash ${row.hash} != recomputed ${expectedHash}`,
        );
      }
      prev = row.hash ?? expectedHash;
    });

    return Promise.resolve({ ok: errors.length === 0, errors });
  }

  close(): void {
    this.db.close();
  }

  // --- private ---------------------------------------------------------------

  /** #6 invariants: >= 2 legs, non-zero safe integers, accounts exist in
   *  tx.groupId, legs grouped by their account's currency each sum to zero. */
  private validateEntries(tx: NewTransaction): void {
    if (tx.entries.length < 2) {
      throw new StorageError('INVALID_TRANSACTION', 'a transaction needs at least two legs');
    }
    for (const entry of tx.entries) {
      if (!Number.isSafeInteger(entry.amount) || entry.amount === 0) {
        throw new StorageError(
          'INVALID_TRANSACTION',
          `leg amount must be a non-zero integer, got ${entry.amount}`,
        );
      }
    }
    const sumsByCurrency = new Map<string, number>();
    for (const entry of tx.entries) {
      const account = this.db
        .prepare('SELECT * FROM accounts WHERE id = ?')
        .get(entry.accountId) as AccountRow | undefined;
      if (!account) {
        throw new StorageError('NOT_FOUND', `account ${entry.accountId} not found`);
      }
      if (account.group_id !== tx.groupId) {
        throw new StorageError(
          'CROSS_GROUP',
          `account ${entry.accountId} belongs to another group`,
        );
      }
      sumsByCurrency.set(
        account.currency_id,
        (sumsByCurrency.get(account.currency_id) ?? 0) + entry.amount,
      );
    }
    for (const [currencyId, sum] of sumsByCurrency) {
      if (sum !== 0) {
        throw new StorageError('UNBALANCED', `currency ${currencyId} legs sum to ${sum}, not 0`);
      }
    }
  }

  /** Next per-group chain position and the prev hash to link from (#10).
   *  Must be called inside a db.transaction so seq assignment is atomic. */
  private nextCommit(groupId: Id): { seq: number; prev: string; committedAt: string } {
    const head = this.db
      .prepare(
        `SELECT seq, hash FROM transactions
         WHERE group_id = ? AND state = 'committed'
         ORDER BY seq DESC LIMIT 1`,
      )
      .get(groupId) as { seq: number; hash: string } | undefined;
    return {
      seq: (head?.seq ?? 0) + 1,
      prev: head?.hash ?? '',
      committedAt: now(),
    };
  }

  private insertEntries(transactionId: Id, entries: { accountId: Id; amount: number }[]): void {
    const insert = this.db.prepare(
      'INSERT INTO entries (id, transaction_id, account_id, amount) VALUES (?, ?, ?, ?)',
    );
    for (const entry of entries) {
      insert.run(uuidv7(), transactionId, entry.accountId, entry.amount);
    }
  }

  private loadEntries(transactionId: Id): Entry[] {
    const rows = this.db
      .prepare('SELECT * FROM entries WHERE transaction_id = ? ORDER BY id')
      .all(transactionId) as EntryRow[];
    return rows.map((row) => ({
      id: row.id,
      transactionId: row.transaction_id,
      accountId: row.account_id,
      amount: row.amount,
    }));
  }

  private loadTransaction(txId: Id): Transaction {
    const row = this.db
      .prepare('SELECT * FROM transactions WHERE id = ?')
      .get(txId) as TransactionRow | undefined;
    if (!row) throw new StorageError('NOT_FOUND', `transaction ${txId} not found`);
    const tx: Transaction = {
      id: row.id,
      groupId: row.group_id,
      type: row.type as TxType,
      state: row.state as TxState,
      createdBy: row.created_by,
      channel: row.channel as Channel,
      createdAt: row.created_at,
      entries: this.loadEntries(txId),
    };
    if (row.flow !== null) tx.flow = row.flow as TxFlow;
    if (row.seq !== null) tx.seq = row.seq;
    if (row.hash !== null) tx.hash = row.hash;
    if (row.hash_version !== null) tx.hashVersion = row.hash_version;
    if (row.description !== null) tx.description = row.description;
    if (row.reference !== null) tx.reference = row.reference;
    if (row.reverses_id !== null) tx.reversesId = row.reverses_id;
    if (row.demurrage_run_id !== null) tx.demurrageRunId = row.demurrage_run_id;
    if (row.remote_ref !== null) tx.remoteRef = row.remote_ref;
    if (row.api_token_id !== null) tx.apiTokenId = row.api_token_id;
    if (row.idempotency_key !== null) tx.idempotencyKey = row.idempotency_key;
    if (row.committed_at !== null) tx.committedAt = row.committed_at;
    if (row.expires_at !== null) tx.expiresAt = row.expires_at;
    return tx;
  }
}
