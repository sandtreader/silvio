// Transactional notifications (decisions #5, #7; server/todo.md "Email &
// notifications"): domain events enqueue email_events for every person on
// the affected membership who has an email address. Enqueueing is
// idempotent via dedup keys, so sweeps and retries never double-send.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  sendPayment,
  requestPayment,
  accept,
  decline,
  sweepDue,
} from '../../src/services/trading.js';
import { apply, approve } from '../../src/services/membership.js';
import {
  notifyRestrictionImposed,
  notifyRestrictionLifted,
} from '../../src/services/notifications.js';
import { SqliteStorage } from '../../src/storage/sqlite/index.js';
import type { Account, Currency, EmailEvent, Group, Member } from '../../src/types.js';

describe('transactional notifications', () => {
  let storage: SqliteStorage;
  let group: Group;
  let cams: Currency;
  let community: Account;
  let alice: Member;
  let bob: Member;

  async function member(name: string): Promise<Member> {
    const { member } = await apply(storage, {
      groupId: group.id,
      displayName: name,
      personName: name,
      email: `${name.toLowerCase()}@example.com`,
    });
    return approve(storage, member.id);
  }

  async function eventsOfKind(kind: string): Promise<EmailEvent[]> {
    const all = await storage.pendingEmails(100);
    return all.filter((e) => e.kind === kind);
  }

  beforeEach(async () => {
    storage = new SqliteStorage(':memory:');
    group = await storage.createGroup({ slug: 'g', name: 'G' });
    cams = await storage.createCurrency({ groupId: group.id, code: 'CAM', name: 'Cams', scale: 2 });
    community = await storage.createAccount({
      groupId: group.id, currencyId: cams.id, type: 'community',
    });
    alice = await member('Alice');
    bob = await member('Bob');
  });

  afterEach(() => {
    storage.close();
  });

  describe('membership (#7)', () => {
    it('approval enqueues a welcome email to the member’s person', async () => {
      const welcomes = await eventsOfKind('welcome');
      expect(welcomes).toHaveLength(2); // alice and bob, from the fixture
      const toAlice = welcomes.find((e) => e.toEmail === 'alice@example.com');
      expect(toAlice).toBeDefined();
      expect(toAlice!.groupId).toBe(group.id);
      expect(toAlice!.subject.toLowerCase()).toContain('welcome');
    });

    it('a member without any person email gets nothing (and approval still works)', async () => {
      const { member: applied } = await apply(storage, {
        groupId: group.id, displayName: 'Quiet', personName: 'Quiet',
      });
      const before = (await storage.pendingEmails(100)).length;
      const approved = await approve(storage, applied.id);
      expect(approved.status).toBe('active');
      expect(await storage.pendingEmails(100)).toHaveLength(before);
    });
  });

  describe('trading (#5)', () => {
    it('an invoice notifies the payer, with the formatted amount', async () => {
      await requestPayment(storage, {
        groupId: group.id,
        payeeMemberId: bob.id,
        payerMemberId: alice.id,
        currencyId: cams.id,
        amount: 500,
        description: 'veg box',
        actorPersonId: 'person-bob',
        channel: 'web',
      });
      const events = await eventsOfKind('invoice_received');
      expect(events).toHaveLength(1);
      expect(events[0]!.toEmail).toBe('alice@example.com');
      // Scale-2 currency: 500 minor units reads as 5.00 CAM.
      const text = `${events[0]!.subject} ${events[0]!.body}`;
      expect(text).toContain('5.00');
      expect(text).toContain('CAM');
      expect(events[0]!.body).toContain('veg box');
    });

    it('every person on the membership with an email is notified', async () => {
      await storage.createPerson({
        memberId: alice.id, name: 'Alice Partner', email: 'partner@example.com',
      });
      await requestPayment(storage, {
        groupId: group.id,
        payeeMemberId: bob.id,
        payerMemberId: alice.id,
        currencyId: cams.id,
        amount: 500,
        actorPersonId: 'person-bob',
        channel: 'web',
      });
      const events = await eventsOfKind('invoice_received');
      expect(events.map((e) => e.toEmail).sort()).toEqual([
        'alice@example.com',
        'partner@example.com',
      ]);
    });

    it('a held payment notifies the payee it awaits confirmation', async () => {
      await storage.updateMember(bob.id, { confirmIncoming: true });
      await sendPayment(storage, {
        groupId: group.id,
        payerMemberId: alice.id,
        payeeMemberId: bob.id,
        currencyId: cams.id,
        amount: 300,
        actorPersonId: 'person-alice',
        channel: 'web',
      });
      const events = await eventsOfKind('payment_held');
      expect(events).toHaveLength(1);
      expect(events[0]!.toEmail).toBe('bob@example.com');
      expect(await eventsOfKind('payment_received')).toEqual([]);
    });

    it('an immediately committed payment notifies the payee it was received', async () => {
      await sendPayment(storage, {
        groupId: group.id,
        payerMemberId: alice.id,
        payeeMemberId: bob.id,
        currencyId: cams.id,
        amount: 300,
        actorPersonId: 'person-alice',
        channel: 'web',
      });
      const events = await eventsOfKind('payment_received');
      expect(events).toHaveLength(1);
      expect(events[0]!.toEmail).toBe('bob@example.com');
      expect(await eventsOfKind('payment_held')).toEqual([]);
    });

    it('accepting an invoice notifies the initiator (the payee)', async () => {
      const tx = await requestPayment(storage, {
        groupId: group.id,
        payeeMemberId: bob.id,
        payerMemberId: alice.id,
        currencyId: cams.id,
        amount: 500,
        actorPersonId: 'person-bob',
        channel: 'web',
      });
      await accept(storage, tx.id, alice.id);
      const events = await eventsOfKind('payment_accepted');
      expect(events).toHaveLength(1);
      expect(events[0]!.toEmail).toBe('bob@example.com');
    });

    it('declining an invoice notifies the initiator (the payee)', async () => {
      const tx = await requestPayment(storage, {
        groupId: group.id,
        payeeMemberId: bob.id,
        payerMemberId: alice.id,
        currencyId: cams.id,
        amount: 500,
        actorPersonId: 'person-bob',
        channel: 'web',
      });
      await decline(storage, tx.id, alice.id);
      const events = await eventsOfKind('payment_declined');
      expect(events).toHaveLength(1);
      expect(events[0]!.toEmail).toBe('bob@example.com');
    });

    it('declining a held payment notifies the initiator (the payer)', async () => {
      await storage.updateMember(bob.id, { confirmIncoming: true });
      const tx = await sendPayment(storage, {
        groupId: group.id,
        payerMemberId: alice.id,
        payeeMemberId: bob.id,
        currencyId: cams.id,
        amount: 300,
        actorPersonId: 'person-alice',
        channel: 'web',
      });
      await decline(storage, tx.id, bob.id);
      const events = await eventsOfKind('payment_declined');
      expect(events).toHaveLength(1);
      expect(events[0]!.toEmail).toBe('alice@example.com');
    });
  });

  describe('sweeps are idempotent notifiers (#5)', () => {
    it('auto-accepting a held payment notifies both parties, once', async () => {
      await storage.updateMember(bob.id, { confirmIncoming: true });
      await sendPayment(storage, {
        groupId: group.id,
        payerMemberId: alice.id,
        payeeMemberId: bob.id,
        currencyId: cams.id,
        amount: 300,
        actorPersonId: 'person-alice',
        channel: 'web',
        expiresAt: '2026-07-01T00:00:00.000Z',
      });
      await sweepDue(storage, group.id, '2026-07-09T00:00:00.000Z');
      await sweepDue(storage, group.id, '2026-07-09T01:00:00.000Z');
      const events = await eventsOfKind('payment_auto_accepted');
      expect(events.map((e) => e.toEmail).sort()).toEqual([
        'alice@example.com',
        'bob@example.com',
      ]);
    });

    it('an expired invoice notifies the initiator (the payee), once', async () => {
      await requestPayment(storage, {
        groupId: group.id,
        payeeMemberId: bob.id,
        payerMemberId: alice.id,
        currencyId: cams.id,
        amount: 500,
        actorPersonId: 'person-bob',
        channel: 'web',
        expiresAt: '2026-07-01T00:00:00.000Z',
      });
      await sweepDue(storage, group.id, '2026-07-09T00:00:00.000Z');
      await sweepDue(storage, group.id, '2026-07-09T01:00:00.000Z');
      const events = await eventsOfKind('invoice_expired');
      expect(events).toHaveLength(1);
      expect(events[0]!.toEmail).toBe('bob@example.com');
    });
  });

  describe('restrictions (#3)', () => {
    it('imposing notifies the member', async () => {
      const restriction = await storage.imposeRestriction(alice.id, 'runaway balance', bob.id);
      await notifyRestrictionImposed(storage, restriction);
      const events = await eventsOfKind('restriction_imposed');
      expect(events).toHaveLength(1);
      expect(events[0]!.toEmail).toBe('alice@example.com');
      expect(events[0]!.body).toContain('runaway balance');
    });

    it('lifting notifies the member', async () => {
      const restriction = await storage.imposeRestriction(alice.id, 'runaway balance', bob.id);
      await storage.liftRestriction(alice.id, bob.id);
      await notifyRestrictionLifted(storage, restriction.memberId);
      const events = await eventsOfKind('restriction_lifted');
      expect(events).toHaveLength(1);
      expect(events[0]!.toEmail).toBe('alice@example.com');
    });
  });
});
