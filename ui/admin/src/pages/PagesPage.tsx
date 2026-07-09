// CMS pages (decision #13): list the group's brochure pages and edit them as
// markdown with a live preview. The page with slug 'home' is the brochure
// front page. Errors — including the 409 slug conflict — surface through the
// api layer's snackbar (decision #11); on failure the dialog stays open so
// the admin can fix the slug and retry.

import { useCallback, useEffect, useState } from 'react';
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
import DeleteIcon from '@mui/icons-material/Delete';
import type { Page, PageVisibility } from '@silvio/ui-shared';
import { api as realApi, type AdminApi } from '../api';
import { MarkdownEditor } from '../MarkdownEditor';

const visibilities: PageVisibility[] = ['public', 'members', 'admin'];

export function PagesPage({ api = realApi }: { api?: AdminApi }) {
  const [pages, setPages] = useState<Page[]>();

  // Editor dialog state: undefined = closed, otherwise the page being edited
  // (editing = undefined means we're creating a new one).
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Page>();
  const [slug, setSlug] = useState('');
  const [title, setTitle] = useState('');
  const [visibility, setVisibility] = useState<PageVisibility>('public');
  const [position, setPosition] = useState('0');
  const [body, setBody] = useState('');
  const [formError, setFormError] = useState<string>();

  // Delete confirmation
  const [deleting, setDeleting] = useState<Page>();

  const refresh = useCallback(async () => {
    const listed = await api.adminPages();
    if (listed !== undefined) setPages(listed);
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const openAdd = () => {
    setEditing(undefined);
    setSlug('');
    setTitle('');
    setVisibility('public');
    setPosition('0');
    setBody('');
    setFormError(undefined);
    setOpen(true);
  };

  const openEdit = (page: Page) => {
    setEditing(page);
    setSlug(page.slug);
    setTitle(page.title);
    setVisibility(page.visibility);
    setPosition(String(page.position));
    setBody(page.body);
    setFormError(undefined);
    setOpen(true);
  };

  const submit = async () => {
    if (slug.trim() === '' || title.trim() === '') {
      setFormError('a page needs a slug and a title');
      return;
    }
    const input = {
      slug: slug.trim(),
      title: title.trim(),
      body,
      visibility,
      position: Number.parseInt(position, 10) || 0,
    };
    const saved =
      editing === undefined
        ? await api.adminCreatePage(input)
        : await api.adminUpdatePage(editing.id, input);
    if (saved !== undefined) {
      setOpen(false);
      await refresh();
    }
  };

  const submitDelete = async () => {
    if (deleting === undefined) return;
    const target = deleting;
    setDeleting(undefined);
    if (await api.adminDeletePage(target.id)) await refresh();
  };

  return (
    <Stack spacing={2} sx={{ marginTop: 2, maxWidth: 800 }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center">
        <Typography variant="h5">Pages</Typography>
        <Button variant="contained" startIcon={<AddIcon />} onClick={openAdd}>
          Add page
        </Button>
      </Stack>
      {pages !== undefined && pages.length === 0 && (
        <Typography color="text.secondary">No pages yet.</Typography>
      )}
      {pages !== undefined && pages.length > 0 && (
        <TableContainer component={Paper}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Title</TableCell>
                <TableCell>Slug</TableCell>
                <TableCell>Visibility</TableCell>
                <TableCell align="right">Position</TableCell>
                <TableCell align="right" />
              </TableRow>
            </TableHead>
            <TableBody>
              {pages.map((page) => (
                <TableRow key={page.id}>
                  <TableCell>{page.title}</TableCell>
                  <TableCell>{page.slug}</TableCell>
                  <TableCell>{page.visibility}</TableCell>
                  <TableCell align="right">{page.position}</TableCell>
                  <TableCell align="right">
                    <IconButton
                      size="small"
                      aria-label={`edit ${page.title}`}
                      onClick={() => openEdit(page)}
                    >
                      <EditIcon fontSize="small" />
                    </IconButton>
                    <IconButton
                      size="small"
                      aria-label={`delete ${page.title}`}
                      onClick={() => setDeleting(page)}
                    >
                      <DeleteIcon fontSize="small" />
                    </IconButton>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      {/* Add/edit dialog */}
      <Dialog open={open} onClose={() => setOpen(false)} fullWidth maxWidth="md">
        <DialogTitle>{editing === undefined ? 'Add page' : 'Edit page'}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ marginTop: 1 }}>
            <Stack direction="row" spacing={2}>
              <TextField
                label="Slug"
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                helperText="lowercase-with-dashes; the page with slug home is the front page"
                sx={{ flex: 1 }}
              />
              <TextField
                label="Title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                sx={{ flex: 1 }}
              />
            </Stack>
            <Stack direction="row" spacing={2}>
              <TextField
                select
                label="Visibility"
                value={visibility}
                onChange={(e) => setVisibility(e.target.value as PageVisibility)}
                sx={{ flex: 1 }}
              >
                {visibilities.map((v) => (
                  <MenuItem key={v} value={v}>
                    {v}
                  </MenuItem>
                ))}
              </TextField>
              <TextField
                label="Position"
                type="number"
                value={position}
                onChange={(e) => setPosition(e.target.value)}
                helperText="menu order, lowest first"
                sx={{ flex: 1 }}
              />
            </Stack>
            <MarkdownEditor value={body} onChange={setBody} />
            {formError !== undefined && <Alert severity="error">{formError}</Alert>}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={() => void submit()}>
            Save
          </Button>
        </DialogActions>
      </Dialog>

      {/* Delete confirmation */}
      <Dialog open={deleting !== undefined} onClose={() => setDeleting(undefined)}>
        <DialogTitle>Delete page?</DialogTitle>
        <DialogContent>
          <Typography>
            This permanently deletes <strong>{deleting?.title}</strong> from the
            brochure.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleting(undefined)}>Cancel</Button>
          <Button color="error" variant="contained" onClick={() => void submitDelete()}>
            Delete
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
