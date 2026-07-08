// Activity: pending transactions with their accept/decline/cancel actions
// (decision #5), then the full statement with running balance.
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import CircularProgress from '@mui/material/CircularProgress';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemText from '@mui/material/ListItemText';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { formatAmount } from '@silvio/ui-shared';
import type { PendingItem, StatementLine, TxAction } from '@silvio/ui-shared';
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../api/auth';
import { useClient } from '../api/client';
import { useFeedback } from '../api/feedback';
import { useApi } from '../api/useApi';
import { PageContainer } from '../components/PageContainer';
import { scaleOf } from '../scale';

const ACTION_LABELS: Record<TxAction, string> = {
  accept: 'Accept',
  decline: 'Decline',
  cancel: 'Cancel',
};

export function Activity() {
  const client = useClient();
  const { me } = useAuth();
  const { run, busy } = useApi();
  const feedback = useFeedback();
  const [pending, setPending] = useState<PendingItem[] | null>(null);
  const [lines, setLines] = useState<StatementLine[] | null>(null);
  const firstCurrencyId = me?.accounts[0]?.currencyId;
  const scale = scaleOf(me?.accounts[0]);

  const load = useCallback(async () => {
    const pendingResult = await run(() => client.pending());
    if (pendingResult !== undefined) setPending(pendingResult.pending);
    if (firstCurrencyId === undefined) {
      setLines([]);
      return;
    }
    const statementResult = await run(() => client.statement(firstCurrencyId));
    if (statementResult !== undefined) {
      setLines([...statementResult.lines].reverse());
    }
  }, [client, run, firstCurrencyId]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (id: string, action: TxAction) => {
    const result = await run(() => client.txAction(id, action));
    if (result !== undefined) {
      feedback.show(`${ACTION_LABELS[action]}ed`, 'success');
      await load();
    }
  };

  return (
    <PageContainer title="Activity">
      <Typography variant="h6" sx={{ mb: 1 }}>
        Pending
      </Typography>
      {pending === null ? (
        <CircularProgress size={24} />
      ) : pending.length === 0 ? (
        <Typography color="text.secondary" sx={{ mb: 2 }}>
          Nothing waiting on you.
        </Typography>
      ) : (
        pending.map((item) => (
          <Card key={item.id} sx={{ mb: 2 }}>
            <CardContent>
              <Stack direction="row" justifyContent="space-between">
                <Typography sx={{ fontWeight: 600 }}>
                  {item.direction === 'in' ? 'Incoming' : 'Outgoing'}{' '}
                  {item.flow ?? item.type}
                </Typography>
                <Typography sx={{ fontWeight: 600 }}>
                  {item.direction === 'in' ? '+' : '-'}
                  {formatAmount(item.amount, scale)}
                </Typography>
              </Stack>
              {item.description !== undefined && (
                <Typography variant="body2" color="text.secondary">
                  {item.description}
                </Typography>
              )}
              <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
                {item.actions.map((action) => (
                  <Button
                    key={action}
                    size="small"
                    variant={action === 'accept' ? 'contained' : 'outlined'}
                    color={action === 'accept' ? 'primary' : 'inherit'}
                    disabled={busy}
                    onClick={() => void act(item.id, action)}
                  >
                    {ACTION_LABELS[action]}
                  </Button>
                ))}
              </Stack>
            </CardContent>
          </Card>
        ))
      )}

      <Typography variant="h6" sx={{ mt: 3, mb: 1 }}>
        Statement
      </Typography>
      {lines === null ? (
        <CircularProgress size={24} />
      ) : lines.length === 0 ? (
        <Typography color="text.secondary">No transactions yet.</Typography>
      ) : (
        <List dense disablePadding>
          {lines.map((line) => (
            <ListItem key={line.seq} disableGutters divider>
              <ListItemText
                primary={line.description ?? line.type}
                secondary={new Date(line.committedAt).toLocaleDateString()}
              />
              <Box sx={{ textAlign: 'right' }}>
                <Typography
                  color={line.amount < 0 ? 'error.main' : 'success.main'}
                >
                  {formatAmount(line.amount, scale)}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  bal {formatAmount(line.runningBalance, scale)}
                </Typography>
              </Box>
            </ListItem>
          ))}
        </List>
      )}
    </PageContainer>
  );
}
