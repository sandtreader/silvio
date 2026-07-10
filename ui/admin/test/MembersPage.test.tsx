import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MembersPage } from '../src/pages/MembersPage';
import { makeMember, makeMockApi, makeRestriction } from './mockApi';

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

  it('offers only Restrict (not Unrestrict) for an unrestricted member', async () => {
    const api = makeMockApi();
    api.adminMembers.mockResolvedValue([
      makeMember({ id: 'm-1', displayName: 'Alice Smith' }),
    ]);

    render(<MembersPage api={api} />);
    await userEvent.click(
      await screen.findByRole('button', { name: /actions for alice smith/i }),
    );
    expect(await screen.findByRole('menuitem', { name: /restrict…/i })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /unrestrict/i })).not.toBeInTheDocument();
  });

  it('acts for an active member after the confirm dialog (#24)', async () => {
    const api = makeMockApi();
    api.adminMembers.mockResolvedValue([
      makeMember({ id: 'm-1', displayName: 'Alice Smith', status: 'active' }),
      makeMember({ id: 'm-2', memberNo: 2, displayName: 'Bob Jones', status: 'suspended' }),
    ]);

    render(<MembersPage api={api} />);
    // Suspended members get no Act as… action.
    await userEvent.click(
      await screen.findByRole('button', { name: /actions for bob jones/i }),
    );
    expect(screen.queryByRole('menuitem', { name: /act as…/i })).not.toBeInTheDocument();
    await userEvent.keyboard('{Escape}');

    await userEvent.click(
      screen.getByRole('button', { name: /actions for alice smith/i }),
    );
    await userEvent.click(await screen.findByRole('menuitem', { name: /act as…/i }));
    // The confirm dialog explains the recording, then starts acting.
    expect(await screen.findByText(/recorded in the audit log/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /act as member/i }));
    await waitFor(() => expect(api.actAsMember).toHaveBeenCalledWith('m-1'));
    // Success snackbar links to the member app.
    expect(await screen.findByText(/now acting for alice smith/i)).toBeInTheDocument();
    expect(screen.getByText('the member app').closest('a')).toHaveAttribute(
      'href',
      '/app/',
    );
  });

  it('marks restricted members and offers only Unrestrict', async () => {
    const api = makeMockApi();
    api.adminMembers.mockResolvedValue([
      makeMember({ id: 'm-1', displayName: 'Alice Smith' }),
      makeMember({ id: 'm-2', memberNo: 2, displayName: 'Bob Jones' }),
    ]);
    api.adminRestrictions.mockResolvedValue([
      makeRestriction({ memberId: 'm-1', reason: 'runaway balance' }),
    ]);

    render(<MembersPage api={api} />);
    expect(await screen.findByText('restricted')).toBeInTheDocument();
    // Only Alice is restricted, so exactly one chip.
    expect(screen.getAllByText('restricted')).toHaveLength(1);

    await userEvent.click(
      screen.getByRole('button', { name: /actions for alice smith/i }),
    );
    const unrestrict = await screen.findByRole('menuitem', { name: /unrestrict/i });
    expect(screen.queryByRole('menuitem', { name: /restrict…/i })).not.toBeInTheDocument();

    api.adminRestrictions.mockResolvedValue([]);
    await userEvent.click(unrestrict);
    await waitFor(() => expect(api.adminUnrestrict).toHaveBeenCalledWith('m-1'));
    // The list refreshes and the chip disappears once the restriction is lifted.
    await waitFor(() =>
      expect(screen.queryByText('restricted')).not.toBeInTheDocument(),
    );
  });
});
