// Operator navigation (decision #21): Rafiki MenuStructure. Every page
// requires an operator.* capability, granted as a static set on login
// (auth.ts) — there is no finer capability model at the platform tier.

import { MenuStructure, StaticMenuProvider } from '@sandtreader/rafiki';
import { GroupsPage } from './pages/GroupsPage';
import { ProvisionPage } from './pages/ProvisionPage';

interface PageDefinition {
  id: string;
  name: string;
  icon: string; // Material Icons font name, snake_case
  content: JSX.Element;
  requirements: string[];
}

const pages: PageDefinition[] = [
  // All groups with per-group management (#20): rename, suspend/reinstate,
  // plan, operator notes, domains.
  {
    id: 'groups',
    name: 'Groups',
    icon: 'groups',
    content: <GroupsPage />,
    requirements: ['operator.groups'],
  },
  // Provision a new tenant (decision #2 via POST /operator/groups).
  {
    id: 'provision',
    name: 'Provision group',
    icon: 'add_business',
    content: <ProvisionPage />,
    requirements: ['operator.provision'],
  },
];

export function buildMenu(): StaticMenuProvider {
  const root = new MenuStructure('root', 'root');
  root.children = pages.map((page) => {
    const item = new MenuStructure(page.id, page.name);
    item.icon = page.icon;
    item.content = page.content;
    item.requirements = page.requirements;
    return item;
  });
  return new StaticMenuProvider(root);
}
