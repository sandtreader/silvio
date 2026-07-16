// Flags page: per-currency credit-control flags (decision #3) with live
// search over the resolved member name, level and reason.

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Flag } from '@silvio/ui-shared';
import { FlagsPage } from '../src/pages/FlagsPage';
import { makeMember, makeMockApi } from './mockApi';

function makeFlag(overrides: Partial<Flag> = {}): Flag {
  return {
    accountId: 'a-1',
    memberId: 'm-1',
    level: 'watch',
    reason: 'balance below -200',
    ...overrides,
  };
}

function makeApi() {
  const api = makeMockApi();
  api.adminMembers.mockResolvedValue([
    makeMember({ id: 'm-1', memberNo: 1, displayName: 'Alice Smith' }),
    makeMember({ id: 'm-2', memberNo: 2, displayName: 'Bob Jones' }),
  ]);
  api.adminFlags.mockResolvedValue([
    makeFlag(),
    makeFlag({
      accountId: 'a-2',
      memberId: 'm-2',
      level: 'stop',
      reason: 'no trades in a year',
    }),
  ]);
  return api;
}

describe('FlagsPage', () => {
  it('lists flags with resolved member names', async () => {
    const api = makeApi();
    render(<FlagsPage api={api} />);
    expect(await screen.findByText('1 Alice Smith')).toBeInTheDocument();
    expect(screen.getByText('2 Bob Jones')).toBeInTheDocument();
    expect(screen.getByText('no trades in a year')).toBeInTheDocument();
  });

  it('filters live over member name, level and reason', async () => {
    const api = makeApi();
    render(<FlagsPage api={api} />);
    await screen.findByText('1 Alice Smith');

    await userEvent.type(screen.getByLabelText(/search/i), 'alice');
    expect(screen.getByText('1 Alice Smith')).toBeInTheDocument();
    expect(screen.queryByText('2 Bob Jones')).not.toBeInTheDocument();

    await userEvent.click(screen.getByLabelText(/clear search/i));
    await userEvent.type(screen.getByLabelText(/search/i), 'stop');
    expect(screen.getByText('2 Bob Jones')).toBeInTheDocument();
    expect(screen.queryByText('1 Alice Smith')).not.toBeInTheDocument();
  });
});
