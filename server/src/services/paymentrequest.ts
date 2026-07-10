// Signed QR payment requests (#22): the payee mints a compact payload signed
// with a per-group secret that never leaves the server; the payer's app
// decodes it for a trustworthy confirm screen and pays via /payments/scan.
// Wire format: base64url(JSON claims) + '.' + base64url(HMAC-SHA256 over the
// exact base64url body, keyed by the group's qr_secret).

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Storage } from '../storage/interface.js';
import type { Id, Transaction } from '../types.js';
import { DomainError } from './errors.js';
import { sendPayment } from './trading.js';

/** Signed claims (#22). Short keys keep the QR small. */
interface QrClaims {
  v: 1;
  g: Id; // group
  p: Id; // payee member
  c: Id; // currency
  a?: number; // amount (minor units); absent = payer supplies one
  r?: string; // reference
  e?: string; // expiresAt ISO; absent = a printed code keeps working
  n: string; // nonce — the idempotency handle
}

export interface MintPaymentRequestInput {
  currencyId: Id;
  amount?: number;
  reference?: string;
  expiresAt?: string;
}

export interface DecodedPaymentRequest {
  payeeMemberId: Id;
  payeeName: string;
  currencyId: Id;
  amount?: number;
  reference?: string;
  expiresAt?: string;
  nonce: string;
}

function hmac(body: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(body).digest();
}

const invalid = (message: string): DomainError => new DomainError('INVALID', message);

/** Structural check on parsed claims — anything off is a forgery or garbage. */
function isQrClaims(value: unknown): value is QrClaims {
  if (typeof value !== 'object' || value === null) return false;
  const claims = value as Record<string, unknown>;
  return (
    claims.v === 1 &&
    typeof claims.g === 'string' &&
    typeof claims.p === 'string' &&
    typeof claims.c === 'string' &&
    typeof claims.n === 'string' &&
    (claims.a === undefined || typeof claims.a === 'number') &&
    (claims.r === undefined || typeof claims.r === 'string') &&
    (claims.e === undefined || typeof claims.e === 'string')
  );
}

/** Mint a signed payment request for the member (the payee). */
export async function mintPaymentRequest(
  storage: Storage,
  memberId: Id,
  input: MintPaymentRequestInput,
): Promise<{ payload: string }> {
  const member = await storage.getMember(memberId);
  const currencies = await storage.listCurrencies(member.groupId);
  if (!currencies.some((currency) => currency.id === input.currencyId)) {
    throw invalid('the currency does not belong to this group');
  }
  if (input.amount !== undefined && (!Number.isSafeInteger(input.amount) || input.amount <= 0)) {
    throw invalid(`amount must be a positive integer, got ${input.amount}`);
  }
  const claims: QrClaims = {
    v: 1,
    g: member.groupId,
    p: memberId,
    c: input.currencyId,
    n: randomUUID(),
  };
  if (input.amount !== undefined) claims.a = input.amount;
  if (input.reference !== undefined) claims.r = input.reference;
  if (input.expiresAt !== undefined) claims.e = input.expiresAt;
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const secret = await storage.groupQrSecret(member.groupId);
  return { payload: `${body}.${hmac(body, secret).toString('base64url')}` };
}

/**
 * Verify and decode a payload against a group (#22). Everything returned is
 * trustworthy: a bad signature, another group's payload, an expired request
 * or a vanished payee all reject with INVALID.
 */
export async function decodePaymentRequest(
  storage: Storage,
  groupId: Id,
  payload: string,
  nowIso?: string,
): Promise<DecodedPaymentRequest> {
  const parts = payload.split('.');
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '') {
    throw invalid('this is not a valid payment request');
  }
  const [body, signature] = parts as [string, string];
  const expected = hmac(body, await storage.groupQrSecret(groupId));
  const provided = Buffer.from(signature, 'base64url');
  // Constant-time compare; a length mismatch is already a bad signature.
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw invalid('this payment request failed verification');
  }
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(body, 'base64url').toString());
  } catch {
    throw invalid('this is not a valid payment request');
  }
  if (!isQrClaims(claims)) throw invalid('this is not a valid payment request');
  if (claims.g !== groupId) throw invalid('this payment request belongs to another group');
  if (claims.e !== undefined && claims.e <= (nowIso ?? new Date().toISOString())) {
    throw invalid('this payment request has expired');
  }
  let payeeName: string;
  try {
    payeeName = (await storage.getMember(claims.p)).displayName;
  } catch {
    throw invalid('the payee of this request no longer exists');
  }
  const decoded: DecodedPaymentRequest = {
    payeeMemberId: claims.p,
    payeeName,
    currencyId: claims.c,
    nonce: claims.n,
  };
  if (claims.a !== undefined) decoded.amount = claims.a;
  if (claims.r !== undefined) decoded.reference = claims.r;
  if (claims.e !== undefined) decoded.expiresAt = claims.e;
  return decoded;
}

/**
 * Pay a scanned request (#22): an ordinary committed trade, except the
 * payee's confirm-incoming does not hold it (they minted the request) and
 * the nonce makes a double scan idempotent per payer.
 */
export async function scanPayment(
  storage: Storage,
  payerMemberId: Id,
  payload: string,
  amount?: number,
  nowIso?: string,
): Promise<Transaction> {
  const payer = await storage.getMember(payerMemberId);
  const decoded = await decodePaymentRequest(storage, payer.groupId, payload, nowIso);
  if (decoded.payeeMemberId === payerMemberId) {
    throw invalid('you cannot pay yourself');
  }
  if (decoded.amount !== undefined && amount !== undefined && amount !== decoded.amount) {
    throw invalid('the amount does not match the request');
  }
  const effectiveAmount = decoded.amount ?? amount;
  if (effectiveAmount === undefined) throw invalid('this request needs an amount');
  // actorPersonId mirrors the /payments route convention (the session user's
  // id); scans are cookie-only, so the payer's linked user is the actor.
  const persons = await storage.personsForMember(payerMemberId);
  const actorUserId = (persons.find((person) => person.isPrimary) ?? persons[0])?.userId;
  if (actorUserId === undefined) {
    throw new DomainError('NOT_AUTHORISED', 'this member has no linked user');
  }
  const input: Parameters<typeof sendPayment>[1] = {
    groupId: payer.groupId,
    payerMemberId,
    payeeMemberId: decoded.payeeMemberId,
    currencyId: decoded.currencyId,
    amount: effectiveAmount,
    actorPersonId: actorUserId,
    channel: 'web',
    // The payee consented by minting the request (#22): no confirm-incoming
    // hold. Double scans replay the original transaction via the nonce key.
    bypassHold: true,
    idempotencyKey: `qr:${decoded.nonce}:${payerMemberId}`,
  };
  if (decoded.reference !== undefined) input.description = decoded.reference;
  return sendPayment(storage, input);
}
