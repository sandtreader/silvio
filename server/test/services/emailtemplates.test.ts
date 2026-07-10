// Email templates (#16): every notification kind has a built-in default;
// groups override per kind. Bodies are markdown with {{placeholder}}
// substitution — substitution is dumb string replacement, markdown-it's
// escaping applies afterwards, unknown placeholders pass through literally.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  DEFAULT_EMAIL_TEMPLATES,
  EMAIL_TEMPLATE_KINDS,
  effectiveEmailTemplate,
  renderTemplate,
} from '../../src/services/emailtemplates.js';
import { notifyWelcome } from '../../src/services/notifications.js';
import { apply, approve } from '../../src/services/membership.js';
import { SqliteStorage } from '../../src/storage/sqlite/index.js';
import type { Group } from '../../src/types.js';

describe('renderTemplate (#16)', () => {
  it('substitutes {{placeholders}}, every occurrence', () => {
    expect(renderTemplate('Hi {{name}}, yes {{name}}: {{amount}}', {
      name: 'Bob', amount: '5.00 CAM',
    })).toBe('Hi Bob, yes Bob: 5.00 CAM');
  });

  it('an unknown placeholder passes through literally', () => {
    expect(renderTemplate('Hi {{tyop}}', { name: 'Bob' })).toBe('Hi {{tyop}}');
  });
});

describe('default templates (#16)', () => {
  it('every notification kind has one, subject and body', () => {
    expect(EMAIL_TEMPLATE_KINDS).toEqual([
      'welcome',
      'invoice_received',
      'payment_held',
      'payment_received',
      'payment_accepted',
      'payment_declined',
      'payment_auto_accepted_payer',
      'payment_auto_accepted_payee',
      'invoice_expired',
      'restriction_imposed',
      'restriction_lifted',
      'password_reset',
      'email_verify',
      'digest',
      'listing_expiry_warning',
      'invite',
    ]);
    for (const kind of EMAIL_TEMPLATE_KINDS) {
      const template = DEFAULT_EMAIL_TEMPLATES[kind];
      expect(template.subject.length).toBeGreaterThan(0);
      expect(template.body.length).toBeGreaterThan(0);
    }
  });
});

describe('template resolution and use (#16)', () => {
  let storage: SqliteStorage;
  let group: Group;

  beforeEach(async () => {
    storage = new SqliteStorage(':memory:');
    group = await storage.createGroup({ slug: 'g', name: 'CamLETS' });
  });

  afterEach(() => {
    storage.close();
  });

  it('effectiveEmailTemplate is the default until overridden, then the override', async () => {
    expect(await effectiveEmailTemplate(storage, group.id, 'welcome'))
      .toEqual(DEFAULT_EMAIL_TEMPLATES.welcome);
    await storage.setEmailTemplate({
      groupId: group.id, kind: 'welcome', subject: 'Custom', body: 'Custom body',
    });
    expect(await effectiveEmailTemplate(storage, group.id, 'welcome'))
      .toEqual({ subject: 'Custom', body: 'Custom body' });
  });

  it('notifications render the override with substituted vars', async () => {
    await storage.setEmailTemplate({
      groupId: group.id,
      kind: 'welcome',
      subject: '{{groupName}} says hi',
      body: 'Dear {{memberName}}, **welcome** to {{groupName}}.',
    });
    const { member } = await apply(storage, {
      groupId: group.id, displayName: 'Alice', personName: 'Alice',
      email: 'alice@example.com',
    });
    await notifyWelcome(storage, await approve(storage, member.id));
    const [event] = await storage.pendingEmails(10);
    expect(event!.subject).toBe('CamLETS says hi');
    expect(event!.body).toBe('Dear Alice, **welcome** to CamLETS.');
  });

  it('the group sender is snapshotted onto the queued event (#16)', async () => {
    await storage.updateGroup(group.id, { emailFrom: 'lets@cam.example.org' });
    const { member } = await apply(storage, {
      groupId: group.id, displayName: 'Bob', personName: 'Bob',
      email: 'bob@example.com',
    });
    await notifyWelcome(storage, await approve(storage, member.id));
    const [event] = await storage.pendingEmails(10);
    expect(event!.fromEmail).toBe('lets@cam.example.org');
  });
});
