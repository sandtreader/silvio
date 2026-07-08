import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MembersPage } from '../src/pages/MembersPage';
import { makeMember, makeMockApi } from './mockApi';

describe('MembersPage', () => {
  it('renders the member table with status and role', async () => {
    const api = makeMockApi();
    api.adminMembers.mockResolvedValue([
      makeMember({ id: 'm-1', memberNo: 1, displayName: 'Alice Smith' }),
      makeMember({
        id: 'm-2',
        memberNo: 2,
        displayName: 'Bob Jones',
        status: 'suspended',
        role: 'committee',
      }),
    ]);

    render(<MembersPage api={api} />);
    expect(await screen.findByText('Alice Smith')).toBeInTheDocument();
    expect(screen.getByText('Bob Jones')).toBeInTheDocument();
    expect(screen.getByText('suspended')).toBeInTheDocument();
    expect(screen.getByText('committee')).toBeInTheDocument();
  });

  it('suspends an active member from the row menu', async () => {
    const api = makeMockApi();
    api.adminMembers.mockResolvedValue([
      makeMember({ id: 'm-1', displayName: 'Alice Smith', status: 'active' }),
    ]);

    render(<MembersPage api={api} />);
    await userEvent.click(
      await screen.findByRole('button', { name: /actions for alice smith/i }),
    );
    await userEvent.click(await screen.findByRole('menuitem', { name: /suspend/i }));
    await waitFor(() =>
      expect(api.adminMemberAction).toHaveBeenCalledWith('m-1', 'suspend'),
    );
  });

  it('restricts a member with a reason via the dialog', async () => {
    const api = makeMockApi();
    api.adminMembers.mockResolvedValue([
      makeMember({ id: 'm-1', displayName: 'Alice Smith' }),
    ]);

    render(<MembersPage api={api} />);
    await userEvent.click(
      await screen.findByRole('button', { name: /actions for alice smith/i }),
    );
    await userEvent.click(
      await screen.findByRole('menuitem', { name: /restrict…/i }),
    );
    await userEvent.type(await screen.findByLabelText(/reason/i), 'leeching');
    await userEvent.click(screen.getByRole('button', { name: /^restrict$/i }));
    await waitFor(() =>
      expect(api.adminRestrict).toHaveBeenCalledWith('m-1', 'leeching'),
    );
  });
});
