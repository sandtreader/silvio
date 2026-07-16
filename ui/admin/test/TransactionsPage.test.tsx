// Transactions page: search/list via GET /admin/transactions, reverse from
// a row — no more pasting ids from statements.

import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AdminTransaction } from '@silvio/ui-shared';
import { TransactionsPage } from '../src/pages/TransactionsPage';
import { makeMockApi } from './mockApi';

function makeTx(overrides: Partial<AdminTransaction> = {}): AdminTransaction {
  return {
    id: 'tx-1',
    groupId: 'g-1',
    type: 'trade',
    state: 'committed',
    seq: 7,
    description: 'veg box',
    createdBy: 'p-1',
    channel: 'web',
    createdAt: '2026-07-01T12:00:00Z',
    committedAt: '2026-07-01T12:00:00Z',
    entries: [
      { id: 'e-1', transactionId: 'tx-1', accountId: 'a-1', amount: -500,
        accountType: 'member', currencyId: 'c-1',
        memberId: 'm-1', memberNo: 1, displayName: 'Alice Smith' },
      { id: 'e-2', transactionId: 'tx-1', accountId: 'a-2', amount: 500,
        accountType: 'member', currencyId: 'c-1',
        memberId: 'm-2', memberNo: 2, displayName: 'Bob Jones' },
    ],
    ...overrides,
  };
}

describe('TransactionsPage', () => {
  it('lists transactions from the search endpoint', async () => {
    const api = makeMockApi();
    api.adminTransactions.mockResolvedValue({
      transactions: [
        makeTx(),
        makeTx({ id: 'tx-2', seq: 8, description: 'bike repair', state: 'pending' }),
      ],
      total: 2,
    });

    render(<TransactionsPage api={api} />);
    expect(await screen.findByText(/veg box/)).toBeInTheDocument();
    expect(screen.getByText(/bike repair/)).toBeInTheDocument();
    expect(api.adminTransactions).toHaveBeenCalled();
  });

  it('passes the text filter through as q', async () => {
    const api = makeMockApi();
    api.adminTransactions.mockResolvedValue({ transactions: [makeTx()], total: 1 });

    render(<TransactionsPage api={api} />);
    await screen.findByText(/veg box/);

    const search = screen.getByLabelText(/search/i);
    await userEvent.type(search, 'veg');
    await waitFor(() =>
      expect(api.adminTransactions).toHaveBeenCalledWith(
        expect.objectContaining({ q: 'veg' }),
      ),
    );
  });

  it('derives From/To from enriched entries, naming system accounts by type', async () => {
    const api = makeMockApi();
    api.adminTransactions.mockResolvedValue({
      transactions: [
        makeTx(),
        makeTx({
          id: 'tx-2',
          seq: 8,
          type: 'demurrage',
          description: 'Demurrage 2026-07',
          entries: [
            { id: 'e-3', transactionId: 'tx-2', accountId: 'a-1', amount: -3,
              accountType: 'member', currencyId: 'c-1',
              memberId: 'm-1', memberNo: 1, displayName: 'Alice Smith' },
            { id: 'e-4', transactionId: 'tx-2', accountId: 'a-sys', amount: 3,
              accountType: 'system', currencyId: 'c-1' },
          ],
        }),
      ],
      total: 2,
    });

    render(<TransactionsPage api={api} />);
    await screen.findByText(/veg box/);

    expect(screen.getByText('From')).toBeInTheDocument();
    expect(screen.getByText('To')).toBeInTheDocument();
    // Alice pays Bob; Alice also pays demurrage into the system account.
    expect(screen.getAllByText('Alice Smith')).toHaveLength(2);
    expect(screen.getByText('Bob Jones')).toBeInTheDocument();
    expect(screen.getByText('system')).toBeInTheDocument();
  });

  it('debounces typing into a single server-side query', async () => {
    const api = makeMockApi();
    api.adminTransactions.mockResolvedValue({ transactions: [makeTx()], total: 1 });

    render(<TransactionsPage api={api} />);
    await screen.findByText(/veg box/);

    await userEvent.type(screen.getByLabelText(/search/i), 'veg');
    await waitFor(() =>
      expect(api.adminTransactions).toHaveBeenCalledWith(
        expect.objectContaining({ q: 'veg' }),
      ),
    );
    // Intermediate keystrokes never reach the server.
    expect(api.adminTransactions).not.toHaveBeenCalledWith(
      expect.objectContaining({ q: 'v' }),
    );
    expect(api.adminTransactions).not.toHaveBeenCalledWith(
      expect.objectContaining({ q: 've' }),
    );
  });

  it('reverses a committed transaction from its row after confirmation', async () => {
    const api = makeMockApi();
    const tx = makeTx();
    api.adminTransactions.mockResolvedValue({ transactions: [tx], total: 1 });
    api.adminReverse.mockResolvedValue(
      makeTx({ id: 'tx-r', type: 'reversal', reversesId: 'tx-1', seq: 9 }),
    );

    render(<TransactionsPage api={api} />);
    await screen.findByText(/veg box/);

    await userEvent.click(screen.getByRole('button', { name: /reverse/i }));
    // Confirmation dialog before anything irreversible.
    expect(api.adminReverse).not.toHaveBeenCalled();
    await userEvent.click(await screen.findByRole('button', { name: /confirm/i }));
    await waitFor(() => expect(api.adminReverse).toHaveBeenCalledWith('tx-1'));
  });

  it('shows a reversed chip instead of the reverse button once reversed (#25)', async () => {
    const api = makeMockApi();
    api.adminTransactions.mockResolvedValue({
      transactions: [
        makeTx({ reversedById: 'tx-r' }),
        makeTx({ id: 'tx-2', seq: 8, description: 'bike repair' }),
      ],
      total: 2,
    });

    render(<TransactionsPage api={api} />);
    await screen.findByText(/veg box/);

    expect(screen.getByText('reversed')).toBeInTheDocument();
    // Only the unreversed row keeps its reverse action.
    expect(screen.getAllByRole('button', { name: /reverse/i })).toHaveLength(1);
  });

  it('offers no reverse action on a pending transaction', async () => {
    const api = makeMockApi();
    api.adminTransactions.mockResolvedValue({
      transactions: [makeTx({ state: 'pending', seq: undefined, committedAt: undefined })],
      total: 1,
    });

    render(<TransactionsPage api={api} />);
    await screen.findByText(/veg box/);
    expect(screen.queryByRole('button', { name: /reverse/i })).toBeNull();
  });
});
