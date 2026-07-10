// SQLite storage implementation of the Storage contract
// (specs/data-model.md §3, decisions #2, #5, #6, #10).
// better-sqlite3 is synchronous; results are wrapped in resolved Promises.

import Database from 'better-sqlite3';
import { v7 as uuidv7 } from 'uuid';
import type {
  Actor,
  AppendAuditEventInput,
  AuditEventFilter,
  CreateAccountInput,
  CreateCurrencyInput,
  CreateGroupInput,
  CreateImageInput,
  CreateOneTimeTokenInput,
  CreateNewsItemInput,
  CreatePageInput,
  EnqueueEmailInput,
  ImageFilter,
  SearchQuery,
  SetEmailTemplateInput,
  Storage,
  TransactionFilter,
} from '../interface.js';
import type {
  Account,
  ApiScope,
  ApiToken,
  AuditEvent,
  Category,
  Channel,
  CreditPolicy,
  CreditPolicyConfig,
  CreditPolicyType,
  Currency,
  DemurrageBand,
  DemurrageRun,
  DigestFrequency,
  EmailEvent,
  EmailTemplate,
  Entry,
  Group,
  GroupSettings,
  Id,
  Image,
  ImageOwnerKind,
  Listing,
  ListingStatus,
  ListingType,
  Member,
  MemberRole,
  MemberStatus,
  MemberType,
  NewTransaction,
  NewsItem,
  OneTimeToken,
  OneTimeTokenPurpose,
  Page,
  PageVisibility,
  Person,
  Restriction,
  SearchDomain,
  SearchResult,
  Session,
  StatementLine,
  TradeStats,
  Transaction,
  TxFlow,
  TxState,
  TxType,
  User,
  VerifyReport,
} from '../../types.js';
import { StorageError } from '../errors.js';
import { HASH_VERSION, txHash } from '../../ledger/hash.js';
import { migrate } from './migrations.js';

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

interface DemurrageRunRow {
  id: string;
  group_id: string;
  currency_id: string;
  period: string;
  status: string;
  started_at: string;
  completed_at: string | null;
}

interface MemberRow {
  id: string;
  group_id: string;
  member_no: number;
  type: string;
  role: string;
  display_name: string;
  status: string;
  confirm_incoming: number;
  digest_frequency: string;
  applied_at: string;
  approved_at: string | null;
  closed_at: string | null;
}

interface PersonRow {
  id: string;
  member_id: string;
  user_id: string | null;
  is_primary: number;
  name: string;
  email: string | null;
}

interface EmailEventRow {
  id: string;
  group_id: string;
  person_id: string;
  kind: string;
  dedup_key: string;
  to_email: string;
  subject: string;
  body: string;
  from_email: string | null;
  created_at: string;
  sent_at: string | null;
  attempts: number;
  last_error: string | null;
}

interface EmailTemplateRow {
  id: string;
  group_id: string;
  kind: string;
  subject: string;
  body: string;
}

interface CurrencyRow {
  id: string;
  group_id: string;
  code: string;
  name: string;
  scale: number;
  demurrage_day: number | null;
  created_at: string;
}

interface CreditPolicyRow {
  id: string;
  group_id: string;
  currency_id: string;
  type: string;
  config: string;
  enabled: number;
}

interface RestrictionRow {
  id: string;
  member_id: string;
  reason: string;
  imposed_by: string;
  imposed_at: string;
  lifted_by: string | null;
  lifted_at: string | null;
}

interface CategoryRow {
  id: string;
  group_id: string;
  name: string;
  parent_id: string | null;
}

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  status: string;
  is_operator: number;
  created_at: string;
  last_login_at: string | null;
  email_verified_at: string | null;
}

interface OneTimeTokenRow {
  id: string;
  user_id: string | null;
  email: string;
  purpose: string;
  token_hash: string;
  expires_at: string;
  used_at: string | null;
}

interface SessionRow {
  id: string;
  user_id: string;
  member_id: string | null;
  token_hash: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
}

interface GroupRow {
  id: string;
  slug: string;
  name: string;
  email_from: string | null;
  settings: string | null; // GroupSettings JSON; NULL = all defaults
  created_at: string;
}

interface ApiTokenRow {
  id: string;
  member_id: string;
  created_by: string;
  token_hash: string;
  label: string;
  scopes: string; // JSON text array
  max_tx_amount: number | null;
  max_period_amount: number | null;
  period_days: number | null;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
  created_at: string;
}

interface ListingRow {
  id: string;
  group_id: string;
  member_id: string;
  type: string;
  title: string;
  description: string;
  category_id: string;
  price_amount: number | null;
  price_currency_id: string | null;
  rate_text: string | null;
  status: string;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

interface PageRow {
  id: string;
  group_id: string;
  slug: string;
  title: string;
  body: string;
  visibility: string;
  position: number;
  created_at: string;
  updated_at: string;
}

interface NewsItemRow {
  id: string;
  group_id: string;
  title: string;
  body: string;
  published_at: string;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

// Metadata columns only (#14): the blob is deliberately absent — it leaves
// storage exclusively via imageData().
interface ImageRow {
  id: string;
  group_id: string;
  owner_kind: string;
  owner_id: string | null;
  mime: string;
  size: number;
  created_by: string;
  created_at: string;
}

interface AuditEventRow {
  id: string;
  group_id: string | null;
  actor_user_id: string | null;
  acting_for_member_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string;
  detail: string | null;
  at: string;
}

/** The images metadata columns (#14): everything but the blob. */
const IMAGE_COLUMNS =
  'id, group_id, owner_kind, owner_id, mime, size, created_by, created_at';

function now(): string {
  return new Date().toISOString();
}

/**
 * User text -> FTS5 MATCH expression: each whitespace token becomes a quoted
 * prefix phrase ("veg"*), so operators in user input can never break the
 * query or error; undefined when nothing searchable remains.
 */
function ftsMatch(text: string): string | undefined {
  const tokens = text
    .split(/\s+/)
    .map((token) => token.replaceAll('"', ''))
    .filter((token) => token.length > 0);
  if (tokens.length === 0) return undefined;
  return tokens.map((token) => `"${token}"*`).join(' ');
}

/** better-sqlite3 surfaces UNIQUE violations as SqliteError with this code. */
function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE'
  );
}

export class SqliteStorage implements Storage {
  private readonly db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    if (path !== ':memory:') {
      this.db.pragma('journal_mode = WAL');
    }
    this.db.pragma('foreign_keys = ON');
    migrate(this.db);
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

  listGroups(): Promise<Group[]> {
    const rows = this.db
      .prepare('SELECT * FROM groups ORDER BY created_at, id')
      .all() as GroupRow[];
    return Promise.resolve(rows.map((row) => this.groupFromRow(row)));
  }

  updateGroup(
    id: Id,
    patch: { name?: string; emailFrom?: string | null; settings?: GroupSettings },
  ): Promise<Group> {
    try {
      this.loadGroup(id);
      if (patch.name !== undefined) {
        this.db.prepare('UPDATE groups SET name = ? WHERE id = ?').run(patch.name, id);
      }
      if (patch.emailFrom !== undefined) {
        // null clears the sender (#16); absent leaves it untouched.
        this.db.prepare('UPDATE groups SET email_from = ? WHERE id = ?').run(patch.emailFrom, id);
      }
      if (patch.settings !== undefined) {
        // Replaces the whole settings object.
        this.db
          .prepare('UPDATE groups SET settings = ? WHERE id = ?')
          .run(JSON.stringify(patch.settings), id);
      }
      return Promise.resolve(this.loadGroup(id));
    } catch (err) {
      return Promise.reject(err);
    }
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
    if (input.demurrageDay !== undefined) currency.demurrageDay = input.demurrageDay;
    this.db
      .prepare(
        'INSERT INTO currencies (id, group_id, code, name, scale, demurrage_day, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        currency.id,
        currency.groupId,
        currency.code,
        currency.name,
        currency.scale,
        input.demurrageDay ?? null,
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

  getAccount(id: Id): Promise<Account> {
    const row = this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as
      | AccountRow
      | undefined;
    if (!row) return Promise.reject(new StorageError('NOT_FOUND', `account ${id} not found`));
    return Promise.resolve(this.accountFromRow(row));
  }

  listAccounts(groupId: Id, currencyId: Id): Promise<Account[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM accounts
         WHERE group_id = ? AND currency_id = ? AND closed_at IS NULL
         ORDER BY id`,
      )
      .all(groupId, currencyId) as AccountRow[];
    return Promise.resolve(rows.map((row) => this.accountFromRow(row)));
  }

  setDemurrageBands(currencyId: Id, bands: DemurrageBand[]): Promise<void> {
    try {
      const seen = new Set<number>();
      for (const band of bands) {
        if (!Number.isSafeInteger(band.fromAmount) || band.fromAmount < 0) {
          throw new StorageError(
            'INVALID_TRANSACTION',
            `band fromAmount must be a non-negative integer, got ${band.fromAmount}`,
          );
        }
        if (!Number.isSafeInteger(band.ratePpmPerMonth) || band.ratePpmPerMonth < 0) {
          throw new StorageError(
            'INVALID_TRANSACTION',
            `band ratePpmPerMonth must be a non-negative integer, got ${band.ratePpmPerMonth}`,
          );
        }
        if (seen.has(band.fromAmount)) {
          throw new StorageError(
            'INVALID_TRANSACTION',
            `duplicate band fromAmount ${band.fromAmount}`,
          );
        }
        seen.add(band.fromAmount);
      }
      this.db.transaction(() => {
        this.db.prepare('DELETE FROM demurrage_bands WHERE currency_id = ?').run(currencyId);
        const insert = this.db.prepare(
          'INSERT INTO demurrage_bands (currency_id, from_amount, rate_ppm_per_month) VALUES (?, ?, ?)',
        );
        for (const band of bands) {
          insert.run(currencyId, band.fromAmount, band.ratePpmPerMonth);
        }
      })();
      return Promise.resolve();
    } catch (err) {
      return Promise.reject(err);
    }
  }

  demurrageBands(currencyId: Id): Promise<DemurrageBand[]> {
    const rows = this.db
      .prepare(
        `SELECT from_amount, rate_ppm_per_month FROM demurrage_bands
         WHERE currency_id = ? ORDER BY from_amount`,
      )
      .all(currencyId) as { from_amount: number; rate_ppm_per_month: number }[];
    return Promise.resolve(
      rows.map((row) => ({ fromAmount: row.from_amount, ratePpmPerMonth: row.rate_ppm_per_month })),
    );
  }

  beginDemurrageRun(groupId: Id, currencyId: Id, period: string): Promise<DemurrageRun> {
    try {
      const run = this.db.transaction((): DemurrageRun => {
        const existing = this.db
          .prepare('SELECT * FROM demurrage_runs WHERE currency_id = ? AND period = ?')
          .get(currencyId, period) as DemurrageRunRow | undefined;
        if (existing) return this.runFromRow(existing);
        const id = uuidv7();
        const startedAt = now();
        this.db
          .prepare(
            `INSERT INTO demurrage_runs (id, group_id, currency_id, period, status, started_at)
             VALUES (?, ?, ?, ?, 'running', ?)`,
          )
          .run(id, groupId, currencyId, period, startedAt);
        return { id, groupId, currencyId, period, status: 'running', startedAt };
      })();
      return Promise.resolve(run);
    } catch (err) {
      return Promise.reject(err);
    }
  }

  completeDemurrageRun(runId: Id): Promise<DemurrageRun> {
    try {
      const result = this.db
        .prepare(
          `UPDATE demurrage_runs SET status = 'completed', completed_at = ? WHERE id = ?`,
        )
        .run(now(), runId);
      if (result.changes === 0) {
        throw new StorageError('NOT_FOUND', `demurrage run ${runId} not found`);
      }
      const row = this.db
        .prepare('SELECT * FROM demurrage_runs WHERE id = ?')
        .get(runId) as DemurrageRunRow;
      return Promise.resolve(this.runFromRow(row));
    } catch (err) {
      return Promise.reject(err);
    }
  }

  transactionsForRun(runId: Id): Promise<Transaction[]> {
    const rows = this.db
      .prepare(
        `SELECT id FROM transactions
         WHERE demurrage_run_id = ? AND state = 'committed'
         ORDER BY seq`,
      )
      .all(runId) as { id: string }[];
    return Promise.resolve(rows.map((row) => this.loadTransaction(row.id)));
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

  createUser(input: { email: string; passwordHash: string }): Promise<User> {
    try {
      const user: User = {
        id: uuidv7(),
        email: input.email,
        status: 'active',
        isOperator: false,
        createdAt: now(),
      };
      try {
        this.db
          .prepare(
            'INSERT INTO users (id, email, password_hash, status, created_at) VALUES (?, ?, ?, ?, ?)',
          )
          .run(user.id, user.email, input.passwordHash, user.status, user.createdAt);
      } catch (err) {
        if (err instanceof Error && /UNIQUE/.test(err.message)) {
          throw new StorageError(
            'INVALID_TRANSACTION',
            `a user with email ${input.email} already exists`,
          );
        }
        throw err;
      }
      return Promise.resolve(user);
    } catch (err) {
      return Promise.reject(err);
    }
  }

  getUser(id: Id): Promise<User> {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as
      | UserRow
      | undefined;
    if (!row) return Promise.reject(new StorageError('NOT_FOUND', `user ${id} not found`));
    return Promise.resolve(this.userFromRow(row));
  }

  credentialsForEmail(
    email: string,
  ): Promise<{ user: User; passwordHash: string } | undefined> {
    const row = this.db.prepare('SELECT * FROM users WHERE email = ?').get(email) as
      | UserRow
      | undefined;
    if (!row) return Promise.resolve(undefined);
    return Promise.resolve({ user: this.userFromRow(row), passwordHash: row.password_hash });
  }

  setOperator(userId: Id, isOperator: boolean): Promise<User> {
    const result = this.db
      .prepare('UPDATE users SET is_operator = ? WHERE id = ?')
      .run(isOperator ? 1 : 0, userId);
    if (result.changes === 0) {
      return Promise.reject(new StorageError('NOT_FOUND', `user ${userId} not found`));
    }
    return this.getUser(userId);
  }

  operatorExists(): Promise<boolean> {
    const row = this.db.prepare('SELECT 1 FROM users WHERE is_operator = 1 LIMIT 1').get();
    return Promise.resolve(row !== undefined);
  }

  createSession(input: {
    userId: Id;
    memberId?: Id;
    tokenHash: string;
    expiresAt: string;
  }): Promise<Session> {
    try {
      const session: Session = {
        id: uuidv7(),
        userId: input.userId,
        createdAt: now(),
        expiresAt: input.expiresAt,
      };
      if (input.memberId !== undefined) session.memberId = input.memberId;
      this.db
        .prepare(
          `INSERT INTO sessions (id, user_id, member_id, token_hash, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          session.id,
          session.userId,
          input.memberId ?? null,
          input.tokenHash,
          session.createdAt,
          session.expiresAt,
        );
      return Promise.resolve(session);
    } catch (err) {
      return Promise.reject(err);
    }
  }

  sessionByTokenHash(tokenHash: string): Promise<Session | undefined> {
    const row = this.db
      .prepare('SELECT * FROM sessions WHERE token_hash = ? AND revoked_at IS NULL')
      .get(tokenHash) as SessionRow | undefined;
    if (!row) return Promise.resolve(undefined);
    const session: Session = {
      id: row.id,
      userId: row.user_id,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
    if (row.member_id !== null) session.memberId = row.member_id;
    return Promise.resolve(session);
  }

  revokeSession(id: Id): Promise<void> {
    this.db
      .prepare('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
      .run(now(), id);
    return Promise.resolve();
  }

  revokeSessionsForUser(userId: Id): Promise<void> {
    this.db
      .prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
      .run(now(), userId);
    return Promise.resolve();
  }

  updateUserPassword(userId: Id, passwordHash: string): Promise<void> {
    const result = this.db
      .prepare('UPDATE users SET password_hash = ? WHERE id = ?')
      .run(passwordHash, userId);
    if (result.changes === 0) {
      return Promise.reject(new StorageError('NOT_FOUND', `user ${userId} not found`));
    }
    return Promise.resolve();
  }

  markUserEmailVerified(userId: Id, whenIso: string): Promise<User> {
    const result = this.db
      .prepare('UPDATE users SET email_verified_at = ? WHERE id = ?')
      .run(whenIso, userId);
    if (result.changes === 0) {
      return Promise.reject(new StorageError('NOT_FOUND', `user ${userId} not found`));
    }
    return this.getUser(userId);
  }

  createOneTimeToken(input: CreateOneTimeTokenInput): Promise<OneTimeToken> {
    try {
      const token: OneTimeToken = {
        id: uuidv7(),
        email: input.email,
        purpose: input.purpose,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
      };
      if (input.userId !== undefined) token.userId = input.userId;
      this.db
        .prepare(
          `INSERT INTO one_time_tokens (id, user_id, email, purpose, token_hash, expires_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          token.id,
          input.userId ?? null,
          token.email,
          token.purpose,
          token.tokenHash,
          token.expiresAt,
        );
      return Promise.resolve(token);
    } catch (err) {
      return Promise.reject(err);
    }
  }

  oneTimeTokenByHash(tokenHash: string): Promise<OneTimeToken | undefined> {
    const row = this.db
      .prepare('SELECT * FROM one_time_tokens WHERE token_hash = ?')
      .get(tokenHash) as OneTimeTokenRow | undefined;
    if (!row) return Promise.resolve(undefined);
    const token: OneTimeToken = {
      id: row.id,
      email: row.email,
      purpose: row.purpose as OneTimeTokenPurpose,
      tokenHash: row.token_hash,
      expiresAt: row.expires_at,
    };
    if (row.user_id !== null) token.userId = row.user_id;
    if (row.used_at !== null) token.usedAt = row.used_at;
    return Promise.resolve(token);
  }

  markOneTimeTokenUsed(id: Id, usedAtIso: string): Promise<void> {
    this.db
      .prepare('UPDATE one_time_tokens SET used_at = ? WHERE id = ?')
      .run(usedAtIso, id);
    return Promise.resolve();
  }

  membersForUser(userId: Id): Promise<Member[]> {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT m.* FROM members m
         JOIN persons p ON p.member_id = m.id
         WHERE p.user_id = ?
         ORDER BY m.id`,
      )
      .all(userId) as MemberRow[];
    return Promise.resolve(rows.map((row) => this.memberFromRow(row)));
  }

  addGroupDomain(groupId: Id, hostname: string): Promise<void> {
    try {
      this.db
        .prepare('INSERT INTO group_domains (hostname, group_id) VALUES (?, ?)')
        .run(hostname, groupId);
      return Promise.resolve();
    } catch (err) {
      return Promise.reject(err);
    }
  }

  groupByDomain(hostname: string): Promise<Group | undefined> {
    const row = this.db
      .prepare(
        `SELECT g.* FROM groups g
         JOIN group_domains d ON d.group_id = g.id
         WHERE d.hostname = ?`,
      )
      .get(hostname) as GroupRow | undefined;
    return Promise.resolve(row ? this.groupFromRow(row) : undefined);
  }

  groupBySlug(slug: string): Promise<Group | undefined> {
    const row = this.db.prepare('SELECT * FROM groups WHERE slug = ?').get(slug) as
      | GroupRow
      | undefined;
    return Promise.resolve(row ? this.groupFromRow(row) : undefined);
  }

  createMember(input: {
    groupId: Id;
    displayName: string;
    type?: MemberType;
    role?: MemberRole;
    digestFrequency?: DigestFrequency;
  }): Promise<Member> {
    try {
      const member = this.db.transaction((): Member => {
        const head = this.db
          .prepare('SELECT COALESCE(MAX(member_no), 0) AS member_no FROM members WHERE group_id = ?')
          .get(input.groupId) as { member_no: number };
        const member: Member = {
          id: uuidv7(),
          groupId: input.groupId,
          memberNo: head.member_no + 1,
          type: input.type ?? 'individual',
          role: input.role ?? 'member',
          displayName: input.displayName,
          status: 'applied',
          confirmIncoming: false,
          digestFrequency: input.digestFrequency ?? 'weekly',
          appliedAt: now(),
        };
        this.db
          .prepare(
            `INSERT INTO members (id, group_id, member_no, type, role, display_name, status, confirm_incoming, digest_frequency, applied_at)
             VALUES (?, ?, ?, ?, ?, ?, 'applied', 0, ?, ?)`,
          )
          .run(
            member.id,
            member.groupId,
            member.memberNo,
            member.type,
            member.role,
            member.displayName,
            member.digestFrequency,
            member.appliedAt,
          );
        return member;
      })();
      return Promise.resolve(member);
    } catch (err) {
      return Promise.reject(err);
    }
  }

  getMember(id: Id): Promise<Member> {
    try {
      return Promise.resolve(this.loadMember(id));
    } catch (err) {
      return Promise.reject(err);
    }
  }

  updateMember(
    id: Id,
    patch: {
      displayName?: string;
      confirmIncoming?: boolean;
      role?: MemberRole;
      digestFrequency?: DigestFrequency;
    },
  ): Promise<Member> {
    try {
      this.loadMember(id);
      if (patch.displayName !== undefined) {
        this.db.prepare('UPDATE members SET display_name = ? WHERE id = ?').run(patch.displayName, id);
      }
      if (patch.confirmIncoming !== undefined) {
        this.db
          .prepare('UPDATE members SET confirm_incoming = ? WHERE id = ?')
          .run(patch.confirmIncoming ? 1 : 0, id);
      }
      if (patch.role !== undefined) {
        this.db.prepare('UPDATE members SET role = ? WHERE id = ?').run(patch.role, id);
      }
      if (patch.digestFrequency !== undefined) {
        this.db
          .prepare('UPDATE members SET digest_frequency = ? WHERE id = ?')
          .run(patch.digestFrequency, id);
      }
      return Promise.resolve(this.loadMember(id));
    } catch (err) {
      return Promise.reject(err);
    }
  }

  setMemberStatus(id: Id, status: MemberStatus): Promise<Member> {
    try {
      const member = this.loadMember(id);
      const at = now();
      const approvedAt =
        status === 'active' && member.approvedAt === undefined ? at : null;
      const closedAt = status === 'closed' ? at : null;
      this.db
        .prepare(
          `UPDATE members
           SET status = ?,
               approved_at = COALESCE(?, approved_at),
               closed_at = COALESCE(?, closed_at)
           WHERE id = ?`,
        )
        .run(status, approvedAt, closedAt, id);
      return Promise.resolve(this.loadMember(id));
    } catch (err) {
      return Promise.reject(err);
    }
  }

  listMembers(groupId: Id, status?: MemberStatus): Promise<Member[]> {
    const rows = (
      status === undefined
        ? this.db
            .prepare('SELECT * FROM members WHERE group_id = ? ORDER BY member_no')
            .all(groupId)
        : this.db
            .prepare('SELECT * FROM members WHERE group_id = ? AND status = ? ORDER BY member_no')
            .all(groupId, status)
    ) as MemberRow[];
    return Promise.resolve(rows.map((row) => this.memberFromRow(row)));
  }

  createPerson(input: {
    memberId: Id;
    userId?: Id;
    name: string;
    email?: string;
    isPrimary?: boolean;
  }): Promise<Person> {
    try {
      this.loadMember(input.memberId);
      const person: Person = {
        id: uuidv7(),
        memberId: input.memberId,
        isPrimary: input.isPrimary ?? false,
        name: input.name,
      };
      if (input.userId !== undefined) person.userId = input.userId;
      if (input.email !== undefined) person.email = input.email;
      this.db
        .prepare(
          'INSERT INTO persons (id, member_id, user_id, is_primary, name, email) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(
          person.id,
          person.memberId,
          input.userId ?? null,
          person.isPrimary ? 1 : 0,
          person.name,
          input.email ?? null,
        );
      return Promise.resolve(person);
    } catch (err) {
      return Promise.reject(err);
    }
  }

  personsForMember(memberId: Id): Promise<Person[]> {
    const rows = this.db
      .prepare('SELECT * FROM persons WHERE member_id = ? ORDER BY id')
      .all(memberId) as PersonRow[];
    return Promise.resolve(
      rows.map((row) => {
        const person: Person = {
          id: row.id,
          memberId: row.member_id,
          isPrimary: row.is_primary !== 0,
          name: row.name,
        };
        if (row.user_id !== null) person.userId = row.user_id;
        if (row.email !== null) person.email = row.email;
        return person;
      }),
    );
  }

  listCurrencies(groupId: Id): Promise<Currency[]> {
    const rows = this.db
      .prepare('SELECT * FROM currencies WHERE group_id = ? ORDER BY id')
      .all(groupId) as CurrencyRow[];
    return Promise.resolve(rows.map((row) => this.currencyFromRow(row)));
  }

  ensureMemberAccount(memberId: Id, currencyId: Id): Promise<Account> {
    try {
      const member = this.loadMember(memberId);
      const account = this.db.transaction((): Account => {
        const existing = this.db
          .prepare(
            `SELECT * FROM accounts
             WHERE member_id = ? AND currency_id = ? AND type = 'member' AND closed_at IS NULL
             ORDER BY id LIMIT 1`,
          )
          .get(memberId, currencyId) as AccountRow | undefined;
        if (existing) return this.accountFromRow(existing);
        const id = uuidv7();
        const createdAt = now();
        this.db
          .prepare(
            `INSERT INTO accounts (id, group_id, currency_id, type, member_id, created_at)
             VALUES (?, ?, ?, 'member', ?, ?)`,
          )
          .run(id, member.groupId, currencyId, memberId, createdAt);
        return {
          id,
          groupId: member.groupId,
          currencyId,
          type: 'member',
          memberId,
          createdAt,
        };
      })();
      return Promise.resolve(account);
    } catch (err) {
      return Promise.reject(err);
    }
  }

  accountsForMember(memberId: Id): Promise<Account[]> {
    const rows = this.db
      .prepare('SELECT * FROM accounts WHERE member_id = ? AND closed_at IS NULL ORDER BY id')
      .all(memberId) as AccountRow[];
    return Promise.resolve(rows.map((row) => this.accountFromRow(row)));
  }

  closeAccount(accountId: Id): Promise<void> {
    const result = this.db
      .prepare('UPDATE accounts SET closed_at = ? WHERE id = ? AND closed_at IS NULL')
      .run(now(), accountId);
    if (result.changes === 0) {
      const exists = this.db.prepare('SELECT id FROM accounts WHERE id = ?').get(accountId);
      if (!exists) {
        return Promise.reject(new StorageError('NOT_FOUND', `account ${accountId} not found`));
      }
    }
    return Promise.resolve();
  }

  setCreditPolicy(input: {
    groupId: Id;
    currencyId: Id;
    type: CreditPolicyType;
    config: CreditPolicyConfig;
    enabled?: boolean;
  }): Promise<CreditPolicy> {
    const policy: CreditPolicy = {
      id: uuidv7(),
      groupId: input.groupId,
      currencyId: input.currencyId,
      type: input.type,
      config: input.config,
      enabled: input.enabled ?? true,
    };
    this.db
      .prepare(
        `INSERT INTO credit_policies (id, group_id, currency_id, type, config, enabled)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        policy.id,
        policy.groupId,
        policy.currencyId,
        policy.type,
        JSON.stringify(policy.config),
        policy.enabled ? 1 : 0,
      );
    return Promise.resolve(policy);
  }

  creditPolicies(groupId: Id, currencyId: Id): Promise<CreditPolicy[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM credit_policies
         WHERE group_id = ? AND currency_id = ? AND enabled = 1
         ORDER BY id`,
      )
      .all(groupId, currencyId) as CreditPolicyRow[];
    return Promise.resolve(rows.map((row) => this.policyFromRow(row)));
  }

  listCreditPolicies(groupId: Id): Promise<CreditPolicy[]> {
    const rows = this.db
      .prepare('SELECT * FROM credit_policies WHERE group_id = ? ORDER BY id')
      .all(groupId) as CreditPolicyRow[];
    return Promise.resolve(rows.map((row) => this.policyFromRow(row)));
  }

  updateCreditPolicy(
    id: Id,
    patch: { enabled?: boolean; config?: CreditPolicyConfig },
  ): Promise<CreditPolicy> {
    try {
      const existing = this.db
        .prepare('SELECT id FROM credit_policies WHERE id = ?')
        .get(id) as { id: string } | undefined;
      if (!existing) {
        throw new StorageError('NOT_FOUND', `credit policy ${id} not found`);
      }
      if (patch.enabled !== undefined) {
        this.db
          .prepare('UPDATE credit_policies SET enabled = ? WHERE id = ?')
          .run(patch.enabled ? 1 : 0, id);
      }
      if (patch.config !== undefined) {
        this.db
          .prepare('UPDATE credit_policies SET config = ? WHERE id = ?')
          .run(JSON.stringify(patch.config), id);
      }
      const row = this.db
        .prepare('SELECT * FROM credit_policies WHERE id = ?')
        .get(id) as CreditPolicyRow;
      return Promise.resolve(this.policyFromRow(row));
    } catch (err) {
      return Promise.reject(err);
    }
  }

  imposeRestriction(memberId: Id, reason: string, imposedBy: Id): Promise<Restriction> {
    try {
      this.loadMember(memberId);
      const restriction: Restriction = {
        id: uuidv7(),
        memberId,
        reason,
        imposedBy,
        imposedAt: now(),
      };
      this.db
        .prepare(
          'INSERT INTO restrictions (id, member_id, reason, imposed_by, imposed_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run(restriction.id, memberId, reason, imposedBy, restriction.imposedAt);
      return Promise.resolve(restriction);
    } catch (err) {
      return Promise.reject(err);
    }
  }

  liftRestriction(memberId: Id, liftedBy: Id): Promise<void> {
    const result = this.db
      .prepare(
        'UPDATE restrictions SET lifted_by = ?, lifted_at = ? WHERE member_id = ? AND lifted_at IS NULL',
      )
      .run(liftedBy, now(), memberId);
    if (result.changes === 0) {
      return Promise.reject(
        new StorageError('NOT_FOUND', `member ${memberId} has no active restriction`),
      );
    }
    return Promise.resolve();
  }

  activeRestriction(memberId: Id): Promise<Restriction | undefined> {
    const row = this.db
      .prepare(
        `SELECT * FROM restrictions
         WHERE member_id = ? AND lifted_at IS NULL
         ORDER BY imposed_at DESC LIMIT 1`,
      )
      .get(memberId) as RestrictionRow | undefined;
    if (!row) return Promise.resolve(undefined);
    return Promise.resolve(this.restrictionFromRow(row));
  }

  activeRestrictions(groupId: Id): Promise<Restriction[]> {
    const rows = this.db
      .prepare(
        `SELECT r.* FROM restrictions r
         JOIN members m ON m.id = r.member_id
         WHERE m.group_id = ? AND r.lifted_at IS NULL
         ORDER BY r.imposed_at ASC`,
      )
      .all(groupId) as RestrictionRow[];
    return Promise.resolve(rows.map((row) => this.restrictionFromRow(row)));
  }

  private restrictionFromRow(row: RestrictionRow): Restriction {
    const restriction: Restriction = {
      id: row.id,
      memberId: row.member_id,
      reason: row.reason,
      imposedBy: row.imposed_by,
      imposedAt: row.imposed_at,
    };
    if (row.lifted_by !== null) restriction.liftedBy = row.lifted_by;
    if (row.lifted_at !== null) restriction.liftedAt = row.lifted_at;
    return restriction;
  }

  createApiToken(input: {
    memberId: Id;
    createdBy: Id;
    tokenHash: string;
    label: string;
    scopes: ApiScope[];
    maxTxAmount?: number;
    maxPeriodAmount?: number;
    periodDays?: number;
    expiresAt?: string;
  }): Promise<ApiToken> {
    try {
      const token: ApiToken = {
        id: uuidv7(),
        memberId: input.memberId,
        createdBy: input.createdBy,
        label: input.label,
        scopes: [...input.scopes],
        createdAt: now(),
      };
      if (input.maxTxAmount !== undefined) token.maxTxAmount = input.maxTxAmount;
      if (input.maxPeriodAmount !== undefined) token.maxPeriodAmount = input.maxPeriodAmount;
      if (input.periodDays !== undefined) token.periodDays = input.periodDays;
      if (input.expiresAt !== undefined) token.expiresAt = input.expiresAt;
      this.db
        .prepare(
          `INSERT INTO api_tokens (
             id, member_id, created_by, token_hash, label, scopes,
             max_tx_amount, max_period_amount, period_days, expires_at, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          token.id,
          token.memberId,
          token.createdBy,
          input.tokenHash,
          token.label,
          JSON.stringify(token.scopes),
          input.maxTxAmount ?? null,
          input.maxPeriodAmount ?? null,
          input.periodDays ?? null,
          input.expiresAt ?? null,
          token.createdAt,
        );
      return Promise.resolve(token);
    } catch (err) {
      return Promise.reject(err);
    }
  }

  apiTokenByHash(tokenHash: string): Promise<ApiToken | undefined> {
    const row = this.db
      .prepare('SELECT * FROM api_tokens WHERE token_hash = ? AND revoked_at IS NULL')
      .get(tokenHash) as ApiTokenRow | undefined;
    return Promise.resolve(row ? this.apiTokenFromRow(row) : undefined);
  }

  listApiTokens(memberId: Id): Promise<ApiToken[]> {
    const rows = this.db
      .prepare('SELECT * FROM api_tokens WHERE member_id = ? ORDER BY created_at, id')
      .all(memberId) as ApiTokenRow[];
    return Promise.resolve(rows.map((row) => this.apiTokenFromRow(row)));
  }

  revokeApiToken(id: Id): Promise<void> {
    this.db
      .prepare('UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
      .run(now(), id);
    return Promise.resolve();
  }

  touchApiToken(id: Id, atIso: string): Promise<void> {
    this.db.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?').run(atIso, id);
    return Promise.resolve();
  }

  tokenSpend(tokenId: Id, sinceIso: string): Promise<number> {
    // Rolling spend (decision #9): the token member's outward (negative) legs
    // over committed transactions carrying this apiTokenId. Inward legs and
    // pending holds do not count.
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(-e.amount), 0) AS spent
         FROM entries e
         JOIN accounts a ON a.id = e.account_id
         JOIN transactions t ON t.id = e.transaction_id
         WHERE t.api_token_id = ?
           AND t.state = 'committed'
           AND t.committed_at >= ?
           AND e.amount < 0
           AND a.member_id = (SELECT member_id FROM api_tokens WHERE id = ?)`,
      )
      .get(tokenId, sinceIso, tokenId) as { spent: number };
    return Promise.resolve(row.spent);
  }

  enqueueEmail(input: EnqueueEmailInput): Promise<EmailEvent | undefined> {
    try {
      const id = uuidv7();
      // OR IGNORE: a duplicate dedup_key means this event was already
      // enqueued (a sweep re-notifying) — a silent no-op by design.
      const result = this.db
        .prepare(
          `INSERT OR IGNORE INTO email_events (
             id, group_id, person_id, kind, dedup_key, to_email, subject, body,
             from_email, created_at, attempts
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        )
        .run(
          id,
          input.groupId,
          input.personId,
          input.kind,
          input.dedupKey,
          input.toEmail,
          input.subject,
          input.body,
          input.fromEmail ?? null,
          input.createdAt,
        );
      if (result.changes === 0) return Promise.resolve(undefined);
      const event: EmailEvent = {
        id,
        groupId: input.groupId,
        personId: input.personId,
        kind: input.kind,
        dedupKey: input.dedupKey,
        toEmail: input.toEmail,
        subject: input.subject,
        body: input.body,
        createdAt: input.createdAt,
        attempts: 0,
      };
      if (input.fromEmail !== undefined) event.fromEmail = input.fromEmail;
      return Promise.resolve(event);
    } catch (err) {
      return Promise.reject(err);
    }
  }

  pendingEmails(limit: number): Promise<EmailEvent[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM email_events
         WHERE sent_at IS NULL AND attempts < 3
         ORDER BY created_at, id LIMIT ?`,
      )
      .all(limit) as EmailEventRow[];
    return Promise.resolve(rows.map((row) => this.emailEventFromRow(row)));
  }

  markEmailSent(id: Id, sentAt: string): Promise<void> {
    this.db.prepare('UPDATE email_events SET sent_at = ? WHERE id = ?').run(sentAt, id);
    return Promise.resolve();
  }

  markEmailFailed(id: Id, error: string): Promise<void> {
    this.db
      .prepare('UPDATE email_events SET attempts = attempts + 1, last_error = ? WHERE id = ?')
      .run(error, id);
    return Promise.resolve();
  }

  private emailEventFromRow(row: EmailEventRow): EmailEvent {
    const event: EmailEvent = {
      id: row.id,
      groupId: row.group_id,
      personId: row.person_id,
      kind: row.kind,
      dedupKey: row.dedup_key,
      toEmail: row.to_email,
      subject: row.subject,
      body: row.body,
      createdAt: row.created_at,
      attempts: row.attempts,
    };
    if (row.from_email !== null) event.fromEmail = row.from_email;
    if (row.sent_at !== null) event.sentAt = row.sent_at;
    if (row.last_error !== null) event.lastError = row.last_error;
    return event;
  }

  // --- Email template overrides (#16) -----------------------------------------

  setEmailTemplate(input: SetEmailTemplateInput): Promise<EmailTemplate> {
    try {
      // Upsert per (group, kind): a replace keeps the original row's id.
      this.db
        .prepare(
          `INSERT INTO email_templates (id, group_id, kind, subject, body)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (group_id, kind)
           DO UPDATE SET subject = excluded.subject, body = excluded.body`,
        )
        .run(uuidv7(), input.groupId, input.kind, input.subject, input.body);
      const row = this.db
        .prepare('SELECT * FROM email_templates WHERE group_id = ? AND kind = ?')
        .get(input.groupId, input.kind) as EmailTemplateRow;
      return Promise.resolve(this.emailTemplateFromRow(row));
    } catch (err) {
      return Promise.reject(err);
    }
  }

  getEmailTemplate(groupId: Id, kind: string): Promise<EmailTemplate | undefined> {
    const row = this.db
      .prepare('SELECT * FROM email_templates WHERE group_id = ? AND kind = ?')
      .get(groupId, kind) as EmailTemplateRow | undefined;
    return Promise.resolve(row ? this.emailTemplateFromRow(row) : undefined);
  }

  listEmailTemplates(groupId: Id): Promise<EmailTemplate[]> {
    const rows = this.db
      .prepare('SELECT * FROM email_templates WHERE group_id = ? ORDER BY kind')
      .all(groupId) as EmailTemplateRow[];
    return Promise.resolve(rows.map((row) => this.emailTemplateFromRow(row)));
  }

  deleteEmailTemplate(groupId: Id, kind: string): Promise<void> {
    this.db
      .prepare('DELETE FROM email_templates WHERE group_id = ? AND kind = ?')
      .run(groupId, kind);
    return Promise.resolve();
  }

  private emailTemplateFromRow(row: EmailTemplateRow): EmailTemplate {
    return {
      id: row.id,
      groupId: row.group_id,
      kind: row.kind,
      subject: row.subject,
      body: row.body,
    };
  }

  pendingDue(groupId: Id, asOf: string): Promise<Transaction[]> {
    const rows = this.db
      .prepare(
        `SELECT id FROM transactions
         WHERE group_id = ? AND state = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?
         ORDER BY created_at, id`,
      )
      .all(groupId, asOf) as { id: string }[];
    return Promise.resolve(rows.map((row) => this.loadTransaction(row.id)));
  }

  listTransactions(
    groupId: Id,
    filter?: TransactionFilter,
  ): Promise<{ transactions: Transaction[]; total: number }> {
    const clauses = ['t.group_id = ?'];
    const values: (string | number)[] = [groupId];
    if (filter?.type !== undefined) {
      clauses.push('t.type = ?');
      values.push(filter.type);
    }
    if (filter?.state !== undefined) {
      clauses.push('t.state = ?');
      values.push(filter.state);
    }
    if (filter?.memberId !== undefined) {
      clauses.push(
        `EXISTS (SELECT 1 FROM entries e JOIN accounts a ON a.id = e.account_id
                 WHERE e.transaction_id = t.id AND a.member_id = ?)`,
      );
      values.push(filter.memberId);
    }
    if (filter?.currencyId !== undefined) {
      clauses.push(
        `EXISTS (SELECT 1 FROM entries e JOIN accounts a ON a.id = e.account_id
                 WHERE e.transaction_id = t.id AND a.currency_id = ?)`,
      );
      values.push(filter.currencyId);
    }
    if (filter?.text !== undefined) {
      const needle = `%${filter.text.toLowerCase().replace(/[\\%_]/g, '\\$&')}%`;
      clauses.push(
        `(lower(COALESCE(t.description, '')) LIKE ? ESCAPE '\\'
          OR lower(COALESCE(t.reference, '')) LIKE ? ESCAPE '\\')`,
      );
      values.push(needle, needle);
    }
    const where = clauses.join(' AND ');
    const { total } = this.db
      .prepare(`SELECT COUNT(*) AS total FROM transactions t WHERE ${where}`)
      .get(...values) as { total: number };
    const limit = Math.min(filter?.limit ?? 50, 200);
    const offset = filter?.offset ?? 0;
    const rows = this.db
      .prepare(
        `SELECT t.id FROM transactions t WHERE ${where}
         ORDER BY t.created_at DESC, t.rowid DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...values, limit, offset) as { id: string }[];
    return Promise.resolve({
      transactions: rows.map((row) => this.loadTransaction(row.id)),
      total,
    });
  }

  pendingForMember(memberId: Id): Promise<Transaction[]> {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT t.id, t.created_at FROM transactions t
         JOIN entries e ON e.transaction_id = t.id
         JOIN accounts a ON a.id = e.account_id
         WHERE t.state = 'pending' AND a.member_id = ?
         ORDER BY t.created_at, t.id`,
      )
      .all(memberId) as { id: string }[];
    return Promise.resolve(rows.map((row) => this.loadTransaction(row.id)));
  }

  tradeStats(memberId: Id): Promise<TradeStats> {
    const row = this.db
      .prepare(
        `WITH member_trades AS (
           SELECT DISTINCT t.id, t.committed_at
           FROM transactions t
           JOIN entries e ON e.transaction_id = t.id
           JOIN accounts a ON a.id = e.account_id
           WHERE t.state = 'committed' AND t.type = 'trade' AND a.member_id = ?
         )
         SELECT
           (SELECT COUNT(*) FROM member_trades) AS trades,
           (SELECT MAX(committed_at) FROM member_trades) AS last_trade_at,
           (SELECT COUNT(DISTINCT a2.member_id)
              FROM member_trades mt
              JOIN entries e2 ON e2.transaction_id = mt.id
              JOIN accounts a2 ON a2.id = e2.account_id
              WHERE a2.member_id IS NOT NULL AND a2.member_id != ?) AS partners`,
      )
      .get(memberId, memberId) as {
      trades: number;
      partners: number;
      last_trade_at: string | null;
    };
    const stats: TradeStats = { trades: row.trades, partners: row.partners };
    if (row.last_trade_at !== null) stats.lastTradeAt = row.last_trade_at;
    return Promise.resolve(stats);
  }

  memberBalances(
    groupId: Id,
    currencyId: Id,
  ): Promise<{ memberId: Id; balance: number }[]> {
    // LEFT JOIN: a member account with no committed entries still appears,
    // with balance 0 — the distribution needs the untraded members too.
    const rows = this.db
      .prepare(
        `SELECT a.member_id AS member_id,
                COALESCE(SUM(CASE WHEN t.state = 'committed' THEN e.amount END), 0)
                  AS balance
         FROM accounts a
         LEFT JOIN entries e ON e.account_id = a.id
         LEFT JOIN transactions t ON t.id = e.transaction_id
         WHERE a.group_id = ? AND a.currency_id = ?
           AND a.type = 'member' AND a.closed_at IS NULL
         GROUP BY a.member_id`,
      )
      .all(groupId, currencyId) as { member_id: string; balance: number }[];
    return Promise.resolve(
      rows.map((row) => ({ memberId: row.member_id, balance: row.balance })),
    );
  }

  monthlyTradeFlow(
    groupId: Id,
    currencyId: Id,
    months: number,
  ): Promise<{ month: string; volume: number; trades: number }[]> {
    const rows = this.db
      .prepare(
        `SELECT substr(t.committed_at, 1, 7) AS month,
                SUM(CASE WHEN e.amount > 0 THEN e.amount ELSE 0 END) AS volume,
                COUNT(DISTINCT t.id) AS trades
         FROM transactions t
         JOIN entries e ON e.transaction_id = t.id
         JOIN accounts a ON a.id = e.account_id
         WHERE t.group_id = ? AND t.type = 'trade' AND t.state = 'committed'
           AND a.currency_id = ?
         GROUP BY month
         ORDER BY month DESC
         LIMIT ?`,
      )
      .all(groupId, currencyId, months) as {
      month: string;
      volume: number;
      trades: number;
    }[];
    return Promise.resolve(rows.reverse());
  }

  lastTradeAt(groupId: Id): Promise<{ memberId: Id; lastTradeAt: string }[]> {
    const rows = this.db
      .prepare(
        `SELECT a.member_id AS member_id, MAX(t.committed_at) AS last_trade_at
         FROM transactions t
         JOIN entries e ON e.transaction_id = t.id
         JOIN accounts a ON a.id = e.account_id
         WHERE t.group_id = ? AND t.type = 'trade' AND t.state = 'committed'
           AND a.member_id IS NOT NULL
         GROUP BY a.member_id`,
      )
      .all(groupId) as { member_id: string; last_trade_at: string }[];
    return Promise.resolve(
      rows.map((row) => ({ memberId: row.member_id, lastTradeAt: row.last_trade_at })),
    );
  }

  tradeVolumeSince(groupId: Id, currencyId: Id, sinceIso: string): Promise<number> {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(e.amount), 0) AS volume
         FROM entries e
         JOIN transactions t ON t.id = e.transaction_id
         JOIN accounts a ON a.id = e.account_id
         WHERE t.group_id = ? AND t.type = 'trade' AND t.state = 'committed'
           AND t.committed_at >= ? AND a.currency_id = ? AND e.amount > 0`,
      )
      .get(groupId, sinceIso, currencyId) as { volume: number };
    return Promise.resolve(row.volume);
  }

  createCategory(input: { groupId: Id; name: string; parentId?: Id }): Promise<Category> {
    try {
      const category: Category = {
        id: uuidv7(),
        groupId: input.groupId,
        name: input.name,
      };
      if (input.parentId !== undefined) category.parentId = input.parentId;
      this.db
        .prepare('INSERT INTO categories (id, group_id, name, parent_id) VALUES (?, ?, ?, ?)')
        .run(category.id, category.groupId, category.name, input.parentId ?? null);
      return Promise.resolve(category);
    } catch (err) {
      return Promise.reject(err);
    }
  }

  getCategory(id: Id): Promise<Category> {
    const row = this.db.prepare('SELECT * FROM categories WHERE id = ?').get(id) as
      | CategoryRow
      | undefined;
    if (!row) return Promise.reject(new StorageError('NOT_FOUND', `category ${id} not found`));
    const category: Category = { id: row.id, groupId: row.group_id, name: row.name };
    if (row.parent_id !== null) category.parentId = row.parent_id;
    return Promise.resolve(category);
  }

  updateCategory(id: Id, patch: { name?: string; parentId?: Id }): Promise<Category> {
    try {
      const existing = this.db.prepare('SELECT id FROM categories WHERE id = ?').get(id) as
        | { id: string }
        | undefined;
      if (!existing) {
        throw new StorageError('NOT_FOUND', `category ${id} not found`);
      }
      if (patch.name !== undefined) {
        this.db.prepare('UPDATE categories SET name = ? WHERE id = ?').run(patch.name, id);
      }
      if (patch.parentId !== undefined) {
        this.db
          .prepare('UPDATE categories SET parent_id = ? WHERE id = ?')
          .run(patch.parentId, id);
      }
      return this.getCategory(id);
    } catch (err) {
      return Promise.reject(err);
    }
  }

  listCategories(groupId: Id): Promise<Category[]> {
    const rows = this.db
      .prepare('SELECT * FROM categories WHERE group_id = ? ORDER BY name')
      .all(groupId) as CategoryRow[];
    return Promise.resolve(
      rows.map((row) => {
        const category: Category = { id: row.id, groupId: row.group_id, name: row.name };
        if (row.parent_id !== null) category.parentId = row.parent_id;
        return category;
      }),
    );
  }

  createListing(input: {
    groupId: Id;
    memberId: Id;
    type: ListingType;
    title: string;
    description: string;
    categoryId: Id;
    priceAmount?: number;
    priceCurrencyId?: Id;
    rateText?: string;
    expiresAt?: string;
  }): Promise<Listing> {
    try {
      const id = uuidv7();
      const createdAt = now();
      this.db
        .prepare(
          `INSERT INTO listings (
             id, group_id, member_id, type, title, description, category_id,
             price_amount, price_currency_id, rate_text, status, expires_at,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
        )
        .run(
          id,
          input.groupId,
          input.memberId,
          input.type,
          input.title,
          input.description,
          input.categoryId,
          input.priceAmount ?? null,
          input.priceCurrencyId ?? null,
          input.rateText ?? null,
          input.expiresAt ?? null,
          createdAt,
          createdAt,
        );
      return Promise.resolve(this.loadListing(id));
    } catch (err) {
      return Promise.reject(err);
    }
  }

  getListing(id: Id): Promise<Listing> {
    try {
      return Promise.resolve(this.loadListing(id));
    } catch (err) {
      return Promise.reject(err);
    }
  }

  updateListing(
    id: Id,
    patch: Partial<{
      title: string;
      description: string;
      categoryId: Id;
      priceAmount: number;
      priceCurrencyId: Id;
      rateText: string;
      status: ListingStatus;
      expiresAt: string;
    }>,
  ): Promise<Listing> {
    try {
      this.loadListing(id);
      const sets: string[] = [];
      const values: (string | number)[] = [];
      const columns: [keyof typeof patch, string][] = [
        ['title', 'title'],
        ['description', 'description'],
        ['categoryId', 'category_id'],
        ['priceAmount', 'price_amount'],
        ['priceCurrencyId', 'price_currency_id'],
        ['rateText', 'rate_text'],
        ['status', 'status'],
        ['expiresAt', 'expires_at'],
      ];
      for (const [key, column] of columns) {
        const value = patch[key];
        if (value !== undefined) {
          sets.push(`${column} = ?`);
          values.push(value);
        }
      }
      if (sets.length > 0) {
        sets.push('updated_at = ?');
        values.push(now());
        this.db.prepare(`UPDATE listings SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
      }
      return Promise.resolve(this.loadListing(id));
    } catch (err) {
      return Promise.reject(err);
    }
  }

  listListings(
    groupId: Id,
    filter?: {
      type?: ListingType;
      categoryId?: Id;
      memberId?: Id;
      status?: ListingStatus;
    },
  ): Promise<Listing[]> {
    const clauses = ['group_id = ?'];
    const values: string[] = [groupId];
    if (filter?.status !== undefined) {
      clauses.push('status = ?');
      values.push(filter.status);
    }
    if (filter?.type !== undefined) {
      clauses.push('type = ?');
      values.push(filter.type);
    }
    if (filter?.categoryId !== undefined) {
      clauses.push('category_id = ?');
      values.push(filter.categoryId);
    }
    if (filter?.memberId !== undefined) {
      clauses.push('member_id = ?');
      values.push(filter.memberId);
    }
    const rows = this.db
      .prepare(`SELECT * FROM listings WHERE ${clauses.join(' AND ')} ORDER BY created_at, id`)
      .all(...values) as ListingRow[];
    return Promise.resolve(rows.map((row) => this.listingFromRow(row)));
  }

  // Purge (#18): the FTS delete trigger keeps the search index in sync.
  deleteListing(id: Id): Promise<void> {
    this.db.prepare('DELETE FROM listings WHERE id = ?').run(id);
    return Promise.resolve();
  }

  // --- CMS pages (decision #13, data-model §6) -------------------------------

  createPage(input: CreatePageInput): Promise<Page> {
    try {
      const id = uuidv7();
      const createdAt = now();
      this.db
        .prepare(
          `INSERT INTO pages (
             id, group_id, slug, title, body, visibility, position,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.groupId,
          input.slug,
          input.title,
          input.body,
          input.visibility,
          input.position ?? 0,
          createdAt,
          createdAt,
        );
      return Promise.resolve(this.loadPage(id));
    } catch (err) {
      if (isUniqueViolation(err)) {
        return Promise.reject(
          new StorageError('CONFLICT', `page slug '${input.slug}' already exists in the group`),
        );
      }
      return Promise.reject(err);
    }
  }

  getPage(id: Id): Promise<Page> {
    try {
      return Promise.resolve(this.loadPage(id));
    } catch (err) {
      return Promise.reject(err);
    }
  }

  pageBySlug(groupId: Id, slug: string): Promise<Page | undefined> {
    const row = this.db
      .prepare('SELECT * FROM pages WHERE group_id = ? AND slug = ?')
      .get(groupId, slug) as PageRow | undefined;
    return Promise.resolve(row ? this.pageFromRow(row) : undefined);
  }

  listPages(groupId: Id): Promise<Page[]> {
    const rows = this.db
      .prepare('SELECT * FROM pages WHERE group_id = ? ORDER BY position, slug')
      .all(groupId) as PageRow[];
    return Promise.resolve(rows.map((row) => this.pageFromRow(row)));
  }

  updatePage(
    id: Id,
    patch: Partial<{
      slug: string;
      title: string;
      body: string;
      visibility: PageVisibility;
      position: number;
    }>,
  ): Promise<Page> {
    try {
      this.loadPage(id);
      const sets: string[] = [];
      const values: (string | number)[] = [];
      const columns: [keyof typeof patch, string][] = [
        ['slug', 'slug'],
        ['title', 'title'],
        ['body', 'body'],
        ['visibility', 'visibility'],
        ['position', 'position'],
      ];
      for (const [key, column] of columns) {
        const value = patch[key];
        if (value !== undefined) {
          sets.push(`${column} = ?`);
          values.push(value);
        }
      }
      if (sets.length > 0) {
        sets.push('updated_at = ?');
        values.push(now());
        this.db.prepare(`UPDATE pages SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
      }
      return Promise.resolve(this.loadPage(id));
    } catch (err) {
      if (isUniqueViolation(err)) {
        return Promise.reject(
          new StorageError('CONFLICT', `page slug '${patch.slug}' already exists in the group`),
        );
      }
      return Promise.reject(err);
    }
  }

  deletePage(id: Id): Promise<void> {
    this.db.prepare('DELETE FROM pages WHERE id = ?').run(id);
    return Promise.resolve();
  }

  // --- News items (decision #13, data-model §6) -------------------------------

  createNewsItem(input: CreateNewsItemInput): Promise<NewsItem> {
    try {
      const id = uuidv7();
      const createdAt = now();
      this.db
        .prepare(
          `INSERT INTO news_items (
             id, group_id, title, body, published_at, expires_at,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.groupId,
          input.title,
          input.body,
          input.publishedAt,
          input.expiresAt ?? null,
          createdAt,
          createdAt,
        );
      return Promise.resolve(this.loadNewsItem(id));
    } catch (err) {
      return Promise.reject(err);
    }
  }

  getNewsItem(id: Id): Promise<NewsItem> {
    try {
      return Promise.resolve(this.loadNewsItem(id));
    } catch (err) {
      return Promise.reject(err);
    }
  }

  listNews(groupId: Id, filter: { currentAt?: string }): Promise<NewsItem[]> {
    const conditions = ['group_id = ?'];
    const values: string[] = [groupId];
    if (filter.currentAt !== undefined) {
      // Current items only: already published, not yet expired.
      conditions.push('published_at <= ?', '(expires_at IS NULL OR expires_at > ?)');
      values.push(filter.currentAt, filter.currentAt);
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM news_items WHERE ${conditions.join(' AND ')}
         ORDER BY published_at DESC`,
      )
      .all(...values) as NewsItemRow[];
    return Promise.resolve(rows.map((row) => this.newsItemFromRow(row)));
  }

  updateNewsItem(
    id: Id,
    patch: Partial<{
      title: string;
      body: string;
      publishedAt: string;
      expiresAt: string;
    }>,
  ): Promise<NewsItem> {
    try {
      this.loadNewsItem(id);
      const sets: string[] = [];
      const values: string[] = [];
      const columns: [keyof typeof patch, string][] = [
        ['title', 'title'],
        ['body', 'body'],
        ['publishedAt', 'published_at'],
        ['expiresAt', 'expires_at'],
      ];
      for (const [key, column] of columns) {
        const value = patch[key];
        if (value !== undefined) {
          sets.push(`${column} = ?`);
          values.push(value);
        }
      }
      if (sets.length > 0) {
        sets.push('updated_at = ?');
        values.push(now());
        this.db
          .prepare(`UPDATE news_items SET ${sets.join(', ')} WHERE id = ?`)
          .run(...values, id);
      }
      return Promise.resolve(this.loadNewsItem(id));
    } catch (err) {
      return Promise.reject(err);
    }
  }

  deleteNewsItem(id: Id): Promise<void> {
    this.db.prepare('DELETE FROM news_items WHERE id = ?').run(id);
    return Promise.resolve();
  }

  // --- Images (decision #14) ---------------------------------------------------

  createImage(input: CreateImageInput): Promise<Image> {
    try {
      const id = uuidv7();
      this.db
        .prepare(
          `INSERT INTO images (
             id, group_id, owner_kind, owner_id, mime, size, blob,
             created_by, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.groupId,
          input.ownerKind,
          input.ownerId ?? null,
          input.mime,
          input.data.length,
          input.data,
          input.createdBy,
          now(),
        );
      return Promise.resolve(this.loadImage(id));
    } catch (err) {
      return Promise.reject(err);
    }
  }

  getImage(id: Id): Promise<Image> {
    try {
      return Promise.resolve(this.loadImage(id));
    } catch (err) {
      return Promise.reject(err);
    }
  }

  imageData(id: Id): Promise<Buffer> {
    const row = this.db
      .prepare('SELECT blob FROM images WHERE id = ?')
      .get(id) as { blob: Buffer } | undefined;
    if (!row) return Promise.reject(new StorageError('NOT_FOUND', `image ${id} not found`));
    return Promise.resolve(row.blob);
  }

  listImages(groupId: Id, filter: ImageFilter): Promise<Image[]> {
    const conditions = ['group_id = ?'];
    const values: string[] = [groupId];
    if (filter.ownerKind !== undefined) {
      conditions.push('owner_kind = ?');
      values.push(filter.ownerKind);
    }
    if (filter.ownerId !== undefined) {
      conditions.push('owner_id = ?');
      values.push(filter.ownerId);
    }
    // Metadata columns only, never the blob (#14): a list query must not
    // drag every image's bytes through memory.
    const rows = this.db
      .prepare(
        `SELECT ${IMAGE_COLUMNS} FROM images WHERE ${conditions.join(' AND ')}
         ORDER BY created_at, id`,
      )
      .all(...values) as ImageRow[];
    return Promise.resolve(rows.map((row) => this.imageFromRow(row)));
  }

  deleteImage(id: Id): Promise<void> {
    this.db.prepare('DELETE FROM images WHERE id = ?').run(id);
    return Promise.resolve();
  }

  imagesTotalSize(groupId: Id): Promise<number> {
    const row = this.db
      .prepare('SELECT COALESCE(SUM(size), 0) AS total FROM images WHERE group_id = ?')
      .get(groupId) as { total: number };
    return Promise.resolve(row.total);
  }

  // Audit trail (data-model §8). Append-only: deliberately no update or
  // delete methods — an audit event, once written, is immutable.
  appendAuditEvent(input: AppendAuditEventInput): Promise<AuditEvent> {
    const event: AuditEvent = {
      id: uuidv7(),
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      at: input.at,
    };
    if (input.groupId !== undefined) event.groupId = input.groupId;
    if (input.actorUserId !== undefined) event.actorUserId = input.actorUserId;
    if (input.actingForMemberId !== undefined) {
      event.actingForMemberId = input.actingForMemberId;
    }
    if (input.detail !== undefined) event.detail = input.detail;
    this.db
      .prepare(
        `INSERT INTO audit_events
           (id, group_id, actor_user_id, acting_for_member_id,
            action, entity_type, entity_id, detail, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.id,
        event.groupId ?? null,
        event.actorUserId ?? null,
        event.actingForMemberId ?? null,
        event.action,
        event.entityType,
        event.entityId,
        event.detail === undefined ? null : JSON.stringify(event.detail),
        event.at,
      );
    return Promise.resolve(event);
  }

  listAuditEvents(
    groupId: Id,
    filter: AuditEventFilter,
  ): Promise<{ events: AuditEvent[]; total: number }> {
    const clauses = ['group_id = ?'];
    const values: (string | number)[] = [groupId];
    if (filter.action !== undefined) {
      clauses.push('action = ?');
      values.push(filter.action);
    }
    if (filter.entityType !== undefined) {
      clauses.push('entity_type = ?');
      values.push(filter.entityType);
    }
    if (filter.entityId !== undefined) {
      clauses.push('entity_id = ?');
      values.push(filter.entityId);
    }
    if (filter.actorUserId !== undefined) {
      clauses.push('actor_user_id = ?');
      values.push(filter.actorUserId);
    }
    const where = clauses.join(' AND ');
    const { total } = this.db
      .prepare(`SELECT COUNT(*) AS total FROM audit_events WHERE ${where}`)
      .get(...values) as { total: number };
    const limit = Math.min(filter.limit ?? 50, 200);
    const offset = filter.offset ?? 0;
    const rows = this.db
      .prepare(
        // Newest first; id DESC breaks `at` ties so pagination is stable.
        `SELECT * FROM audit_events WHERE ${where}
         ORDER BY at DESC, id DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...values, limit, offset) as AuditEventRow[];
    return Promise.resolve({
      events: rows.map((row) => this.auditEventFromRow(row)),
      total,
    });
  }

  // --- Generic search (data-model Search interface) ---------------------------

  search(
    groupId: Id,
    domain: SearchDomain,
    query: SearchQuery,
  ): Promise<{ items: SearchResult[]; total: number }> {
    const empty = { items: [] as SearchResult[], total: 0 };
    // The directory is member-tier content: public callers get an empty page.
    if (domain === 'directory' && query.visibility === 'public') {
      return Promise.resolve(empty);
    }
    const match = ftsMatch(query.text);
    if (match === undefined) return Promise.resolve(empty);
    // Tier rules live here, against the live source row — the FTS index
    // carries text only, so status/visibility flips need no index write.
    let join: string;
    const joinValues: string[] = [];
    switch (domain) {
      case 'listings':
        join = "JOIN listings d ON d.id = s.entity_id AND d.status = 'active'";
        break;
      case 'directory':
        join = "JOIN members d ON d.id = s.entity_id AND d.status = 'active'";
        break;
      case 'pages': {
        const tiers =
          query.visibility === 'admin'
            ? ['public', 'members', 'admin']
            : query.visibility === 'member'
              ? ['public', 'members']
              : ['public'];
        join = `JOIN pages d ON d.id = s.entity_id
                AND d.visibility IN (${tiers.map(() => '?').join(', ')})`;
        joinValues.push(...tiers);
        break;
      }
      case 'news': {
        // Rows store ISO 8601 strings, so lexical comparison is time order.
        const nowIso = now();
        join = `JOIN news_items d ON d.id = s.entity_id
                AND d.published_at <= ? AND (d.expires_at IS NULL OR d.expires_at > ?)`;
        joinValues.push(nowIso, nowIso);
        break;
      }
    }
    const from = `FROM search_index s ${join}
                  WHERE s.domain = ? AND s.group_id = ? AND search_index MATCH ?`;
    const values = [...joinValues, domain, groupId, match];
    const { total } = this.db
      .prepare(`SELECT COUNT(*) AS total ${from}`)
      .get(...values) as { total: number };
    const limit = Math.min(query.limit ?? 20, 100);
    const offset = query.offset ?? 0;
    const rows = this.db
      .prepare(
        // Best match first; entity_id DESC (uuidv7 = creation order) breaks
        // rank ties newest-first and keeps pagination stable.
        `SELECT s.entity_id AS id, s.title AS title,
                snippet(search_index, -1, '', '', '…', 12) AS snippet
         ${from}
         ORDER BY bm25(search_index), s.entity_id DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...values, limit, offset) as { id: string; title: string; snippet: string }[];
    const items = rows.map((row) => {
      const result: SearchResult = { domain, id: row.id, title: row.title };
      if (row.snippet !== '') result.snippet = row.snippet;
      return result;
    });
    return Promise.resolve({ items, total });
  }

  // SQLite's online backup API: safe against a live database.
  async backup(destPath: string): Promise<void> {
    await this.db.backup(destPath);
  }

  close(): void {
    this.db.close();
  }

  // --- private ---------------------------------------------------------------

  private accountFromRow(row: AccountRow): Account {
    const account: Account = {
      id: row.id,
      groupId: row.group_id,
      currencyId: row.currency_id,
      type: row.type as Account['type'],
      createdAt: row.created_at,
    };
    if (row.member_id !== null) account.memberId = row.member_id;
    if (row.counterparty_ref !== null) account.counterpartyRef = row.counterparty_ref;
    if (row.closed_at !== null) account.closedAt = row.closed_at;
    return account;
  }

  private currencyFromRow(row: CurrencyRow): Currency {
    const currency: Currency = {
      id: row.id,
      groupId: row.group_id,
      code: row.code,
      name: row.name,
      scale: row.scale,
      createdAt: row.created_at,
    };
    if (row.demurrage_day !== null) currency.demurrageDay = row.demurrage_day;
    return currency;
  }

  private memberFromRow(row: MemberRow): Member {
    const member: Member = {
      id: row.id,
      groupId: row.group_id,
      memberNo: row.member_no,
      type: row.type as MemberType,
      role: row.role as MemberRole,
      displayName: row.display_name,
      status: row.status as MemberStatus,
      confirmIncoming: row.confirm_incoming !== 0,
      digestFrequency: row.digest_frequency as DigestFrequency,
      appliedAt: row.applied_at,
    };
    if (row.approved_at !== null) member.approvedAt = row.approved_at;
    if (row.closed_at !== null) member.closedAt = row.closed_at;
    return member;
  }

  private policyFromRow(row: CreditPolicyRow): CreditPolicy {
    return {
      id: row.id,
      groupId: row.group_id,
      currencyId: row.currency_id,
      type: row.type as CreditPolicyType,
      config: JSON.parse(row.config) as CreditPolicyConfig,
      enabled: row.enabled !== 0,
    };
  }

  private auditEventFromRow(row: AuditEventRow): AuditEvent {
    const event: AuditEvent = {
      id: row.id,
      action: row.action,
      entityType: row.entity_type,
      entityId: row.entity_id,
      at: row.at,
    };
    if (row.group_id !== null) event.groupId = row.group_id;
    if (row.actor_user_id !== null) event.actorUserId = row.actor_user_id;
    if (row.acting_for_member_id !== null) {
      event.actingForMemberId = row.acting_for_member_id;
    }
    if (row.detail !== null) event.detail = JSON.parse(row.detail) as Record<string, unknown>;
    return event;
  }

  private userFromRow(row: UserRow): User {
    const user: User = {
      id: row.id,
      email: row.email,
      status: row.status as User['status'],
      isOperator: row.is_operator !== 0,
      createdAt: row.created_at,
    };
    if (row.email_verified_at !== null) user.emailVerifiedAt = row.email_verified_at;
    return user;
  }

  private groupFromRow(row: GroupRow): Group {
    const group: Group = {
      id: row.id,
      slug: row.slug,
      name: row.name,
      createdAt: row.created_at,
    };
    if (row.email_from !== null) group.emailFrom = row.email_from;
    if (row.settings !== null) group.settings = JSON.parse(row.settings) as GroupSettings;
    return group;
  }

  private loadGroup(id: Id): Group {
    const row = this.db
      .prepare('SELECT * FROM groups WHERE id = ?')
      .get(id) as GroupRow | undefined;
    if (!row) throw new StorageError('NOT_FOUND', `group ${id} not found`);
    return this.groupFromRow(row);
  }

  private apiTokenFromRow(row: ApiTokenRow): ApiToken {
    const token: ApiToken = {
      id: row.id,
      memberId: row.member_id,
      createdBy: row.created_by,
      label: row.label,
      scopes: JSON.parse(row.scopes) as ApiScope[],
      createdAt: row.created_at,
    };
    if (row.max_tx_amount !== null) token.maxTxAmount = row.max_tx_amount;
    if (row.max_period_amount !== null) token.maxPeriodAmount = row.max_period_amount;
    if (row.period_days !== null) token.periodDays = row.period_days;
    if (row.expires_at !== null) token.expiresAt = row.expires_at;
    if (row.revoked_at !== null) token.revokedAt = row.revoked_at;
    if (row.last_used_at !== null) token.lastUsedAt = row.last_used_at;
    return token;
  }

  private loadMember(id: Id): Member {
    const row = this.db
      .prepare('SELECT * FROM members WHERE id = ?')
      .get(id) as MemberRow | undefined;
    if (!row) throw new StorageError('NOT_FOUND', `member ${id} not found`);
    return this.memberFromRow(row);
  }

  private listingFromRow(row: ListingRow): Listing {
    const listing: Listing = {
      id: row.id,
      groupId: row.group_id,
      memberId: row.member_id,
      type: row.type as ListingType,
      title: row.title,
      description: row.description,
      categoryId: row.category_id,
      status: row.status as ListingStatus,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
    if (row.price_amount !== null) listing.priceAmount = row.price_amount;
    if (row.price_currency_id !== null) listing.priceCurrencyId = row.price_currency_id;
    if (row.rate_text !== null) listing.rateText = row.rate_text;
    if (row.expires_at !== null) listing.expiresAt = row.expires_at;
    return listing;
  }

  private loadListing(id: Id): Listing {
    const row = this.db
      .prepare('SELECT * FROM listings WHERE id = ?')
      .get(id) as ListingRow | undefined;
    if (!row) throw new StorageError('NOT_FOUND', `listing ${id} not found`);
    return this.listingFromRow(row);
  }

  private pageFromRow(row: PageRow): Page {
    return {
      id: row.id,
      groupId: row.group_id,
      slug: row.slug,
      title: row.title,
      body: row.body,
      visibility: row.visibility as PageVisibility,
      position: row.position,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private loadPage(id: Id): Page {
    const row = this.db
      .prepare('SELECT * FROM pages WHERE id = ?')
      .get(id) as PageRow | undefined;
    if (!row) throw new StorageError('NOT_FOUND', `page ${id} not found`);
    return this.pageFromRow(row);
  }

  private newsItemFromRow(row: NewsItemRow): NewsItem {
    const item: NewsItem = {
      id: row.id,
      groupId: row.group_id,
      title: row.title,
      body: row.body,
      publishedAt: row.published_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
    if (row.expires_at !== null) item.expiresAt = row.expires_at;
    return item;
  }

  private loadNewsItem(id: Id): NewsItem {
    const row = this.db
      .prepare('SELECT * FROM news_items WHERE id = ?')
      .get(id) as NewsItemRow | undefined;
    if (!row) throw new StorageError('NOT_FOUND', `news item ${id} not found`);
    return this.newsItemFromRow(row);
  }

  private imageFromRow(row: ImageRow): Image {
    const image: Image = {
      id: row.id,
      groupId: row.group_id,
      ownerKind: row.owner_kind as ImageOwnerKind,
      mime: row.mime,
      size: row.size,
      createdBy: row.created_by,
      createdAt: row.created_at,
    };
    if (row.owner_id !== null) image.ownerId = row.owner_id;
    return image;
  }

  /** Image metadata by id (#14): the blob column is never selected here. */
  private loadImage(id: Id): Image {
    const row = this.db
      .prepare(`SELECT ${IMAGE_COLUMNS} FROM images WHERE id = ?`)
      .get(id) as ImageRow | undefined;
    if (!row) throw new StorageError('NOT_FOUND', `image ${id} not found`);
    return this.imageFromRow(row);
  }

  private runFromRow(row: DemurrageRunRow): DemurrageRun {
    const run: DemurrageRun = {
      id: row.id,
      groupId: row.group_id,
      currencyId: row.currency_id,
      period: row.period,
      status: row.status as DemurrageRun['status'],
      startedAt: row.started_at,
    };
    if (row.completed_at !== null) run.completedAt = row.completed_at;
    return run;
  }

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
