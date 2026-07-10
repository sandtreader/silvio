// More page: profile photo upload/remove (decision #14 phase 2) and the
// member directory with avatars. The canvas resize step is mocked — jsdom
// has no canvas — so tests assert the flow around it.
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Me } from '@silvio/ui-shared';
import { More } from '../src/pages/More';
import { resizeImage } from '../src/resize';
import { renderWithClient, testMe } from './helpers';

vi.mock('../src/resize', () => ({ resizeImage: vi.fn() }));

const meWithPhoto: Me = {
  ...testMe,
  member: { ...testMe.member, photoId: 'ph-1' },
};

const noMembers = { members: [] };

describe('More: profile photo', () => {
  it('uploads a selected photo via resize + setMyPhoto, then refreshes /me', async () => {
    const resized = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' });
    vi.mocked(resizeImage).mockResolvedValue({ blob: resized, mime: 'image/jpeg' });
    const client = {
      me: vi.fn().mockResolvedValueOnce(testMe).mockResolvedValue(meWithPhoto),
      members: vi.fn().mockResolvedValue(noMembers),
      setMyPhoto: vi.fn().mockResolvedValue({ image: { id: 'ph-1' } }),
    };
    const { container } = renderWithClient(<More />, client);

    expect(await screen.findByText('Add photo')).toBeTruthy();
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input.accept).toBe('image/*');
    const file = new File([new Uint8Array([9, 9])], 'me.png', { type: 'image/png' });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(client.setMyPhoto).toHaveBeenCalledWith(resized, 'image/jpeg'));
    expect(resizeImage).toHaveBeenCalledWith(file);
    // The auth context refreshed /me after the upload (mount + refresh).
    await waitFor(() => expect(client.me).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Change photo')).toBeTruthy();
  });

  it('shows the photo as the avatar image and removes it via deleteMyPhoto', async () => {
    const client = {
      me: vi.fn().mockResolvedValueOnce(meWithPhoto).mockResolvedValue(testMe),
      members: vi.fn().mockResolvedValue(noMembers),
      deleteMyPhoto: vi.fn().mockResolvedValue({ ok: true }),
    };
    const { container } = renderWithClient(<More />, client);

    expect(await screen.findByText('Change photo')).toBeTruthy();
    expect(container.querySelector('img[src="/i/ph-1"]')).toBeTruthy();

    fireEvent.click(screen.getByText('Remove photo'));
    await waitFor(() => expect(client.deleteMyPhoto).toHaveBeenCalledTimes(1));
    // Refreshed /me; without a photoId the avatar falls back to initials.
    await waitFor(() => expect(client.me).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(container.querySelector('img[src="/i/ph-1"]')).toBeNull(),
    );
    expect(screen.queryByText('Remove photo')).toBeNull();
  });
});

describe('More: offers & wants digest preference (decision #17)', () => {
  it('shows the current frequency and saves a change via updateMe', async () => {
    const monthlyMe: Me = {
      ...testMe,
      member: { ...testMe.member, digestFrequency: 'monthly' },
    };
    const client = {
      me: vi.fn().mockResolvedValueOnce(testMe).mockResolvedValue(monthlyMe),
      members: vi.fn().mockResolvedValue(noMembers),
      updateMe: vi.fn().mockResolvedValue({ member: monthlyMe.member }),
    };
    renderWithClient(<More />, client);

    // testMe defaults to weekly, so that option renders pressed.
    const weekly = await screen.findByRole('button', { name: 'Weekly' });
    expect(weekly.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'Monthly' }));
    await waitFor(() =>
      expect(client.updateMe).toHaveBeenCalledWith({ digestFrequency: 'monthly' }),
    );
    // The auth context refreshed /me (mount + refresh) and the new choice shows.
    await waitFor(() => expect(client.me).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Monthly' }).getAttribute('aria-pressed'),
      ).toBe('true'),
    );
  });
});

describe('More: neighbourhood (CamLETS location pattern)', () => {
  it('saves the neighbourhood on blur via updateMe, blank clears with null', async () => {
    const withArea: Me = {
      ...testMe,
      member: { ...testMe.member, neighbourhood: 'Mill Road' },
    };
    const client = {
      me: vi.fn().mockResolvedValueOnce(testMe).mockResolvedValue(withArea),
      members: vi.fn().mockResolvedValue(noMembers),
      updateMe: vi.fn().mockResolvedValue({ member: withArea.member }),
    };
    renderWithClient(<More />, client);

    const field = (await screen.findByLabelText('Neighbourhood')) as HTMLInputElement;
    expect(field.value).toBe('');
    fireEvent.change(field, { target: { value: 'Mill Road' } });
    fireEvent.blur(field);
    await waitFor(() =>
      expect(client.updateMe).toHaveBeenCalledWith({ neighbourhood: 'Mill Road' }),
    );
    await waitFor(() => expect(field.value).toBe('Mill Road'));

    fireEvent.change(field, { target: { value: '' } });
    fireEvent.blur(field);
    await waitFor(() =>
      expect(client.updateMe).toHaveBeenCalledWith({ neighbourhood: null }),
    );
  });

  it('does not call updateMe when the value is unchanged', async () => {
    const client = {
      me: vi.fn().mockResolvedValue(testMe),
      members: vi.fn().mockResolvedValue(noMembers),
      updateMe: vi.fn(),
    };
    renderWithClient(<More />, client);
    const field = await screen.findByLabelText('Neighbourhood');
    fireEvent.blur(field);
    expect(client.updateMe).not.toHaveBeenCalled();
  });

  it('shows neighbourhoods in the directory and filters by the dropdown', async () => {
    const client = {
      me: vi.fn().mockResolvedValue(testMe),
      members: vi.fn().mockResolvedValue({
        members: [
          {
            id: 'm2',
            memberNo: 8,
            displayName: 'Bob Smith',
            type: 'individual',
            status: 'active',
            neighbourhood: 'Mill Road',
          },
          {
            id: 'm3',
            memberNo: 9,
            displayName: 'Carol',
            type: 'individual',
            status: 'active',
          },
        ],
      }),
    };
    renderWithClient(<More />, client);

    // Secondary text carries the neighbourhood when set.
    expect(await screen.findByText('#8 · Mill Road')).toBeTruthy();
    expect(screen.getByText('#9')).toBeTruthy();

    // Dropdown derives its options from the loaded list; picking one filters.
    fireEvent.mouseDown(screen.getByLabelText('Neighbourhood filter'));
    fireEvent.click(await screen.findByRole('option', { name: 'Mill Road' }));
    await waitFor(() => expect(screen.queryByText('Carol')).toBeNull());
    expect(screen.getByText('Bob Smith')).toBeTruthy();
  });
});

describe('More: directory avatars', () => {
  it('renders an avatar image for members with a photo, initials without', async () => {
    const client = {
      me: vi.fn().mockResolvedValue(testMe),
      members: vi.fn().mockResolvedValue({
        members: [
          {
            id: 'm2',
            memberNo: 8,
            displayName: 'Bob Smith',
            type: 'individual',
            status: 'active',
            photoId: 'ph-2',
          },
          {
            id: 'm3',
            memberNo: 9,
            displayName: 'Carol',
            type: 'individual',
            status: 'active',
          },
        ],
      }),
    };
    const { container } = renderWithClient(<More />, client);

    expect(await screen.findByText('Bob Smith')).toBeTruthy();
    expect(container.querySelector('img[src="/i/ph-2"]')).toBeTruthy();
    // Carol has no photo: initials fallback, no image.
    expect(screen.getByText('C')).toBeTruthy();
    expect(container.querySelector('img[src="/i/undefined"]')).toBeNull();
  });
});
