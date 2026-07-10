import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GroupsPage } from '../src/pages/GroupsPage';
import { makeMockApi, makeOperatorGroup } from './mockApi';

describe('GroupsPage', () => {
  it('renders the group table with status chips', async () => {
    const api = makeMockApi();
    api.operatorGroups.mockResolvedValue([
      makeOperatorGroup({ id: 'g-1', slug: 'camlets', name: 'CamLETS', plan: 'hosted' }),
      makeOperatorGroup({
        id: 'g-2',
        slug: 'oxlets',
        name: 'OxLETS',
        status: 'suspended',
      }),
    ]);

    render(<GroupsPage api={api} />);
    expect(await screen.findByText('CamLETS')).toBeInTheDocument();
    expect(screen.getByText('OxLETS')).toBeInTheDocument();
    expect(screen.getByText('hosted')).toBeInTheDocument();
    // Suspended renders in the warning colour (#20)
    const suspended = screen.getByText('suspended').closest('.MuiChip-root');
    expect(suspended).toHaveClass('MuiChip-colorWarning');
    expect(screen.getByText('active').closest('.MuiChip-root')).toHaveClass(
      'MuiChip-colorSuccess',
    );
  });

  it('suspends a group through the confirm dialog', async () => {
    const api = makeMockApi();
    api.operatorGroups.mockResolvedValue([
      makeOperatorGroup({ id: 'g-1', name: 'CamLETS' }),
    ]);
    api.patchOperatorGroup.mockResolvedValue(
      makeOperatorGroup({ id: 'g-1', name: 'CamLETS', status: 'suspended' }),
    );

    render(<GroupsPage api={api} />);
    await userEvent.click(await screen.findByText('CamLETS'));
    await userEvent.click(screen.getByRole('button', { name: /suspend…/i }));
    // The confirm explains #20's read-only semantics
    expect(await screen.findByText(/read-only/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /^suspend$/i }));
    await waitFor(() =>
      expect(api.patchOperatorGroup).toHaveBeenCalledWith('g-1', {
        status: 'suspended',
      }),
    );
  });

  it('sends null to clear the notes when blanked', async () => {
    const api = makeMockApi();
    api.operatorGroups.mockResolvedValue([
      makeOperatorGroup({ id: 'g-1', name: 'CamLETS', notes: 'lapsed since May' }),
    ]);
    api.patchOperatorGroup.mockResolvedValue(makeOperatorGroup({ id: 'g-1' }));

    render(<GroupsPage api={api} />);
    await userEvent.click(await screen.findByText('CamLETS'));
    const notes = screen.getByLabelText(/operator notes/i);
    expect(notes).toHaveValue('lapsed since May');
    await userEvent.clear(notes);
    await userEvent.click(screen.getByRole('button', { name: /save notes/i }));
    await waitFor(() =>
      expect(api.patchOperatorGroup).toHaveBeenCalledWith('g-1', { notes: null }),
    );
  });

  it('adds and removes a domain, removal via confirm', async () => {
    const api = makeMockApi();
    const before = makeOperatorGroup({
      id: 'g-1',
      name: 'CamLETS',
      domains: ['cam.example.org'],
    });
    const after = makeOperatorGroup({
      id: 'g-1',
      name: 'CamLETS',
      domains: ['cam.example.org', 'lets.example.org'],
    });
    // Initial load, refetch after add, refetch after remove
    api.operatorGroups
      .mockResolvedValueOnce([before])
      .mockResolvedValueOnce([after])
      .mockResolvedValue([before]);

    render(<GroupsPage api={api} />);
    await userEvent.click(await screen.findByText('CamLETS'));
    // The panel lists the group's current domains
    expect(screen.getByText('cam.example.org')).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText(/hostname/i), 'lets.example.org');
    await userEvent.click(screen.getByRole('button', { name: /^add$/i }));
    await waitFor(() =>
      expect(api.addGroupDomain).toHaveBeenCalledWith('g-1', 'lets.example.org'),
    );
    // The list refreshes to include the new hostname, with a remove action
    expect(await screen.findByText('lets.example.org')).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole('button', { name: /remove lets\.example\.org/i }),
    );
    await userEvent.click(await screen.findByRole('button', { name: /^remove$/i }));
    await waitFor(() =>
      expect(api.removeGroupDomain).toHaveBeenCalledWith('g-1', 'lets.example.org'),
    );
    // ...and refreshes again without it
    await waitFor(() =>
      expect(screen.queryByText('lets.example.org')).not.toBeInTheDocument(),
    );
  });
});
