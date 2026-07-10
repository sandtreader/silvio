import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SettingsPage } from '../src/pages/SettingsPage';
import { makeGroup, makeMockApi } from './mockApi';

describe('SettingsPage', () => {
  it('renders the current values with platform defaults as placeholders', async () => {
    const api = makeMockApi();
    api.adminGroup.mockResolvedValue(
      makeGroup({ settings: { autoAcceptDays: 7, digestDefault: 'monthly' } }),
    );

    render(<SettingsPage api={api} />);
    expect(await screen.findByLabelText('Group name')).toHaveValue('CamLETS');
    expect(screen.getByLabelText('Payment auto-accept days')).toHaveValue(7);
    // Unset keys show the platform default as a placeholder, not a value
    const expiry = screen.getByLabelText('Invoice expiry days');
    expect(expiry).toHaveValue(null);
    expect(expiry).toHaveAttribute('placeholder', '30');
    expect(screen.getByLabelText('Payment auto-accept days')).toHaveAttribute(
      'placeholder',
      '14',
    );
    const shelfLife = screen.getByLabelText('Listing shelf life (days)');
    expect(shelfLife).toHaveValue(null);
    expect(shelfLife).toHaveAttribute('placeholder', '180');
    expect(shelfLife).toHaveAttribute('min', '1');
    expect(shelfLife).toHaveAttribute('max', '730');
    expect(screen.getByText('Monthly')).toBeInTheDocument();
  });

  it('shows the default digest option when no settings are stored', async () => {
    const api = makeMockApi();

    render(<SettingsPage api={api} />);
    expect(await screen.findByText('Platform default (weekly)')).toBeInTheDocument();
  });

  it('saves the group name via PATCH name', async () => {
    const api = makeMockApi();
    api.patchAdminGroup.mockResolvedValue(makeGroup({ name: 'NewLETS' }));

    render(<SettingsPage api={api} />);
    const name = await screen.findByLabelText('Group name');
    await waitFor(() => expect(name).toHaveValue('CamLETS'));
    await userEvent.clear(name);
    await userEvent.type(name, 'NewLETS');
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() =>
      expect(api.patchAdminGroup).toHaveBeenCalledWith({ name: 'NewLETS' }),
    );
    expect(await screen.findByText(/group name saved/i)).toBeInTheDocument();
  });

  it('saves only the keys the admin set; blank numbers are omitted', async () => {
    const api = makeMockApi();
    api.adminGroup.mockResolvedValue(
      makeGroup({ settings: { autoAcceptDays: 7, invoiceExpiryDays: 60 } }),
    );
    api.patchAdminGroup.mockResolvedValue(
      makeGroup({
        settings: {
          autoAcceptDays: 21,
          listingMaxAgeDays: 365,
          digestDefault: 'monthly',
        },
      }),
    );

    render(<SettingsPage api={api} />);
    const auto = await screen.findByLabelText('Payment auto-accept days');
    await waitFor(() => expect(auto).toHaveValue(7));
    await userEvent.clear(auto);
    await userEvent.type(auto, '21');
    // Blanking the expiry drops its key so the platform default applies
    await userEvent.clear(screen.getByLabelText('Invoice expiry days'));
    await userEvent.type(
      screen.getByLabelText('Listing shelf life (days)'),
      '365',
    );
    await userEvent.click(
      screen.getByLabelText('Digest default for new members'),
    );
    await userEvent.click(await screen.findByRole('option', { name: 'Monthly' }));
    await userEvent.click(screen.getByRole('button', { name: /save settings/i }));
    await waitFor(() =>
      expect(api.patchAdminGroup).toHaveBeenCalledWith({
        settings: {
          autoAcceptDays: 21,
          listingMaxAgeDays: 365,
          digestDefault: 'monthly',
        },
      }),
    );
    expect(await screen.findByText(/settings saved/i)).toBeInTheDocument();
  });

  it('sends an empty settings object when everything is left as default', async () => {
    const api = makeMockApi();
    api.adminGroup.mockResolvedValue(
      makeGroup({ settings: { autoAcceptDays: 7 } }),
    );
    api.patchAdminGroup.mockResolvedValue(makeGroup());

    render(<SettingsPage api={api} />);
    const auto = await screen.findByLabelText('Payment auto-accept days');
    await waitFor(() => expect(auto).toHaveValue(7));
    await userEvent.clear(auto);
    await userEvent.click(screen.getByRole('button', { name: /save settings/i }));
    await waitFor(() =>
      expect(api.patchAdminGroup).toHaveBeenCalledWith({ settings: {} }),
    );
  });
});
