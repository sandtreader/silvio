// Password reset & email verification (data-model §1, todo: Membership &
// identity). Token hygiene mirrors auth.ts's sessions: opaque randomBytes
// values, sha256-hashed at rest, here single-use (usedAt) with expiry. The
// emails ride the #16 template pathway but are rendered here rather than via
// notifications' enqueueForMember: the recipient is a user, not necessarily
// a member. Requesting a reset never discloses whether an email has an
// account, and token failures share one message — no oracle.

import { createHash, randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import type { Storage } from '../storage/interface.js';
import type { Id, OneTimeToken, OneTimeTokenPurpose, User } from '../types.js';
import { DomainError } from './errors.js';
import { MIN_PASSWORD_LENGTH } from './auth.js';
import { effectiveEmailTemplate, renderTemplate } from './emailtemplates.js';

const RESET_TTL_MS = 60 * 60 * 1000; // one hour
const VERIFY_TTL_MS = 7 * 24 * 60 * 60 * 1000; // seven days

// One message for unknown, wrong-purpose, used, and expired tokens alike.
const BAD_TOKEN = 'this link is invalid, expired or already used';

function sha256(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface RequestPasswordResetInput {
  groupId: Id;
  email: string;
  baseUrl: string; // scheme://host the emailed link points back at
  now?: string;
}

export interface SendEmailVerificationInput {
  groupId: Id;
  userId: Id;
  baseUrl: string;
  now?: string;
}

/**
 * Render the group's effective template for the kind (#16) and enqueue the
 * email directly. personId is the user's person in this group when one
 * exists, else the user id — person_id is deliberately loose (no FK). The
 * dedup key is unique per minted token, so every request sends its own link.
 */
async function sendTokenEmail(
  storage: Storage,
  opts: {
    groupId: Id;
    userId: Id;
    toEmail: string;
    kind: 'password_reset' | 'email_verify';
    tokenId: Id;
    urlVar: 'resetUrl' | 'verifyUrl';
    url: string;
    nowIso: string;
  },
): Promise<void> {
  // No getGroup on the interface; look it up as notifications.ts does.
  const group = (await storage.listGroups()).find((candidate) => candidate.id === opts.groupId);
  const template = await effectiveEmailTemplate(storage, opts.groupId, opts.kind);
  const vars: Record<string, string> = {
    groupName: group?.name ?? 'the group',
    [opts.urlVar]: opts.url,
  };
  const members = await storage.membersForUser(opts.userId);
  const member = members.find((candidate) => candidate.groupId === opts.groupId);
  const persons = member === undefined ? [] : await storage.personsForMember(member.id);
  const person = persons.find((candidate) => candidate.userId === opts.userId);
  await storage.enqueueEmail({
    groupId: opts.groupId,
    personId: person?.id ?? opts.userId,
    kind: opts.kind,
    dedupKey: `${opts.kind}:${opts.tokenId}`,
    toEmail: opts.toEmail,
    subject: renderTemplate(template.subject, vars),
    body: renderTemplate(template.body, vars).trimEnd(),
    // Snapshot the group sender (#16); absent falls back at delivery.
    ...(group?.emailFrom !== undefined ? { fromEmail: group.emailFrom } : {}),
    createdAt: opts.nowIso,
  });
}

/** Look up by hash and validate purpose/single-use/expiry; INVALID otherwise. */
async function liveToken(
  storage: Storage,
  rawToken: string,
  purpose: OneTimeTokenPurpose,
  nowIso: string,
): Promise<{ token: OneTimeToken; userId: Id }> {
  const token = await storage.oneTimeTokenByHash(sha256(rawToken));
  if (
    token === undefined ||
    token.purpose !== purpose ||
    token.usedAt !== undefined ||
    token.expiresAt <= nowIso ||
    token.userId === undefined
  ) {
    throw new DomainError('INVALID', BAD_TOKEN);
  }
  return { token, userId: token.userId };
}

/** Email a single-use reset link; a silent no-op for unknown emails (§1). */
export async function requestPasswordReset(
  storage: Storage,
  input: RequestPasswordResetInput,
): Promise<void> {
  const creds = await storage.credentialsForEmail(input.email);
  if (creds === undefined) return; // no account enumeration
  const nowIso = input.now ?? new Date().toISOString();
  const raw = randomBytes(32).toString('hex');
  const token = await storage.createOneTimeToken({
    userId: creds.user.id,
    email: input.email,
    purpose: 'password_reset',
    tokenHash: sha256(raw),
    expiresAt: new Date(Date.parse(nowIso) + RESET_TTL_MS).toISOString(),
  });
  await sendTokenEmail(storage, {
    groupId: input.groupId,
    userId: creds.user.id,
    toEmail: input.email,
    kind: 'password_reset',
    tokenId: token.id,
    urlVar: 'resetUrl',
    url: `${input.baseUrl}/app/reset?token=${raw}`,
    nowIso,
  });
}

/** Consume an emailed reset token; a reset invalidates every open session. */
export async function resetPassword(
  storage: Storage,
  rawToken: string,
  newPassword: string,
  now?: string,
): Promise<void> {
  const nowIso = now ?? new Date().toISOString();
  const { token, userId } = await liveToken(storage, rawToken, 'password_reset', nowIso);
  // Same rule as auth.register — the reset form is a way to set a password.
  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    throw new DomainError(
      'INVALID',
      `password must be at least ${MIN_PASSWORD_LENGTH} characters`,
    );
  }
  const passwordHash = await argon2.hash(newPassword); // argon2id, as register
  await storage.updateUserPassword(userId, passwordHash);
  await storage.markOneTimeTokenUsed(token.id, nowIso);
  await storage.revokeSessionsForUser(userId);
}

/** Email a verification link for the user's login email (data-model §1). */
export async function sendEmailVerification(
  storage: Storage,
  input: SendEmailVerificationInput,
): Promise<void> {
  const user = await storage.getUser(input.userId);
  const nowIso = input.now ?? new Date().toISOString();
  const raw = randomBytes(32).toString('hex');
  const token = await storage.createOneTimeToken({
    userId: user.id,
    email: user.email,
    purpose: 'email_verify',
    tokenHash: sha256(raw),
    expiresAt: new Date(Date.parse(nowIso) + VERIFY_TTL_MS).toISOString(),
  });
  await sendTokenEmail(storage, {
    groupId: input.groupId,
    userId: user.id,
    toEmail: user.email,
    kind: 'email_verify',
    tokenId: token.id,
    urlVar: 'verifyUrl',
    url: `${input.baseUrl}/app/verify?token=${raw}`,
    nowIso,
  });
}

/** Consume an emailed verification token, stamping the user (§1). */
export async function verifyEmail(
  storage: Storage,
  rawToken: string,
  now?: string,
): Promise<User> {
  const nowIso = now ?? new Date().toISOString();
  const { token, userId } = await liveToken(storage, rawToken, 'email_verify', nowIso);
  await storage.markOneTimeTokenUsed(token.id, nowIso);
  return storage.markUserEmailVerified(userId, nowIso);
}
