// Tokens page (decision #9): list personal API tokens with scopes and caps,
// create one (the raw value shows exactly once), revoke behind a confirm.
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ApiToken } from '@silvio/ui-shared';
import { Tokens } from '../src/pages/Tokens';
import { renderWithClient, testMe } from './helpers';

const activeToken: ApiToken = {
  id: 'tok-1',
  memberId: 'm1',
  createdBy: 'p1',
  label: 'Claude agent',
  scopes: ['account:read', 'trade:request'],
  maxTxAmount: 2500,
  maxPeriodAmount: 10000,
  periodDays: 30,
  createdAt: '2026-07-01T10:00:00Z',
  lastUsedAt: '2026-07-08T09:00:00Z',
};

const revokedToken: ApiToken = {
  id: 'tok-2',
  memberId: 'm1',
  createdBy: 'p1',
  label: 'Old bot',
  scopes: ['marketplace:read'],
  createdAt: '2026-06-01T10:00:00Z',
  revokedAt: '2026-07-05T10:00:00Z',
};

describe('Tokens: list', () => {
  it('renders labels, scope chips, caps at the account scale, and marks revoked', async () => {
    const client = {
      me: vi.fn().mockResolvedValue(testMe),
      myTokens: vi.fn().mockResolvedValue({ tokens: [activeToken, revokedToken] }),
    };
    renderWithClient(<Tokens />, client);

    expect(await screen.findByText('Claude agent')).toBeTruthy();
    expect(screen.getByText('account:read')).toBeTruthy();
    expect(screen.getByText('trade:request')).toBeTruthy();
    // Caps format at the first account's scale (2): 2500 -> 25.00 CAM.
    expect(screen.getByText(/25\.00 CAM per transaction/)).toBeTruthy();
    expect(screen.getByText(/100\.00 CAM per 30 days/)).toBeTruthy();
    // The revoked token still lists, labelled as such.
    expect(screen.getByText('Old bot')).toBeTruthy();
    expect(screen.getByText('Revoked')).toBeTruthy();
    // Only the active token offers revocation.
    expect(screen.getAllByRole('button', { name: 'Revoke' })).toHaveLength(1);
  });
});

describe('Tokens: create flow', () => {
  it('creates a token from label + scopes and shows the raw value once', async () => {
    const client = {
      me: vi.fn().mockResolvedValue(testMe),
      myTokens: vi.fn().mockResolvedValue({ tokens: [] }),
      createToken: vi.fn().mockResolvedValue({
        token: 'slv_secret123',
        apiToken: { ...activeToken, id: 'tok-3', label: 'My agent' },
      }),
    };
    renderWithClient(<Tokens />, client);

    fireEvent.click(await screen.findByRole('button', { name: 'New token' }));
    fireEvent.change(await screen.findByLabelText(/Label/), {
      target: { value: 'My agent' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: /account:read/ }));

    fireEvent.click(screen.getByRole('button', { name: 'Create token' }));
    await waitFor(() =>
      expect(client.createToken).toHaveBeenCalledWith({
        label: 'My agent',
        scopes: ['account:read'],
      }),
    );

    // The raw token appears exactly once, with a copy-now warning.
    expect(await screen.findByText('slv_secret123')).toBeTruthy();
    expect(screen.getByText(/won.t see it again/i)).toBeTruthy();
    // The list reloaded behind the dialog.
    await waitFor(() => expect(client.myTokens).toHaveBeenCalledTimes(2));

    // Closing the dialog discards the raw value for good.
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByText('slv_secret123')).toBeNull());
  });

  it('requires a per-transaction cap before autonomous trading can be granted', async () => {
    const client = {
      me: vi.fn().mockResolvedValue(testMe),
      myTokens: vi.fn().mockResolvedValue({ tokens: [] }),
      createToken: vi.fn(),
    };
    renderWithClient(<Tokens />, client);

    fireEvent.click(await screen.findByRole('button', { name: 'New token' }));
    fireEvent.change(await screen.findByLabelText(/Label/), {
      target: { value: 'Free rein' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: /trade:autonomous/ }));

    // No per-transaction cap yet: create stays disabled (server would 400).
    const create = screen.getByRole('button', { name: 'Create token' });
    expect(create.hasAttribute('disabled')).toBe(true);

    fireEvent.change(screen.getByLabelText(/Max per transaction/), {
      target: { value: '25.00' },
    });
    expect(create.hasAttribute('disabled')).toBe(false);
    fireEvent.click(create);
    await waitFor(() =>
      expect(client.createToken).toHaveBeenCalledWith({
        label: 'Free rein',
        scopes: ['trade:autonomous'],
        maxTxAmount: 2500, // minor units at the account's scale (2)
      }),
    );
  });
});

describe('Tokens: revoke', () => {
  it('confirms, then calls revokeToken and reloads', async () => {
    const client = {
      me: vi.fn().mockResolvedValue(testMe),
      myTokens: vi
        .fn()
        .mockResolvedValueOnce({ tokens: [activeToken] })
        .mockResolvedValue({ tokens: [{ ...activeToken, revokedAt: '2026-07-10T00:00:00Z' }] }),
      revokeToken: vi.fn().mockResolvedValue({ ok: true }),
    };
    renderWithClient(<Tokens />, client);

    fireEvent.click(await screen.findByRole('button', { name: 'Revoke' }));
    // Nothing revoked yet: the confirm dialog gates the call.
    expect(client.revokeToken).not.toHaveBeenCalled();
    expect(await screen.findByText(/Claude agent.*stop working/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Revoke token' }));
    await waitFor(() => expect(client.revokeToken).toHaveBeenCalledWith('tok-1'));
    // List reloaded; the token now shows as revoked.
    await waitFor(() => expect(client.myTokens).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Revoked')).toBeTruthy();
  });

  it('cancelling the confirm leaves the token alone', async () => {
    const client = {
      me: vi.fn().mockResolvedValue(testMe),
      myTokens: vi.fn().mockResolvedValue({ tokens: [activeToken] }),
      revokeToken: vi.fn(),
    };
    renderWithClient(<Tokens />, client);

    fireEvent.click(await screen.findByRole('button', { name: 'Revoke' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByText(/stop working/)).toBeNull());
    expect(client.revokeToken).not.toHaveBeenCalled();
  });
});
