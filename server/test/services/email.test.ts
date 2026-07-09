// Outbound email delivery (server/todo.md "Email & notifications"): queued
// email_events are delivered by a Mailer, marked sent on success, retried on
// failure up to a small attempt cap, with failures alerted loudly.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { deliverEmails, type Mailer, type MailMessage } from '../../src/services/email.js';
import { SqliteStorage } from '../../src/storage/sqlite/index.js';
import type { Group } from '../../src/types.js';

class FakeMailer implements Mailer {
  sent: MailMessage[] = [];
  failWith?: string;

  async send(message: MailMessage): Promise<void> {
    if (this.failWith !== undefined) throw new Error(this.failWith);
    this.sent.push(message);
  }
}

describe('email delivery', () => {
  let storage: SqliteStorage;
  let group: Group;
  let mailer: FakeMailer;
  const now = '2026-07-09T12:00:00.000Z';

  async function enqueue(dedupKey: string, subject = 'Hello'): Promise<void> {
    await storage.enqueueEmail({
      groupId: group.id,
      personId: 'person-1',
      kind: 'welcome',
      dedupKey,
      toEmail: 'someone@example.com',
      subject,
      body: 'Body text',
      createdAt: '2026-07-09T11:00:00.000Z',
    });
  }

  beforeEach(async () => {
    storage = new SqliteStorage(':memory:');
    group = await storage.createGroup({ slug: 'g', name: 'G' });
    mailer = new FakeMailer();
  });

  afterEach(() => {
    storage.close();
  });

  it('delivers pending emails and marks them sent', async () => {
    await enqueue('k1', 'First');
    await enqueue('k2', 'Second');

    const report = await deliverEmails(storage, mailer, now);
    expect(report).toEqual({ sent: 2, failed: 0 });
    expect(mailer.sent.map((m) => m.subject)).toEqual(['First', 'Second']);
    expect(mailer.sent[0]!.to).toBe('someone@example.com');
    expect(mailer.sent[0]!.text).toBe('Body text');

    // Nothing left, and a second run sends nothing again (dedup by sent_at).
    expect(await storage.pendingEmails(10)).toEqual([]);
    const again = await deliverEmails(storage, mailer, now);
    expect(again).toEqual({ sent: 0, failed: 0 });
    expect(mailer.sent).toHaveLength(2);
  });

  it('a mailer failure leaves the email queued for retry and alerts', async () => {
    await enqueue('k1');
    mailer.failWith = 'connection refused';
    const alerts: string[] = [];

    const report = await deliverEmails(storage, mailer, now, {
      alert: (message) => alerts.push(message),
    });
    expect(report).toEqual({ sent: 0, failed: 1 });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain('connection refused');

    const pending = await storage.pendingEmails(10);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.attempts).toBe(1);

    // Mailer recovers: the retry succeeds.
    delete mailer.failWith;
    const retry = await deliverEmails(storage, mailer, now);
    expect(retry).toEqual({ sent: 1, failed: 0 });
    expect(await storage.pendingEmails(10)).toEqual([]);
  });

  it('gives up after three failed attempts', async () => {
    await enqueue('k1');
    mailer.failWith = 'permanent failure';
    const alert = () => {};

    await deliverEmails(storage, mailer, now, { alert });
    await deliverEmails(storage, mailer, now, { alert });
    await deliverEmails(storage, mailer, now, { alert });

    // Given up: no longer pending, and further runs do not touch the mailer.
    expect(await storage.pendingEmails(10)).toEqual([]);
    delete mailer.failWith;
    const after = await deliverEmails(storage, mailer, now, { alert });
    expect(after).toEqual({ sent: 0, failed: 0 });
    expect(mailer.sent).toEqual([]);
  });

  it('respects the batch limit', async () => {
    await enqueue('k1');
    await enqueue('k2');
    await enqueue('k3');

    const report = await deliverEmails(storage, mailer, now, { limit: 2 });
    expect(report).toEqual({ sent: 2, failed: 0 });
    expect(await storage.pendingEmails(10)).toHaveLength(1);
  });
});
