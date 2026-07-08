// Auth service (decision #2, data-model §1): global user identity, group-
// scoped sessions. Passwords are argon2id-hashed; session tokens are opaque
// random values, sha256-hashed at rest, server-side revocable.

import { createHash, randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import type { Storage } from '../storage/interface.js';
import type { Id, Member, Session, User } from '../types.js';
import { DomainError } from './errors.js';

const MIN_PASSWORD_LENGTH = 8;
const SESSION_DAYS = 30;

// One message for unknown email and wrong password — no account enumeration.
const BAD_CREDENTIALS = 'email or password is incorrect';

export interface RegisterInput {
  email: string;
  password: string;
}

export interface LoginInput {
  email: string;
  password: string;
  groupId: Id;
}

export interface AuthContext {
  user: User;
  session: Session;
  member?: Member;
}

function sha256(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function register(storage: Storage, input: RegisterInput): Promise<User> {
  if (input.password.length < MIN_PASSWORD_LENGTH) {
    throw new DomainError(
      'INVALID',
      `password must be at least ${MIN_PASSWORD_LENGTH} characters`,
    );
  }
  if ((await storage.credentialsForEmail(input.email)) !== undefined) {
    throw new DomainError('INVALID', `an account with email ${input.email} already exists`);
  }
  const passwordHash = await argon2.hash(input.password); // argon2id by default
  try {
    return await storage.createUser({ email: input.email, passwordHash });
  } catch {
    // Lost a race with a concurrent registration (UNIQUE email violation).
    throw new DomainError('INVALID', `an account with email ${input.email} already exists`);
  }
}

/** Verify credentials and open a session in the given group's context. */
export async function login(
  storage: Storage,
  input: LoginInput,
): Promise<{ token: string; session: Session }> {
  const creds = await storage.credentialsForEmail(input.email);
  if (!creds || !(await argon2.verify(creds.passwordHash, input.password))) {
    throw new DomainError('NOT_AUTHORISED', BAD_CREDENTIALS);
  }
  const members = await storage.membersForUser(creds.user.id);
  const member = members.find((candidate) => candidate.groupId === input.groupId);
  if (!member) {
    throw new DomainError('NOT_AUTHORISED', BAD_CREDENTIALS);
  }
  const token = randomBytes(32).toString('hex');
  const session = await storage.createSession({
    userId: creds.user.id,
    memberId: member.id,
    tokenHash: sha256(token),
    expiresAt: new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString(),
  });
  return { token, session };
}

/** Resolve a raw token to its live session context; undefined if invalid. */
export async function authenticate(
  storage: Storage,
  token: string,
): Promise<AuthContext | undefined> {
  const session = await storage.sessionByTokenHash(sha256(token));
  if (!session) return undefined;
  if (session.expiresAt <= new Date().toISOString()) return undefined;
  const user = await storage.getUser(session.userId);
  const context: AuthContext = { user, session };
  if (session.memberId !== undefined) {
    context.member = await storage.getMember(session.memberId);
  }
  return context;
}

/** Revoke the token's session; silently a no-op for unknown tokens. */
export async function logout(storage: Storage, token: string): Promise<void> {
  const session = await storage.sessionByTokenHash(sha256(token));
  if (session) await storage.revokeSession(session.id);
}
