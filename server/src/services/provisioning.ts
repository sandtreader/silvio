// Provisioning service (decision #2): operators create tenants. A new group
// gets its currency and that currency's community account in one step, so a
// freshly provisioned group is immediately usable (#1 needs the community
// account for demurrage redistribution).

import type { CreateCurrencyInput, Storage } from '../storage/interface.js';
import type { Currency, Group, Member } from '../types.js';
import { DomainError } from './errors.js';
import { register } from './auth.js';
import { apply, approve } from './membership.js';

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
  // Initial admin (first-admin bootstrap): an existing user is linked as-is
  // (any password given is ignored); a new email registers a fresh user and
  // therefore requires a password.
  admin?: {
    displayName: string;
    personName: string;
    email: string;
    password?: string;
  };
}

export async function provisionGroup(
  storage: Storage,
  input: ProvisionGroupInput,
): Promise<{ group: Group; currency: Currency; admin?: Member }> {
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
  if (input.admin === undefined) return { group, currency };

  // Resolve the admin's user: link an existing account by email, or register
  // a new one (which needs a password to be usable at all).
  const existing = await storage.credentialsForEmail(input.admin.email);
  let userId: string;
  if (existing !== undefined) {
    userId = existing.user.id;
  } else {
    if (input.admin.password === undefined) {
      throw new DomainError(
        'INVALID',
        `a password is required to create a new user for initial admin ${input.admin.email}`,
      );
    }
    const user = await register(storage, {
      email: input.admin.email,
      password: input.admin.password,
    });
    userId = user.id;
  }

  const { member } = await apply(storage, {
    groupId: group.id,
    displayName: input.admin.displayName,
    personName: input.admin.personName,
    email: input.admin.email,
    userId,
  });
  await approve(storage, member.id); // opens accounts, sets 'active'
  const admin = await storage.updateMember(member.id, { role: 'admin' });
  return { group, currency, admin };
}
