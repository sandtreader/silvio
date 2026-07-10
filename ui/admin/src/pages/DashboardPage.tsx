// Admin dashboard (plan.md): the group's health at a glance for one currency —
// per-member balance distribution (published balances are part of the CamLETS
// culture, decision #3), monthly trade flow, velocity and dormant members.
// The charts are hand-rolled MUI boxes: two colours and a dozen bars do not
// justify a chart library.

import { useEffect, useState } from 'react';
import {
  Box,
  Card,
  CardContent,
  List,
  ListItem,
  ListItemText,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { formatAmount, type AdminStats } from '@silvio/ui-shared';
import { api as realApi, type AdminApi } from '../api';
import { useCurrencies } from '../currencies';
import { scaleFor } from '../money';

/** The 'YYYY-MM' key of the month `offset` calendar months before now. */
export function monthsBack(offset: number): string {
  const now = new Date();
  const then = new Date(now.getFullYear(), now.getMonth() - offset, 1);
  return `${then.getFullYear()}-${String(then.getMonth() + 1).padStart(2, '0')}`;
}

/** Short month name for a 'YYYY-MM' key, e.g. 'Jul'. */
function monthLabel(key: string): string {
  const [year, month] = key.split('-').map(Number);
  return new Date(year!, month! - 1, 1).toLocaleString(undefined, {
    month: 'short',
  });
}

/** The server omits months with no trades; project the flow onto the last
 *  twelve calendar months so the axis is continuous. */
function twelveMonthFlow(flow: AdminStats['flow']): AdminStats['flow'] {
  const byMonth = new Map(flow.map((entry) => [entry.month, entry]));
  return Array.from({ length: 12 }, (_, i) => {
    const month = monthsBack(11 - i);
    return byMonth.get(month) ?? { month, volume: 0, trades: 0 };
  });
}

/** One horizontal bar per member around a zero axis: debits left in red,
 *  credits right in green, direct-labelled with name and amount so the
 *  colour never carries the meaning alone. */
function BalanceBars({
  balances,
  scale,
}: {
  balances: AdminStats['balances'];
  scale: number;
}) {
  if (balances.length === 0) {
    return (
      <Typography color="text.secondary">
        No balances yet — nobody holds this currency.
      </Typography>
    );
  }
  const maxAbs = Math.max(1, ...balances.map((b) => Math.abs(b.balance)));
  return (
    <Stack spacing={0.5}>
      {balances.map(({ memberId, displayName, balance }) => {
        const amount = formatAmount(balance, scale);
        const width = `${(Math.abs(balance) / maxAbs) * 100}%`;
        return (
          <Stack key={memberId} direction="row" spacing={1} alignItems="center">
            <Typography
              variant="body2"
              noWrap
              sx={{ width: 160, flexShrink: 0, textAlign: 'right' }}
            >
              {displayName}
            </Typography>
            <Box
              role="img"
              aria-label={`${displayName}: balance ${amount}`}
              sx={{ flex: 1, display: 'flex', height: 14 }}
            >
              <Box
                sx={{
                  width: '50%',
                  display: 'flex',
                  justifyContent: 'flex-end',
                  borderRight: 1,
                  borderColor: 'divider',
                }}
              >
                {balance < 0 && (
                  <Box
                    sx={{
                      width,
                      bgcolor: 'error.main',
                      borderRadius: '4px 0 0 4px',
                    }}
                  />
                )}
              </Box>
              <Box sx={{ width: '50%' }}>
                {balance > 0 && (
                  <Box
                    sx={{
                      width,
                      height: '100%',
                      bgcolor: 'success.main',
                      borderRadius: '0 4px 4px 0',
                    }}
                  />
                )}
              </Box>
            </Box>
            <Typography
              variant="body2"
              sx={{ width: 96, flexShrink: 0, textAlign: 'right' }}
            >
              {amount}
            </Typography>
          </Stack>
        );
      })}
    </Stack>
  );
}

/** Vertical volume bars for the last twelve months; the exact volume shows
 *  on hover, the trade count sits under each month label. */
function FlowChart({
  flow,
  scale,
}: {
  flow: AdminStats['flow'];
  scale: number;
}) {
  if (flow.every((month) => month.trades === 0)) {
    return (
      <Typography color="text.secondary">
        No trades in the last 12 months.
      </Typography>
    );
  }
  const maxVolume = Math.max(1, ...flow.map((m) => m.volume));
  return (
    <Box sx={{ display: 'flex', gap: 1 }}>
      {flow.map(({ month, volume, trades }) => {
        const title = `${month}: volume ${formatAmount(volume, scale)}, ${trades} trade${
          trades === 1 ? '' : 's'
        }`;
        return (
          <Stack key={month} alignItems="center" sx={{ flex: 1, minWidth: 0 }}>
            <Box
              role="img"
              aria-label={title}
              title={title}
              sx={{
                width: '100%',
                height: 120,
                display: 'flex',
                alignItems: 'flex-end',
                justifyContent: 'center',
                borderBottom: 1,
                borderColor: 'divider',
              }}
            >
              <Box
                sx={{
                  width: '70%',
                  height: `${(volume / maxVolume) * 100}%`,
                  bgcolor: 'primary.main',
                  borderRadius: '4px 4px 0 0',
                }}
              />
            </Box>
            <Typography variant="caption">{monthLabel(month)}</Typography>
            <Typography variant="caption" color="text.secondary">
              {trades}
            </Typography>
          </Stack>
        );
      })}
    </Box>
  );
}

export function DashboardPage({ api = realApi }: { api?: AdminApi }) {
  const currencies = useCurrencies(api);
  const [currencyId, setCurrencyId] = useState('');
  const [stats, setStats] = useState<AdminStats>();
  const scale = scaleFor(currencies, currencyId);

  // Default to the first currency once known
  useEffect(() => {
    if (currencyId === '' && currencies.length > 0) {
      setCurrencyId(currencies[0]!.id);
    }
  }, [currencies, currencyId]);

  // Load stats whenever the currency changes
  useEffect(() => {
    if (currencyId === '') return;
    let cancelled = false;
    setStats(undefined);
    void api.adminStats(currencyId).then((result) => {
      if (!cancelled && result !== undefined) setStats(result);
    });
    return () => {
      cancelled = true;
    };
  }, [api, currencyId]);

  return (
    <Stack spacing={3} sx={{ marginTop: 2, maxWidth: 840 }}>
      <Typography variant="h5">Dashboard</Typography>
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

      {stats !== undefined && (
        <>
          <Stack spacing={1}>
            <Typography variant="h6">Balance distribution</Typography>
            <BalanceBars balances={stats.balances} scale={scale} />
          </Stack>

          <Stack spacing={1}>
            <Typography variant="h6">Currency flow (12 months)</Typography>
            <FlowChart flow={twelveMonthFlow(stats.flow)} scale={scale} />
          </Stack>

          <Card variant="outlined" sx={{ maxWidth: 320 }}>
            <CardContent>
              <Typography variant="overline" color="text.secondary">
                Velocity
              </Typography>
              <Typography variant="h4">
                {stats.velocity.toFixed(2)}×/30d
              </Typography>
              <Typography variant="body2" color="text.secondary">
                30-day trade volume as a share of the positive money supply.
              </Typography>
            </CardContent>
          </Card>

          <Stack spacing={1}>
            <Typography variant="h6">Dormant members</Typography>
            {stats.dormant.length === 0 ? (
              <Typography color="text.secondary">
                No dormant members — everyone is trading.
              </Typography>
            ) : (
              <List aria-label="Dormant members" dense disablePadding>
                {stats.dormant.map(({ memberId, displayName, lastTradeAt }) => (
                  <ListItem key={memberId} disableGutters>
                    <ListItemText
                      primary={displayName}
                      secondary={
                        lastTradeAt === undefined
                          ? 'never traded'
                          : `last trade ${new Date(lastTradeAt).toLocaleDateString()}`
                      }
                    />
                  </ListItem>
                ))}
              </List>
            )}
          </Stack>
        </>
      )}
    </Stack>
  );
}
