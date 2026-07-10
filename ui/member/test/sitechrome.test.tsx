// Site chrome (decision #15): the app's own brochure-style header, built
// from GET /shell with the session corner from the auth context.
import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SiteChrome } from '../src/components/SiteChrome';
import { notAuthorised, renderWithClient, testMe } from './helpers';

const shell = {
  group: { name: 'CamLETS', slug: 'cam' },
  branding: {},
  navPages: [{ slug: 'about', title: 'About us' }],
};

describe('SiteChrome', () => {
  it('renders brand and full-page nav links from /shell when logged out', async () => {
    const client = {
      me: vi.fn().mockRejectedValue(notAuthorised()),
      shellInfo: vi.fn().mockResolvedValue(shell),
    };
    renderWithClient(<SiteChrome />, client);

    // Brand links back to the brochure root; nav pages, News and Market are
    // plain anchors out of the SPA.
    const brand = await screen.findByText('CamLETS');
    expect(brand.closest('a')?.getAttribute('href')).toBe('/');
    expect(screen.getByText('Home').closest('a')?.getAttribute('href')).toBe('/');
    expect(screen.getByText('About us').closest('a')?.getAttribute('href')).toBe('/p/about');
    expect(screen.getByText('News').closest('a')?.getAttribute('href')).toBe('/news');
    expect(screen.getByText('Market').closest('a')?.getAttribute('href')).toBe('/market');
    // Logged out: no session corner (the app's login screen handles that).
    expect(screen.queryByText('Alice')).toBeNull();
  });

  it('shows the member name from the auth context when logged in', async () => {
    const client = {
      me: vi.fn().mockResolvedValue(testMe),
      shellInfo: vi.fn().mockResolvedValue(shell),
    };
    renderWithClient(<SiteChrome />, client);

    expect(await screen.findByText('CamLETS')).toBeTruthy();
    expect(await screen.findByText('Alice')).toBeTruthy();
  });

  it('shows the suspension banner when /shell says suspended (#20)', async () => {
    const client = {
      me: vi.fn().mockRejectedValue(notAuthorised()),
      shellInfo: vi.fn().mockResolvedValue({ ...shell, suspended: true }),
    };
    renderWithClient(<SiteChrome />, client);

    expect(
      await screen.findByText('This group is currently suspended — trading is paused.'),
    ).toBeTruthy();
    // And the ordinary chrome is still there under it.
    expect(screen.getByText('CamLETS')).toBeTruthy();
  });

  it('shows the acting banner with a working Stop (#24)', async () => {
    const client = {
      me: vi.fn().mockResolvedValue(testMe),
      shellInfo: vi.fn().mockResolvedValue({
        ...shell,
        member: { displayName: 'Bob', acting: true },
      }),
      stopActing: vi.fn().mockResolvedValue({ ok: true }),
    };
    renderWithClient(<SiteChrome />, client);

    expect(await screen.findByText(/Acting for Bob/)).toBeTruthy();
    screen.getByText('Stop').click();
    await waitFor(() => expect(client.stopActing).toHaveBeenCalled());
  });

  it('renders nothing while /shell fails (e.g. an unknown host)', async () => {
    const client = {
      me: vi.fn().mockRejectedValue(notAuthorised()),
      shellInfo: vi.fn().mockRejectedValue(new Error('no group at this host')),
    };
    const { container } = renderWithClient(<SiteChrome />, client);

    await waitFor(() => expect(client.shellInfo).toHaveBeenCalled());
    expect(container.querySelector('header')).toBeNull();
  });
});
