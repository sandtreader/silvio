// Transactions admin page: search and list the group's transactions via
// GET /admin/transactions, and reverse a committed one from its row
// (decision #5/#6 — committed entries are immutable; a reversal is a
// compensating transaction linked via reversesId).

import { useCallback, useEffect, useState } from 'react';
import {
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
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
import UndoIcon from '@mui/icons-material/Undo';
import type { Transaction, TxState } from '@silvio/ui-shared';
import { api as realApi, type AdminApi } from '../api';

const LIMIT = 50;

const STATE_COLOURS: Record<TxState, 'default' | 'success' | 'warning' | 'error'> = {
  pending: 'warning',
  committed: 'success',
  declined: 'error',
  cancelled: 'default',
  expired: 'default',
};

/** The transaction's magnitude: the sum of its positive legs, minor units. */
function amountOf(tx: Transaction): number {
  return (tx.entries ?? [])
    .filter((entry) => entry.amount > 0)
    .reduce((sum, entry) => sum + entry.amount, 0);
}

export function TransactionsPage({ api = realApi }: { api?: AdminApi }) {
  const [q, setQ] = useState('');
  const [transactions, setTransactions] = useState<Transaction[]>();
  const [total, setTotal] = useState(0);
  const [confirming, setConfirming] = useState<Transaction>();

  const search = useCallback(
    async (offset = 0) => {
      const result = await api.adminTransactions({
        ...(q.trim() === '' ? {} : { q: q.trim() }),
        limit: LIMIT,
        offset,
      });
      if (result === undefined) return;
      setTotal(result.total);
      setTransactions((previous) =>
        offset === 0
          ? result.transactions
          : [...(previous ?? []), ...result.transactions],
      );
    },
    [api, q],
  );

  useEffect(() => {
    void search();
  }, [search]);

  const reverse = async () => {
    const target = confirming;
    setConfirming(undefined);
    if (target === undefined) return;
    await api.adminReverse(target.id);
    await search();
  };

  const shown = transactions ?? [];

  return (
    <Stack spacing={2} sx={{ marginTop: 2 }}>
      <Typography variant="h5">Transactions</Typography>
      <TextField
        label="Search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Description or reference"
        sx={{ maxWidth: 480 }}
      />
      {transactions !== undefined && shown.length === 0 && (
        <Typography color="text.secondary">No matching transactions.</Typography>
      )}
      {shown.length > 0 && (
        <TableContainer component={Paper}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Seq</TableCell>
                <TableCell>Date</TableCell>
                <TableCell>Type</TableCell>
                <TableCell>State</TableCell>
                <TableCell>Description</TableCell>
                <TableCell align="right">Amount (minor units)</TableCell>
                <TableCell align="right" />
              </TableRow>
            </TableHead>
            <TableBody>
              {shown.map((tx) => (
                <TableRow key={tx.id}>
                  <TableCell>{tx.seq ?? '—'}</TableCell>
                  <TableCell>{tx.createdAt.slice(0, 10)}</TableCell>
                  <TableCell>{tx.type}</TableCell>
                  <TableCell>
                    <Chip label={tx.state} size="small" color={STATE_COLOURS[tx.state]} />
                  </TableCell>
                  <TableCell>{tx.description}</TableCell>
                  <TableCell align="right">{amountOf(tx)}</TableCell>
                  <TableCell align="right">
                    {tx.state === 'committed' && (
                      <Button
                        size="small"
                        color="error"
                        startIcon={<UndoIcon />}
                        onClick={() => setConfirming(tx)}
                      >
                        Reverse
                      </Button>
                    )}
                  </TableCell>
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

      {/* Reversal confirmation */}
      <Dialog open={confirming !== undefined} onClose={() => setConfirming(undefined)}>
        <DialogTitle>Reverse transaction?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Posts a compensating transaction undoing every leg of{' '}
            <strong>{confirming?.description ?? confirming?.id}</strong>. The original
            stays on the ledger. This cannot itself be undone except by another
            reversal.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirming(undefined)}>Cancel</Button>
          <Button color="error" variant="contained" onClick={() => void reverse()}>
            Confirm
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
