// Audit admin page: browse the group's audit log via GET /admin/audit —
// who did what to which entity, newest first, with dotted-action and
// entity-id filters. Read-only: the log itself is append-only on the server.

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
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import type { AuditEvent } from '@silvio/ui-shared';
import { api as realApi, type AdminApi } from '../api';

const LIMIT = 50;

/** First 8 characters of an id, with the full id on hover. */
function ShortId({ id }: { id: string }) {
  return (
    <Tooltip title={id}>
      <Typography component="span" variant="body2" sx={{ fontFamily: 'monospace' }}>
        {id.slice(0, 8)}
      </Typography>
    </Tooltip>
  );
}

/** The detail object as a compact "key: value" line; empty when absent. */
function detailLine(detail: AuditEvent['detail']): string {
  if (detail === undefined) return '';
  return Object.entries(detail)
    .map(([key, value]) =>
      `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`,
    )
    .join(', ');
}

export function AuditPage({ api = realApi }: { api?: AdminApi }) {
  const [action, setAction] = useState('');
  const [entityId, setEntityId] = useState('');
  const [events, setEvents] = useState<AuditEvent[]>();
  const [total, setTotal] = useState(0);

  const search = useCallback(
    async (offset = 0) => {
      const result = await api.adminAudit({
        ...(action.trim() === '' ? {} : { action: action.trim() }),
        ...(entityId.trim() === '' ? {} : { entityId: entityId.trim() }),
        limit: LIMIT,
        offset,
      });
      if (result === undefined) return;
      setTotal(result.total);
      setEvents((previous) =>
        offset === 0 ? result.events : [...(previous ?? []), ...result.events],
      );
    },
    [api, action, entityId],
  );

  useEffect(() => {
    void search();
  }, [search]);

  const shown = events ?? [];

  return (
    <Stack spacing={2} sx={{ marginTop: 2 }}>
      <Typography variant="h5">Audit log</Typography>
      <Stack direction="row" spacing={2}>
        <TextField
          label="Action"
          value={action}
          onChange={(e) => setAction(e.target.value)}
          placeholder="e.g. member.approve"
          sx={{ maxWidth: 280 }}
        />
        <TextField
          label="Entity id"
          value={entityId}
          onChange={(e) => setEntityId(e.target.value)}
          sx={{ maxWidth: 280 }}
        />
      </Stack>
      {events !== undefined && shown.length === 0 && (
        <Typography color="text.secondary">No matching audit events.</Typography>
      )}
      {shown.length > 0 && (
        <TableContainer component={Paper}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Time</TableCell>
                <TableCell>Action</TableCell>
                <TableCell>Entity</TableCell>
                <TableCell>Actor</TableCell>
                <TableCell>Detail</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {shown.map((event) => (
                <TableRow key={event.id}>
                  <TableCell>{new Date(event.at).toLocaleString()}</TableCell>
                  <TableCell>{event.action}</TableCell>
                  <TableCell>
                    {event.entityType} <ShortId id={event.entityId} />
                  </TableCell>
                  <TableCell>
                    {event.actorUserId !== undefined && (
                      <ShortId id={event.actorUserId} />
                    )}
                  </TableCell>
                  <TableCell>{detailLine(event.detail)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
      {total > shown.length && (
        <Stack direction="row">
          <Button onClick={() => void search(shown.length)}>
            Load more ({shown.length} of {total})
          </Button>
        </Stack>
      )}
    </Stack>
  );
}
