// A fully-mocked OperatorApi for component tests: every method is a vitest
// mock resolving undefined ("call failed") unless a test overrides it.

import { vi } from 'vitest';
import type { Currency, Group, OperatorGroup } from '@silvio/ui-shared';
import type { OperatorApi } from '../src/api';

export function makeOperatorGroup(
  overrides: Partial<OperatorGroup> = {},
): OperatorGroup {
  return {
    id: 'g-1',
    slug: 'camlets',
    name: 'CamLETS',
    status: 'active', // #20
    domains: [], // #21
    createdAt: '2026-07-01T12:00:00Z',
    ...overrides,
  };
}

export function makeGroup(overrides: Partial<Group> = {}): Group {
  return makeOperatorGroup(overrides);
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

export type MockOperatorApi = { [K in keyof OperatorApi]: ReturnType<typeof vi.fn> };

export function makeMockApi(): MockOperatorApi {
  return {
    operatorGroups: vi.fn().mockResolvedValue([]),
    provisionGroup: vi.fn().mockResolvedValue(undefined),
    patchOperatorGroup: vi.fn().mockResolvedValue(undefined),
    addGroupDomain: vi.fn().mockResolvedValue(true),
    removeGroupDomain: vi.fn().mockResolvedValue(true),
  };
}
