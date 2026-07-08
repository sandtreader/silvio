// Trading service (decision #5): payments and invoices over the ledger,
// with credit-control authorisation at commit (decision #3).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  sendPayment,
  requestPayment,
  accept,
  decline,
  cancel,
  sweepDue,
} from '../../src/services/trading.js';
import { apply, approve, suspend } from '../../src/services/membership.js';
import { evaluateFlags } from '../../src/services/creditcontrol.js';
import { DomainError } from '../../src/services/errors.js';
import { SqliteStorage } from '../../src/storage/sqlite/index.js';
import type { Account, Currency, Group, Member } from '../../src/types.js';

async function expectDomainError(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toSatisfy(
    (e: unknown) => e instanceof DomainError && e.code === code,
    `expected DomainError ${code}`,
  );
}

describe('trading service (#5, #3)', () => {
  let storage: SqliteStorage;
  let group: Group;
  let cams: Currency;
  let community: Account;
  let alice: Member;
  let bob: Member;

  async function member(name: string): Promise<Member> {
    const { member } = await apply(storage, {
      groupId: group.id, displayName: name, personName: name,
    });
    return approve(storage, member.id);
  }

  async function balanceOf(m: Member): Promise<number> {
    const acc = await storage.ensureMemberAccount(m.id, cams.id);
    return storage.balance(acc.id);
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

  describe('payments', () => {
    it('a payment commits immediately by default', async () => {
      const tx = await sendPayment(storage, {
        groupId: group.id,
        payerMemberId: alice.id,
        payeeMemberId: bob.id,
        currencyId: cams.id,
        amount: 500,
        description: 'veg box',
        actorPersonId: 'person-alice',
        channel: 'web',
      });
      expect(tx.state).toBe('committed');
      expect(tx.flow).toBe('payment');
      expect(await balanceOf(alice)).toBe(-500);
      expect(await balanceOf(bob)).toBe(500);
    });

    it('rejects non-positive, non-integer amounts and self-payment', async () => {
      const base = {
        groupId: group.id, payerMemberId: alice.id, payeeMemberId: bob.id,
        currencyId: cams.id, actorPersonId: 'p', channel: 'web' as const,
      };
      await expectDomainError(sendPayment(storage, { ...base, amount: 0 }), 'INVALID');
      await expectDomainError(sendPayment(storage, { ...base, amount: -5 }), 'INVALID');
      await expectDomainError(sendPayment(storage, { ...base, amount: 1.5 }), 'INVALID');
      await expectDomainError(
        sendPayment(storage, { ...base, payeeMemberId: alice.id, amount: 5 }),
        'INVALID',
      );
    });

    it('suspended members can neither pay nor be paid', async () => {
      await suspend(storage, bob.id);
      const base = {
        groupId: group.id, currencyId: cams.id, amount: 100,
        actorPersonId: 'p', channel: 'web' as const,
      };
      await expectDomainError(
        sendPayment(storage, { ...base, payerMemberId: bob.id, payeeMemberId: alice.id }),
        'SUSPENDED',
      );
      await expectDomainError(
        sendPayment(storage, { ...base, payerMemberId: alice.id, payeeMemberId: bob.id }),
        'SUSPENDED',
      );
    });

    it('a payee with confirm-incoming holds the payment pending, then accepts', async () => {
      await storage.updateMember(bob.id, { confirmIncoming: true });
      const tx = await sendPayment(storage, {
        groupId: group.id, payerMemberId: alice.id, payeeMemberId: bob.id,
        currencyId: cams.id, amount: 200, actorPersonId: 'p', channel: 'web',
      });
      expect(tx.state).toBe('pending');
      expect(tx.expiresAt).toBeDefined(); // auto-accept deadline (#5)
      expect(await balanceOf(bob)).toBe(0);

      const committed = await accept(storage, tx.id, bob.id);
      expect(committed.state).toBe('committed');
      expect(await balanceOf(bob)).toBe(200);
    });

    it('only the payee may accept or decline a held payment', async () => {
      await storage.updateMember(bob.id, { confirmIncoming: true });
      const tx = await sendPayment(storage, {
        groupId: group.id, payerMemberId: alice.id, payeeMemberId: bob.id,
        currencyId: cams.id, amount: 200, actorPersonId: 'p', channel: 'web',
      });
      await expectDomainError(accept(storage, tx.id, alice.id), 'NOT_AUTHORISED');
      const declined = await decline(storage, tx.id, bob.id);
      expect(declined.state).toBe('declined');
      expect(await balanceOf(bob)).toBe(0);
    });

    it('the payer may cancel a held payment before acceptance', async () => {
      await storage.updateMember(bob.id, { confirmIncoming: true });
      const tx = await sendPayment(storage, {
        groupId: group.id, payerMemberId: alice.id, payeeMemberId: bob.id,
        currencyId: cams.id, amount: 200, actorPersonId: 'p', channel: 'web',
      });
      const cancelled = await cancel(storage, tx.id, alice.id);
      expect(cancelled.state).toBe('cancelled');
      await expectDomainError(accept(storage, tx.id, bob.id), 'WRONG_STATE');
    });
  });

  describe('invoices', () => {
    it('an invoice is pending until the payer accepts (#5: payer always authorises)', async () => {
      const invoice = await requestPayment(storage, {
        groupId: group.id, payeeMemberId: bob.id, payerMemberId: alice.id,
        currencyId: cams.id, amount: 300, description: 'hedge trimming',
        actorPersonId: 'person-bob', channel: 'web',
      });
      expect(invoice.state).toBe('pending');
      expect(invoice.flow).toBe('invoice');
      expect(await balanceOf(alice)).toBe(0);

      const committed = await accept(storage, invoice.id, alice.id);
      expect(committed.state).toBe('committed');
      expect(await balanceOf(alice)).toBe(-300);
      expect(await balanceOf(bob)).toBe(300);
    });

    it('only the payer may accept; the payee may cancel', async () => {
      const invoice = await requestPayment(storage, {
        groupId: group.id, payeeMemberId: bob.id, payerMemberId: alice.id,
        currencyId: cams.id, amount: 300, actorPersonId: 'p', channel: 'web',
      });
      await expectDomainError(accept(storage, invoice.id, bob.id), 'NOT_AUTHORISED');
      const cancelled = await cancel(storage, invoice.id, bob.id);
      expect(cancelled.state).toBe('cancelled');
    });

    it('the payer may decline an invoice', async () => {
      const invoice = await requestPayment(storage, {
        groupId: group.id, payeeMemberId: bob.id, payerMemberId: alice.id,
        currencyId: cams.id, amount: 300, actorPersonId: 'p', channel: 'web',
      });
      const declined = await decline(storage, invoice.id, alice.id);
      expect(declined.state).toBe('declined');
      expect(await balanceOf(alice)).toBe(0);
    });
  });

  describe('expiry sweep (#5)', () => {
    it('due held payments auto-accept; due invoices expire', async () => {
      await storage.updateMember(bob.id, { confirmIncoming: true });
      const past = new Date(Date.now() - 1000).toISOString();
      const payment = await sendPayment(storage, {
        groupId: group.id, payerMemberId: alice.id, payeeMemberId: bob.id,
        currencyId: cams.id, amount: 200, actorPersonId: 'p', channel: 'web',
        expiresAt: past,
      });
      const invoice = await requestPayment(storage, {
        groupId: group.id, payeeMemberId: bob.id, payerMemberId: alice.id,
        currencyId: cams.id, amount: 300, actorPersonId: 'p', channel: 'web',
        expiresAt: past,
      });

      const result = await sweepDue(storage, group.id, new Date().toISOString());
      expect(result.autoAccepted).toBe(1);
      expect(result.expired).toBe(1);
      expect((await storage.getTransaction(payment.id)).state).toBe('committed');
      expect((await storage.getTransaction(invoice.id)).state).toBe('expired');
      expect(await balanceOf(bob)).toBe(200);
    });

    it('undue pending items are untouched', async () => {
      await storage.updateMember(bob.id, { confirmIncoming: true });
      const future = new Date(Date.now() + 86_400_000).toISOString();
      const payment = await sendPayment(storage, {
        groupId: group.id, payerMemberId: alice.id, payeeMemberId: bob.id,
        currencyId: cams.id, amount: 200, actorPersonId: 'p', channel: 'web',
        expiresAt: future,
      });
      const result = await sweepDue(storage, group.id, new Date().toISOString());
      expect(result.autoAccepted).toBe(0);
      expect((await storage.getTransaction(payment.id)).state).toBe('pending');
    });
  });

  describe('credit control at commit (#3)', () => {
    it('an enabled hard limit denies payments breaching the debit floor, with the rule in the message', async () => {
      await storage.setCreditPolicy({
        groupId: group.id, currencyId: cams.id, type: 'hard_limit',
        config: { minBalance: -400 },
      });
      const base = {
        groupId: group.id, payerMemberId: alice.id, payeeMemberId: bob.id,
        currencyId: cams.id, actorPersonId: 'p', channel: 'web' as const,
      };
      await sendPayment(storage, { ...base, amount: 300 }); // alice at -300
      await expect(sendPayment(storage, { ...base, amount: 200 })).rejects.toSatisfy(
        (e: unknown) =>
          e instanceof DomainError && e.code === 'LIMIT_BREACHED' && /-400/.test(e.message),
      );
      expect(await balanceOf(alice)).toBe(-300); // denied payment left no trace
    });

    it('a hard credit ceiling protects the payee side', async () => {
      await storage.setCreditPolicy({
        groupId: group.id, currencyId: cams.id, type: 'hard_limit',
        config: { maxBalance: 250 },
      });
      const base = {
        groupId: group.id, payerMemberId: alice.id, payeeMemberId: bob.id,
        currencyId: cams.id, actorPersonId: 'p', channel: 'web' as const,
      };
      await expectDomainError(sendPayment(storage, { ...base, amount: 300 }), 'LIMIT_BREACHED');
    });

    it('hard limits apply when a pending invoice is accepted (commit time, #5)', async () => {
      const invoice = await requestPayment(storage, {
        groupId: group.id, payeeMemberId: bob.id, payerMemberId: alice.id,
        currencyId: cams.id, amount: 500, actorPersonId: 'p', channel: 'web',
      });
      await storage.setCreditPolicy({
        groupId: group.id, currencyId: cams.id, type: 'hard_limit',
        config: { minBalance: -400 },
      });
      await expectDomainError(accept(storage, invoice.id, alice.id), 'LIMIT_BREACHED');
      expect((await storage.getTransaction(invoice.id)).state).toBe('pending'); // still actionable
    });

    it('a restricted member cannot make outward payments but can still earn', async () => {
      await storage.imposeRestriction(alice.id, 'persistent taker', 'admin-1');
      const base = {
        groupId: group.id, currencyId: cams.id, amount: 100,
        actorPersonId: 'p', channel: 'web' as const,
      };
      await expectDomainError(
        sendPayment(storage, { ...base, payerMemberId: alice.id, payeeMemberId: bob.id }),
        'RESTRICTED',
      );
      // earning stays open (#3)
      const inward = await sendPayment(storage, {
        ...base, payerMemberId: bob.id, payeeMemberId: alice.id,
      });
      expect(inward.state).toBe('committed');
      // lifting restores trading
      await storage.liftRestriction(alice.id, 'admin-1');
      const outward = await sendPayment(storage, {
        ...base, payerMemberId: alice.id, payeeMemberId: bob.id,
      });
      expect(outward.state).toBe('committed');
    });

    it('soft thresholds raise flags but never block (#3)', async () => {
      await storage.setCreditPolicy({
        groupId: group.id, currencyId: cams.id, type: 'soft_threshold',
        config: {
          thresholds: [
            { balance: -200, level: 'notice' },
            { balance: -400, level: 'review' },
          ],
        },
      });
      const base = {
        groupId: group.id, payerMemberId: alice.id, payeeMemberId: bob.id,
        currencyId: cams.id, actorPersonId: 'p', channel: 'web' as const,
      };
      await sendPayment(storage, { ...base, amount: 450 }); // never blocked
      expect(await balanceOf(alice)).toBe(-450);

      const flags = await evaluateFlags(storage, group.id, cams.id);
      const aliceFlags = flags.filter((fl) => fl.memberId === alice.id);
      expect(aliceFlags).toHaveLength(1); // deepest crossed threshold only
      expect(aliceFlags[0]!.level).toBe('review');
      expect(flags.filter((fl) => fl.memberId === bob.id)).toHaveLength(0); // +450, no credit thresholds set
    });
  });
});
