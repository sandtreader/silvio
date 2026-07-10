// Household page (joint members, decision #23): list the persons sharing the
// membership (with an Invited hint while a userId is missing), add one
// (unknown emails get an invite), and remove behind a confirm that spells
// out access revocation; the last-person 422 surfaces the server message.
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { ApiError } from '@silvio/ui-shared';
import type { Person } from '@silvio/ui-shared';
import { describe, expect, it, vi } from 'vitest';
import { Household } from '../src/pages/Household';
import { renderWithClient, testMe } from './helpers';

const alice: Person = {
  id: 'p1',
  memberId: 'm1',
  userId: 'u1',
  isPrimary: true,
  name: 'Alice',
  email: 'alice@x.y',
};

// No userId yet: invited but not accepted.
const bob: Person = {
  id: 'p2',
  memberId: 'm1',
  isPrimary: false,
  name: 'Bob',
  email: 'bob@x.y',
};

describe('Household: list', () => {
  it('lists persons with emails and marks pending invites', async () => {
    const client = {
      me: vi.fn().mockResolvedValue(testMe),
      myPersons: vi.fn().mockResolvedValue({ persons: [alice, bob] }),
    };
    renderWithClient(<Household />, client);

    expect(await screen.findByText('Alice')).toBeTruthy();
    expect(screen.getByText('alice@x.y')).toBeTruthy();
    expect(screen.getByText('Bob')).toBeTruthy();
    // Only Bob (no userId) shows the Invited hint.
    expect(screen.getAllByText('Invited')).toHaveLength(1);
    // The page explains the shared-membership model in a sentence.
    expect(screen.getByText(/shares this membership/i)).toBeTruthy();
  });
});

describe('Household: add', () => {
  it('adds a person from name + email and reloads the list', async () => {
    const carol: Person = {
      id: 'p3',
      memberId: 'm1',
      isPrimary: false,
      name: 'Carol',
      email: 'carol@x.y',
    };
    const client = {
      me: vi.fn().mockResolvedValue(testMe),
      myPersons: vi
        .fn()
        .mockResolvedValueOnce({ persons: [alice] })
        .mockResolvedValue({ persons: [alice, carol] }),
      addPerson: vi.fn().mockResolvedValue({ person: carol }),
    };
    renderWithClient(<Household />, client);

    fireEvent.change(await screen.findByLabelText(/name/i), {
      target: { value: 'Carol' },
    });
    fireEvent.change(screen.getByLabelText(/email/i), {
      target: { value: 'carol@x.y' },
    });
    // The form warns that unknown emails get an invitation.
    expect(screen.getByText(/email them an invitation/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /add person/i }));
    await waitFor(() =>
      expect(client.addPerson).toHaveBeenCalledWith('Carol', 'carol@x.y'),
    );
    // List reloaded; the new person appears and the form cleared.
    await waitFor(() => expect(client.myPersons).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Carol')).toBeTruthy();
    expect((screen.getByLabelText(/name/i) as HTMLInputElement).value).toBe('');
  });
});

describe('Household: remove', () => {
  it('confirms with the access-revocation wording, then removes and reloads', async () => {
    const client = {
      me: vi.fn().mockResolvedValue(testMe),
      myPersons: vi
        .fn()
        .mockResolvedValueOnce({ persons: [alice, bob] })
        .mockResolvedValue({ persons: [alice] }),
      removePerson: vi.fn().mockResolvedValue({ ok: true }),
    };
    renderWithClient(<Household />, client);

    fireEvent.click(await screen.findByRole('button', { name: 'Remove Bob' }));
    // Nothing removed yet: the confirm dialog gates the call.
    expect(client.removePerson).not.toHaveBeenCalled();
    expect(
      await screen.findByText(/keep their Silvio login but lose access/i),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Remove person' }));
    await waitFor(() => expect(client.removePerson).toHaveBeenCalledWith('p2'));
    await waitFor(() => expect(client.myPersons).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText('Bob')).toBeNull());
  });

  it('cancelling the confirm leaves the person alone', async () => {
    const client = {
      me: vi.fn().mockResolvedValue(testMe),
      myPersons: vi.fn().mockResolvedValue({ persons: [alice, bob] }),
      removePerson: vi.fn(),
    };
    renderWithClient(<Household />, client);

    fireEvent.click(await screen.findByRole('button', { name: 'Remove Bob' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(screen.queryByText(/lose access to this membership/i)).toBeNull(),
    );
    expect(client.removePerson).not.toHaveBeenCalled();
  });

  it('surfaces the server message when the last person cannot be removed (422)', async () => {
    const client = {
      me: vi.fn().mockResolvedValue(testMe),
      myPersons: vi.fn().mockResolvedValue({ persons: [alice] }),
      removePerson: vi
        .fn()
        .mockRejectedValue(
          new ApiError(
            'VALIDATION',
            'cannot remove the last person on a membership',
            422,
          ),
        ),
    };
    renderWithClient(<Household />, client);

    fireEvent.click(await screen.findByRole('button', { name: 'Remove Alice' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove person' }));
    await waitFor(() => expect(client.removePerson).toHaveBeenCalledWith('p1'));
    // The 422 message lands in the snackbar; Alice stays listed.
    expect(
      await screen.findByText(/cannot remove the last person/i),
    ).toBeTruthy();
    expect(screen.getByText('Alice')).toBeTruthy();
  });
});
