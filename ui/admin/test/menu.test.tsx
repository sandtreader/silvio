// Admin navigation grouping (decision #11): a two-level Rafiki menu tree —
// Dashboard and Settings stay top-level; the rest group under Members,
// Policies, Audit, Content and Email. Group headers carry requirements so a
// user without the capability sees no empty group (Rafiki does not roll child
// visibility up to the parent).

import { useMemo, useState } from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Menu, type MenuStructure, type MenuState } from '@sandtreader/rafiki';
import { buildMenu } from '../src/menu';

const childIds = (node: MenuStructure | undefined) =>
  (node?.children ?? []).map((c) => c.id);
const menu = () => buildMenu().getMenu();
const groupOf = (root: MenuStructure, id: string) =>
  (root.children ?? []).find((c) => c.id === id);

describe('admin menu', () => {
  it('nests pages under Members/Policies/Audit/Content/Email, Dashboard and Settings top-level', () => {
    const root = menu();
    expect(childIds(root)).toEqual([
      'dashboard', 'members', 'policies', 'audit', 'content', 'email', 'settings',
    ]);
    expect(childIds(groupOf(root, 'members'))).toEqual(['approvals', 'member-directory', 'flags']);
    expect(childIds(groupOf(root, 'policies'))).toEqual(['credit-policies', 'demurrage']);
    expect(childIds(groupOf(root, 'audit'))).toEqual(['transactions', 'audit-log']);
    expect(childIds(groupOf(root, 'content'))).toEqual(['categories', 'pages', 'news', 'images', 'branding']);
    expect(childIds(groupOf(root, 'email'))).toEqual(['email-templates', 'broadcast']);
  });

  it('makes group headers content-less nodes with requirements, leaves carry a page', () => {
    const groups = (menu().children ?? []).filter((c) => (c.children?.length ?? 0) > 0);
    expect(groups.map((g) => g.id)).toEqual(['members', 'policies', 'audit', 'content', 'email']);
    for (const g of groups) {
      expect(g.content, `${g.id} is a pure header`).toBeUndefined();
      expect(g.requirements?.length ?? 0, `${g.id} gates its own visibility`).toBeGreaterThan(0);
      for (const leaf of g.children ?? []) expect(leaf.content, `${leaf.id} has a page`).toBeDefined();
    }
  });

  it('shows every group to a full admin, hides group headers from non-admins (empty-group fix)', () => {
    const admin = menu();
    admin.filterWithCapabilities(['admin.*']);
    expect((admin.children ?? []).filter((c) => c.hidden).map((c) => c.id)).toEqual([]);

    const nonAdmin = menu();
    nonAdmin.filterWithCapabilities(['member.*']);
    expect((nonAdmin.children ?? []).every((c) => c.hidden)).toBe(true);
  });

  it('renders as a Rafiki tree: group headers with expand chevrons that toggle on click', () => {
    function Harness() {
      const structure = useMemo(() => menu(), []);
      const [state, setState] = useState<MenuState>({});
      return <Menu structure={structure} state={state} setState={setState} />;
    }
    render(<Harness />);

    // Group headers render, and each is an expandable parent (expand_more).
    for (const name of ['Members', 'Policies', 'Audit', 'Content', 'Email']) {
      expect(screen.getByText(name)).toBeInTheDocument();
    }
    expect(screen.getAllByText('expand_more')).toHaveLength(5);
    expect(screen.queryByText('expand_less')).not.toBeInTheDocument();

    // Clicking a header expands it — that group's chevron flips.
    fireEvent.click(screen.getByText('Members'));
    expect(screen.getByText('expand_less')).toBeInTheDocument();
    expect(screen.getAllByText('expand_more')).toHaveLength(4);
  });
});
