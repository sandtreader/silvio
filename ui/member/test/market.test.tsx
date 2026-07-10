// Market page: authenticated browse (decision #12 — public browse moved to
// the brochure site) renders listing cards with the post-listing FAB, plus
// listing photos (decision #14 phase 3). The canvas resize step is mocked —
// jsdom has no canvas — so tests assert the flow around it.
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Listing } from '@silvio/ui-shared';
import { Market } from '../src/pages/Market';
import { resizeImage } from '../src/resize';
import { renderWithClient, testMe } from './helpers';

vi.mock('../src/resize', () => ({ resizeImage: vi.fn() }));

/** An active listing owned by `memberId` ('m1' is the logged-in member). */
function listing(overrides: Partial<Listing> & { memberId: string }): Listing {
  return {
    id: 'l1',
    groupId: 'g1',
    type: 'offer',
    title: 'Bike repair',
    description: 'Punctures and gears',
    categoryId: 'cat1',
    status: 'active',
    createdAt: '2026-06-01T00:00:00Z',
    updatedAt: '2026-06-01T00:00:00Z',
    ...overrides,
  };
}

describe('Market', () => {
  it('renders listings from browse() with the post-listing FAB', async () => {
    const client = {
      me: vi.fn().mockResolvedValue(testMe),
      browse: vi.fn().mockResolvedValue({
        listings: [
          {
            id: 'l1',
            groupId: 'g1',
            memberId: 'm2',
            type: 'offer',
            title: 'Bike repair',
            description: 'Punctures and gears',
            categoryId: 'cat1',
            priceAmount: 500,
            priceCurrencyId: 'c1',
            status: 'active',
            createdAt: '2026-06-01T00:00:00Z',
            updatedAt: '2026-06-01T00:00:00Z',
          },
          {
            id: 'l2',
            groupId: 'g1',
            memberId: 'm3',
            type: 'want',
            title: 'Dog walking',
            description: 'Weekday afternoons',
            categoryId: 'cat2',
            rateText: 'negotiable',
            status: 'active',
            createdAt: '2026-06-02T00:00:00Z',
            updatedAt: '2026-06-02T00:00:00Z',
          },
        ],
      }),
      categories: vi.fn().mockResolvedValue({ categories: [] }),
    };
    renderWithClient(<Market />, client);

    expect(await screen.findByText('Bike repair')).toBeTruthy();
    expect(screen.getByText('Dog walking')).toBeTruthy();
    expect(screen.getByText('Offer')).toBeTruthy();
    expect(screen.getByText('Want')).toBeTruthy();
    expect(screen.getByText('5.00')).toBeTruthy(); // priceAmount at scale 2
    expect(screen.getByText('negotiable')).toBeTruthy(); // rateText fallback
    // The app is logged-in-only: the FAB is always present
    expect(screen.getByLabelText('post listing')).toBeTruthy();
  });
});

// Prices must be formatted at the currency's real scale from the viewer's
// /me account summaries (members hold an account per group currency) — not
// the fallback guess.
describe('Market price scale', () => {
  it('uses the account scale for the listing currency', async () => {
    const me = {
      ...testMe,
      accounts: [
        { id: 'a1', currencyId: 'c1', currencyCode: 'HRS', scale: 0, balance: 3 },
      ],
    };
    const client = {
      me: vi.fn().mockResolvedValue(me),
      browse: vi.fn().mockResolvedValue({
        listings: [
          {
            id: 'l1',
            groupId: 'g1',
            memberId: 'm2',
            type: 'offer',
            title: 'Hedge trimming',
            description: 'Per hedge',
            categoryId: 'cat1',
            priceAmount: 3,
            priceCurrencyId: 'c1',
            status: 'active',
            createdAt: '2026-06-01T00:00:00Z',
            updatedAt: '2026-06-01T00:00:00Z',
          },
        ],
      }),
      categories: vi.fn().mockResolvedValue({ categories: [] }),
    };
    renderWithClient(<Market />, client);

    expect(await screen.findByText('Hedge trimming')).toBeTruthy();
    // scale 0: '3', not the fallback-scale-2 '0.03'
    expect(screen.getByText('3')).toBeTruthy();
    expect(screen.queryByText('0.03')).toBeNull();
  });
});

// Search (#18): typing (debounced) calls GET /search on the listings domain
// and narrows the already-loaded browse to the returned ids; clearing the
// text restores the full browse.
describe('Market search', () => {
  it('calls search and narrows the visible listings to the matches', async () => {
    const client = {
      me: vi.fn().mockResolvedValue(testMe),
      browse: vi.fn().mockResolvedValue({
        listings: [
          listing({ id: 'l1', memberId: 'm2', title: 'Bike repair' }),
          listing({ id: 'l2', memberId: 'm3', title: 'Dog walking' }),
        ],
      }),
      search: vi.fn().mockResolvedValue({
        items: [{ domain: 'listings', id: 'l1', title: 'Bike repair' }],
        total: 1,
      }),
      categories: vi.fn().mockResolvedValue({ categories: [] }),
    };
    renderWithClient(<Market />, client);

    expect(await screen.findByText('Bike repair')).toBeTruthy();
    expect(screen.getByText('Dog walking')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('search listings'), {
      target: { value: 'bike' },
    });
    // Debounced ~300ms; waitFor rides it out.
    await waitFor(() => expect(client.search).toHaveBeenCalledWith('listings', 'bike'));
    await waitFor(() => expect(screen.queryByText('Dog walking')).toBeNull());
    expect(screen.getByText('Bike repair')).toBeTruthy();

    // The clear affordance resets to the full browse without a new search.
    fireEvent.click(screen.getByLabelText('clear search'));
    expect(await screen.findByText('Dog walking')).toBeTruthy();
    expect(client.search).toHaveBeenCalledTimes(1);
  });

  it('shows "No matches" when the search returns nothing', async () => {
    const client = {
      me: vi.fn().mockResolvedValue(testMe),
      browse: vi.fn().mockResolvedValue({
        listings: [listing({ id: 'l1', memberId: 'm2' })],
      }),
      search: vi.fn().mockResolvedValue({ items: [], total: 0 }),
      categories: vi.fn().mockResolvedValue({ categories: [] }),
    };
    renderWithClient(<Market />, client);

    expect(await screen.findByText('Bike repair')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('search listings'), {
      target: { value: 'unicycle' },
    });
    expect(await screen.findByText('No matches')).toBeTruthy();
    expect(screen.queryByText('Bike repair')).toBeNull();
  });
});

// Shelf life (#18): owners see the expiry date and can renew in one tap;
// other members' cards carry neither.
describe('Market: listing expiry and renew', () => {
  it('renews an own listing and refreshes with a snackbar', async () => {
    const client = {
      me: vi.fn().mockResolvedValue(testMe),
      browse: vi
        .fn()
        .mockResolvedValueOnce({
          listings: [
            listing({ memberId: 'm1', expiresAt: '2027-01-06T00:00:00Z' }),
          ],
        })
        .mockResolvedValue({
          listings: [
            listing({ memberId: 'm1', expiresAt: '2027-07-05T00:00:00Z' }),
          ],
        }),
      renewListing: vi.fn().mockResolvedValue({
        listing: listing({ memberId: 'm1', expiresAt: '2027-07-05T00:00:00Z' }),
      }),
      categories: vi.fn().mockResolvedValue({ categories: [] }),
    };
    renderWithClient(<Market />, client);

    expect(await screen.findByText('Expires 6 Jan 2027')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Renew' }));

    await waitFor(() => expect(client.renewListing).toHaveBeenCalledWith('l1'));
    await waitFor(() => expect(client.browse).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Expires 5 Jul 2027')).toBeTruthy();
    expect(await screen.findByText('Listing renewed')).toBeTruthy();
  });

  it('shows no expiry or renew on another member\'s listing', async () => {
    const client = {
      me: vi.fn().mockResolvedValue(testMe),
      browse: vi.fn().mockResolvedValue({
        listings: [
          listing({ memberId: 'm2', expiresAt: '2027-01-06T00:00:00Z' }),
        ],
      }),
      categories: vi.fn().mockResolvedValue({ categories: [] }),
    };
    renderWithClient(<Market />, client);

    expect(await screen.findByText('Bike repair')).toBeTruthy();
    expect(screen.queryByText(/^Expires/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Renew' })).toBeNull();
  });
});

// Listing photos (decision #14 phase 3): thumbnails for everyone; add/remove
// only on the viewer's own listings (server enforces owner-only, 5 max).
describe('Market: listing photos', () => {
  it('renders lazy thumbnails; no management controls on another member\'s listing', async () => {
    const client = {
      me: vi.fn().mockResolvedValue(testMe),
      browse: vi.fn().mockResolvedValue({
        listings: [listing({ memberId: 'm2', photoIds: ['ph-1', 'ph-2'] })],
      }),
      categories: vi.fn().mockResolvedValue({ categories: [] }),
    };
    const { container } = renderWithClient(<Market />, client);

    expect(await screen.findByText('Bike repair')).toBeTruthy();
    const first = container.querySelector('img[src="/i/ph-1"]');
    expect(first).toBeTruthy();
    expect(first?.getAttribute('loading')).toBe('lazy');
    expect(container.querySelector('img[src="/i/ph-2"]')).toBeTruthy();
    // Not the viewer's listing: no add button, no delete affordance.
    expect(screen.queryByText('Add photo')).toBeNull();
    expect(screen.queryByLabelText('remove photo')).toBeNull();
    expect(container.querySelector('input[type="file"]')).toBeNull();
  });

  it('uploads to own listing via resize(1200) + addListingPhoto, then refreshes', async () => {
    const resized = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' });
    vi.mocked(resizeImage).mockResolvedValue({ blob: resized, mime: 'image/jpeg' });
    const client = {
      me: vi.fn().mockResolvedValue(testMe),
      browse: vi
        .fn()
        .mockResolvedValueOnce({ listings: [listing({ memberId: 'm1' })] })
        .mockResolvedValue({
          listings: [listing({ memberId: 'm1', photoIds: ['ph-9'] })],
        }),
      addListingPhoto: vi.fn().mockResolvedValue({ image: { id: 'ph-9' } }),
      categories: vi.fn().mockResolvedValue({ categories: [] }),
    };
    const { container } = renderWithClient(<Market />, client);

    expect(await screen.findByText('Add photo')).toBeTruthy();
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input.accept).toBe('image/*');
    const file = new File([new Uint8Array([9, 9])], 'bike.png', { type: 'image/png' });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() =>
      expect(client.addListingPhoto).toHaveBeenCalledWith('l1', resized, 'image/jpeg'),
    );
    // Listings use the 1200px long-edge cap (decision #14), not the 512 default.
    expect(resizeImage).toHaveBeenCalledWith(file, 1200);
    // The list refreshed after the upload (mount + refresh).
    await waitFor(() => expect(client.browse).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(container.querySelector('img[src="/i/ph-9"]')).toBeTruthy(),
    );
  });

  it('removes a photo from own listing via removeListingPhoto, then refreshes', async () => {
    const client = {
      me: vi.fn().mockResolvedValue(testMe),
      browse: vi
        .fn()
        .mockResolvedValueOnce({
          listings: [listing({ memberId: 'm1', photoIds: ['ph-1'] })],
        })
        .mockResolvedValue({ listings: [listing({ memberId: 'm1' })] }),
      removeListingPhoto: vi.fn().mockResolvedValue({ ok: true }),
      categories: vi.fn().mockResolvedValue({ categories: [] }),
    };
    const { container } = renderWithClient(<Market />, client);

    expect(await screen.findByText('Bike repair')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('remove photo'));

    await waitFor(() =>
      expect(client.removeListingPhoto).toHaveBeenCalledWith('l1', 'ph-1'),
    );
    await waitFor(() => expect(client.browse).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(container.querySelector('img[src="/i/ph-1"]')).toBeNull(),
    );
  });

  it('hides the add button at the 5-photo cap but keeps deletes', async () => {
    const client = {
      me: vi.fn().mockResolvedValue(testMe),
      browse: vi.fn().mockResolvedValue({
        listings: [
          listing({
            memberId: 'm1',
            photoIds: ['ph-1', 'ph-2', 'ph-3', 'ph-4', 'ph-5'],
          }),
        ],
      }),
      categories: vi.fn().mockResolvedValue({ categories: [] }),
    };
    const { container } = renderWithClient(<Market />, client);

    expect(await screen.findByText('Bike repair')).toBeTruthy();
    expect(screen.queryByText('Add photo')).toBeNull();
    expect(container.querySelector('input[type="file"]')).toBeNull();
    expect(screen.getAllByLabelText('remove photo')).toHaveLength(5);
  });
});
