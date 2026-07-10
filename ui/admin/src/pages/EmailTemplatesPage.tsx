// Email templates (decision #16): every notification kind has a built-in
// default; saving here stores a group override, "Revert to default" deletes
// it. Bodies are markdown with {{placeholder}} substitution, edited with the
// same live preview as the CMS screens (#13). The per-group sender address
// (groups.emailFrom) sits at the top; blank means the instance-wide sender.
// API errors surface through the api layer's snackbar (decision #11).

import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Chip,
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
  TextField,
  Typography,
} from '@mui/material';
import EditIcon from '@mui/icons-material/Edit';
import type { EmailTemplate, EmailTemplateKind } from '@silvio/ui-shared';
import { api as realApi, type AdminApi } from '../api';
import { MarkdownEditor } from '../MarkdownEditor';

/** Human labels for the notification kinds, in the server's listing order. */
const KIND_LABELS: Record<EmailTemplateKind, string> = {
  welcome: 'Welcome / approval',
  invoice_received: 'Invoice received',
  payment_held: 'Payment held for confirmation',
  payment_received: 'Payment received',
  payment_accepted: 'Payment or invoice accepted',
  payment_declined: 'Payment or invoice declined',
  payment_auto_accepted_payer: 'Payment auto-accepted (payer copy)',
  payment_auto_accepted_payee: 'Payment auto-accepted (payee copy)',
  invoice_expired: 'Invoice expired',
  restriction_imposed: 'Restriction imposed',
  restriction_lifted: 'Restriction lifted',
  password_reset: 'Password reset',
  email_verify: 'Email verification',
  digest: 'Offers & wants digest', // decision #17
};

/** Every substitutable variable (#16); which apply depends on the kind. */
const ALL_PLACEHOLDERS =
  '{{memberName}}, {{groupName}}, {{amount}}, {{payerName}}, {{payeeName}}, ' +
  '{{flowName}}, {{reason}}, {{descriptionLine}}, {{resetUrl}}, {{verifyUrl}}, ' +
  '{{listings}}';

/** The distinct {{placeholder}} tokens used across the given texts. */
function scanPlaceholders(...texts: string[]): string[] {
  const found = new Set<string>();
  for (const text of texts)
    for (const match of text.matchAll(/\{\{[A-Za-z0-9_]+\}\}/g)) found.add(match[0]);
  return [...found];
}

export function EmailTemplatesPage({ api = realApi }: { api?: AdminApi }) {
  const [templates, setTemplates] = useState<EmailTemplate[]>();

  // Sender address (groups.emailFrom); '' means the instance-wide default.
  const [emailFrom, setEmailFrom] = useState<string>();
  const [savedNotice, setSavedNotice] = useState<string>();

  // Editor dialog state
  const [editing, setEditing] = useState<EmailTemplate>();
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');

  // Revert confirmation
  const [reverting, setReverting] = useState(false);

  const refresh = useCallback(async () => {
    const listed = await api.adminEmailTemplates();
    if (listed !== undefined) setTemplates(listed);
  }, [api]);

  useEffect(() => {
    void refresh();
    void (async () => {
      const group = await api.adminGroup();
      if (group !== undefined) setEmailFrom(group.emailFrom ?? '');
    })();
  }, [api, refresh]);

  const saveSender = async () => {
    const trimmed = (emailFrom ?? '').trim();
    const group = await api.patchAdminGroup({
      emailFrom: trimmed === '' ? null : trimmed,
    });
    if (group !== undefined) {
      setEmailFrom(group.emailFrom ?? '');
      setSavedNotice('Sender address saved');
    }
  };

  const openEdit = (template: EmailTemplate) => {
    setEditing(template);
    setSubject(template.subject);
    setBody(template.body);
  };

  const submit = async () => {
    if (editing === undefined) return;
    const saved = await api.putEmailTemplate(editing.kind, { subject, body });
    if (saved !== undefined) {
      setEditing(undefined);
      await refresh();
    }
  };

  const submitRevert = async () => {
    if (editing === undefined) return;
    setReverting(false);
    if (await api.deleteEmailTemplate(editing.kind)) {
      setEditing(undefined);
      await refresh();
    }
  };

  const used = editing === undefined ? [] : scanPlaceholders(subject, body);

  return (
    <Stack spacing={2} sx={{ marginTop: 2, maxWidth: 800 }}>
      <Typography variant="h5">Email templates</Typography>

      {/* Per-group sender (#16): blank falls back to the instance sender */}
      <Paper sx={{ padding: 2 }}>
        <Stack direction="row" spacing={2} alignItems="flex-start">
          <TextField
            label="Sender address"
            value={emailFrom ?? ''}
            onChange={(e) => setEmailFrom(e.target.value)}
            helperText="Leave blank to use the instance-wide sender address"
            disabled={emailFrom === undefined}
            fullWidth
          />
          <Button
            variant="contained"
            disabled={emailFrom === undefined}
            onClick={() => void saveSender()}
            sx={{ marginTop: 1 }}
          >
            Save
          </Button>
        </Stack>
      </Paper>

      <Typography color="text.secondary">
        Each notification has a built-in template; edit one to override it for
        this group. Subjects and bodies substitute these placeholders where the
        notification provides them: {ALL_PLACEHOLDERS}.
      </Typography>
      {templates !== undefined && (
        <TableContainer component={Paper}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Notification</TableCell>
                <TableCell>Subject</TableCell>
                <TableCell />
                <TableCell align="right" />
              </TableRow>
            </TableHead>
            <TableBody>
              {templates.map((template) => (
                <TableRow key={template.kind}>
                  <TableCell>{KIND_LABELS[template.kind]}</TableCell>
                  <TableCell>{template.subject}</TableCell>
                  <TableCell>
                    {!template.isDefault && (
                      <Chip label="edited" size="small" color="primary" />
                    )}
                  </TableCell>
                  <TableCell align="right">
                    <IconButton
                      size="small"
                      aria-label={`edit ${KIND_LABELS[template.kind]}`}
                      onClick={() => openEdit(template)}
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

      {/* Editor dialog */}
      <Dialog
        open={editing !== undefined}
        onClose={() => setEditing(undefined)}
        fullWidth
        maxWidth="md"
      >
        <DialogTitle>
          {editing === undefined ? '' : KIND_LABELS[editing.kind]}
        </DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ marginTop: 1 }}>
            <TextField
              label="Subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              fullWidth
            />
            <MarkdownEditor value={body} onChange={setBody} />
            <Typography variant="caption" color="text.secondary">
              Placeholders used: {used.length === 0 ? 'none' : used.join(', ')}.
              Available: {ALL_PLACEHOLDERS} — unknown ones pass through
              literally.
            </Typography>
          </Stack>
        </DialogContent>
        <DialogActions>
          {editing !== undefined && !editing.isDefault && (
            <Button color="error" onClick={() => setReverting(true)}>
              Revert to default
            </Button>
          )}
          <Button onClick={() => setEditing(undefined)}>Cancel</Button>
          <Button variant="contained" onClick={() => void submit()}>
            Save
          </Button>
        </DialogActions>
      </Dialog>

      {/* Revert confirmation */}
      <Dialog open={reverting} onClose={() => setReverting(false)}>
        <DialogTitle>Revert to default?</DialogTitle>
        <DialogContent>
          <Typography>
            This discards the group&apos;s override of{' '}
            <strong>{editing === undefined ? '' : KIND_LABELS[editing.kind]}</strong>{' '}
            and restores the built-in template.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setReverting(false)}>Cancel</Button>
          <Button color="error" variant="contained" onClick={() => void submitRevert()}>
            Revert
          </Button>
        </DialogActions>
      </Dialog>

      {/* Sender-save confirmation */}
      <Snackbar
        open={savedNotice !== undefined}
        autoHideDuration={4000}
        onClose={() => setSavedNotice(undefined)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert
          severity="success"
          variant="filled"
          onClose={() => setSavedNotice(undefined)}
        >
          {savedNotice}
        </Alert>
      </Snackbar>
    </Stack>
  );
}
