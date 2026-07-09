// Verify page: posts the token from the query string exactly once on mount
// (the token is single-use, so StrictMode's double effect must not re-fire
// it) and shows success or failure with a login link.
import { screen } from '@testing-library/react';
import { ApiError } from '@silvio/ui-shared';
import { StrictMode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Verify } from '../src/pages/Verify';
import { notAuthorised, renderWithClient } from './helpers';

describe('Verify', () => {
  it('fires exactly once (even under StrictMode) and shows success', async () => {
    const client = {
      me: vi.fn().mockRejectedValue(notAuthorised()),
      verifyEmail: vi.fn().mockResolvedValue({ ok: true }),
    };
    renderWithClient(
      <StrictMode>
        <Verify />
      </StrictMode>,
      client,
      ['/verify?token=tok-1'],
    );

    expect(await screen.findByText(/email address confirmed/i)).toBeTruthy();
    expect(client.verifyEmail).toHaveBeenCalledTimes(1);
    expect(client.verifyEmail).toHaveBeenCalledWith('tok-1');
    expect(screen.getByText(/go to login/i)).toBeTruthy();
  });

  it('shows the failure message when the token is rejected', async () => {
    const client = {
      me: vi.fn().mockRejectedValue(notAuthorised()),
      verifyEmail: vi
        .fn()
        .mockRejectedValue(new ApiError('BAD_REQUEST', 'invalid token', 400)),
    };
    renderWithClient(<Verify />, client, ['/verify?token=tok-bad']);

    expect(await screen.findByText(/verification failed/i)).toBeTruthy();
    expect(
      screen.getByText(/invalid, expired or already used/i),
    ).toBeTruthy();
    expect(screen.getByText(/go to login/i)).toBeTruthy();
  });
});
