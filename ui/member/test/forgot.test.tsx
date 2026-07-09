// Forgot page: posts the email and always shows the same neutral message
// (no account enumeration).
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Forgot } from '../src/pages/Forgot';
import { notAuthorised, renderWithClient } from './helpers';

describe('Forgot', () => {
  it('posts the email and shows the neutral confirmation', async () => {
    const client = {
      me: vi.fn().mockRejectedValue(notAuthorised()),
      forgotPassword: vi.fn().mockResolvedValue({ ok: true }),
    };
    renderWithClient(<Forgot />, client);

    const email = await screen.findByLabelText(/email/i);
    fireEvent.change(email, { target: { value: 'alice@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: /send reset link/i }));

    await waitFor(() =>
      expect(client.forgotPassword).toHaveBeenCalledWith('alice@example.com'),
    );
    expect(
      await screen.findByText(/if that address has an account here/i),
    ).toBeTruthy();
    // Link back to login from the confirmation
    expect(screen.getByText(/back to login/i)).toBeTruthy();
  });
});
