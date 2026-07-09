// CMS images (decision #14, phase 1): list the group's uploaded images with a
// copy-the-markdown-snippet affordance for pasting into page/news bodies.
// Uploads are downscaled client-side (src/resize.ts) before being POSTed as a
// raw body; the server only validates. API errors surface through the api
// layer's snackbar (decision #11); the local snackbar here handles the two
// page-level notices (markdown copied, undecodable file).

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Paper,
  Snackbar,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import UploadIcon from '@mui/icons-material/Upload';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import DeleteIcon from '@mui/icons-material/Delete';
import type { Image } from '@silvio/ui-shared';
import { api as realApi, type AdminApi } from '../api';
import { resizeImage } from '../resize';

/** 35021 → '34.2 KB': human-readable byte size for the list. */
function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function ImagesPage({ api = realApi }: { api?: AdminApi }) {
  const [images, setImages] = useState<Image[]>();
  const fileInput = useRef<HTMLInputElement>(null);

  // Local snackbar: copy confirmation or a decode failure.
  const [notice, setNotice] = useState<{ severity: 'success' | 'error'; text: string }>();

  // Delete confirmation
  const [deleting, setDeleting] = useState<Image>();

  const refresh = useCallback(async () => {
    const listed = await api.adminImages();
    if (listed !== undefined) setImages(listed);
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const upload = async (file: File) => {
    let resized: { blob: Blob; mime: string };
    try {
      resized = await resizeImage(file);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      setNotice({ severity: 'error', text: detail });
      return;
    }
    const uploaded = await api.adminUploadImage(resized.blob, resized.mime);
    if (uploaded !== undefined) await refresh();
  };

  const onFileChosen = (files: FileList | null) => {
    const file = files?.[0];
    if (file !== undefined) void upload(file);
    // Reset so choosing the same file again re-fires the change event
    if (fileInput.current !== null) fileInput.current.value = '';
  };

  const copyMarkdown = async (image: Image) => {
    await navigator.clipboard.writeText(`![description](/i/${image.id})`);
    setNotice({ severity: 'success', text: 'Markdown copied — edit the description' });
  };

  const submitDelete = async () => {
    if (deleting === undefined) return;
    const target = deleting;
    setDeleting(undefined);
    if (await api.adminDeleteImage(target.id)) await refresh();
  };

  return (
    <Stack spacing={2} sx={{ marginTop: 2, maxWidth: 800 }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center">
        <Typography variant="h5">Images</Typography>
        <Button
          variant="contained"
          startIcon={<UploadIcon />}
          onClick={() => fileInput.current?.click()}
        >
          Upload image
        </Button>
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          hidden
          data-testid="image-upload-input"
          onChange={(e) => onFileChosen(e.target.files)}
        />
      </Stack>
      {images !== undefined && images.length === 0 && (
        <Typography color="text.secondary">
          No images yet. Upload one, then paste its markdown into a page or news item.
        </Typography>
      )}
      {images !== undefined && images.length > 0 && (
        <TableContainer component={Paper}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Preview</TableCell>
                <TableCell>Type</TableCell>
                <TableCell align="right">Size</TableCell>
                <TableCell>Uploaded</TableCell>
                <TableCell align="right" />
              </TableRow>
            </TableHead>
            <TableBody>
              {images.map((image) => (
                <TableRow key={image.id}>
                  <TableCell>
                    <img
                      src={`/i/${image.id}`}
                      alt={image.id}
                      style={{ maxWidth: 96, maxHeight: 64, display: 'block' }}
                    />
                  </TableCell>
                  <TableCell>{image.mime}</TableCell>
                  <TableCell align="right">{humanSize(image.size)}</TableCell>
                  <TableCell>{image.createdAt.slice(0, 10)}</TableCell>
                  <TableCell align="right">
                    <IconButton
                      size="small"
                      aria-label={`copy markdown for ${image.id}`}
                      onClick={() => void copyMarkdown(image)}
                    >
                      <ContentCopyIcon fontSize="small" />
                    </IconButton>
                    <IconButton
                      size="small"
                      aria-label={`delete image ${image.id}`}
                      onClick={() => setDeleting(image)}
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

      {/* Delete confirmation */}
      <Dialog open={deleting !== undefined} onClose={() => setDeleting(undefined)}>
        <DialogTitle>Delete image?</DialogTitle>
        <DialogContent>
          <Typography>
            This permanently deletes the image. Any markdown still referencing it
            will show its text instead.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleting(undefined)}>Cancel</Button>
          <Button color="error" variant="contained" onClick={() => void submitDelete()}>
            Delete
          </Button>
        </DialogActions>
      </Dialog>

      {/* Copy confirmations and decode failures */}
      <Snackbar
        open={notice !== undefined}
        autoHideDuration={4000}
        onClose={() => setNotice(undefined)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert
          severity={notice?.severity}
          variant="filled"
          onClose={() => setNotice(undefined)}
        >
          {notice?.text}
        </Alert>
      </Snackbar>
    </Stack>
  );
}
