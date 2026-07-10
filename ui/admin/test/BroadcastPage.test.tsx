import { describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BroadcastPage } from '../src/pages/BroadcastPage';
import { makeMockApi } from './mockApi';

describe('BroadcastPage', () => {
  it('disables Send until both subject and body are filled', async () => {
    const api = makeMockApi();
    render(<BroadcastPage api={api} />);

    const send = screen.getByRole('button', { name: /^send$/i });
    expect(send).toBeDisabled();

    await userEvent.type(screen.getByLabelText('Subject'), 'Summer fair');
    expect(send).toBeDisabled(); // body still empty

    await userEvent.type(screen.getByLabelText('Body'), 'Bring *everything*.');
    expect(send).toBeEnabled();

    await userEvent.clear(screen.getByLabelText('Subject'));
    expect(send).toBeDisabled(); // subject cleared again
  });

  it('sends after confirmation, shows the queued count and clears the form', async () => {
    const api = makeMockApi();
    api.adminBroadcast.mockResolvedValue(42);
    render(<BroadcastPage api={api} />);

    await userEvent.type(screen.getByLabelText('Subject'), 'Summer fair');
    await userEvent.type(screen.getByLabelText('Body'), 'Bring *everything*.');
    await userEvent.click(screen.getByRole('button', { name: /^send$/i }));

    // Nothing goes out until the "emails every active member" confirmation.
    expect(api.adminBroadcast).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/emails every active member/i)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: /send broadcast/i }));

    await waitFor(() =>
      expect(api.adminBroadcast).toHaveBeenCalledWith('Summer fair', 'Bring *everything*.'),
    );
    expect(await screen.findByText(/queued to 42 members/i)).toBeInTheDocument();
    expect(screen.getByLabelText('Subject')).toHaveValue('');
    expect(screen.getByLabelText('Body')).toHaveValue('');
  });

  it('does not send when the confirmation is cancelled', async () => {
    const api = makeMockApi();
    render(<BroadcastPage api={api} />);

    await userEvent.type(screen.getByLabelText('Subject'), 'Oops');
    await userEvent.type(screen.getByLabelText('Body'), 'Not yet.');
    await userEvent.click(screen.getByRole('button', { name: /^send$/i }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: /cancel/i }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(api.adminBroadcast).not.toHaveBeenCalled();
    // The draft survives a cancel.
    expect(screen.getByLabelText('Subject')).toHaveValue('Oops');
  });

  it('live-previews the markdown body', async () => {
    const api = makeMockApi();
    render(<BroadcastPage api={api} />);

    await userEvent.type(screen.getByLabelText('Body'), 'So *exciting*');
    const preview = screen.getByTestId('markdown-preview');
    await waitFor(() => {
      const em = within(preview).getByText('exciting');
      expect(em.tagName).toBe('EM');
    });
  });
});
