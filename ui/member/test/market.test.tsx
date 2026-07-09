// Market page: public browse renders listing cards even when logged out.
import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Market } from '../src/pages/Market';
import { notAuthorised, renderWithClient } from './helpers';

describe('Market', () => {
  it('renders listings from browse() while logged out', async () => {
    const client = {
      me: vi.fn().mockRejectedValue(notAuthorised()),
      currencies: vi.fn().mockResolvedValue({
        currencies: [
          { id: 'c1', groupId: 'g1', code: 'CAM', name: 'Cams', scale: 2, createdAt: '2026-01-01T00:00:00Z' },
        ],
      }),
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
    };
    renderWithClient(<Market />, client);

    expect(await screen.findByText('Bike repair')).toBeTruthy();
    expect(screen.getByText('Dog walking')).toBeTruthy();
    expect(screen.getByText('Offer')).toBeTruthy();
    expect(screen.getByText('Want')).toBeTruthy();
    expect(screen.getByText('5.00')).toBeTruthy(); // priceAmount at scale 2
    expect(screen.getByText('negotiable')).toBeTruthy(); // rateText fallback
    // Logged out: no post-listing FAB
    expect(screen.queryByLabelText('post listing')).toBeNull();
  });
});

// Public browse must format prices at the currency's real scale from
// GET /currencies — not the logged-in viewer's accounts (there is no
// viewer), and not the fallback guess.
describe('Market price scale', () => {
  it('uses the group currency scale when logged out', async () => {
    const client = {
      me: vi.fn().mockRejectedValue(notAuthorised()),
      currencies: vi.fn().mockResolvedValue({
        currencies: [
          { id: 'c1', groupId: 'g1', code: 'HRS', name: 'Hours', scale: 0, createdAt: '2026-01-01T00:00:00Z' },
        ],
      }),
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
    };
    renderWithClient(<Market />, client);

    expect(await screen.findByText('Hedge trimming')).toBeTruthy();
    // scale 0: '3', not the fallback-scale-2 '0.03'
    expect(screen.getByText('3')).toBeTruthy();
    expect(screen.queryByText('0.03')).toBeNull();
  });
});
