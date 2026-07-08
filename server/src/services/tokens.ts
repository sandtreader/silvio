// API token service (decision #9): personal access tokens acting as one
// membership, with member-granted scopes. Raw tokens are shown once and
// sha256-hashed at rest, like session tokens. trade:autonomous requires a
// per-transaction cap at grant time; rolling spend is computed from the
// journal (transactions.api_token_id), never a counter.

import { createHash, randomBytes } from 'node:crypto';
import type { Storage } from '../storage/interface.js';
import type { ApiScope, ApiToken, Id, Member } from '../types.js';
import { API_SCOPES } from '../types.js';
import { DomainError } from './errors.js';

const TOKEN_BYTES = 32; // 64 hex chars after the slv_ prefix

function sha256(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface IssueTokenInput {
  memberId: Id;
  createdBy: Id; // person
  label: string;
  scopes: ApiScope[];
  maxTxAmount?: number;
  maxPeriodAmount?: number;
  periodDays?: number;
  expiresAt?: string;
}

/** The raw token (prefix 'slv_', shown exactly once) plus its stored record. */
export async function issueApiToken(
  storage: Storage,
  input: IssueTokenInput,
): Promise<{ token: string; apiToken: ApiToken }> {
  if (input.label.trim() === '') {
    throw new DomainError('INVALID', 'a token label is required');
  }
  if (input.scopes.length === 0) {
    throw new DomainError('INVALID', 'at least one scope is required');
  }
  for (const scope of input.scopes) {
    if (!API_SCOPES.includes(scope)) {
      throw new DomainError('INVALID', `unknown scope: ${scope}`);
    }
  }
  // trade:autonomous is bounded by construction (decision #9): a token that
  // can commit trades must carry a per-transaction cap from the start.
  if (input.scopes.includes('trade:autonomous') && input.maxTxAmount === undefined) {
    throw new DomainError('INVALID', 'trade:autonomous requires maxTxAmount');
  }
  if ((input.maxPeriodAmount === undefined) !== (input.periodDays === undefined)) {
    throw new DomainError(
      'INVALID',
      'a rolling period cap needs both maxPeriodAmount and periodDays',
    );
  }
  const token = `slv_${randomBytes(TOKEN_BYTES).toString('hex')}`;
  const createInput: Parameters<Storage['createApiToken']>[0] = {
    memberId: input.memberId,
    createdBy: input.createdBy,
    tokenHash: sha256(token),
    label: input.label,
    scopes: input.scopes,
  };
  if (input.maxTxAmount !== undefined) createInput.maxTxAmount = input.maxTxAmount;
  if (input.maxPeriodAmount !== undefined) createInput.maxPeriodAmount = input.maxPeriodAmount;
  if (input.periodDays !== undefined) createInput.periodDays = input.periodDays;
  if (input.expiresAt !== undefined) createInput.expiresAt = input.expiresAt;
  const apiToken = await storage.createApiToken(createInput);
  return { token, apiToken };
}

/**
 * Resolve a raw bearer token to its live token + member; undefined for
 * unknown, revoked, or expired tokens. Touches lastUsedAt on success.
 */
export async function authenticateApiToken(
  storage: Storage,
  raw: string,
): Promise<{ token: ApiToken; member: Member } | undefined> {
  const token = await storage.apiTokenByHash(sha256(raw)); // unrevoked only
  if (!token) return undefined;
  const nowIso = new Date().toISOString();
  if (token.expiresAt !== undefined && token.expiresAt <= nowIso) return undefined;
  await storage.touchApiToken(token.id, nowIso);
  token.lastUsedAt = nowIso;
  return { token, member: await storage.getMember(token.memberId) };
}

/**
 * trade:autonomous caps (decision #9): amount within maxTxAmount, and the
 * rolling-period spend (journal-derived) within maxPeriodAmount. Throws
 * LIMIT_BREACHED with the specific rule in the message.
 */
export async function checkTokenCaps(
  storage: Storage,
  token: ApiToken,
  amount: number,
  nowIso: string,
): Promise<void> {
  if (token.maxTxAmount !== undefined && amount > token.maxTxAmount) {
    throw new DomainError(
      'LIMIT_BREACHED',
      `amount ${amount} exceeds this token's per-transaction cap of ${token.maxTxAmount}`,
    );
  }
  if (token.maxPeriodAmount !== undefined && token.periodDays !== undefined) {
    const since = new Date(
      Date.parse(nowIso) - token.periodDays * 86_400_000,
    ).toISOString();
    const spent = await storage.tokenSpend(token.id, since);
    if (spent + amount > token.maxPeriodAmount) {
      throw new DomainError(
        'LIMIT_BREACHED',
        `amount ${amount} would take this token's ${token.periodDays}-day spend to ` +
          `${spent + amount}, over its rolling cap of ${token.maxPeriodAmount}`,
      );
    }
  }
}
