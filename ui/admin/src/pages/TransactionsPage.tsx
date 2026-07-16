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
  Typography,
} from '@mui/material';
import UndoIcon from '@mui/icons-material/Undo';
import { FilteredView } from '@sandtreader/rafiki';
import type { AdminEntry, AdminTransaction, TxState } from '@silvio/ui-shared';
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
function amountOf(tx: AdminTransaction): number {
  return (tx.entries ?? [])
    .filter((entry) => entry.amount > 0)
    .reduce((sum, entry) => sum + entry.amount, 0);
}

/** Human label for one enriched leg: member name when known, gateway
 * counterparty ref otherwise, else the bare account type (e.g. 'system'). */
function entryLabel(entry: AdminEntry): string {
  return entry.displayName ?? entry.counterpartyRef ?? entry.accountType;
}

/** From = debited legs (amount < 0), To = credited legs, joined for display. */
function legsOf(tx: AdminTransaction, sign: 1 | -1): string {
  return (tx.entries ?? [])
    .filter((entry) => Math.sign(entry.amount) === sign)
    .map(entryLabel)
    .join(', ');
}

export function TransactionsPage({ api = realApi }: { api?: AdminApi }) {
  const [q, setQ] = useState('');
  const [transactions, setTransactions] = useState<AdminTransaction[]>();
  const [total, setTotal] = useState(0);
  const [confirming, setConfirming] = useState<AdminTransaction>();

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
      {/* Server mode (onFilterChange): FilteredView debounces the typed
          filter into q, and the q effect above re-queries from offset 0 —
          no client-side filtering. Only mounted once the first page loads
          so its empty-list alert can't flash while loading. */}
      {transactions !== undefined && (
        <FilteredView items={shown} onFilterChange={(filter) => setQ(filter)}>
          {(filtered) => (
            <TableContainer component={Paper}>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Seq</TableCell>
                    <TableCell>Date</TableCell>
                    <TableCell>Type</TableCell>
                    <TableCell>State</TableCell>
                    <TableCell>From</TableCell>
                    <TableCell>To</TableCell>
                    <TableCell>Description</TableCell>
                    <TableCell align="right">Amount (minor units)</TableCell>
                    <TableCell align="right" />
                  </TableRow>
                </TableHead>
                <TableBody>
                  {filtered.map((tx) => (
                    <TableRow key={tx.id}>
                      <TableCell>{tx.seq ?? '—'}</TableCell>
                      <TableCell>{tx.createdAt.slice(0, 10)}</TableCell>
                      <TableCell>{tx.type}</TableCell>
                      <TableCell>
                        <Chip
                          label={tx.state}
                          size="small"
                          color={STATE_COLOURS[tx.state]}
                        />
                      </TableCell>
                      <TableCell>{legsOf(tx, -1)}</TableCell>
                      <TableCell>{legsOf(tx, 1)}</TableCell>
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
        </FilteredView>
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
