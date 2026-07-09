import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NewsPage } from '../src/pages/NewsPage';
import { makeMockApi, makeNewsItem } from './mockApi';

const news = [
  makeNewsItem({ id: 'n-1', title: 'Summer market day' }),
  makeNewsItem({
    id: 'n-2',
    title: 'AGM notice',
    publishedAt: '2026-07-01T10:00:00Z',
    expiresAt: '2026-08-01T10:00:00Z',
  }),
];

describe('NewsPage', () => {
  it('lists news with published and expiry dates', async () => {
    const api = makeMockApi();
    api.adminNews.mockResolvedValue(news);

    render(<NewsPage api={api} />);
    expect(await screen.findByText('Summer market day')).toBeInTheDocument();
    expect(screen.getByText('AGM notice')).toBeInTheDocument();
    expect(
      screen.getByText(new Date('2026-08-01T10:00:00Z').toLocaleString()),
    ).toBeInTheDocument();
    // The item without an expiry shows a dash
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('creates a news item, omitting blank dates (server defaults publishedAt)', async () => {
    const api = makeMockApi();
    api.adminNews.mockResolvedValue(news);
    api.adminCreateNews.mockResolvedValue(makeNewsItem({ id: 'n-3' }));

    render(<NewsPage api={api} />);
    await userEvent.click(
      await screen.findByRole('button', { name: /add news item/i }),
    );
    await userEvent.type(await screen.findByLabelText('Title'), 'Village fair');
    await userEvent.type(screen.getByLabelText('Body'), 'A *grand* day out.');
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() =>
      expect(api.adminCreateNews).toHaveBeenCalledWith({
        title: 'Village fair',
        body: 'A *grand* day out.',
      }),
    );
  });

  it('creates a news item with explicit published and expiry times', async () => {
    const api = makeMockApi();
    api.adminNews.mockResolvedValue(news);
    api.adminCreateNews.mockResolvedValue(makeNewsItem({ id: 'n-3' }));

    render(<NewsPage api={api} />);
    await userEvent.click(
      await screen.findByRole('button', { name: /add news item/i }),
    );
    await userEvent.type(await screen.findByLabelText('Title'), 'Village fair');
    await userEvent.type(screen.getByLabelText('Body'), 'Soon.');
    fireEvent.change(screen.getByLabelText('Published at'), {
      target: { value: '2026-08-01T10:00' },
    });
    fireEvent.change(screen.getByLabelText('Expires at'), {
      target: { value: '2026-09-01T10:00' },
    });
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() =>
      expect(api.adminCreateNews).toHaveBeenCalledWith({
        title: 'Village fair',
        body: 'Soon.',
        publishedAt: new Date('2026-08-01T10:00').toISOString(),
        expiresAt: new Date('2026-09-01T10:00').toISOString(),
      }),
    );
  });

  it('edits a news item via the edit icon', async () => {
    const api = makeMockApi();
    api.adminNews.mockResolvedValue(news);
    api.adminUpdateNews.mockResolvedValue(makeNewsItem({ id: 'n-1' }));

    render(<NewsPage api={api} />);
    await userEvent.click(
      await screen.findByRole('button', { name: /edit summer market day/i }),
    );
    const title = await screen.findByLabelText('Title');
    await userEvent.clear(title);
    await userEvent.type(title, 'Market day moved');
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() =>
      expect(api.adminUpdateNews).toHaveBeenCalledWith('n-1', {
        title: 'Market day moved',
        body: 'Bring your *best* produce.', // makeNewsItem default body
        publishedAt: new Date('2026-07-05T09:00:00Z').toISOString(),
      }),
    );
  });

  it('deletes a news item after confirmation', async () => {
    const api = makeMockApi();
    api.adminNews.mockResolvedValue(news);

    render(<NewsPage api={api} />);
    await userEvent.click(
      await screen.findByRole('button', { name: /delete agm notice/i }),
    );
    await userEvent.click(await screen.findByRole('button', { name: /^delete$/i }));
    await waitFor(() => expect(api.adminDeleteNews).toHaveBeenCalledWith('n-2'));
  });

  it('live-previews markdown and never renders raw HTML', async () => {
    const api = makeMockApi();
    api.adminNews.mockResolvedValue([]);

    render(<NewsPage api={api} />);
    await userEvent.click(
      await screen.findByRole('button', { name: /add news item/i }),
    );
    await userEvent.type(
      await screen.findByLabelText('Body'),
      'So *exciting* <script>alert(1)</script>',
    );
    const preview = screen.getByTestId('markdown-preview');
    await waitFor(() => {
      const em = within(preview).getByText('exciting');
      expect(em.tagName).toBe('EM');
    });
    expect(preview.querySelector('script')).toBeNull();
    expect(preview.innerHTML).toContain('&lt;script&gt;');
  });
});
