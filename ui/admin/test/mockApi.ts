// A fully-mocked AdminApi for component tests: every method is a vitest mock
// resolving undefined ("call failed") unless a test overrides it.

import { vi } from 'vitest';
import type { Me, Member } from '@silvio/ui-shared';
import type { AdminApi } from '../src/api';

export function makeMember(overrides: Partial<Member> = {}): Member {
  return {
    id: 'm-1',
    groupId: 'g-1',
    memberNo: 1,
    type: 'individual',
    role: 'member',
    displayName: 'Alice Smith',
    status: 'active',
    confirmIncoming: false,
    appliedAt: '2026-07-01T12:00:00Z',
    ...overrides,
  };
}

export function makeMe(): Me {
  return {
    member: makeMember({ id: 'm-admin', memberNo: 99, role: 'admin' }),
    accounts: [
      { id: 'a-1', currencyId: 'c-1', currencyCode: 'CAM', scale: 2, balance: 0 },
    ],
  };
}

export type MockAdminApi = { [K in keyof AdminApi]: ReturnType<typeof vi.fn> };

export function makeMockApi(): MockAdminApi {
  return {
    me: vi.fn().mockResolvedValue(makeMe()),
    adminMembers: vi.fn().mockResolvedValue([]),
    adminMemberAction: vi.fn().mockResolvedValue(makeMember()),
    adminSetRole: vi.fn().mockResolvedValue(makeMember()),
    adminRestrict: vi.fn().mockResolvedValue(undefined),
    adminUnrestrict: vi.fn().mockResolvedValue(true),
    adminPolicies: vi.fn().mockResolvedValue([]),
    adminAddPolicy: vi.fn().mockResolvedValue(undefined),
    adminPatchPolicy: vi.fn().mockResolvedValue(undefined),
    adminGetBands: vi.fn().mockResolvedValue([]),
    adminSetBands: vi.fn().mockResolvedValue([]),
    adminFlags: vi.fn().mockResolvedValue([]),
    adminReverse: vi.fn().mockResolvedValue(undefined),
    categories: vi.fn().mockResolvedValue([]),
    adminCreateCategory: vi.fn().mockResolvedValue(undefined),
    adminUpdateCategory: vi.fn().mockResolvedValue(undefined),
  };
}
