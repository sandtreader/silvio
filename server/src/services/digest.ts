// Offers & wants digest (#17): a scheduler sweep sends each active member,
// per their digestFrequency, the listings created since the start of the
// PREVIOUS period — windows deliberately overlap so nothing falls between
// sweeps, and the per-period dedup key digest:{periodLabel}:{personId} makes
// both reruns and the overlap harmless.

import type { Storage } from '../storage/interface.js';
import type { DigestFrequency, Id, Listing } from '../types.js';
import { effectiveEmailTemplate, renderTemplate } from './emailtemplates.js';

const DAY = 86_400_000;

/** UTC midnight of the Monday of `at`'s week. */
function mondayOf(at: Date): Date {
  return new Date(
    Date.UTC(
      at.getUTCFullYear(),
      at.getUTCMonth(),
      at.getUTCDate() - ((at.getUTCDay() + 6) % 7),
    ),
  );
}

/** Markdown body section: offers then wants, empty sections omitted. */
function renderListings(listings: Listing[]): string {
  const sections: string[] = [];
  for (const [heading, type] of [['Offers', 'offer'], ['Wants', 'want']] as const) {
    const items = listings.filter((listing) => listing.type === type);
    if (items.length === 0) continue;
    sections.push(
      `## ${heading}\n\n` +
        items.map((item) => `- **${item.title}** — ${item.description}\n`).join(''),
    );
  }
  return sections.join('\n');
}

/**
 * One digest per member per period: enqueue the period's new active listings
 * to every person-with-email of every active member whose frequency is not
 * 'none'. Returns the number of emails actually enqueued (dedup no-ops
 * excluded).
 */
export async function sweepDigests(
  storage: Storage,
  groupId: Id,
  nowIso: string,
): Promise<{ sent: number }> {
  const group = (await storage.listGroups()).find((candidate) => candidate.id === groupId);
  const at = new Date(nowIso);
  const monday = mondayOf(at);
  // Period label + window start (start of the previous period, inclusive).
  const periods: Record<Exclude<DigestFrequency, 'none'>, { label: string; since: number }> = {
    weekly: {
      label: monday.toISOString().slice(0, 10),
      since: monday.getTime() - 7 * DAY,
    },
    monthly: {
      label: `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}`,
      since: Date.UTC(at.getUTCFullYear(), at.getUTCMonth() - 1, 1),
    },
  };

  const active = await storage.listListings(groupId, { status: 'active' });
  const template = await effectiveEmailTemplate(storage, groupId, 'digest');
  let sent = 0;
  for (const member of await storage.listMembers(groupId, 'active')) {
    if (member.digestFrequency === 'none') continue;
    const period = periods[member.digestFrequency];
    const fresh = active.filter((listing) => Date.parse(listing.createdAt) >= period.since);
    if (fresh.length === 0) continue;
    const vars = {
      listings: renderListings(fresh),
      memberName: member.displayName,
      groupName: group?.name ?? 'the group',
    };
    const subject = renderTemplate(template.subject, vars);
    const body = renderTemplate(template.body, vars).trimEnd();
    for (const person of await storage.personsForMember(member.id)) {
      if (person.email === undefined) continue;
      const queued = await storage.enqueueEmail({
        groupId,
        personId: person.id,
        kind: 'digest',
        dedupKey: `digest:${period.label}:${person.id}`,
        toEmail: person.email,
        subject,
        body,
        // Snapshot the group sender (#16); absent falls back at delivery.
        ...(group?.emailFrom !== undefined ? { fromEmail: group.emailFrom } : {}),
        createdAt: nowIso,
      });
      if (queued !== undefined) sent += 1;
    }
  }
  return { sent };
}
