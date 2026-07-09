import { describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EmailTemplatesPage } from '../src/pages/EmailTemplatesPage';
import { makeEmailTemplate, makeGroup, makeMockApi } from './mockApi';

const templates = [
  makeEmailTemplate(),
  makeEmailTemplate({
    kind: 'payment_held',
    subject: 'Custom hold: {{amount}}',
    body: 'Someone sent you {{amount}}.',
    isDefault: false,
  }),
];

describe('EmailTemplatesPage', () => {
  it('lists templates with human labels and an edited flag on overrides', async () => {
    const api = makeMockApi();
    api.adminEmailTemplates.mockResolvedValue(templates);

    render(<EmailTemplatesPage api={api} />);
    expect(await screen.findByText('Welcome / approval')).toBeInTheDocument();
    expect(screen.getByText('Payment held for confirmation')).toBeInTheDocument();
    expect(screen.getByText('Custom hold: {{amount}}')).toBeInTheDocument();
    // Only the overridden kind is flagged
    expect(screen.getAllByText('edited')).toHaveLength(1);
  });

  it('edits a template and saves the override via PUT', async () => {
    const api = makeMockApi();
    api.adminEmailTemplates.mockResolvedValue(templates);
    api.putEmailTemplate.mockResolvedValue(
      makeEmailTemplate({ isDefault: false }),
    );

    render(<EmailTemplatesPage api={api} />);
    await userEvent.click(
      await screen.findByRole('button', { name: /edit welcome \/ approval/i }),
    );
    const dialog = await screen.findByRole('dialog');
    const subject = within(dialog).getByLabelText('Subject');
    await userEvent.clear(subject);
    await userEvent.type(subject, 'Hello from {{{{groupName}}');
    await userEvent.click(within(dialog).getByRole('button', { name: /^save$/i }));
    await waitFor(() =>
      expect(api.putEmailTemplate).toHaveBeenCalledWith('welcome', {
        subject: 'Hello from {{groupName}}',
        body: 'Hello {{memberName}}, your membership has been approved.',
      }),
    );
    // The list refreshes with the new override
    await waitFor(() => expect(api.adminEmailTemplates).toHaveBeenCalledTimes(2));
  });

  it('shows the placeholders used by the template being edited', async () => {
    const api = makeMockApi();
    api.adminEmailTemplates.mockResolvedValue(templates);

    render(<EmailTemplatesPage api={api} />);
    await userEvent.click(
      await screen.findByRole('button', {
        name: /edit payment held for confirmation/i,
      }),
    );
    expect(
      await screen.findByText(/Placeholders used: \{\{amount\}\}/),
    ).toBeInTheDocument();
  });

  it('offers revert only on overrides, and reverts via DELETE after confirm', async () => {
    const api = makeMockApi();
    api.adminEmailTemplates.mockResolvedValue(templates);

    render(<EmailTemplatesPage api={api} />);
    // A default template has no revert button
    await userEvent.click(
      await screen.findByRole('button', { name: /edit welcome \/ approval/i }),
    );
    expect(
      screen.queryByRole('button', { name: /revert to default/i }),
    ).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /^cancel$/i }));

    // An overridden one does
    await userEvent.click(
      await screen.findByRole('button', {
        name: /edit payment held for confirmation/i,
      }),
    );
    await userEvent.click(
      await screen.findByRole('button', { name: /revert to default/i }),
    );
    await userEvent.click(await screen.findByRole('button', { name: /^revert$/i }));
    await waitFor(() =>
      expect(api.deleteEmailTemplate).toHaveBeenCalledWith('payment_held'),
    );
    await waitFor(() => expect(api.adminEmailTemplates).toHaveBeenCalledTimes(2));
  });

  it('loads and saves the sender address', async () => {
    const api = makeMockApi();
    api.adminGroup.mockResolvedValue(makeGroup({ emailFrom: 'old@example.org' }));
    api.patchAdminGroup.mockResolvedValue(
      makeGroup({ emailFrom: 'lets@example.org' }),
    );

    render(<EmailTemplatesPage api={api} />);
    const sender = await screen.findByLabelText('Sender address');
    await waitFor(() => expect(sender).toHaveValue('old@example.org'));
    await userEvent.clear(sender);
    await userEvent.type(sender, 'lets@example.org');
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() =>
      expect(api.patchAdminGroup).toHaveBeenCalledWith({
        emailFrom: 'lets@example.org',
      }),
    );
    expect(await screen.findByText(/sender address saved/i)).toBeInTheDocument();
  });

  it('saves a blank sender as null to fall back to the instance default', async () => {
    const api = makeMockApi();
    api.adminGroup.mockResolvedValue(makeGroup({ emailFrom: 'old@example.org' }));
    api.patchAdminGroup.mockResolvedValue(makeGroup());

    render(<EmailTemplatesPage api={api} />);
    const sender = await screen.findByLabelText('Sender address');
    await waitFor(() => expect(sender).toHaveValue('old@example.org'));
    await userEvent.clear(sender);
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() =>
      expect(api.patchAdminGroup).toHaveBeenCalledWith({ emailFrom: null }),
    );
  });
});
