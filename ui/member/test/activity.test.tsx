// Activity page: pending items expose their actions; clicking one calls
// txAction and reloads.
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Activity } from '../src/pages/Activity';
import { renderWithClient, testMe } from './helpers';

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
      statement: vi.fn().mockResolvedValue({ lines: [] }),
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
});
