// Joint members (#23): any person on a membership manages its people.
// Adding an unknown email sends an invite (single-use token); accepting it
// creates the login, links the person and verifies the email. Guard rails:
// never the last person, and removal revokes this membership's access.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app.js';
import { register, login, authenticate } from '../../src/services/auth.js';
import { apply, approve } from '../../src/services/membership.js';
import { SqliteStorage } from '../../src/storage/sqlite/index.js';
import type { Currency, EmailEvent, Group, Member, Person } from '../../src/types.js';

describe('joint members: persons API (#23)', () => {
  let storage: SqliteStorage;
  let app: FastifyInstance;
  let group: Group;
  let cams: Currency;
  let alice: Member;
  let aliceCookie: string;

  beforeEach(async () => {
    storage = new SqliteStorage(':memory:');
    group = await storage.createGroup({ slug: 'cam', name: 'CamLETS' });
    cams = await storage.createCurrency({
      groupId: group.id, code: 'CAM', name: 'Cams', scale: 2,
    });
    await storage.createAccount({ groupId: group.id, currencyId: cams.id, type: 'community' });
    const user = await register(storage, {
      email: 'alice@example.com', password: 'password-1',
    });
    const applied = await apply(storage, {
      groupId: group.id, displayName: 'The Applegrowers', personName: 'Alice',
      email: 'alice@example.com', userId: user.id,
    });
    alice = await approve(storage, applied.member.id);
    app = await buildApp(storage);
    await app.ready();
    const { token } = await login(storage, {
      email: 'alice@example.com', password: 'password-1', groupId: group.id,
    });
    aliceCookie = `silvio_session=${token}`;
  });

  afterEach(async () => {
    await app.close();
    storage.close();
  });

  function addPerson(payload: Record<string, unknown>, cookie = aliceCookie) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/g/cam/me/persons',
      headers: { cookie, origin: 'http://localhost' },
      payload,
    });
  }

  async function inviteEmails(): Promise<EmailEvent[]> {
    return (await storage.pendingEmails(100)).filter((e) => e.kind === 'invite');
  }

  it('lists the membership’s people', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/v1/g/cam/me/persons', headers: { cookie: aliceCookie },
    });
    expect(res.statusCode).toBe(200);
    const { persons } = res.json() as { persons: Person[] };
    expect(persons).toHaveLength(1);
    expect(persons[0]!.name).toBe('Alice');
  });

  it('adding an unknown email invites them; accepting creates a working login', async () => {
    const res = await addPerson({ name: 'Andy', email: 'andy@example.com' });
    expect(res.statusCode).toBe(201);

    const [invite] = await inviteEmails();
    expect(invite).toBeDefined();
    expect(invite!.toEmail).toBe('andy@example.com');
    const token = invite!.body.match(/[?&]token=([0-9a-f]+)/)![1]!;

    const accept = await app.inject({
      method: 'POST',
      url: '/api/v1/g/cam/auth/accept-invite',
      headers: { origin: 'http://localhost' },
      payload: { token, password: 'password-andy' },
    });
    expect(accept.statusCode).toBe(200);

    // Andy logs into the shared membership; his email is verified (#23).
    const andyLogin = await login(storage, {
      email: 'andy@example.com', password: 'password-andy', groupId: group.id,
    });
    const context = await authenticate(storage, andyLogin.token);
    expect(context!.member!.id).toBe(alice.id);
    const creds = await storage.credentialsForEmail('andy@example.com');
    expect(creds!.user.emailVerifiedAt).toBeTruthy();

    // Single use.
    expect((await app.inject({
      method: 'POST',
      url: '/api/v1/g/cam/auth/accept-invite',
      headers: { origin: 'http://localhost' },
      payload: { token, password: 'password-other' },
    })).statusCode).toBe(400);
  });

  it('an email with an existing account links immediately, no invite', async () => {
    await register(storage, { email: 'beth@example.com', password: 'password-beth' });
    const res = await addPerson({ name: 'Beth', email: 'beth@example.com' });
    expect(res.statusCode).toBe(201);
    expect(await inviteEmails()).toEqual([]);

    const bethLogin = await login(storage, {
      email: 'beth@example.com', password: 'password-beth', groupId: group.id,
    });
    const context = await authenticate(storage, bethLogin.token);
    expect(context!.member!.id).toBe(alice.id);
  });

  it('a second person flips an individual membership to joint', async () => {
    expect(alice.type).toBe('individual');
    await addPerson({ name: 'Andy', email: 'andy@example.com' });
    expect((await storage.getMember(alice.id)).type).toBe('joint');
  });

  it('removal revokes this membership’s access but never the last person', async () => {
    await register(storage, { email: 'beth@example.com', password: 'password-beth' });
    const added = await addPerson({ name: 'Beth', email: 'beth@example.com' });
    const { person: beth } = added.json() as { person: Person };

    const bethLogin = await login(storage, {
      email: 'beth@example.com', password: 'password-beth', groupId: group.id,
    });

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/v1/g/cam/me/persons/${beth.id}`,
      headers: { cookie: aliceCookie, origin: 'http://localhost' },
    });
    expect(removed.statusCode).toBe(200);

    // Beth's session in this membership is dead; her login itself survives.
    expect(await authenticate(storage, bethLogin.token)).toBeUndefined();
    await login(storage, { email: 'beth@example.com', password: 'password-beth' });

    // Alice is now the last person and cannot be removed.
    const [remaining] = await storage.personsForMember(alice.id);
    const last = await app.inject({
      method: 'DELETE',
      url: `/api/v1/g/cam/me/persons/${remaining!.id}`,
      headers: { cookie: aliceCookie, origin: 'http://localhost' },
    });
    expect(last.statusCode).toBe(422);
  });

  it('adds and removes are audited', async () => {
    await register(storage, { email: 'beth@example.com', password: 'password-beth' });
    const { person } = (await addPerson({ name: 'Beth', email: 'beth@example.com' }))
      .json() as { person: Person };
    await app.inject({
      method: 'DELETE',
      url: `/api/v1/g/cam/me/persons/${person.id}`,
      headers: { cookie: aliceCookie, origin: 'http://localhost' },
    });
    expect((await storage.listAuditEvents(group.id, { action: 'person.add' })).total).toBe(1);
    expect((await storage.listAuditEvents(group.id, { action: 'person.remove' })).total).toBe(1);
  });

  it('a duplicate email on the membership is refused', async () => {
    expect((await addPerson({ name: 'Alice again', email: 'alice@example.com' })).statusCode)
      .toBe(400);
  });
});
