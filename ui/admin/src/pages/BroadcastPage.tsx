// Admin broadcast (decision #17): compose a markdown email and send it,
// ad hoc, to every person on an active membership — one email each, queued
// through the standard outbox. Nothing is stored page-side; the email_events
// log records what was sent to whom. Sending sits behind a confirmation
// because there is no undo, and the success snackbar reports how many
// emails were queued. API errors surface through the api layer's snackbar
// (decision #11).

import { useState } from 'react';
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Snackbar,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import SendIcon from '@mui/icons-material/Send';
import { api as realApi, type AdminApi } from '../api';
import { MarkdownEditor } from '../MarkdownEditor';

export function BroadcastPage({ api = realApi }: { api?: AdminApi }) {
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [queuedNotice, setQueuedNotice] = useState<string>();

  const ready = subject.trim() !== '' && body.trim() !== '';

  const submit = async () => {
    setConfirming(false);
    setSending(true);
    const queued = await api.adminBroadcast(subject.trim(), body);
    setSending(false);
    if (queued !== undefined) {
      setQueuedNotice(`Broadcast queued to ${queued} member${queued === 1 ? '' : 's'}`);
      setSubject('');
      setBody('');
    }
  };

  return (
    <Stack spacing={2} sx={{ marginTop: 2, maxWidth: 800 }}>
      <Typography variant="h5">Broadcast</Typography>
      <Typography color="text.secondary">
        Email every active member, one message each. The body is markdown; the
        preview shows what the email will contain.
      </Typography>
      <TextField
        label="Subject"
        value={subject}
        onChange={(e) => setSubject(e.target.value)}
        fullWidth
      />
      <MarkdownEditor value={body} onChange={setBody} />
      <Stack direction="row" justifyContent="flex-end">
        <Button
          variant="contained"
          startIcon={<SendIcon />}
          disabled={!ready || sending}
          onClick={() => setConfirming(true)}
        >
          Send
        </Button>
      </Stack>

      {/* Send confirmation: there is no undo */}
      <Dialog open={confirming} onClose={() => setConfirming(false)}>
        <DialogTitle>Send broadcast?</DialogTitle>
        <DialogContent>
          <Typography>
            This emails every active member. <strong>{subject.trim()}</strong>{' '}
            cannot be recalled once sent.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirming(false)}>Cancel</Button>
          <Button variant="contained" onClick={() => void submit()}>
            Send broadcast
          </Button>
        </DialogActions>
      </Dialog>

      {/* Queued confirmation */}
      <Snackbar
        open={queuedNotice !== undefined}
        autoHideDuration={6000}
        onClose={() => setQueuedNotice(undefined)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert
          severity="success"
          variant="filled"
          onClose={() => setQueuedNotice(undefined)}
        >
          {queuedNotice}
        </Alert>
      </Snackbar>
    </Stack>
  );
}
