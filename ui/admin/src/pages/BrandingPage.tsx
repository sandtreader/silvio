// Group skinning (decision #15): one brand image per slot — the logo and the
// header background — shown side by side with upload/replace and remove.
// Uploads are downscaled client-side (src/resize.ts) at a per-slot edge cap
// before being PUT as a raw body; replace-on-upload is the server's job. API
// errors surface through the api layer's snackbar (decision #11); the local
// snackbar here handles undecodable files.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Paper,
  Snackbar,
  Stack,
  Typography,
} from '@mui/material';
import UploadIcon from '@mui/icons-material/Upload';
import DeleteIcon from '@mui/icons-material/Delete';
import type { BrandSlot, Image } from '@silvio/ui-shared';
import { api as realApi, type AdminApi } from '../api';
import { resizeImage } from '../resize';

/** The two slots (#15) and their client-side long-edge caps. */
const SLOTS: { slot: BrandSlot; name: string; maxEdge: number }[] = [
  { slot: 'logo', name: 'Logo', maxEdge: 512 },
  { slot: 'header', name: 'Header background image', maxEdge: 1600 },
];

function SlotCard({
  name,
  slot,
  image,
  onUpload,
  onRemove,
}: {
  name: string;
  slot: BrandSlot;
  image: Image | undefined;
  onUpload: (file: File) => void;
  onRemove: () => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);

  const onFileChosen = (files: FileList | null) => {
    const file = files?.[0];
    if (file !== undefined) onUpload(file);
    // Reset so choosing the same file again re-fires the change event
    if (fileInput.current !== null) fileInput.current.value = '';
  };

  return (
    <Paper sx={{ padding: 2, flex: 1 }}>
      <Stack spacing={2} alignItems="flex-start">
        <Typography variant="h6">{name}</Typography>
        {image === undefined ? (
          <Typography color="text.secondary">No image set.</Typography>
        ) : (
          <img
            src={`/i/${image.id}`}
            alt={name}
            style={{ maxWidth: '100%', maxHeight: 160, display: 'block' }}
          />
        )}
        <Stack direction="row" spacing={1}>
          <Button
            variant="contained"
            startIcon={<UploadIcon />}
            onClick={() => fileInput.current?.click()}
          >
            {image === undefined ? `Upload ${name}` : `Replace ${name}`}
          </Button>
          {image !== undefined && (
            <Button color="error" startIcon={<DeleteIcon />} onClick={onRemove}>
              Remove {name}
            </Button>
          )}
        </Stack>
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          hidden
          data-testid={`brand-upload-${slot}`}
          onChange={(e) => onFileChosen(e.target.files)}
        />
      </Stack>
    </Paper>
  );
}

export function BrandingPage({ api = realApi }: { api?: AdminApi }) {
  const [images, setImages] = useState<Image[]>();

  // Local snackbar: decode failures only (API errors go via decision #11).
  const [notice, setNotice] = useState<{ severity: 'success' | 'error'; text: string }>();

  // Remove confirmation
  const [removing, setRemoving] = useState<BrandSlot>();

  const refresh = useCallback(async () => {
    const listed = await api.adminBrandImages();
    if (listed !== undefined) setImages(listed);
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const upload = async (slot: BrandSlot, maxEdge: number, file: File) => {
    let resized: { blob: Blob; mime: string };
    try {
      resized = await resizeImage(file, maxEdge);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      setNotice({ severity: 'error', text: detail });
      return;
    }
    const uploaded = await api.setBrandImage(slot, resized.blob, resized.mime);
    if (uploaded !== undefined) await refresh();
  };

  const submitRemove = async () => {
    if (removing === undefined) return;
    const target = removing;
    setRemoving(undefined);
    if (await api.deleteBrandImage(target)) await refresh();
  };

  return (
    <Stack spacing={2} sx={{ marginTop: 2, maxWidth: 800 }}>
      <Typography variant="h5">Branding</Typography>
      <Typography color="text.secondary">
        These images skin the public site: the logo appears beside the group
        name, the header image behind it.
      </Typography>
      {images !== undefined && (
        <Stack direction="row" spacing={2} alignItems="stretch">
          {SLOTS.map(({ slot, name, maxEdge }) => (
            <SlotCard
              key={slot}
              slot={slot}
              name={name}
              image={images.find((image) => image.ownerId === slot)}
              onUpload={(file) => void upload(slot, maxEdge, file)}
              onRemove={() => setRemoving(slot)}
            />
          ))}
        </Stack>
      )}

      {/* Remove confirmation */}
      <Dialog open={removing !== undefined} onClose={() => setRemoving(undefined)}>
        <DialogTitle>Remove image?</DialogTitle>
        <DialogContent>
          <Typography>
            The public site reverts to its unbranded look for this slot.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRemoving(undefined)}>Cancel</Button>
          <Button color="error" variant="contained" onClick={() => void submitRemove()}>
            Remove
          </Button>
        </DialogActions>
      </Dialog>

      {/* Decode failures */}
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
