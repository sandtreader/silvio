import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApprovalQueuePage } from '../src/pages/ApprovalQueuePage';
import { makeMember, makeMockApi } from './mockApi';

describe('ApprovalQueuePage', () => {
  it('shows an empty-state message when nobody has applied', async () => {
    const api = makeMockApi();
    render(<ApprovalQueuePage api={api} />);
    expect(
      await screen.findByText(/no applications waiting/i),
    ).toBeInTheDocument();
    expect(api.adminMembers).toHaveBeenCalledWith('applied');
  });

  it('lists applicants and approves via adminMemberAction', async () => {
    const api = makeMockApi();
    const applicant = makeMember({
      id: 'm-2',
      memberNo: 7,
      displayName: 'Bob Jones',
      status: 'applied',
    });
    api.adminMembers.mockResolvedValue([applicant]);

    render(<ApprovalQueuePage api={api} />);
    expect(await screen.findByText('Bob Jones')).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /approve/i }));
    await waitFor(() =>
      expect(api.adminMemberAction).toHaveBeenCalledWith('m-2', 'approve'),
    );
    // Refreshed after the action: initial load + post-action reload
    expect(api.adminMembers.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('rejects via the remove action', async () => {
    const api = makeMockApi();
    api.adminMembers.mockResolvedValue([
      makeMember({ id: 'm-3', displayName: 'Carol', status: 'applied' }),
    ]);

    render(<ApprovalQueuePage api={api} />);
    await userEvent.click(await screen.findByRole('button', { name: /reject/i }));
    await waitFor(() =>
      expect(api.adminMemberAction).toHaveBeenCalledWith('m-3', 'remove'),
    );
  });
});
