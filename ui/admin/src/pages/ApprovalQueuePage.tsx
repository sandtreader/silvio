// Approval queue (decision #7): members in the 'applied' state, with
// approve/reject actions. Reject maps to the API's 'remove' action — the
// server's removal flow handles a never-approved member.

import { useCallback, useEffect, useState } from 'react';
import {
  Button,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import CheckIcon from '@mui/icons-material/Check';
import CloseIcon from '@mui/icons-material/Close';
import type { Member } from '@silvio/ui-shared';
import { api as realApi, type AdminApi } from '../api';

export function ApprovalQueuePage({ api = realApi }: { api?: AdminApi }) {
  const [applicants, setApplicants] = useState<Member[]>();
  const [busyId, setBusyId] = useState<string>();

  const refresh = useCallback(async () => {
    const members = await api.adminMembers('applied');
    if (members !== undefined) setApplicants(members);
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const act = async (id: string, action: 'approve' | 'remove') => {
    setBusyId(id);
    await api.adminMemberAction(id, action);
    setBusyId(undefined);
    await refresh();
  };

  return (
    <Stack spacing={2} sx={{ marginTop: 2 }}>
      <Typography variant="h5">Approval queue</Typography>
      {applicants !== undefined && applicants.length === 0 && (
        <Typography color="text.secondary">
          No applications waiting for approval.
        </Typography>
      )}
      {applicants !== undefined && applicants.length > 0 && (
        <TableContainer component={Paper}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>No.</TableCell>
                <TableCell>Name</TableCell>
                <TableCell>Applied</TableCell>
                <TableCell align="right">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {applicants.map((member) => (
                <TableRow key={member.id}>
                  <TableCell>{member.memberNo}</TableCell>
                  <TableCell>{member.displayName}</TableCell>
                  <TableCell>
                    {new Date(member.appliedAt).toLocaleDateString()}
                  </TableCell>
                  <TableCell align="right">
                    <Stack direction="row" spacing={1} justifyContent="flex-end">
                      <Button
                        size="small"
                        variant="contained"
                        startIcon={<CheckIcon />}
                        disabled={busyId === member.id}
                        onClick={() => void act(member.id, 'approve')}
                      >
                        Approve
                      </Button>
                      <Button
                        size="small"
                        color="error"
                        startIcon={<CloseIcon />}
                        disabled={busyId === member.id}
                        onClick={() => void act(member.id, 'remove')}
                      >
                        Reject
                      </Button>
                    </Stack>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
    </Stack>
  );
}
