// Activity page: pending items expose their actions; clicking one calls
// txAction and reloads. The statement is paged 50 at a time, newest first,
// with a "Load more" button and a CSV download link.
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { StatementLine } from '@silvio/ui-shared';
import { describe, expect, it, vi } from 'vitest';
import { Activity } from '../src/pages/Activity';
import { renderWithClient, testMe } from './helpers';

function line(seq: number): StatementLine {
  return {
    seq,
    transactionId: `t${seq}`,
    type: 'trade',
    description: `trade ${seq}`,
    amount: -100,
    runningBalance: -100 * seq,
    committedAt: '2026-07-01T10:00:00Z',
  };
}

describe('Activity', () => {
  it('accepts a pending item via txAction and refreshes', async () => {
    const client = {
      me: vi.fn().mockResolvedValue(testMe),
      pending: vi.fn().mockResolvedValue({
        pending: [
          {
            id: 't9',
            type: 'trade',
            flow: 'invoice',
            amount: 500,
            direction: 'out',
            description: 'veg box',
            actions: ['accept', 'decline'],
          },
        ],
      }),
      statement: vi.fn().mockResolvedValue({ lines: [], total: 0 }),
      statementCsvUrl: vi.fn().mockReturnValue('/api/v1/me/statement.csv?currencyId=c1'),
      txAction: vi
        .fn()
        .mockResolvedValue({ transaction: { id: 't9', state: 'committed' } }),
    };
    renderWithClient(<Activity />, client);

    expect(await screen.findByText('veg box')).toBeTruthy();
    expect(screen.getByText(/outgoing invoice/i)).toBeTruthy();
    expect(screen.getByText('-5.00')).toBeTruthy();

    const before = client.pending.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }));

    await waitFor(() =>
      expect(client.txAction).toHaveBeenCalledWith('t9', 'accept'),
    );
    // Refreshed after the action
    await waitFor(() =>
      expect(client.pending.mock.calls.length).toBeGreaterThan(before),
    );
  });

  it('pages the statement: Load more appends the next 50', async () => {
    const firstPage = Array.from({ length: 50 }, (_, i) => line(120 - i));
    const secondPage = Array.from({ length: 50 }, (_, i) => line(70 - i));
    const client = {
      me: vi.fn().mockResolvedValue(testMe),
      pending: vi.fn().mockResolvedValue({ pending: [] }),
      statement: vi
        .fn()
        .mockResolvedValueOnce({ lines: firstPage, total: 120 })
        .mockResolvedValueOnce({ lines: secondPage, total: 120 }),
      statementCsvUrl: vi.fn().mockReturnValue('/api/v1/me/statement.csv?currencyId=c1'),
    };
    renderWithClient(<Activity />, client);

    expect(await screen.findByText('trade 120')).toBeTruthy();
    expect(client.statement).toHaveBeenCalledWith('c1', { limit: 50, offset: 0 });

    const more = screen.getByRole('button', { name: 'Load more (50 of 120)' });
    fireEvent.click(more);

    expect(await screen.findByText('trade 70')).toBeTruthy();
    expect(client.statement).toHaveBeenCalledWith('c1', { limit: 50, offset: 50 });
    // First page is still shown above the appended one.
    expect(screen.getByText('trade 120')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Load more (100 of 120)' })).toBeTruthy();
  });

  it('offers the CSV download for the first account', async () => {
    const client = {
      me: vi.fn().mockResolvedValue(testMe),
      pending: vi.fn().mockResolvedValue({ pending: [] }),
      statement: vi.fn().mockResolvedValue({ lines: [line(1)], total: 1 }),
      statementCsvUrl: vi.fn().mockReturnValue('/api/v1/me/statement.csv?currencyId=c1'),
    };
    renderWithClient(<Activity />, client);

    const link = await screen.findByRole('link', { name: 'Download CSV' });
    expect(link.getAttribute('href')).toBe('/api/v1/me/statement.csv?currencyId=c1');
    expect(client.statementCsvUrl).toHaveBeenCalledWith('c1');
    // No pager when everything already fits on one page.
    expect(screen.queryByRole('button', { name: /Load more/ })).toBeNull();
  });
});
