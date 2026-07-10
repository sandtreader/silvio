// Group balances page (#19): renders the published table, and turns the
// server's 404 (transparency off) into a friendly explanation.
import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@silvio/ui-shared';
import { Balances } from '../src/pages/Balances';
import { renderWithClient, testMe } from './helpers';

describe('Balances (#19)', () => {
  it('renders member balances and turnover at the currency scale', async () => {
    const client = {
      me: vi.fn().mockResolvedValue(testMe),
      groupBalances: vi.fn().mockResolvedValue({
        balances: [
          { memberId: 'm2', displayName: 'Bob', balance: 700, turnover: 950 },
          { memberId: 'm1', displayName: 'Alice', balance: -700, turnover: 0 },
        ],
      }),
    };
    renderWithClient(<Balances />, client);

    expect(await screen.findByText('Bob')).toBeTruthy();
    expect(client.groupBalances).toHaveBeenCalledWith('c1');
    // testMe's account has scale 2, so 700 renders as 7.00.
    expect(screen.getByText('7.00')).toBeTruthy();
    expect(screen.getByText('9.50')).toBeTruthy();
    expect(screen.getByText('-7.00')).toBeTruthy();
    expect(screen.getByText('Alice')).toBeTruthy();
    expect(screen.getByText('Turnover (12m)')).toBeTruthy();
  });

  it('explains when the group does not publish balances (404)', async () => {
    const client = {
      me: vi.fn().mockResolvedValue(testMe),
      groupBalances: vi
        .fn()
        .mockRejectedValue(
          new ApiError('NOT_FOUND', 'this group does not publish balances', 404),
        ),
    };
    renderWithClient(<Balances />, client);

    expect(
      await screen.findByText(/doesn't publish balances/i),
    ).toBeTruthy();
  });
});
