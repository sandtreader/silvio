// Joint members (#23): any person on a membership manages its people.
// Adding an email that already has a Silvio login links immediately;
// otherwise an invite email carries a single-use 'invite' token (7-day
// expiry, data-model §1) and acceptance creates the login, links the
// person(s) and counts as email verification — the link proved the address.
// Token hygiene mirrors recovery.ts: sha256-hashed at rest, one generic
// failure message, no oracle.

import { createHash, randomBytes } from 'node:crypto';
import type { Storage } from '../storage/interface.js';
import type { Id, Person, User } from '../types.js';
import { DomainError } from './errors.js';
import { register } from './auth.js';
import { effectiveEmailTemplate, renderTemplate } from './emailtemplates.js';

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // seven days (#23)

// One message for unknown, wrong-purpose, used, and expired tokens alike.
const BAD_TOKEN = 'this link is invalid, expired or already used';

function sha256(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface AddPersonInput {
  name: string;
  email: string;
}

/**
 * Add a person to the membership. An email with an existing account links
 * straight away; an unknown one gets an invite email through the #16
 * template pathway. Adding a second person to an 'individual' membership
 * flips it to 'joint' — never back, and 'organisation' is left alone (#23).
 */
export async function addPerson(
  storage: Storage,
  memberId: Id,
  input: AddPersonInput,
  baseUrl: string,
  now?: string,
): Promise<{ person: Person; invited: boolean }> {
  const nowIso = now ?? new Date().toISOString();
  const member = await storage.getMember(memberId);
  const existing = await storage.personsForMember(memberId);
  const email = input.email.toLowerCase();
  if (existing.some((candidate) => candidate.email?.toLowerCase() === email)) {
    throw new DomainError('INVALID', `${input.email} is already a person on this membership`);
  }
  const creds = await storage.credentialsForEmail(input.email);
  const person = await storage.createPerson({
    memberId,
    name: input.name,
    email: input.email,
    ...(creds !== undefined ? { userId: creds.user.id } : {}),
  });
  const invited = creds === undefined;
  if (invited) {
    // No account yet: mint the invite token. userId stays absent — the
    // person is found again at accept time by email (see acceptInvite).
    const raw = randomBytes(32).toString('hex');
    const token = await storage.createOneTimeToken({
      email: input.email,
      purpose: 'invite',
      tokenHash: sha256(raw),
      expiresAt: new Date(Date.parse(nowIso) + INVITE_TTL_MS).toISOString(),
    });
    // Render and enqueue directly, as recovery.ts does: the recipient is
    // not yet a user, let alone a member. Per-token dedup key — every
    // invite sends its own link.
    const group = (await storage.listGroups()).find(
      (candidate) => candidate.id === member.groupId,
    );
    const template = await effectiveEmailTemplate(storage, member.groupId, 'invite');
    const vars: Record<string, string> = {
      inviterName: member.displayName,
      groupName: group?.name ?? 'the group',
      inviteUrl: `${baseUrl}/app/invite?token=${raw}`,
    };
    await storage.enqueueEmail({
      groupId: member.groupId,
      personId: person.id,
      kind: 'invite',
      dedupKey: `invite:${token.id}`,
      toEmail: input.email,
      subject: renderTemplate(template.subject, vars),
      body: renderTemplate(template.body, vars).trimEnd(),
      // Snapshot the group sender (#16); absent falls back at delivery.
      ...(group?.emailFrom !== undefined ? { fromEmail: group.emailFrom } : {}),
      createdAt: nowIso,
    });
  }
  // Auto-typing: a second person makes an individual joint (#23).
  if (member.type === 'individual' && existing.length + 1 > 1) {
    await storage.updateMember(memberId, { type: 'joint' });
  }
  return { person, invited };
}

/**
 * Remove a person from the membership — never the last one. A departed
 * person keeps their Silvio login; only this membership's access goes:
 * their sessions in this member context and the API tokens they created
 * for it are revoked (#23).
 */
export async function removePerson(
  storage: Storage,
  memberId: Id,
  personId: Id,
): Promise<Person> {
  const persons = await storage.personsForMember(memberId);
  const target = persons.find((candidate) => candidate.id === personId);
  if (target === undefined) {
    throw new DomainError('NOT_FOUND', `person ${personId} not found on this membership`);
  }
  if (persons.length <= 1) {
    throw new DomainError('LIMIT_BREACHED', 'the last person on a membership cannot be removed');
  }
  await storage.deletePerson(personId);
  if (target.userId !== undefined) {
    await storage.revokeSessionsForMember(target.userId, memberId);
  }
  for (const token of await storage.listApiTokens(memberId)) {
    if (token.createdBy === personId && token.revokedAt === undefined) {
      await storage.revokeApiToken(token.id);
    }
  }
  return target;
}

/**
 * Consume an invite token: create the login (the email is verified — the
 * link proved it) and attach it to every unlinked person row carrying that
 * email. Linking by email rather than a stored person id is deliberate: an
 * address invited onto two memberships joins both, which is the correct
 * semantics (#23). A raced registration turns the token useless — honest
 * INVALID rather than silently adopting an account the inviter never saw.
 */
export async function acceptInvite(
  storage: Storage,
  rawToken: string,
  password: string,
  now?: string,
): Promise<User> {
  const nowIso = now ?? new Date().toISOString();
  const token = await storage.oneTimeTokenByHash(sha256(rawToken));
  if (
    token === undefined ||
    token.purpose !== 'invite' ||
    token.usedAt !== undefined ||
    token.expiresAt <= nowIso
  ) {
    throw new DomainError('INVALID', BAD_TOKEN);
  }
  if ((await storage.credentialsForEmail(token.email)) !== undefined) {
    throw new DomainError('INVALID', 'this email already has an account — log in instead');
  }
  // register() enforces the password rule and hashes with argon2id.
  const user = await register(storage, { email: token.email, password });
  const verified = await storage.markUserEmailVerified(user.id, nowIso);
  for (const person of await storage.unlinkedPersonsByEmail(token.email)) {
    await storage.linkPersonUser(person.id, user.id);
  }
  await storage.markOneTimeTokenUsed(token.id, nowIso);
  return verified;
}
