// Home page: balances from /me, recent statement lines, pending chip.
import { screen } from '@testing-library/react';
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
      }),
    };
    renderWithClient(<Home />, client);

    // Balance formatted at the default scale of 2
    expect(await screen.findByText('123.45')).toBeTruthy();
    expect(screen.getByText(/CAM balance/i)).toBeTruthy();
    // Statement of the first account's currency
    expect(await screen.findByText('bike repair')).toBeTruthy();
    expect(screen.getByText('-15.00')).toBeTruthy();
    expect(client.statement).toHaveBeenCalledWith('c1');
    // Pending chip
    expect(await screen.findByText(/1 pending action/i)).toBeTruthy();
  });
});
