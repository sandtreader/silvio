// Groups page (decision #21): master-detail on one page — Rafiki menu apps
// are page-per-menu-entry, so the group list selects into a management panel
// below rather than routing to a detail page. Management covers #20: rename,
// suspend/reinstate (read-only semantics), plan label, operator-private
// notes, and domain add/remove (the operator list carries each group's
// current domains).

import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  IconButton,
  List,
  ListItem,
  ListItemText,
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
import DeleteIcon from '@mui/icons-material/Delete';
import type { OperatorGroup, OperatorGroupPatch } from '@silvio/ui-shared';
import { api as realApi, type OperatorApi } from '../api';

const STATUS_COLOURS: Record<OperatorGroup['status'], 'success' | 'warning'> = {
  active: 'success',
  suspended: 'warning', // #20
};

export function GroupsPage({ api = realApi }: { api?: OperatorApi }) {
  const [groups, setGroups] = useState<OperatorGroup[]>();
  const [selectedId, setSelectedId] = useState<string>();

  // Management panel fields, loaded from the selected group
  const [name, setName] = useState('');
  const [plan, setPlan] = useState('');
  const [notes, setNotes] = useState('');

  const [newDomain, setNewDomain] = useState('');

  // Confirm dialogs
  const [confirmingStatus, setConfirmingStatus] = useState<'suspend' | 'reinstate'>();
  const [removingDomain, setRemovingDomain] = useState<string>();

  const [savedNotice, setSavedNotice] = useState<string>();

  const refresh = useCallback(async () => {
    const listed = await api.operatorGroups();
    if (listed !== undefined) setGroups(listed);
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const selected = groups?.find((group) => group.id === selectedId);

  const select = (group: OperatorGroup) => {
    setSelectedId(group.id);
    setName(group.name);
    setPlan(group.plan ?? '');
    setNotes(group.notes ?? '');
    setNewDomain('');
  };

  /** Apply a patch to the selected group and fold the result back in. */
  const patch = async (body: OperatorGroupPatch, notice: string) => {
    if (selected === undefined) return;
    const updated = await api.patchOperatorGroup(selected.id, body);
    if (updated === undefined) return;
    setGroups((current) =>
      current?.map((group) => (group.id === updated.id ? updated : group)),
    );
    setName(updated.name);
    setPlan(updated.plan ?? '');
    setNotes(updated.notes ?? '');
    setSavedNotice(notice);
  };

  const addDomain = async () => {
    if (selected === undefined) return;
    const hostname = newDomain.trim();
    const ok = await api.addGroupDomain(selected.id, hostname);
    if (!ok) return;
    await refresh();
    setNewDomain('');
    setSavedNotice(`Domain ${hostname} added`);
  };

  const removeDomain = async (hostname: string) => {
    if (selected === undefined) return;
    const ok = await api.removeGroupDomain(selected.id, hostname);
    if (!ok) return;
    await refresh();
    setSavedNotice(`Domain ${hostname} removed`);
  };

  const domains = selected?.domains ?? [];

  return (
    <Stack spacing={2} sx={{ marginTop: 2 }}>
      <Typography variant="h5">Groups</Typography>
      {groups !== undefined && groups.length === 0 && (
        <Typography color="text.secondary">No groups provisioned yet.</Typography>
      )}
      {groups !== undefined && groups.length > 0 && (
        <TableContainer component={Paper}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Name</TableCell>
                <TableCell>Slug</TableCell>
                <TableCell>Status</TableCell>
                <TableCell>Plan</TableCell>
                <TableCell>Created</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {groups.map((row) => (
                <TableRow
                  key={row.id}
                  hover
                  selected={row.id === selectedId}
                  onClick={() => select(row)}
                  sx={{ cursor: 'pointer' }}
                >
                  <TableCell>{row.name}</TableCell>
                  <TableCell>{row.slug}</TableCell>
                  <TableCell>
                    <Chip
                      label={row.status}
                      size="small"
                      color={STATUS_COLOURS[row.status]}
                    />
                  </TableCell>
                  <TableCell>{row.plan ?? ''}</TableCell>
                  <TableCell>{new Date(row.createdAt).toLocaleDateString()}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      {/* Management panel for the selected group (#20) */}
      {selected !== undefined && (
        <Paper sx={{ padding: 2, maxWidth: 800 }}>
          <Stack spacing={2}>
            <Stack direction="row" spacing={2} alignItems="center">
              <Typography variant="h6" sx={{ flexGrow: 1 }}>
                Manage {selected.slug}
              </Typography>
              <Chip
                label={selected.status}
                size="small"
                color={STATUS_COLOURS[selected.status]}
              />
              {selected.status === 'active' && (
                <Button
                  color="warning"
                  variant="outlined"
                  onClick={() => setConfirmingStatus('suspend')}
                >
                  Suspend…
                </Button>
              )}
              {selected.status === 'suspended' && (
                <Button
                  color="success"
                  variant="outlined"
                  onClick={() => setConfirmingStatus('reinstate')}
                >
                  Reinstate…
                </Button>
              )}
            </Stack>

            {/* Rename */}
            <Stack direction="row" spacing={2} alignItems="flex-start">
              <TextField
                label="Group name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                fullWidth
              />
              <Button
                variant="contained"
                disabled={name.trim() === ''}
                onClick={() => void patch({ name: name.trim() }, 'Group name saved')}
              >
                Save name
              </Button>
            </Stack>

            {/* Plan label (#20): free text, no billing logic; blank clears */}
            <Stack direction="row" spacing={2} alignItems="flex-start">
              <TextField
                label="Plan"
                value={plan}
                onChange={(e) => setPlan(e.target.value)}
                helperText="Free-text plan label; blank clears it"
                fullWidth
              />
              <Button
                variant="contained"
                onClick={() =>
                  void patch(
                    { plan: plan.trim() === '' ? null : plan.trim() },
                    'Plan saved',
                  )
                }
              >
                Save plan
              </Button>
            </Stack>

            {/* Operator-private notes (#20); blank clears */}
            <Stack direction="row" spacing={2} alignItems="flex-start">
              <TextField
                label="Operator notes (never visible to the group)"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                helperText="Contacts, history; blank clears them"
                multiline
                minRows={3}
                fullWidth
              />
              <Button
                variant="contained"
                onClick={() =>
                  void patch({ notes: notes.trim() === '' ? null : notes }, 'Notes saved')
                }
              >
                Save notes
              </Button>
            </Stack>

            {/* Domains: Host-header tenancy */}
            <Stack spacing={1}>
              <Typography variant="subtitle1">Domains</Typography>
              <Typography variant="body2" color="text.secondary">
                Members reach the group at these hostnames (Host-header
                tenancy).
              </Typography>
              <Stack direction="row" spacing={2} alignItems="flex-start">
                <TextField
                  label="Hostname"
                  value={newDomain}
                  onChange={(e) => setNewDomain(e.target.value)}
                  placeholder="lets.example.org"
                  fullWidth
                />
                <Button
                  variant="contained"
                  disabled={newDomain.trim() === ''}
                  onClick={() => void addDomain()}
                >
                  Add
                </Button>
              </Stack>
              {domains.length > 0 && (
                <List dense disablePadding>
                  {domains.map((hostname) => (
                    <ListItem
                      key={hostname}
                      secondaryAction={
                        <IconButton
                          edge="end"
                          size="small"
                          aria-label={`remove ${hostname}`}
                          onClick={() => setRemovingDomain(hostname)}
                        >
                          <DeleteIcon fontSize="small" />
                        </IconButton>
                      }
                    >
                      <ListItemText primary={hostname} />
                    </ListItem>
                  ))}
                </List>
              )}
            </Stack>
          </Stack>
        </Paper>
      )}

      {/* Suspend / reinstate confirmation (#20) */}
      <Dialog
        open={confirmingStatus !== undefined}
        onClose={() => setConfirmingStatus(undefined)}
      >
        <DialogTitle>
          {confirmingStatus === 'suspend' ? 'Suspend' : 'Reinstate'} {selected?.name}?
        </DialogTitle>
        <DialogContent>
          <DialogContentText>
            {confirmingStatus === 'suspend'
              ? 'Suspension makes the group read-only (#20): members can still ' +
                'log in and read everything, but every state-changing action — ' +
                'trades, listings, applications, CMS and admin changes — is ' +
                'refused, scheduled sweeps, demurrage and digests are skipped, ' +
                'and the public brochure shows a suspension notice.'
              : 'The group returns to full read-write service and its scheduled ' +
                'jobs resume.'}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmingStatus(undefined)}>Cancel</Button>
          <Button
            color={confirmingStatus === 'suspend' ? 'warning' : 'success'}
            variant="contained"
            onClick={() => {
              const action = confirmingStatus;
              setConfirmingStatus(undefined);
              if (action !== undefined)
                void patch(
                  { status: action === 'suspend' ? 'suspended' : 'active' },
                  action === 'suspend' ? 'Group suspended' : 'Group reinstated',
                );
            }}
          >
            {confirmingStatus === 'suspend' ? 'Suspend' : 'Reinstate'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Domain removal confirmation */}
      <Dialog
        open={removingDomain !== undefined}
        onClose={() => setRemovingDomain(undefined)}
      >
        <DialogTitle>Remove {removingDomain}?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Members reach the group at its hostnames — anyone visiting{' '}
            {removingDomain} will no longer reach {selected?.name}.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRemovingDomain(undefined)}>Cancel</Button>
          <Button
            color="error"
            variant="contained"
            onClick={() => {
              const hostname = removingDomain;
              setRemovingDomain(undefined);
              if (hostname !== undefined) void removeDomain(hostname);
            }}
          >
            Remove
          </Button>
        </DialogActions>
      </Dialog>

      {/* Save confirmation */}
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
