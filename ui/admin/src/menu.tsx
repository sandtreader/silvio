// Admin navigation (decision #11): Rafiki MenuStructure with capability
// requirements — role 'admin' maps to the 'admin.*' glob in auth.ts, and
// every page here requires an admin.* capability, so committee members see
// an empty menu for now (committee pages can be added with 'committee.*').

import { MenuStructure, StaticMenuProvider } from '@sandtreader/rafiki';
import { ApprovalQueuePage } from './pages/ApprovalQueuePage';
import { CategoriesPage } from './pages/CategoriesPage';
import { ImagesPage } from './pages/ImagesPage';
import { MembersPage } from './pages/MembersPage';
import { NewsPage } from './pages/NewsPage';
import { PagesPage } from './pages/PagesPage';
import { PoliciesPage } from './pages/PoliciesPage';
import { DemurragePage } from './pages/DemurragePage';
import { FlagsPage } from './pages/FlagsPage';
import { TransactionsPage } from './pages/TransactionsPage';

interface PageDefinition {
  id: string;
  name: string;
  icon: string; // Material Icons font name, snake_case
  content: JSX.Element;
  requirements: string[];
}

const pages: PageDefinition[] = [
  {
    id: 'approvals',
    name: 'Approval queue',
    icon: 'how_to_reg',
    content: <ApprovalQueuePage />,
    requirements: ['admin.members.approve'],
  },
  {
    id: 'members',
    name: 'Members',
    icon: 'people',
    content: <MembersPage />,
    requirements: ['admin.members'],
  },
  {
    id: 'policies',
    name: 'Credit policies',
    icon: 'rule',
    content: <PoliciesPage />,
    requirements: ['admin.policies'],
  },
  {
    id: 'demurrage',
    name: 'Demurrage bands',
    icon: 'trending_down',
    content: <DemurragePage />,
    requirements: ['admin.demurrage'],
  },
  {
    id: 'flags',
    name: 'Flags',
    icon: 'flag',
    content: <FlagsPage />,
    requirements: ['admin.flags'],
  },
  {
    id: 'transactions',
    name: 'Transactions',
    icon: 'receipt_long',
    content: <TransactionsPage />,
    requirements: ['admin.transactions'],
  },
  {
    id: 'categories',
    name: 'Categories',
    icon: 'category',
    content: <CategoriesPage />,
    requirements: ['admin.*'],
  },
  // CMS content (decision #13)
  {
    id: 'pages',
    name: 'Pages',
    icon: 'article',
    content: <PagesPage />,
    requirements: ['admin.content'],
  },
  {
    id: 'news',
    name: 'News',
    icon: 'campaign',
    content: <NewsPage />,
    requirements: ['admin.content'],
  },
  // CMS images (decision #14)
  {
    id: 'images',
    name: 'Images',
    icon: 'image',
    content: <ImagesPage />,
    requirements: ['admin.content'],
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
