import { describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PagesPage } from '../src/pages/PagesPage';
import { makeMockApi, makePage } from './mockApi';

const pages = [
  makePage({ id: 'p-1', slug: 'home', title: 'Welcome', visibility: 'public' }),
  makePage({
    id: 'p-2',
    slug: 'constitution',
    title: 'Our constitution',
    visibility: 'members',
    position: 2,
  }),
];

describe('PagesPage', () => {
  it('lists pages with title, slug, visibility and position', async () => {
    const api = makeMockApi();
    api.adminPages.mockResolvedValue(pages);

    render(<PagesPage api={api} />);
    expect(await screen.findByText('Welcome')).toBeInTheDocument();
    expect(screen.getByText('home')).toBeInTheDocument();
    expect(screen.getByText('Our constitution')).toBeInTheDocument();
    expect(screen.getByText('constitution')).toBeInTheDocument();
    expect(screen.getByText('members')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('creates a page via the add dialog', async () => {
    const api = makeMockApi();
    api.adminPages.mockResolvedValue(pages);
    api.adminCreatePage.mockResolvedValue(makePage({ id: 'p-3' }));

    render(<PagesPage api={api} />);
    await userEvent.click(await screen.findByRole('button', { name: /add page/i }));
    await userEvent.type(await screen.findByLabelText('Slug'), 'contact');
    await userEvent.type(screen.getByLabelText('Title'), 'Contact us');
    await userEvent.type(screen.getByLabelText('Body'), 'Email the *committee*.');
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() =>
      expect(api.adminCreatePage).toHaveBeenCalledWith({
        slug: 'contact',
        title: 'Contact us',
        body: 'Email the *committee*.',
        visibility: 'public',
        position: 0,
      }),
    );
  });

  it('keeps the dialog open when the create fails (e.g. slug conflict)', async () => {
    const api = makeMockApi();
    api.adminPages.mockResolvedValue(pages);
    api.adminCreatePage.mockResolvedValue(undefined); // api layer snackbarred a 409

    render(<PagesPage api={api} />);
    await userEvent.click(await screen.findByRole('button', { name: /add page/i }));
    await userEvent.type(await screen.findByLabelText('Slug'), 'home');
    await userEvent.type(screen.getByLabelText('Title'), 'Duplicate');
    await userEvent.type(screen.getByLabelText('Body'), 'x');
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(api.adminCreatePage).toHaveBeenCalled());
    expect(screen.getByLabelText('Slug')).toBeInTheDocument(); // still editing
  });

  it('hints that home is the front page', async () => {
    const api = makeMockApi();
    api.adminPages.mockResolvedValue([]);

    render(<PagesPage api={api} />);
    await userEvent.click(await screen.findByRole('button', { name: /add page/i }));
    expect(await screen.findByText(/home.*front page/i)).toBeInTheDocument();
  });

  it('edits a page via the edit icon', async () => {
    const api = makeMockApi();
    api.adminPages.mockResolvedValue(pages);
    api.adminUpdatePage.mockResolvedValue(makePage({ id: 'p-2' }));

    render(<PagesPage api={api} />);
    await userEvent.click(
      await screen.findByRole('button', { name: /edit our constitution/i }),
    );
    const title = await screen.findByLabelText('Title');
    await userEvent.clear(title);
    await userEvent.type(title, 'The constitution');
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() =>
      expect(api.adminUpdatePage).toHaveBeenCalledWith('p-2', {
        slug: 'constitution',
        title: 'The constitution',
        body: 'We are a *local* exchange.', // makePage default body
        visibility: 'members',
        position: 2,
      }),
    );
  });

  it('deletes a page after confirmation', async () => {
    const api = makeMockApi();
    api.adminPages.mockResolvedValue(pages);

    render(<PagesPage api={api} />);
    await userEvent.click(
      await screen.findByRole('button', { name: /delete our constitution/i }),
    );
    await userEvent.click(await screen.findByRole('button', { name: /^delete$/i }));
    await waitFor(() => expect(api.adminDeletePage).toHaveBeenCalledWith('p-2'));
  });

  it('live-previews markdown, with raw HTML escaped and images disabled', async () => {
    const api = makeMockApi();
    api.adminPages.mockResolvedValue([]);

    render(<PagesPage api={api} />);
    await userEvent.click(await screen.findByRole('button', { name: /add page/i }));
    await userEvent.type(
      await screen.findByLabelText('Body'),
      'Hello *emphasis* <b>raw</b> ![alt](http://x/y.png)',
    );
    const preview = screen.getByTestId('markdown-preview');
    await waitFor(() => {
      const em = within(preview).getByText('emphasis');
      expect(em.tagName).toBe('EM');
    });
    // Raw HTML from the body is escaped, never parsed into elements
    expect(preview.querySelector('b')).toBeNull();
    expect(preview.innerHTML).toContain('&lt;b&gt;');
    // Image syntax is disabled (decision #13): no <img> ever
    expect(preview.querySelector('img')).toBeNull();
  });
});
