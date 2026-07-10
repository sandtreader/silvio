// Home page: balances from /me, recent statement lines, pending chip,
// demurrage projection caption (#1).
import { screen } from '@testing-library/react';
import type { Me } from '@silvio/ui-shared';
import { describe, expect, it, vi } from 'vitest';
import { Home } from '../src/pages/Home';
import { renderWithClient, testMe } from './helpers';

describe('Home', () => {
  it('renders account balance, recent activity and pending count', async () => {
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
      statement: vi.fn().mockResolvedValue({
        lines: [
          {
            seq: 1,
            transactionId: 't1',
            type: 'trade',
            description: 'bike repair',
            amount: -1500,
            runningBalance: 12345,
            committedAt: '2026-07-01T10:00:00Z',
          },
        ],
        total: 1,
      }),
    };
    renderWithClient(<Home />, client);

    // Balance formatted at the account's scale of 2
    expect(await screen.findByText('123.45')).toBeTruthy();
    expect(screen.getByText(/CAM balance/i)).toBeTruthy();
    // Statement of the first account's currency
    expect(await screen.findByText('bike repair')).toBeTruthy();
    expect(screen.getByText('-15.00')).toBeTruthy();
    expect(client.statement).toHaveBeenCalledWith('c1', { limit: 5 });
    // Pending chip
    expect(await screen.findByText(/1 pending action/i)).toBeTruthy();
  });

  it('shows the demurrage nudge only on accounts that carry one (#1)', async () => {
    const me: Me = {
      ...testMe,
      accounts: [
        {
          ...testMe.accounts[0]!,
          demurrage: { amount: 400, postingDate: '2026-08-01' },
        },
        { id: 'a2', currencyId: 'c2', currencyCode: 'ACR', scale: 0, balance: 10 },
      ],
    };
    const client = {
      me: vi.fn().mockResolvedValue(me),
      pending: vi.fn().mockResolvedValue({ pending: [] }),
      statement: vi.fn().mockResolvedValue({ lines: [], total: 0 }),
    };
    renderWithClient(<Home />, client);

    expect(
      await screen.findByText(
        /If unspent, ~4\.00 CAM goes to the community pot on 1 Aug\./,
      ),
    ).toBeTruthy();
    // The demurrage-free ACR account carries no caption.
    expect(screen.getAllByText(/If unspent/)).toHaveLength(1);
  });
});
