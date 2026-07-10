// Test harness: render a page inside the real providers with a fake
// ApiClient injected via ClientProvider (the whole point of the context).
import { render } from '@testing-library/react';
import { ApiError } from '@silvio/ui-shared';
import type { ApiClient, Me } from '@silvio/ui-shared';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { vi } from 'vitest';
import { AuthProvider } from '../src/api/auth';
import { ClientProvider } from '../src/api/client';
import { FeedbackProvider } from '../src/api/feedback';

/** A partial client; anything a test doesn't stub must not be called. */
export type FakeClient = Partial<Record<keyof ApiClient, ReturnType<typeof vi.fn>>>;

export function renderWithClient(
  ui: ReactNode,
  client: FakeClient,
  initialEntries: string[] = ['/'], // e.g. ['/reset?token=t1'] for token pages
) {
  return render(
    <ClientProvider value={client as unknown as ApiClient}>
      <FeedbackProvider>
        <AuthProvider>
          <MemoryRouter initialEntries={initialEntries}>{ui}</MemoryRouter>
        </AuthProvider>
      </FeedbackProvider>
    </ClientProvider>,
  );
}

export const notAuthorised = () =>
  new ApiError('NOT_AUTHORISED', 'not logged in', 401);

export const testMe: Me = {
  member: {
    id: 'm1',
    groupId: 'g1',
    memberNo: 7,
    type: 'individual',
    role: 'member',
    displayName: 'Alice',
    status: 'active',
    confirmIncoming: false,
    digestFrequency: 'weekly',
    appliedAt: '2026-01-01T00:00:00Z',
    approvedAt: '2026-01-02T00:00:00Z',
  },
  accounts: [
    { id: 'a1', currencyId: 'c1', currencyCode: 'CAM', scale: 2, balance: 12345 },
  ],
};
