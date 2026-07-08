// Transactions admin page: reversal by transaction id (decision #5/#6 —
// committed entries are immutable; a reversal is a compensating transaction
// linked via reversesId).
// LIMITATION: the server has no admin transaction list/search endpoint yet,
// so the id must be pasted from a statement or elsewhere (server gap).

import { useState } from 'react';
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import UndoIcon from '@mui/icons-material/Undo';
import type { Transaction } from '@silvio/ui-shared';
import { api as realApi, type AdminApi } from '../api';

export function TransactionsPage({ api = realApi }: { api?: AdminApi }) {
  const [txId, setTxId] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<Transaction>();

  const reverse = async () => {
    setConfirming(false);
    const transaction = await api.adminReverse(txId.trim());
    if (transaction !== undefined) {
      setResult(transaction);
      setTxId('');
    }
  };

  return (
    <Stack spacing={2} sx={{ marginTop: 2, maxWidth: 640 }}>
      <Typography variant="h5">Transactions</Typography>
      <Typography color="text.secondary">
        Reverse a committed transaction by id: a compensating transaction is
        posted, the original is never altered. There is no transaction search
        here yet — paste the id from a member statement.
      </Typography>
      <TextField
        label="Transaction id"
        value={txId}
        onChange={(e) => {
          setTxId(e.target.value);
          setResult(undefined);
        }}
        fullWidth
      />
      <Stack direction="row">
        <Button
          variant="contained"
          color="error"
          startIcon={<UndoIcon />}
          disabled={txId.trim() === ''}
          onClick={() => setConfirming(true)}
        >
          Reverse
        </Button>
      </Stack>
      {result !== undefined && (
        <Alert severity="success">
          Reversal posted: transaction {result.id} ({result.state}), reverses{' '}
          {result.reversesId}.
        </Alert>
      )}

      <Dialog open={confirming} onClose={() => setConfirming(false)}>
        <DialogTitle>Reverse transaction?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Posts a compensating transaction undoing every leg of{' '}
            <code>{txId.trim()}</code>. The original stays on the ledger. This
            cannot itself be undone except by another reversal.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirming(false)}>Cancel</Button>
          <Button color="error" variant="contained" onClick={() => void reverse()}>
            Reverse
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
