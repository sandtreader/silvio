import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProvisionPage } from '../src/pages/ProvisionPage';
import { makeCurrency, makeGroup, makeMockApi } from './mockApi';

describe('ProvisionPage', () => {
  it('requires slug, name and currency before enabling Provision', async () => {
    const api = makeMockApi();
    render(<ProvisionPage api={api} />);

    const provision = screen.getByRole('button', { name: /provision/i });
    expect(provision).toBeDisabled();

    await userEvent.type(screen.getByLabelText(/slug/i), 'camlets');
    await userEvent.type(screen.getByLabelText(/^group name/i), 'CamLETS');
    expect(provision).toBeDisabled();

    await userEvent.type(screen.getByLabelText(/^code/i), 'CAM');
    await userEvent.type(screen.getByLabelText(/^currency name/i), 'Cams');
    expect(provision).toBeEnabled();
  });

  it('submits the full payload and hints about domains when no hostname', async () => {
    const api = makeMockApi();
    api.provisionGroup.mockResolvedValue({
      group: makeGroup({ name: 'CamLETS' }),
      currency: makeCurrency(),
    });
    render(<ProvisionPage api={api} />);

    await userEvent.type(screen.getByLabelText(/slug/i), 'camlets');
    await userEvent.type(screen.getByLabelText(/^group name/i), 'CamLETS');
    await userEvent.type(screen.getByLabelText(/^code/i), 'CAM');
    await userEvent.type(screen.getByLabelText(/^currency name/i), 'Cams');
    await userEvent.type(screen.getByLabelText(/scale/i), '0');
    await userEvent.click(screen.getByLabelText(/create initial admin/i));
    await userEvent.type(screen.getByLabelText(/display name/i), 'Alice');
    await userEvent.type(screen.getByLabelText(/person name/i), 'Alice Smith');
    await userEvent.type(screen.getByLabelText(/^email/i), 'alice@example.org');
    await userEvent.type(screen.getByLabelText(/^password/i), 'hunter22');
    await userEvent.click(screen.getByRole('button', { name: /provision/i }));

    await waitFor(() =>
      expect(api.provisionGroup).toHaveBeenCalledWith({
        slug: 'camlets',
        name: 'CamLETS',
        currency: { code: 'CAM', name: 'Cams', scale: 0 },
        admin: {
          displayName: 'Alice',
          personName: 'Alice Smith',
          email: 'alice@example.org',
          password: 'hunter22',
        },
      }),
    );
    // Success: snackbar with the add-domains hint, and the form resets
    expect(await screen.findByText(/add.*domains on the groups page/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/slug/i)).toHaveValue('');
  });
});
