// Login page: renders the form, submits credentials, reloads /me.
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Login } from '../src/pages/Login';
import { notAuthorised, renderWithClient, testMe } from './helpers';

describe('Login', () => {
  it('submits email and password then reloads me()', async () => {
    const client = {
      me: vi
        .fn()
        .mockRejectedValueOnce(notAuthorised())
        .mockResolvedValue(testMe),
      login: vi.fn().mockResolvedValue({ ok: true }),
    };
    renderWithClient(<Login />, client);

    const email = await screen.findByLabelText(/email/i);
    fireEvent.change(email, { target: { value: 'alice@example.com' } });
    fireEvent.change(screen.getByLabelText(/password/i), {
      target: { value: 'hunter2' },
    });
    fireEvent.click(screen.getByRole('button', { name: /log in/i }));

    await waitFor(() =>
      expect(client.login).toHaveBeenCalledWith('alice@example.com', 'hunter2'),
    );
    // refresh() after successful login calls me() a second time
    await waitFor(() => expect(client.me).toHaveBeenCalledTimes(2));
  });

  it('shows the join link', async () => {
    const client = {
      me: vi.fn().mockRejectedValue(notAuthorised()),
      login: vi.fn(),
    };
    renderWithClient(<Login />, client);
    expect(await screen.findByText(/join this lets/i)).toBeTruthy();
  });
});
