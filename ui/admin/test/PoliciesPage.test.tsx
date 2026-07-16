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
  it('lists policies with config rendered at the currency scale (#26)', async () => {
    const api = makeMockApi();
    api.adminPolicies.mockResolvedValue([
      policy,
      {
        ...policy,
        id: 'p-2',
        type: 'soft_threshold',
        config: { thresholds: [{ balance: -25000, level: 'review' }] },
      },
      { ...policy, id: 'p-3', type: 'max_payment', config: { maxAmount: 50000 } },
    ]);

    render(<PoliciesPage api={api} />);
    expect(await screen.findByText('hard_limit')).toBeInTheDocument();
    // Human amounts, not raw minor-unit JSON.
    expect(screen.getByText(/min -400\.00/)).toBeInTheDocument();
    expect(screen.getByText(/-250\.00 → review/)).toBeInTheDocument();
    expect(screen.getByText(/max payment 500\.00/)).toBeInTheDocument();
    expect(screen.queryByText(/-40000/)).not.toBeInTheDocument();
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

  it('adds a max_payment policy with a parsed cap (#26)', async () => {
    const api = makeMockApi();
    api.adminAddPolicy.mockResolvedValue({
      ...policy,
      id: 'p-3',
      type: 'max_payment',
      config: { maxAmount: 50000 },
    });

    render(<PoliciesPage api={api} />);
    await userEvent.click(
      await screen.findByRole('button', { name: /add policy/i }),
    );
    await userEvent.click(screen.getByLabelText(/type/i));
    await userEvent.click(await screen.findByRole('option', { name: /max payment/i }));
    await userEvent.type(
      await screen.findByLabelText(/max payment/i),
      '500.00',
    );
    await userEvent.click(screen.getByRole('button', { name: /^add$/i }));
    await waitFor(() =>
      expect(api.adminAddPolicy).toHaveBeenCalledWith({
        currencyId: 'c-1',
        type: 'max_payment',
        config: { maxAmount: 50000 },
      }),
    );
  });

  it('adds a soft-threshold policy choosing the level from a select', async () => {
    const api = makeMockApi();
    api.adminAddPolicy.mockResolvedValue({
      ...policy,
      id: 'p-2',
      type: 'soft_threshold',
      config: { thresholds: [{ balance: -20000, level: 'review' }] },
    });

    render(<PoliciesPage api={api} />);
    await userEvent.click(
      await screen.findByRole('button', { name: /add policy/i }),
    );
    await userEvent.click(screen.getByLabelText(/type/i));
    await userEvent.click(
      await screen.findByRole('option', { name: /soft thresholds/i }),
    );
    await userEvent.type(screen.getByLabelText(/balance/i), '-200.00');

    // Level offers the escalation ladder rather than free text.
    await userEvent.click(screen.getByLabelText(/level/i));
    const levels = screen.getAllByRole('option').map((o) => o.textContent);
    expect(levels).toEqual(['notice', 'review', 'alert']);
    await userEvent.click(screen.getByRole('option', { name: 'review' }));

    await userEvent.click(screen.getByRole('button', { name: /^add$/i }));
    await waitFor(() =>
      expect(api.adminAddPolicy).toHaveBeenCalledWith({
        currencyId: 'c-1',
        type: 'soft_threshold',
        config: { thresholds: [{ balance: -20000, level: 'review' }] },
      }),
    );
  });

  it('deletes a policy behind a confirmation', async () => {
    const api = makeMockApi();
    api.adminPolicies.mockResolvedValue([policy]);
    api.adminDeletePolicy.mockResolvedValue(true);

    render(<PoliciesPage api={api} />);
    await userEvent.click(
      await screen.findByRole('button', { name: /delete hard_limit/i }),
    );
    // Nothing deleted before the confirmation.
    expect(api.adminDeletePolicy).not.toHaveBeenCalled();

    await userEvent.click(await screen.findByRole('button', { name: /^delete$/i }));
    await waitFor(() => expect(api.adminDeletePolicy).toHaveBeenCalledWith('p-1'));
  });

  it('explains blocking vs flagging and that min balance is usually negative (#26)', async () => {
    const api = makeMockApi();
    render(<PoliciesPage api={api} />);
    await userEvent.click(
      await screen.findByRole('button', { name: /add policy/i }),
    );
    // Which types block and which only flag.
    expect(screen.getByText(/block/i)).toBeInTheDocument();
    expect(screen.getByText(/only raise flags/i)).toBeInTheDocument();
    // The debit floor is a negative number for a normal debit allowance.
    expect(screen.getByText(/usually negative/i)).toBeInTheDocument();
  });
});
