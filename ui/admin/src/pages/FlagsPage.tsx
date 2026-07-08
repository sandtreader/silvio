// Credit-control flags page (decision #3): the periodic evaluation's output
// per currency — level + reason per member. Flags never block by themselves;
// this is the committee-review surface.

import { useEffect, useMemo, useState } from 'react';
import {
  Chip,
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
import type { Flag, Member } from '@silvio/ui-shared';
import { api as realApi, type AdminApi } from '../api';
import { useCurrencies } from '../currencies';

export function FlagsPage({ api = realApi }: { api?: AdminApi }) {
  const currencies = useCurrencies(api);
  const [currencyId, setCurrencyId] = useState('');
  const [flags, setFlags] = useState<Flag[]>();
  const [members, setMembers] = useState<Member[]>();

  useEffect(() => {
    if (currencyId === '' && currencies.length > 0) {
      setCurrencyId(currencies[0]!.id);
    }
  }, [currencies, currencyId]);

  // Member names for the flag rows
  useEffect(() => {
    let cancelled = false;
    void api.adminMembers().then((listed) => {
      if (!cancelled && listed !== undefined) setMembers(listed);
    });
    return () => {
      cancelled = true;
    };
  }, [api]);

  useEffect(() => {
    if (currencyId === '') return;
    let cancelled = false;
    setFlags(undefined);
    void api.adminFlags(currencyId).then((listed) => {
      if (!cancelled && listed !== undefined) setFlags(listed);
    });
    return () => {
      cancelled = true;
    };
  }, [api, currencyId]);

  const memberName = useMemo(() => {
    const byId = new Map(members?.map((m) => [m.id, m]) ?? []);
    return (id: string) => {
      const member = byId.get(id);
      return member === undefined
        ? id
        : `${member.memberNo} ${member.displayName}`;
    };
  }, [members]);

  return (
    <Stack spacing={2} sx={{ marginTop: 2 }}>
      <Typography variant="h5">Flags</Typography>
      <TextField
        select
        label="Currency"
        value={currencyId}
        onChange={(e) => setCurrencyId(e.target.value)}
        sx={{ width: 200 }}
      >
        {currencies.map((c) => (
          <MenuItem key={c.id} value={c.id}>
            {c.code}
          </MenuItem>
        ))}
      </TextField>
      {flags !== undefined && flags.length === 0 && (
        <Typography color="text.secondary">
          No flags for this currency — nothing needs review.
        </Typography>
      )}
      {flags !== undefined && flags.length > 0 && (
        <TableContainer component={Paper}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Member</TableCell>
                <TableCell>Level</TableCell>
                <TableCell>Reason</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {flags.map((flag) => (
                <TableRow key={flag.accountId + flag.level}>
                  <TableCell>{memberName(flag.memberId)}</TableCell>
                  <TableCell>
                    <Chip label={flag.level} size="small" color="warning" />
                  </TableCell>
                  <TableCell>{flag.reason}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
    </Stack>
  );
}
