// Provisioning service (decision #2): operators create tenants. A new group
// gets its currency and that currency's community account in one step, so a
// freshly provisioned group is immediately usable (#1 needs the community
// account for demurrage redistribution).

import type { CreateCurrencyInput, Storage } from '../storage/interface.js';
import type { Currency, Group } from '../types.js';

export interface ProvisionGroupInput {
  slug: string;
  name: string;
  hostname?: string; // custom domain for host-header tenancy
  currency: {
    code: string;
    name: string;
    scale?: number;
    demurrageDay?: number;
  };
}

export async function provisionGroup(
  storage: Storage,
  input: ProvisionGroupInput,
): Promise<{ group: Group; currency: Currency }> {
  const group = await storage.createGroup({ slug: input.slug, name: input.name });
  if (input.hostname !== undefined) {
    await storage.addGroupDomain(group.id, input.hostname);
  }
  const currencyInput: CreateCurrencyInput = {
    groupId: group.id,
    code: input.currency.code,
    name: input.currency.name,
  };
  if (input.currency.scale !== undefined) currencyInput.scale = input.currency.scale;
  if (input.currency.demurrageDay !== undefined) {
    currencyInput.demurrageDay = input.currency.demurrageDay;
  }
  const currency = await storage.createCurrency(currencyInput);
  await storage.createAccount({
    groupId: group.id,
    currencyId: currency.id,
    type: 'community',
  });
  return { group, currency };
}
