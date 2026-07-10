// Members admin page (decisions #3, #7): full member list with lifecycle
// actions (suspend/reinstate/remove), role changes, and manual payment
// restrictions. Action-shaped, so a custom page rather than ListEditPage.
// Active restrictions are fetched alongside the member list: restricted
// members get a "restricted" chip (reason as tooltip) and only the
// applicable Restrict/Unrestrict action is offered.

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
  Link,
  Menu,
  MenuItem,
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
  Tooltip,
  Typography,
} from '@mui/material';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import type { Member, MemberRole, MemberStatus, Restriction } from '@silvio/ui-shared';
import { api as realApi, type AdminApi } from '../api';

const STATUS_COLOURS: Record<MemberStatus, 'default' | 'success' | 'warning' | 'error'> =
  {
    applied: 'default',
    active: 'success',
    away: 'default',
    suspended: 'warning',
    closed: 'error',
  };

const ROLES: MemberRole[] = ['member', 'committee', 'admin'];

export function MembersPage({ api = realApi }: { api?: AdminApi }) {
  const [members, setMembers] = useState<Member[]>();
  const [restrictions, setRestrictions] = useState<Restriction[]>([]);

  // Per-row action menu state
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement>();
  const [menuMember, setMenuMember] = useState<Member>();
  const [roleAnchor, setRoleAnchor] = useState<HTMLElement>();

  // Dialogs: remove confirmation, restriction reason, act-as confirmation (#24)
  const [removing, setRemoving] = useState<Member>();
  const [restricting, setRestricting] = useState<Member>();
  const [reason, setReason] = useState('');
  const [actingAs, setActingAs] = useState<Member>();
  const [actingStarted, setActingStarted] = useState<Member>();

  const refresh = useCallback(async () => {
    const [listed, restricted] = await Promise.all([
      api.adminMembers(),
      api.adminRestrictions(),
    ]);
    if (listed !== undefined) setMembers(listed);
    if (restricted !== undefined) setRestrictions(restricted);
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const closeMenus = () => {
    setMenuAnchor(undefined);
    setMenuMember(undefined);
    setRoleAnchor(undefined);
  };

  const act = async (action: () => Promise<unknown>) => {
    closeMenus();
    await action();
    await refresh();
  };

  const restrictionFor = (memberId: string): Restriction | undefined =>
    restrictions.find((r) => r.memberId === memberId);

  const member = menuMember;
  const memberRestriction = member === undefined ? undefined : restrictionFor(member.id);

  return (
    <Stack spacing={2} sx={{ marginTop: 2 }}>
      <Typography variant="h5">Members</Typography>
      {members !== undefined && members.length === 0 && (
        <Typography color="text.secondary">No members in this group.</Typography>
      )}
      {members !== undefined && members.length > 0 && (
        <TableContainer component={Paper}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>No.</TableCell>
                <TableCell>Name</TableCell>
                <TableCell>Status</TableCell>
                <TableCell>Role</TableCell>
                <TableCell align="right" />
              </TableRow>
            </TableHead>
            <TableBody>
              {members.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>{row.memberNo}</TableCell>
                  <TableCell>{row.displayName}</TableCell>
                  <TableCell>
                    <Stack direction="row" spacing={1}>
                      <Chip
                        label={row.status}
                        size="small"
                        color={STATUS_COLOURS[row.status]}
                      />
                      {restrictionFor(row.id) !== undefined && (
                        <Tooltip title={restrictionFor(row.id)!.reason}>
                          <Chip label="restricted" size="small" color="error" />
                        </Tooltip>
                      )}
                    </Stack>
                  </TableCell>
                  <TableCell>{row.role}</TableCell>
                  <TableCell align="right">
                    <IconButton
                      size="small"
                      aria-label={`actions for ${row.displayName}`}
                      onClick={(e) => {
                        setMenuAnchor(e.currentTarget);
                        setMenuMember(row);
                      }}
                    >
                      <MoreVertIcon />
                    </IconButton>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      {/* Row action menu */}
      <Menu
        open={menuAnchor !== undefined && member !== undefined}
        anchorEl={menuAnchor ?? null}
        onClose={closeMenus}
      >
        {member !== undefined &&
          (member.status === 'active' || member.status === 'away') && (
            <MenuItem
              onClick={() =>
                void act(() => api.adminMemberAction(member.id, 'suspend'))
              }
            >
              Suspend
            </MenuItem>
          )}
        {member !== undefined && member.status === 'suspended' && (
          <MenuItem
            onClick={() =>
              void act(() => api.adminMemberAction(member.id, 'reinstate'))
            }
          >
            Reinstate
          </MenuItem>
        )}
        {member !== undefined && member.status === 'active' && (
          <MenuItem
            onClick={() => {
              closeMenus();
              setActingAs(member);
            }}
          >
            Act as…
          </MenuItem>
        )}
        {member !== undefined && member.status !== 'closed' && (
          <MenuItem
            onClick={() => {
              closeMenus();
              setRemoving(member);
            }}
          >
            Remove…
          </MenuItem>
        )}
        <MenuItem onClick={(e) => setRoleAnchor(e.currentTarget)}>
          Role <ChevronRightIcon fontSize="small" sx={{ marginLeft: 'auto' }} />
        </MenuItem>
        {member !== undefined && memberRestriction === undefined && (
          <MenuItem
            onClick={() => {
              closeMenus();
              setReason('');
              setRestricting(member);
            }}
          >
            Restrict…
          </MenuItem>
        )}
        {member !== undefined && memberRestriction !== undefined && (
          <MenuItem onClick={() => void act(() => api.adminUnrestrict(member.id))}>
            Unrestrict
          </MenuItem>
        )}
      </Menu>

      {/* Role submenu */}
      <Menu
        open={roleAnchor !== undefined && member !== undefined}
        anchorEl={roleAnchor ?? null}
        onClose={() => setRoleAnchor(undefined)}
        anchorOrigin={{ vertical: 'top', horizontal: 'right' }}
      >
        {ROLES.map((role) => (
          <MenuItem
            key={role}
            selected={member?.role === role}
            disabled={member?.role === role}
            onClick={() =>
              member !== undefined &&
              void act(() => api.adminSetRole(member.id, role))
            }
          >
            {role}
          </MenuItem>
        ))}
      </Menu>

      {/* Remove confirmation */}
      <Dialog open={removing !== undefined} onClose={() => setRemoving(undefined)}>
        <DialogTitle>Remove {removing?.displayName}?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Removal closes the member's accounts. Any residual balance — either
            sign — is settled to the community account as an ordinary
            settlement transaction. This cannot be undone.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRemoving(undefined)}>Cancel</Button>
          <Button
            color="error"
            variant="contained"
            onClick={() => {
              const target = removing;
              setRemoving(undefined);
              if (target !== undefined)
                void act(() => api.adminMemberAction(target.id, 'remove'));
            }}
          >
            Remove
          </Button>
        </DialogActions>
      </Dialog>

      {/* Restriction reason */}
      <Dialog
        open={restricting !== undefined}
        onClose={() => setRestricting(undefined)}
        fullWidth
      >
        <DialogTitle>Restrict {restricting?.displayName}</DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ marginBottom: 2 }}>
            Blocks outward payments; the member can still earn their way back
            up. The member is notified, and the action is audit-logged.
          </DialogContentText>
          <TextField
            label="Reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            fullWidth
            autoFocus
            required
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRestricting(undefined)}>Cancel</Button>
          <Button
            variant="contained"
            disabled={reason.trim() === ''}
            onClick={() => {
              const target = restricting;
              setRestricting(undefined);
              if (target !== undefined)
                void act(() => api.adminRestrict(target.id, reason.trim()));
            }}
          >
            Restrict
          </Button>
        </DialogActions>
      </Dialog>

      {/* Act-as confirmation (#24) */}
      <Dialog open={actingAs !== undefined} onClose={() => setActingAs(undefined)}>
        <DialogTitle>Act as {actingAs?.displayName}?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            You will see the member app exactly as {actingAs?.displayName} does
            and can trade on their behalf. Every action is recorded in the
            audit log as you acting for them. Use the banner in the member app
            to stop.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setActingAs(undefined)}>Cancel</Button>
          <Button
            variant="contained"
            onClick={() => {
              const target = actingAs;
              setActingAs(undefined);
              if (target !== undefined)
                void api.actAsMember(target.id).then((ok) => {
                  if (ok) setActingStarted(target);
                });
            }}
          >
            Act as member
          </Button>
        </DialogActions>
      </Dialog>

      {/* Act-as success: point at the member app (#24) */}
      <Snackbar
        open={actingStarted !== undefined}
        autoHideDuration={10000}
        onClose={() => setActingStarted(undefined)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert severity="success" onClose={() => setActingStarted(undefined)}>
          Now acting for {actingStarted?.displayName} — open{' '}
          <Link href="/app/">the member app</Link> to continue.
        </Alert>
      </Snackbar>
    </Stack>
  );
}
