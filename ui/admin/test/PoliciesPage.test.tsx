import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Policy } from '@silvio/ui-shared';
import { PoliciesPage } from '../src/pages/PoliciesPage';
import { makeMockApi } from './mockApi';

const policy: Policy = {
  id: 'p-1',
  groupId: 'g-1',
  currencyId: 'c-1',
  type: 'hard_limit',
  config: { minBalance: -40000 },
  enabled: true,
};

describe('PoliciesPage', () => {
  it('lists policies with pretty-printed config', async () => {
    const api = makeMockApi();
    api.adminPolicies.mockResolvedValue([policy]);

    render(<PoliciesPage api={api} />);
    expect(await screen.findByText('hard_limit')).toBeInTheDocument();
    expect(screen.getByText(/-40000/)).toBeInTheDocument();
  });

  it('disables a policy via the switch', async () => {
    const api = makeMockApi();
    api.adminPolicies.mockResolvedValue([policy]);
    api.adminPatchPolicy.mockResolvedValue({ ...policy, enabled: false });

    render(<PoliciesPage api={api} />);
    const toggle = await screen.findByRole('checkbox');
    expect(toggle).toBeChecked();

    await userEvent.click(toggle);
    await waitFor(() =>
      expect(api.adminPatchPolicy).toHaveBeenCalledWith('p-1', { enabled: false }),
    );
    await waitFor(() => expect(screen.getByRole('checkbox')).not.toBeChecked());
  });

  it('adds a hard-limit policy with parsed amounts', async () => {
    const api = makeMockApi();
    api.adminAddPolicy.mockResolvedValue(policy);

    render(<PoliciesPage api={api} />);
    await userEvent.click(
      await screen.findByRole('button', { name: /add policy/i }),
    );
    await userEvent.type(
      await screen.findByLabelText(/min balance/i),
      '-400.00',
    );
    await userEvent.click(screen.getByRole('button', { name: /^add$/i }));
    await waitFor(() =>
      expect(api.adminAddPolicy).toHaveBeenCalledWith({
        currencyId: 'c-1',
        type: 'hard_limit',
        config: { minBalance: -40000 },
      }),
    );
  });
});
