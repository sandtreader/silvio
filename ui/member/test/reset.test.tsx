// Reset page: token from the query string + new password -> POST
// /auth/reset; mismatched confirm blocks submission; a 400 (expired/used
// link) surfaces the server's message and offers to request another.
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { ApiError } from '@silvio/ui-shared';
import { describe, expect, it, vi } from 'vitest';
import { Reset } from '../src/pages/Reset';
import { notAuthorised, renderWithClient } from './helpers';

function setPasswords(password: string, confirm: string) {
  fireEvent.change(screen.getByLabelText(/new password/i), {
    target: { value: password },
  });
  fireEvent.change(screen.getByLabelText(/confirm password/i), {
    target: { value: confirm },
  });
}

describe('Reset', () => {
  it('posts token and password then shows success with a login link', async () => {
    const client = {
      me: vi.fn().mockRejectedValue(notAuthorised()),
      resetPassword: vi.fn().mockResolvedValue({ ok: true }),
    };
    renderWithClient(<Reset />, client, ['/reset?token=tok-1']);

    await screen.findByLabelText(/new password/i);
    setPasswords('longenough', 'longenough');
    fireEvent.click(screen.getByRole('button', { name: /set password/i }));

    await waitFor(() =>
      expect(client.resetPassword).toHaveBeenCalledWith('tok-1', 'longenough'),
    );
    expect(await screen.findByText(/password changed/i)).toBeTruthy();
    expect(screen.getByText(/go to login/i)).toBeTruthy();
  });

  it('blocks submission when the passwords do not match', async () => {
    const client = {
      me: vi.fn().mockRejectedValue(notAuthorised()),
      resetPassword: vi.fn(),
    };
    renderWithClient(<Reset />, client, ['/reset?token=tok-1']);

    await screen.findByLabelText(/new password/i);
    setPasswords('longenough', 'different');
    expect(await screen.findByText(/passwords do not match/i)).toBeTruthy();
    fireEvent.submit(screen.getByRole('button', { name: /set password/i }));
    await waitFor(() => expect(client.resetPassword).not.toHaveBeenCalled());
  });

  it('shows the server message and a request-another link on 400', async () => {
    const client = {
      me: vi.fn().mockRejectedValue(notAuthorised()),
      resetPassword: vi
        .fn()
        .mockRejectedValue(new ApiError('BAD_REQUEST', 'reset link expired', 400)),
    };
    renderWithClient(<Reset />, client, ['/reset?token=tok-old']);

    await screen.findByLabelText(/new password/i);
    setPasswords('longenough', 'longenough');
    fireEvent.click(screen.getByRole('button', { name: /set password/i }));

    // The server's message lands in the snackbar...
    expect(await screen.findByText(/reset link expired/i)).toBeTruthy();
    // ...and the page offers to request another link
    expect(await screen.findByText(/request another/i)).toBeTruthy();
  });
});
