// Home: a balance card per account, pending-action chip, last five
// statement lines from the first account.
import PendingActionsIcon from '@mui/icons-material/PendingActions';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemText from '@mui/material/ListItemText';
import Typography from '@mui/material/Typography';
import { formatAmount } from '@silvio/ui-shared';
import type { StatementLine } from '@silvio/ui-shared';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { useAuth } from '../api/auth';
import { useClient } from '../api/client';
import { useApi } from '../api/useApi';
import { PageContainer } from '../components/PageContainer';
import { scaleOf } from '../scale';

export function Home() {
  const { me } = useAuth();
  const client = useClient();
  const { run } = useApi();
  const navigate = useNavigate();
  const [lines, setLines] = useState<StatementLine[] | null>(null);
  const [pendingCount, setPendingCount] = useState(0);
  const firstCurrencyId = me?.accounts[0]?.currencyId;

  useEffect(() => {
    void run(() => client.pending()).then((result) => {
      if (result !== undefined) setPendingCount(result.pending.length);
    });
  }, [client, run]);

  useEffect(() => {
    if (firstCurrencyId === undefined) {
      setLines([]);
      return;
    }
    void run(() => client.statement(firstCurrencyId)).then((result) => {
      if (result !== undefined) setLines(result.lines.slice(-5).reverse());
    });
  }, [client, run, firstCurrencyId]);

  if (me === null) return null;

  return (
    <PageContainer title={`Hello, ${me.member.displayName}`}>
      {me.accounts.map((account) => (
        <Card key={account.id} sx={{ mb: 2 }}>
          <CardContent>
            <Typography variant="overline" color="text.secondary">
              {account.currencyCode} balance
            </Typography>
            <Typography variant="h4">
              {formatAmount(account.balance, account.scale)}
            </Typography>
          </CardContent>
        </Card>
      ))}
      {me.accounts.length === 0 && (
        <Typography color="text.secondary" sx={{ mb: 2 }}>
          No accounts yet.
        </Typography>
      )}

      {pendingCount > 0 && (
        <Box sx={{ mb: 2 }}>
          <Chip
            icon={<PendingActionsIcon />}
            color="warning"
            label={`${pendingCount} pending action${pendingCount === 1 ? '' : 's'}`}
            onClick={() => void navigate('/activity')}
          />
        </Box>
      )}

      <Typography variant="h6" sx={{ mb: 1 }}>
        Recent activity
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
              <Typography
                color={line.amount < 0 ? 'error.main' : 'success.main'}
              >
                {formatAmount(line.amount, scaleOf(me.accounts[0]))}
              </Typography>
            </ListItem>
          ))}
        </List>
      )}
    </PageContainer>
  );
}
