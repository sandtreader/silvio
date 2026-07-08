import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Category } from '@silvio/ui-shared';
import { CategoriesPage } from '../src/pages/CategoriesPage';
import { makeMockApi } from './mockApi';

const categories: Category[] = [
  { id: 'cat-1', groupId: 'g-1', name: 'Food' },
  { id: 'cat-2', groupId: 'g-1', name: 'Vegetables', parentId: 'cat-1' },
  { id: 'cat-3', groupId: 'g-1', name: 'Services' },
];

describe('CategoriesPage', () => {
  it('lists categories with children under their parent', async () => {
    const api = makeMockApi();
    api.categories.mockResolvedValue(categories);

    render(<CategoriesPage api={api} />);
    expect(await screen.findByText('Food')).toBeInTheDocument();
    expect(screen.getByText('Vegetables')).toBeInTheDocument();
    expect(screen.getByText('Services')).toBeInTheDocument();
    // Child row follows its parent, not alphabetical order overall
    const cells = screen.getAllByRole('cell').map((cell) => cell.textContent);
    expect(cells.indexOf('Vegetables')).toBeGreaterThan(cells.indexOf('Food'));
    expect(cells.indexOf('Vegetables')).toBeLessThan(cells.indexOf('Services'));
  });

  it('creates a category via the add dialog', async () => {
    const api = makeMockApi();
    api.categories.mockResolvedValue(categories);
    api.adminCreateCategory.mockResolvedValue({
      id: 'cat-4',
      groupId: 'g-1',
      name: 'Tools',
    });

    render(<CategoriesPage api={api} />);
    await userEvent.click(
      await screen.findByRole('button', { name: /add category/i }),
    );
    await userEvent.type(await screen.findByLabelText('Name'), 'Tools');
    await userEvent.click(screen.getByRole('button', { name: /^add$/i }));
    await waitFor(() =>
      expect(api.adminCreateCategory).toHaveBeenCalledWith({ name: 'Tools' }),
    );
  });

  it('renames a category via the edit icon', async () => {
    const api = makeMockApi();
    api.categories.mockResolvedValue(categories);
    api.adminUpdateCategory.mockResolvedValue({
      id: 'cat-3',
      groupId: 'g-1',
      name: 'Trades',
    });

    render(<CategoriesPage api={api} />);
    await userEvent.click(
      await screen.findByRole('button', { name: /rename services/i }),
    );
    const field = await screen.findByDisplayValue('Services');
    await userEvent.clear(field);
    await userEvent.type(field, 'Trades');
    await userEvent.click(screen.getByRole('button', { name: /^rename$/i }));
    await waitFor(() =>
      expect(api.adminUpdateCategory).toHaveBeenCalledWith('cat-3', {
        name: 'Trades',
      }),
    );
  });
});
