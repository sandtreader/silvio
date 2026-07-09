// Market page: authenticated browse (decision #12 — public browse moved to
// the brochure site) renders listing cards with the post-listing FAB.
import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Market } from '../src/pages/Market';
import { renderWithClient, testMe } from './helpers';

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
