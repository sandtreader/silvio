// Header status (top-right of the Rafiki app bar): which group this admin
// console is signed into and who is signed in — a 'groups' icon + group name
// over a 'person' icon + user name. Group identity comes from the public
// session-aware GET /shell (#15); the user comes from the Rafiki session.

import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { SessionState } from '@sandtreader/rafiki';
import { HeaderStatus } from '../src/HeaderStatus';
import { makeMockApi } from './mockApi';

const session = {
  loggedIn: true,
  userId: 'grace@demo.org',
  userName: 'Grace',
  hasCapability: () => true,
} as unknown as SessionState;

describe('HeaderStatus', () => {
  it('shows the group name from /shell with a groups icon', async () => {
    const api = makeMockApi();
    render(<HeaderStatus api={api} session={session} />);
    expect(await screen.findByText('Demo LETS')).toBeInTheDocument();
    expect(screen.getByText('groups')).toBeInTheDocument();
  });

  it('shows the logged-in user name with a person icon', async () => {
    const api = makeMockApi();
    render(<HeaderStatus api={api} session={session} />);
    expect(await screen.findByText('Grace')).toBeInTheDocument();
    expect(screen.getByText('person')).toBeInTheDocument();
  });

  it('shows only the group when logged out', async () => {
    const api = makeMockApi();
    render(<HeaderStatus api={api} />);
    expect(await screen.findByText('Demo LETS')).toBeInTheDocument();
    expect(screen.queryByText('person')).not.toBeInTheDocument();
  });

  it('renders nothing group-side (no crash) when /shell fails', async () => {
    const api = makeMockApi();
    api.shellInfo.mockResolvedValue(undefined); // api.ts wraps failures as undefined
    render(<HeaderStatus api={api} session={session} />);
    await waitFor(() => expect(api.shellInfo).toHaveBeenCalled());
    expect(screen.queryByText('groups')).not.toBeInTheDocument();
    expect(screen.getByText('Grace')).toBeInTheDocument();
  });
});
