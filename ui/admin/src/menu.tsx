// Admin navigation (decision #11): Rafiki MenuStructure with capability
// requirements — role 'admin' maps to the 'admin.*' glob in auth.ts.
//
// The menu is a two-level tree: Dashboard and Settings sit at the top level,
// the rest group under Members, Policies, Audit, Content and Email. Group
// headers are content-less parent nodes; Rafiki renders them with an
// expand/collapse chevron and indents their children.
//
// Each group header carries its own `requirements`, because Rafiki's
// filterWithCapabilities hides a node by its own requirements only — it does
// not roll child visibility up to the parent, so a header with no
// requirements would show (empty) even to a user who can see none of its
// children. The chosen requirement is a representative admin.* capability:
// full admins (admin.*) see every group, non-admins see none.

import { MenuStructure, StaticMenuProvider } from '@sandtreader/rafiki';
import { ApprovalQueuePage } from './pages/ApprovalQueuePage';
import { AuditPage } from './pages/AuditPage';
import { BrandingPage } from './pages/BrandingPage';
import { BroadcastPage } from './pages/BroadcastPage';
import { CategoriesPage } from './pages/CategoriesPage';
import { DashboardPage } from './pages/DashboardPage';
import { EmailTemplatesPage } from './pages/EmailTemplatesPage';
import { ImagesPage } from './pages/ImagesPage';
import { MembersPage } from './pages/MembersPage';
import { NewsPage } from './pages/NewsPage';
import { PagesPage } from './pages/PagesPage';
import { PoliciesPage } from './pages/PoliciesPage';
import { SettingsPage } from './pages/SettingsPage';
import { DemurragePage } from './pages/DemurragePage';
import { FlagsPage } from './pages/FlagsPage';
import { TransactionsPage } from './pages/TransactionsPage';

interface MenuNode {
  id: string;
  name: string;
  icon: string; // Material Icons font name, snake_case
  requirements: string[];
  // A leaf has content; a group header has children instead (no content).
  content?: JSX.Element;
  children?: MenuNode[];
}

const pages: MenuNode[] = [
  // Group health at a glance (plan.md): balances, flow, velocity, dormancy
  {
    id: 'dashboard',
    name: 'Dashboard',
    icon: 'insights',
    content: <DashboardPage />,
    requirements: ['admin.stats'],
  },
  {
    id: 'members',
    name: 'Members',
    icon: 'groups',
    requirements: ['admin.members'],
    children: [
      {
        id: 'approvals',
        name: 'Approval queue',
        icon: 'how_to_reg',
        content: <ApprovalQueuePage />,
        requirements: ['admin.members.approve'],
      },
      {
        id: 'member-directory',
        name: 'Directory',
        icon: 'people',
        content: <MembersPage />,
        requirements: ['admin.members'],
      },
      {
        id: 'flags',
        name: 'Flags',
        icon: 'flag',
        content: <FlagsPage />,
        requirements: ['admin.flags'],
      },
    ],
  },
  {
    id: 'policies',
    name: 'Policies',
    icon: 'gavel',
    requirements: ['admin.policies'],
    children: [
      {
        id: 'credit-policies',
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
    ],
  },
  {
    id: 'audit',
    name: 'Audit',
    icon: 'fact_check',
    requirements: ['admin.audit'],
    children: [
      {
        id: 'transactions',
        name: 'Transactions',
        icon: 'receipt_long',
        content: <TransactionsPage />,
        requirements: ['admin.transactions'],
      },
      {
        id: 'audit-log',
        name: 'Audit log',
        icon: 'history',
        content: <AuditPage />,
        requirements: ['admin.audit'],
      },
    ],
  },
  {
    id: 'content',
    name: 'Content',
    icon: 'folder',
    requirements: ['admin.content'],
    children: [
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
      // Group skinning (decision #15)
      {
        id: 'branding',
        name: 'Branding',
        icon: 'palette',
        content: <BrandingPage />,
        requirements: ['admin.content'],
      },
    ],
  },
  {
    id: 'email',
    name: 'Email',
    icon: 'forward_to_inbox',
    requirements: ['admin.content'],
    children: [
      // Email templates and sender (decision #16)
      {
        id: 'email-templates',
        name: 'Templates',
        icon: 'mail',
        content: <EmailTemplatesPage />,
        requirements: ['admin.content'],
      },
      // Ad-hoc broadcast to every active member (decision #17)
      {
        id: 'broadcast',
        name: 'Broadcast',
        icon: 'send',
        content: <BroadcastPage />,
        requirements: ['admin.content'],
      },
    ],
  },
  // Group name and per-group tunables (group.settings)
  {
    id: 'settings',
    name: 'Settings',
    icon: 'settings',
    content: <SettingsPage />,
    requirements: ['admin.settings'],
  },
];

function toStructure(node: MenuNode): MenuStructure {
  const item = new MenuStructure(node.id, node.name);
  item.icon = node.icon;
  item.requirements = node.requirements;
  if (node.content) item.content = node.content;
  if (node.children) item.children = node.children.map(toStructure);
  return item;
}

export function buildMenu(): StaticMenuProvider {
  const root = new MenuStructure('root', 'root');
  root.children = pages.map(toStructure);
  return new StaticMenuProvider(root);
}
