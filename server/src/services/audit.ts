// Audit trail helper (data-model §8): stamps `at` so API call sites stay one
// line. The storage write is the source of truth; append-only by contract.

import type { AppendAuditEventInput, Storage } from '../storage/interface.js';

/**
 * Append an audit event, never throwing: an audit failure must not fail the
 * action it records — log it and move on.
 */
export async function recordAudit(
  storage: Storage,
  event: Omit<AppendAuditEventInput, 'at'>,
): Promise<void> {
  try {
    await storage.appendAuditEvent({ ...event, at: new Date().toISOString() });
  } catch (err) {
    console.error(`audit append failed for ${event.action}`, err);
  }
}
