// Marketplace categories page: the group's category tree (children indented
// under their parent), an add dialog (name + optional parent) and inline
// rename. Errors surface through the api layer's snackbar (decision #11).

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  MenuItem,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import EditIcon from '@mui/icons-material/Edit';
import type { Category } from '@silvio/ui-shared';
import { api as realApi, type AdminApi } from '../api';

interface TreeRow {
  category: Category;
  depth: number;
}

/** Flatten the parentId tree depth-first, children under their parent. */
function toRows(categories: Category[]): TreeRow[] {
  const ids = new Set(categories.map((c) => c.id));
  const childrenOf = (parentId: string | undefined) =>
    categories
      .filter((c) =>
        parentId === undefined
          ? // Roots: no parent, or a parent we cannot see (defensive)
            c.parentId === undefined || !ids.has(c.parentId)
          : c.parentId === parentId,
      )
      .sort((a, b) => a.name.localeCompare(b.name));
  const rows: TreeRow[] = [];
  const walk = (parentId: string | undefined, depth: number) => {
    for (const category of childrenOf(parentId)) {
      rows.push({ category, depth });
      walk(category.id, depth + 1);
    }
  };
  walk(undefined, 0);
  return rows;
}

export function CategoriesPage({ api = realApi }: { api?: AdminApi }) {
  const [categories, setCategories] = useState<Category[]>();

  // Add dialog state
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [parentId, setParentId] = useState('');
  const [formError, setFormError] = useState<string>();

  // Rename dialog state
  const [renaming, setRenaming] = useState<Category>();
  const [newName, setNewName] = useState('');

  const refresh = useCallback(async () => {
    const listed = await api.categories();
    if (listed !== undefined) setCategories(listed);
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const rows = useMemo(() => toRows(categories ?? []), [categories]);

  const openAdd = () => {
    setName('');
    setParentId('');
    setFormError(undefined);
    setAdding(true);
  };

  const submitAdd = async () => {
    if (name.trim() === '') {
      setFormError('a category needs a name');
      return;
    }
    const input: { name: string; parentId?: string } = { name: name.trim() };
    if (parentId !== '') input.parentId = parentId;
    const created = await api.adminCreateCategory(input);
    if (created !== undefined) {
      setAdding(false);
      await refresh();
    }
  };

  const openRename = (category: Category) => {
    setNewName(category.name);
    setRenaming(category);
  };

  const submitRename = async () => {
    if (renaming === undefined || newName.trim() === '') return;
    const updated = await api.adminUpdateCategory(renaming.id, {
      name: newName.trim(),
    });
    if (updated !== undefined) {
      setRenaming(undefined);
      await refresh();
    }
  };

  return (
    <Stack spacing={2} sx={{ marginTop: 2, maxWidth: 640 }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center">
        <Typography variant="h5">Categories</Typography>
        <Button variant="contained" startIcon={<AddIcon />} onClick={openAdd}>
          Add category
        </Button>
      </Stack>
      {categories !== undefined && categories.length === 0 && (
        <Typography color="text.secondary">No categories yet.</Typography>
      )}
      {categories !== undefined && categories.length > 0 && (
        <TableContainer component={Paper}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Name</TableCell>
                <TableCell align="right" />
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map(({ category, depth }) => (
                <TableRow key={category.id}>
                  <TableCell sx={{ paddingLeft: 2 + depth * 3 }}>
                    {category.name}
                  </TableCell>
                  <TableCell align="right">
                    <IconButton
                      size="small"
                      aria-label={`rename ${category.name}`}
                      onClick={() => openRename(category)}
                    >
                      <EditIcon fontSize="small" />
                    </IconButton>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      {/* Add-category dialog */}
      <Dialog open={adding} onClose={() => setAdding(false)} fullWidth>
        <DialogTitle>Add category</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ marginTop: 1 }}>
            <TextField
              label="Name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              fullWidth
            />
            <TextField
              select
              label="Parent"
              value={parentId}
              onChange={(e) => setParentId(e.target.value)}
              fullWidth
            >
              <MenuItem value="">(none — top level)</MenuItem>
              {rows.map(({ category, depth }) => (
                <MenuItem key={category.id} value={category.id}>
                  {' '.repeat(depth * 4)}
                  {category.name}
                </MenuItem>
              ))}
            </TextField>
            {formError !== undefined && <Alert severity="error">{formError}</Alert>}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setAdding(false)}>Cancel</Button>
          <Button variant="contained" onClick={() => void submitAdd()}>
            Add
          </Button>
        </DialogActions>
      </Dialog>

      {/* Rename dialog */}
      <Dialog
        open={renaming !== undefined}
        onClose={() => setRenaming(undefined)}
        fullWidth
      >
        <DialogTitle>Rename category</DialogTitle>
        <DialogContent>
          <TextField
            label="Name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            fullWidth
            sx={{ marginTop: 1 }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRenaming(undefined)}>Cancel</Button>
          <Button
            variant="contained"
            disabled={newName.trim() === ''}
            onClick={() => void submitRename()}
          >
            Rename
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
