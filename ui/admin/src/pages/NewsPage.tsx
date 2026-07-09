// CMS news items (decision #13): list the group's news and edit them as
// markdown with a live preview. publishedAt defaults server-side to "now"
// when omitted; expiresAt is optional (never expires). Errors surface through
// the api layer's snackbar (decision #11).

import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
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
import type { NewsItem } from '@silvio/ui-shared';
import { api as realApi, type AdminApi } from '../api';
import { MarkdownEditor } from '../MarkdownEditor';

/** ISO timestamp → the local `datetime-local` input value (minute precision). */
function isoToLocalInput(iso: string | undefined): string {
  if (iso === undefined) return '';
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

export function NewsPage({ api = realApi }: { api?: AdminApi }) {
  const [news, setNews] = useState<NewsItem[]>();

  // Editor dialog state (editing = undefined means creating).
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<NewsItem>();
  const [title, setTitle] = useState('');
  const [publishedAt, setPublishedAt] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [body, setBody] = useState('');
  const [formError, setFormError] = useState<string>();

  // Delete confirmation
  const [deleting, setDeleting] = useState<NewsItem>();

  const refresh = useCallback(async () => {
    const listed = await api.adminNews();
    if (listed !== undefined) setNews(listed);
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const openAdd = () => {
    setEditing(undefined);
    setTitle('');
    setPublishedAt('');
    setExpiresAt('');
    setBody('');
    setFormError(undefined);
    setOpen(true);
  };

  const openEdit = (item: NewsItem) => {
    setEditing(item);
    setTitle(item.title);
    setPublishedAt(isoToLocalInput(item.publishedAt));
    setExpiresAt(isoToLocalInput(item.expiresAt));
    setBody(item.body);
    setFormError(undefined);
    setOpen(true);
  };

  const submit = async () => {
    if (title.trim() === '') {
      setFormError('a news item needs a title');
      return;
    }
    const input: {
      title: string;
      body: string;
      publishedAt?: string;
      expiresAt?: string;
    } = { title: title.trim(), body };
    if (publishedAt !== '') input.publishedAt = new Date(publishedAt).toISOString();
    if (expiresAt !== '') input.expiresAt = new Date(expiresAt).toISOString();
    const saved =
      editing === undefined
        ? await api.adminCreateNews(input)
        : await api.adminUpdateNews(editing.id, input);
    if (saved !== undefined) {
      setOpen(false);
      await refresh();
    }
  };

  const submitDelete = async () => {
    if (deleting === undefined) return;
    const target = deleting;
    setDeleting(undefined);
    if (await api.adminDeleteNews(target.id)) await refresh();
  };

  return (
    <Stack spacing={2} sx={{ marginTop: 2, maxWidth: 800 }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center">
        <Typography variant="h5">News</Typography>
        <Button variant="contained" startIcon={<AddIcon />} onClick={openAdd}>
          Add news item
        </Button>
      </Stack>
      {news !== undefined && news.length === 0 && (
        <Typography color="text.secondary">No news yet.</Typography>
      )}
      {news !== undefined && news.length > 0 && (
        <TableContainer component={Paper}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Title</TableCell>
                <TableCell>Published</TableCell>
                <TableCell>Expires</TableCell>
                <TableCell align="right" />
              </TableRow>
            </TableHead>
            <TableBody>
              {news.map((item) => (
                <TableRow key={item.id}>
                  <TableCell>{item.title}</TableCell>
                  <TableCell>{new Date(item.publishedAt).toLocaleString()}</TableCell>
                  <TableCell>
                    {item.expiresAt === undefined
                      ? '—'
                      : new Date(item.expiresAt).toLocaleString()}
                  </TableCell>
                  <TableCell align="right">
                    <IconButton
                      size="small"
                      aria-label={`edit ${item.title}`}
                      onClick={() => openEdit(item)}
                    >
                      <EditIcon fontSize="small" />
                    </IconButton>
                    <IconButton
                      size="small"
                      aria-label={`delete ${item.title}`}
                      onClick={() => setDeleting(item)}
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
        <DialogTitle>
          {editing === undefined ? 'Add news item' : 'Edit news item'}
        </DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ marginTop: 1 }}>
            <TextField
              label="Title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              fullWidth
            />
            <Stack direction="row" spacing={2}>
              <TextField
                label="Published at"
                type="datetime-local"
                value={publishedAt}
                onChange={(e) => setPublishedAt(e.target.value)}
                helperText="leave blank to publish now"
                InputLabelProps={{ shrink: true }}
                sx={{ flex: 1 }}
              />
              <TextField
                label="Expires at"
                type="datetime-local"
                value={expiresAt}
                onChange={(e) => setExpiresAt(e.target.value)}
                helperText="leave blank to never expire"
                InputLabelProps={{ shrink: true }}
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
        <DialogTitle>Delete news item?</DialogTitle>
        <DialogContent>
          <Typography>
            This permanently deletes <strong>{deleting?.title}</strong>.
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
