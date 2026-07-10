// Dashboard page: the group's health at a glance for one currency —
// balance distribution bars, monthly trade flow, velocity and dormancy.

import { describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AdminStats } from '@silvio/ui-shared';
import { DashboardPage, monthsBack } from '../src/pages/DashboardPage';
import { makeCurrency, makeMockApi, makeStats } from './mockApi';

/** Stats with some of everything, in recent months so they land in the
 *  dashboard's rolling 12-month window. */
function makeBusyStats(): AdminStats {
  return makeStats({
    balances: [
      { memberId: 'm-1', displayName: 'Alice Smith', balance: 1250 },
      { memberId: 'm-2', displayName: 'Bob Jones', balance: -340 },
    ],
    flow: [
      { month: monthsBack(1), volume: 5000, trades: 7 },
      { month: monthsBack(0), volume: 2500, trades: 3 },
    ],
    velocity: 0.42,
    dormant: [
      { memberId: 'm-3', displayName: 'Carol New' },
      {
        memberId: 'm-4',
        displayName: 'Dave Idle',
        lastTradeAt: '2026-01-15T10:00:00Z',
      },
    ],
  });
}

describe('DashboardPage', () => {
  it('loads currencies then stats for the first currency', async () => {
    const api = makeMockApi();
    render(<DashboardPage api={api} />);
    await waitFor(() => expect(api.adminStats).toHaveBeenCalledWith('c-1'));
    expect(api.currencies).toHaveBeenCalled();
    expect(await screen.findByLabelText(/currency/i)).toBeInTheDocument();
  });

  it('reloads stats when the currency changes', async () => {
    const api = makeMockApi();
    api.currencies.mockResolvedValue([
      makeCurrency(),
      makeCurrency({ id: 'c-2', code: 'ALT', scale: 0 }),
    ]);
    render(<DashboardPage api={api} />);
    await waitFor(() => expect(api.adminStats).toHaveBeenCalledWith('c-1'));

    await userEvent.click(await screen.findByLabelText(/currency/i));
    await userEvent.click(await screen.findByRole('option', { name: 'ALT' }));
    await waitFor(() => expect(api.adminStats).toHaveBeenCalledWith('c-2'));
  });

  it('renders a balance bar per member with name and formatted amount', async () => {
    const api = makeMockApi();
    api.adminStats.mockResolvedValue(makeBusyStats());
    render(<DashboardPage api={api} />);

    expect(await screen.findByText('Alice Smith')).toBeInTheDocument();
    expect(screen.getByText('12.50')).toBeInTheDocument();
    expect(screen.getByText('Bob Jones')).toBeInTheDocument();
    expect(screen.getByText('-3.40')).toBeInTheDocument();
    // One bar per member, sides by sign around the zero axis
    expect(
      screen.getByRole('img', { name: /Alice Smith: balance 12\.50/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('img', { name: /Bob Jones: balance -3\.40/ }),
    ).toBeInTheDocument();
  });

  it('renders the 12-month flow with volumes on hover and trades under labels', async () => {
    const api = makeMockApi();
    api.adminStats.mockResolvedValue(makeBusyStats());
    render(<DashboardPage api={api} />);

    await screen.findByText('Alice Smith');
    // Every month of the window renders, absent months filled with 0
    const bars = screen.getAllByRole('img', { name: /volume/ });
    expect(bars).toHaveLength(12);
    // The trading months carry volume and trade counts
    expect(
      screen.getByRole('img', { name: new RegExp(`${monthsBack(1)}: volume 50\\.00, 7 trades`) }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('img', { name: new RegExp(`${monthsBack(0)}: volume 25\\.00, 3 trades`) }),
    ).toBeInTheDocument();
  });

  it('shows the velocity stat with its explanation', async () => {
    const api = makeMockApi();
    api.adminStats.mockResolvedValue(makeBusyStats());
    render(<DashboardPage api={api} />);

    expect(await screen.findByText('0.42×/30d')).toBeInTheDocument();
    expect(screen.getByText(/30-day trade volume/i)).toBeInTheDocument();
  });

  it('lists dormant members with never-traded or last-trade dates', async () => {
    const api = makeMockApi();
    api.adminStats.mockResolvedValue(makeBusyStats());
    render(<DashboardPage api={api} />);

    const dormant = await screen.findByRole('list', { name: /dormant/i });
    expect(within(dormant).getByText('Carol New')).toBeInTheDocument();
    expect(within(dormant).getByText(/never traded/i)).toBeInTheDocument();
    expect(within(dormant).getByText('Dave Idle')).toBeInTheDocument();
    expect(
      within(dormant).getByText(
        `last trade ${new Date('2026-01-15T10:00:00Z').toLocaleDateString()}`,
      ),
    ).toBeInTheDocument();
  });

  it('shows empty states for a group with no trades', async () => {
    const api = makeMockApi(); // adminStats defaults to the empty makeStats()
    render(<DashboardPage api={api} />);

    expect(await screen.findByText(/no balances yet/i)).toBeInTheDocument();
    expect(screen.getByText(/no trades in the last 12 months/i)).toBeInTheDocument();
    expect(screen.getByText(/no dormant members/i)).toBeInTheDocument();
  });
});
