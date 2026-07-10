// Invite page (joint members, decision #23): token from the query string +
// a chosen password -> POST /auth/accept-invite exactly once; mismatched
// confirm blocks submission; a 400 (invalid/expired/used link) is terminal —
// the form goes away, so there is no retry loop.
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { ApiError } from '@silvio/ui-shared';
import { describe, expect, it, vi } from 'vitest';
import { Invite } from '../src/pages/Invite';
import { notAuthorised, renderWithClient } from './helpers';

function setPasswords(password: string, confirm: string) {
  fireEvent.change(screen.getByLabelText(/choose a password/i), {
    target: { value: password },
  });
  fireEvent.change(screen.getByLabelText(/confirm password/i), {
    target: { value: confirm },
  });
}

describe('Invite', () => {
  it('posts token and password once, then shows success with a login link', async () => {
    const client = {
      me: vi.fn().mockRejectedValue(notAuthorised()),
      acceptInvite: vi.fn().mockResolvedValue({ ok: true }),
    };
    renderWithClient(<Invite />, client, ['/invite?token=tok-1']);

    await screen.findByLabelText(/choose a password/i);
    setPasswords('longenough', 'longenough');
    fireEvent.click(screen.getByRole('button', { name: /accept invitation/i }));

    await waitFor(() =>
      expect(client.acceptInvite).toHaveBeenCalledWith('tok-1', 'longenough'),
    );
    expect(client.acceptInvite).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/invitation accepted/i)).toBeTruthy();
    expect(screen.getByText(/go to login/i)).toBeTruthy();
  });

  it('blocks submission when the passwords do not match', async () => {
    const client = {
      me: vi.fn().mockRejectedValue(notAuthorised()),
      acceptInvite: vi.fn(),
    };
    renderWithClient(<Invite />, client, ['/invite?token=tok-1']);

    await screen.findByLabelText(/choose a password/i);
    setPasswords('longenough', 'different');
    expect(await screen.findByText(/passwords do not match/i)).toBeTruthy();
    fireEvent.submit(screen.getByRole('button', { name: /accept invitation/i }));
    await waitFor(() => expect(client.acceptInvite).not.toHaveBeenCalled());
  });

  it('shows the invalid/expired message on 400 with no way to retry', async () => {
    const client = {
      me: vi.fn().mockRejectedValue(notAuthorised()),
      acceptInvite: vi
        .fn()
        .mockRejectedValue(new ApiError('BAD_REQUEST', 'invite token expired', 400)),
    };
    renderWithClient(<Invite />, client, ['/invite?token=tok-old']);

    await screen.findByLabelText(/choose a password/i);
    setPasswords('longenough', 'longenough');
    fireEvent.click(screen.getByRole('button', { name: /accept invitation/i }));

    expect(
      await screen.findByText(/invalid, expired or already used/i),
    ).toBeTruthy();
    // The form is gone — no retry loop on a single-use token.
    expect(screen.queryByLabelText(/choose a password/i)).toBeNull();
    expect(
      screen.queryByRole('button', { name: /accept invitation/i }),
    ).toBeNull();
    expect(client.acceptInvite).toHaveBeenCalledTimes(1);
  });
});
