// A fully-mocked AdminApi for component tests: every method is a vitest mock
// resolving undefined ("call failed") unless a test overrides it.

import { vi } from 'vitest';
import type {
  Currency,
  Image,
  Me,
  Member,
  NewsItem,
  Page,
  Restriction,
} from '@silvio/ui-shared';
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

export function makeRestriction(overrides: Partial<Restriction> = {}): Restriction {
  return {
    id: 'r-1',
    memberId: 'm-1',
    reason: 'runaway balance',
    imposedBy: 'm-admin',
    imposedAt: '2026-07-02T12:00:00Z',
    ...overrides,
  };
}

export function makeCurrency(overrides: Partial<Currency> = {}): Currency {
  return {
    id: 'c-1',
    groupId: 'g-1',
    code: 'CAM',
    name: 'Cams',
    scale: 2,
    createdAt: '2026-07-01T12:00:00Z',
    ...overrides,
  };
}

export function makePage(overrides: Partial<Page> = {}): Page {
  return {
    id: 'p-1',
    groupId: 'g-1',
    slug: 'about',
    title: 'About us',
    body: 'We are a *local* exchange.',
    visibility: 'public',
    position: 0,
    createdAt: '2026-07-01T12:00:00Z',
    updatedAt: '2026-07-01T12:00:00Z',
    ...overrides,
  };
}

export function makeNewsItem(overrides: Partial<NewsItem> = {}): NewsItem {
  return {
    id: 'n-1',
    groupId: 'g-1',
    title: 'Summer market day',
    body: 'Bring your *best* produce.',
    publishedAt: '2026-07-05T09:00:00Z',
    createdAt: '2026-07-05T09:00:00Z',
    updatedAt: '2026-07-05T09:00:00Z',
    ...overrides,
  };
}

export function makeImage(overrides: Partial<Image> = {}): Image {
  return {
    id: 'img-1',
    groupId: 'g-1',
    ownerKind: 'cms',
    mime: 'image/jpeg',
    size: 35021,
    createdBy: 'm-admin',
    createdAt: '2026-07-06T10:00:00Z',
    ...overrides,
  };
}

export type MockAdminApi = { [K in keyof AdminApi]: ReturnType<typeof vi.fn> };

export function makeMockApi(): MockAdminApi {
  return {
    me: vi.fn().mockResolvedValue(makeMe()),
    adminMembers: vi.fn().mockResolvedValue([]),
    adminMemberAction: vi.fn().mockResolvedValue(makeMember()),
    adminSetRole: vi.fn().mockResolvedValue(makeMember()),
    adminRestrictions: vi.fn().mockResolvedValue([]),
    adminRestrict: vi.fn().mockResolvedValue(undefined),
    adminUnrestrict: vi.fn().mockResolvedValue(true),
    adminPolicies: vi.fn().mockResolvedValue([]),
    adminAddPolicy: vi.fn().mockResolvedValue(undefined),
    adminPatchPolicy: vi.fn().mockResolvedValue(undefined),
    adminGetBands: vi.fn().mockResolvedValue([]),
    adminSetBands: vi.fn().mockResolvedValue([]),
    adminFlags: vi.fn().mockResolvedValue([]),
    adminTransactions: vi.fn().mockResolvedValue({ transactions: [], total: 0 }),
    adminReverse: vi.fn().mockResolvedValue(undefined),
    categories: vi.fn().mockResolvedValue([]),
    currencies: vi.fn().mockResolvedValue([makeCurrency()]),
    adminCreateCategory: vi.fn().mockResolvedValue(undefined),
    adminUpdateCategory: vi.fn().mockResolvedValue(undefined),
    adminPages: vi.fn().mockResolvedValue([]),
    adminCreatePage: vi.fn().mockResolvedValue(undefined),
    adminUpdatePage: vi.fn().mockResolvedValue(undefined),
    adminDeletePage: vi.fn().mockResolvedValue(true),
    adminImages: vi.fn().mockResolvedValue([]),
    adminUploadImage: vi.fn().mockResolvedValue(undefined),
    adminDeleteImage: vi.fn().mockResolvedValue(true),
    adminNews: vi.fn().mockResolvedValue([]),
    adminCreateNews: vi.fn().mockResolvedValue(undefined),
    adminUpdateNews: vi.fn().mockResolvedValue(undefined),
    adminDeleteNews: vi.fn().mockResolvedValue(true),
  };
}
