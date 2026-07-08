// Credit policies page (decision #3). CRUD-ish, but the Rafiki ListEditPage
// create-by-id flow doesn't fit server-assigned UUIDs, so a custom table
// with an enable/disable switch and an add dialog.
// LIMITATION: currency choices come from the admin's own accounts (see
// currencies.ts) — there is no public currencies endpoint yet.

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  MenuItem,
  Paper,
  Stack,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import {
  parseAmount,
  type CreditPolicyConfig,
  type CreditPolicyType,
  type Policy,
  type SoftThreshold,
} from '@silvio/ui-shared';
import { api as realApi, type AdminApi } from '../api';
import { useCurrencies } from '../currencies';
import { scaleFor } from '../money';

interface ThresholdRow {
  balance: string;
  level: string;
}

export function PoliciesPage({ api = realApi }: { api?: AdminApi }) {
  const [policies, setPolicies] = useState<Policy[]>();
  const currencies = useCurrencies(api);
  const currencyCode = useMemo(() => {
    const byId = new Map(currencies.map((c) => [c.id, c.code]));
    return (id: string) => byId.get(id) ?? id;
  }, [currencies]);

  // Add-policy dialog state
  const [adding, setAdding] = useState(false);
  const [currencyId, setCurrencyId] = useState('');
  const [type, setType] = useState<CreditPolicyType>('hard_limit');
  const [minBalance, setMinBalance] = useState('');
  const [maxBalance, setMaxBalance] = useState('');
  const [thresholds, setThresholds] = useState<ThresholdRow[]>([
    { balance: '', level: '' },
  ]);
  const [formError, setFormError] = useState<string>();

  const refresh = useCallback(async () => {
    const listed = await api.adminPolicies();
    if (listed !== undefined) setPolicies(listed);
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Default the dialog's currency once the (async) currency list arrives
  useEffect(() => {
    if (currencyId === '' && currencies.length > 0) {
      setCurrencyId(currencies[0]!.id);
    }
  }, [currencies, currencyId]);

  const setEnabled = async (policy: Policy, enabled: boolean) => {
    const updated = await api.adminPatchPolicy(policy.id, { enabled });
    if (updated !== undefined)
      setPolicies((list) => list?.map((p) => (p.id === policy.id ? updated : p)));
  };

  const openAdd = () => {
    setCurrencyId((id) => (id !== '' ? id : (currencies[0]?.id ?? '')));
    setType('hard_limit');
    setMinBalance('');
    setMaxBalance('');
    setThresholds([{ balance: '', level: '' }]);
    setFormError(undefined);
    setAdding(true);
  };

  /** Build the config from the form; throws RangeError on bad amounts. */
  const buildConfig = (): CreditPolicyConfig => {
    const scale = scaleFor(currencies, currencyId);
    if (type === 'hard_limit') {
      const config: CreditPolicyConfig = {};
      if (minBalance.trim() !== '')
        config.minBalance = parseAmount(minBalance, scale);
      if (maxBalance.trim() !== '')
        config.maxBalance = parseAmount(maxBalance, scale);
      if (config.minBalance === undefined && config.maxBalance === undefined) {
        throw new RangeError('a hard limit needs a min or max balance');
      }
      return config;
    }
    const rows = thresholds.filter(
      (t) => t.balance.trim() !== '' || t.level.trim() !== '',
    );
    if (rows.length === 0) {
      throw new RangeError('a soft threshold policy needs at least one threshold');
    }
    const parsed: SoftThreshold[] = rows.map((t) => {
      if (t.level.trim() === '') throw new RangeError('every threshold needs a level');
      return { balance: parseAmount(t.balance, scale), level: t.level.trim() };
    });
    return { thresholds: parsed };
  };

  const submit = async () => {
    let config: CreditPolicyConfig;
    try {
      if (currencyId === '') throw new RangeError('choose a currency');
      config = buildConfig();
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : String(cause));
      return;
    }
    const policy = await api.adminAddPolicy({ currencyId, type, config });
    if (policy !== undefined) {
      setAdding(false);
      await refresh();
    }
  };

  return (
    <Stack spacing={2} sx={{ marginTop: 2 }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center">
        <Typography variant="h5">Credit policies</Typography>
        <Button variant="contained" startIcon={<AddIcon />} onClick={openAdd}>
          Add policy
        </Button>
      </Stack>
      {policies !== undefined && policies.length === 0 && (
        <Typography color="text.secondary">
          No credit policies configured.
        </Typography>
      )}
      {policies !== undefined && policies.length > 0 && (
        <TableContainer component={Paper}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Type</TableCell>
                <TableCell>Currency</TableCell>
                <TableCell>Configuration</TableCell>
                <TableCell>Enabled</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {policies.map((policy) => (
                <TableRow key={policy.id}>
                  <TableCell>{policy.type}</TableCell>
                  <TableCell>{currencyCode(policy.currencyId)}</TableCell>
                  <TableCell>
                    <Typography
                      component="pre"
                      variant="body2"
                      sx={{ fontFamily: 'monospace', margin: 0 }}
                    >
                      {JSON.stringify(policy.config, null, 2)}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <Switch
                      checked={policy.enabled}
                      inputProps={{
                        'aria-label': `${policy.type} ${currencyCode(policy.currencyId)} enabled`,
                      }}
                      onChange={(e) => void setEnabled(policy, e.target.checked)}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      {/* Add-policy dialog */}
      <Dialog open={adding} onClose={() => setAdding(false)} fullWidth>
        <DialogTitle>Add policy</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ marginTop: 1 }}>
            <TextField
              select
              label="Currency"
              value={currencyId}
              onChange={(e) => setCurrencyId(e.target.value)}
              fullWidth
            >
              {currencies.map((c) => (
                <MenuItem key={c.id} value={c.id}>
                  {c.code}
                </MenuItem>
              ))}
            </TextField>
            <TextField
              select
              label="Type"
              value={type}
              onChange={(e) => setType(e.target.value as CreditPolicyType)}
              fullWidth
            >
              <MenuItem value="hard_limit">Hard limit</MenuItem>
              <MenuItem value="soft_threshold">Soft thresholds</MenuItem>
            </TextField>

            {type === 'hard_limit' && (
              <Stack direction="row" spacing={2}>
                <TextField
                  label="Min balance (max debit)"
                  value={minBalance}
                  onChange={(e) => setMinBalance(e.target.value)}
                  placeholder="-400.00"
                  fullWidth
                />
                <TextField
                  label="Max balance (max credit)"
                  value={maxBalance}
                  onChange={(e) => setMaxBalance(e.target.value)}
                  placeholder="400.00"
                  fullWidth
                />
              </Stack>
            )}

            {type === 'soft_threshold' &&
              thresholds.map((row, index) => (
                <Stack direction="row" spacing={2} key={index} alignItems="center">
                  <TextField
                    label="Balance"
                    value={row.balance}
                    onChange={(e) =>
                      setThresholds((rows) =>
                        rows.map((r, i) =>
                          i === index ? { ...r, balance: e.target.value } : r,
                        ),
                      )
                    }
                    placeholder="-200.00"
                    fullWidth
                  />
                  <TextField
                    label="Level"
                    value={row.level}
                    onChange={(e) =>
                      setThresholds((rows) =>
                        rows.map((r, i) =>
                          i === index ? { ...r, level: e.target.value } : r,
                        ),
                      )
                    }
                    placeholder="notice"
                    fullWidth
                  />
                  <IconButton
                    aria-label="remove threshold"
                    disabled={thresholds.length === 1}
                    onClick={() =>
                      setThresholds((rows) => rows.filter((_, i) => i !== index))
                    }
                  >
                    <DeleteIcon />
                  </IconButton>
                </Stack>
              ))}
            {type === 'soft_threshold' && (
              <Button
                startIcon={<AddIcon />}
                onClick={() =>
                  setThresholds((rows) => [...rows, { balance: '', level: '' }])
                }
              >
                Add threshold
              </Button>
            )}

            {formError !== undefined && <Alert severity="error">{formError}</Alert>}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setAdding(false)}>Cancel</Button>
          <Button variant="contained" onClick={() => void submit()}>
            Add
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
