// Group balances (#19): every member's balance and 12-month turnover, when
// the group publishes them (settings.transparency). The server 404s when it
// doesn't, so this page turns that into a friendly explanation rather than
// an error snackbar. Reached from More, like /tokens — not a tab.
import CircularProgress from '@mui/material/CircularProgress';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import { ApiError, formatAmount } from '@silvio/ui-shared';
import type { GroupBalance } from '@silvio/ui-shared';
import { useEffect, useState } from 'react';
import { useAuth } from '../api/auth';
import { useClient } from '../api/client';
import { PageContainer } from '../components/PageContainer';
import { scaleForCurrency } from '../scale';

export function Balances() {
  const client = useClient();
  const { me } = useAuth();
  const accounts = me?.accounts ?? [];
  // The /me account summaries are the member's currencies (one account per
  // currency); a picker only appears when there is more than one. Derived,
  // not initial state: /me may still be loading on first render.
  const [picked, setPicked] = useState<string>();
  const currencyId = picked ?? accounts[0]?.currencyId;
  const [rows, setRows] = useState<GroupBalance[] | null>(null);
  // 404 = the group doesn't publish balances (#19), not a failure.
  const [unpublished, setUnpublished] = useState(false);

  useEffect(() => {
    if (currencyId === undefined) return;
    setRows(null);
    void client.groupBalances(currencyId).then(
      (result) => setRows(result.balances),
      (error: unknown) => {
        if (!(error instanceof ApiError)) throw error;
        setUnpublished(true);
      },
    );
  }, [client, currencyId]);

  if (me === null) return null;
  const scale = scaleForCurrency(me.accounts, currencyId);

  return (
    <PageContainer title="Group balances">
      {unpublished ? (
        <Typography color="text.secondary">
          This group doesn&apos;t publish balances.
        </Typography>
      ) : (
        <>
          {accounts.length > 1 && (
            <ToggleButtonGroup
              exclusive
              size="small"
              value={currencyId}
              onChange={(_event, value: string | null) => {
                if (value !== null) setPicked(value);
              }}
              aria-label="Currency"
              sx={{ mb: 2 }}
            >
              {accounts.map((account) => (
                <ToggleButton key={account.currencyId} value={account.currencyId}>
                  {account.currencyCode}
                </ToggleButton>
              ))}
            </ToggleButtonGroup>
          )}
          {rows === null ? (
            <CircularProgress size={24} />
          ) : (
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Member</TableCell>
                  <TableCell align="right">Balance</TableCell>
                  <TableCell align="right">Turnover (12m)</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.memberId}>
                    <TableCell>{row.displayName}</TableCell>
                    <TableCell align="right">
                      {formatAmount(row.balance, scale)}
                    </TableCell>
                    <TableCell align="right">
                      {formatAmount(row.turnover, scale)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </>
      )}
    </PageContainer>
  );
}
