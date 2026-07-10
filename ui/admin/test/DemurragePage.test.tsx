// Demurrage page: bands editor plus the run history table (GET /admin/runs).

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DemurragePage } from '../src/pages/DemurragePage';
import { makeMockApi } from './mockApi';

describe('DemurragePage', () => {
  it('renders the bands editor and the run history, newest first', async () => {
    const api = makeMockApi();
    api.adminGetBands.mockResolvedValue([{ fromAmount: 0, ratePpmPerMonth: 5000 }]);
    api.adminRuns.mockResolvedValue([
      {
        id: 'run-2', groupId: 'g-1', currencyId: 'c-1', period: '2026-07',
        status: 'running', startedAt: '2026-07-01T02:00:00Z',
      },
      {
        id: 'run-1', groupId: 'g-1', currencyId: 'c-1', period: '2026-06',
        status: 'completed', startedAt: '2026-06-01T02:00:00Z',
        completedAt: '2026-06-01T02:00:05Z',
      },
    ]);

    render(<DemurragePage api={api} />);
    expect(await screen.findByLabelText('band 1 rate')).toHaveValue('0.5000');

    expect(await screen.findByText('2026-07')).toBeInTheDocument();
    const rows = screen.getAllByRole('row', { name: /2026-/ });
    expect(rows[0]).toHaveTextContent('2026-07');
    expect(rows[0]).toHaveTextContent('running');
    expect(rows[1]).toHaveTextContent('2026-06');
    expect(rows[1]).toHaveTextContent('completed');
  });
});
