// Audit page: browse the audit log via GET /admin/audit with action and
// entity-id filters, newest first, "load more" paging against the total.

import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AdminAuditEvent } from '@silvio/ui-shared';
import { AuditPage } from '../src/pages/AuditPage';
import { makeMockApi } from './mockApi';

function makeEvent(overrides: Partial<AdminAuditEvent> = {}): AdminAuditEvent {
  return {
    id: 'ev-1',
    groupId: 'g-1',
    actorUserId: 'u-admin-0001',
    action: 'member.approve',
    entityType: 'member',
    entityId: 'm-11111111-2222',
    detail: { role: 'member' },
    at: '2026-07-01T12:00:00Z',
    ...overrides,
  };
}

describe('AuditPage', () => {
  it('lists audit events with entity, actor and detail', async () => {
    const api = makeMockApi();
    api.adminAudit.mockResolvedValue({
      events: [
        makeEvent(),
        makeEvent({
          id: 'ev-2',
          action: 'restriction.impose',
          entityType: 'restriction',
          detail: { reason: 'runaway balance' },
        }),
      ],
      total: 2,
    });

    render(<AuditPage api={api} />);
    expect(await screen.findByText('member.approve')).toBeInTheDocument();
    expect(screen.getByText('restriction.impose')).toBeInTheDocument();
    // Detail as a compact key: value line; ids truncated to 8 characters.
    expect(screen.getByText('role: member')).toBeInTheDocument();
    expect(screen.getByText('reason: runaway balance')).toBeInTheDocument();
    expect(screen.getAllByText('m-111111').length).toBe(2);
    expect(api.adminAudit).toHaveBeenCalled();
  });

  it('shows names and labels when present, ids only as fallback', async () => {
    const api = makeMockApi();
    api.adminAudit.mockResolvedValue({
      events: [
        makeEvent({
          actorName: 'Grace',
          entityLabel: 'Bob Jones',
          action: 'member.suspend',
        }),
        makeEvent({
          id: 'ev-2',
          action: 'page.delete',
          entityType: 'page',
          entityId: 'p-33333333-4444',
        }),
      ],
      total: 2,
    });

    render(<AuditPage api={api} />);
    // Labelled event: names shown, raw ids not in the cell text.
    expect(await screen.findByText(/Bob Jones/)).toBeInTheDocument();
    expect(screen.getByText('Grace')).toBeInTheDocument();
    expect(screen.queryByText('m-111111')).not.toBeInTheDocument();
    // Unlabelled event falls back to the short id.
    expect(screen.getByText('p-333333')).toBeInTheDocument();
    expect(screen.getByText('u-admin-')).toBeInTheDocument();
  });

  it('passes the action filter through and refetches', async () => {
    const api = makeMockApi();
    api.adminAudit.mockResolvedValue({ events: [makeEvent()], total: 1 });

    render(<AuditPage api={api} />);
    await screen.findByText('member.approve');

    const action = screen.getByLabelText(/action/i);
    await userEvent.type(action, 'token.issue');
    await waitFor(() =>
      expect(api.adminAudit).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'token.issue' }),
      ),
    );
  });

  it('loads more pages against the total', async () => {
    const api = makeMockApi();
    api.adminAudit.mockResolvedValueOnce({
      events: Array.from({ length: 50 }, (_, i) =>
        makeEvent({ id: `ev-${i}`, action: `page.update.${i}` }),
      ),
      total: 51,
    });
    api.adminAudit.mockResolvedValueOnce({
      events: [makeEvent({ id: 'ev-50', action: 'broadcast.send' })],
      total: 51,
    });

    render(<AuditPage api={api} />);
    await screen.findByText('page.update.0');

    await userEvent.click(screen.getByRole('button', { name: /load more/i }));
    await waitFor(() =>
      expect(api.adminAudit).toHaveBeenCalledWith(
        expect.objectContaining({ offset: 50 }),
      ),
    );
    // The next page appends; the first page stays visible.
    expect(await screen.findByText('broadcast.send')).toBeInTheDocument();
    expect(screen.getByText('page.update.0')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /load more/i })).toBeNull();
  });
});
