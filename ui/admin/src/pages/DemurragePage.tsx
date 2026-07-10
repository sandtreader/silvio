// Demurrage bands page (decision #1): per-currency marginal bands, edited as
// a small table of {from balance, % per month} and saved as a whole — the
// server replaces the band list atomically (PUT).

import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Chip,
  IconButton,
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
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import {
  formatAmount,
  parseAmount,
  type DemurrageBand,
  type DemurrageRun,
} from '@silvio/ui-shared';
import { api as realApi, type AdminApi } from '../api';
import { useCurrencies } from '../currencies';
import { scaleFor } from '../money';

// Rates are parts-per-million per month on the wire; presented as % with up
// to four decimal places (1 ppm = 0.0001 %), converted with the shared
// integer-exact parse/format (never float multiplication).
const RATE_SCALE = 4;

interface BandRow {
  fromAmount: string;
  ratePct: string;
}

function toRow(band: DemurrageBand, scale: number): BandRow {
  return {
    fromAmount: formatAmount(band.fromAmount, scale),
    ratePct: formatAmount(band.ratePpmPerMonth, RATE_SCALE),
  };
}

function toBand(row: BandRow, scale: number): DemurrageBand {
  return {
    fromAmount: parseAmount(row.fromAmount, scale),
    ratePpmPerMonth: parseAmount(row.ratePct, RATE_SCALE),
  };
}

export function DemurragePage({ api = realApi }: { api?: AdminApi }) {
  const currencies = useCurrencies(api);
  const [currencyId, setCurrencyId] = useState('');
  const [rows, setRows] = useState<BandRow[]>();
  const [runs, setRuns] = useState<DemurrageRun[]>();
  const [formError, setFormError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const scale = scaleFor(currencies, currencyId);

  // Default to the first currency once known
  useEffect(() => {
    if (currencyId === '' && currencies.length > 0) {
      setCurrencyId(currencies[0]!.id);
    }
  }, [currencies, currencyId]);

  // Load bands whenever the currency changes
  useEffect(() => {
    if (currencyId === '') return;
    let cancelled = false;
    setRows(undefined);
    setFormError(undefined);
    setSaved(false);
    void api.adminGetBands(currencyId).then((bands) => {
      if (!cancelled && bands !== undefined)
        setRows(bands.map((band) => toRow(band, scale)));
    });
    return () => {
      cancelled = true;
    };
  }, [api, currencyId, scale]);

  // Run history, newest first (group-wide, so loaded once)
  useEffect(() => {
    let cancelled = false;
    void api.adminRuns().then((result) => {
      if (!cancelled && result !== undefined) setRuns(result);
    });
    return () => {
      cancelled = true;
    };
  }, [api]);

  const update = (index: number, patch: Partial<BandRow>) => {
    setSaved(false);
    setRows((r) => r?.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };

  const save = async () => {
    if (rows === undefined) return;
    let bands: DemurrageBand[];
    try {
      bands = rows.map((row) => toBand(row, scale));
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : String(cause));
      return;
    }
    setFormError(undefined);
    const result = await api.adminSetBands(currencyId, bands);
    if (result !== undefined) {
      setRows(result.map((band) => toRow(band, scale)));
      setSaved(true);
    }
  };

  return (
    <Stack spacing={2} sx={{ marginTop: 2, maxWidth: 640 }}>
      <Typography variant="h5">Demurrage bands</Typography>
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

      {rows !== undefined && (
        <TableContainer component={Paper}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>From balance</TableCell>
                <TableCell>Rate (% per month)</TableCell>
                <TableCell align="right" />
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((row, index) => (
                <TableRow key={index}>
                  <TableCell>
                    <TextField
                      size="small"
                      value={row.fromAmount}
                      inputProps={{ 'aria-label': `band ${index + 1} from balance` }}
                      onChange={(e) => update(index, { fromAmount: e.target.value })}
                    />
                  </TableCell>
                  <TableCell>
                    <TextField
                      size="small"
                      value={row.ratePct}
                      inputProps={{ 'aria-label': `band ${index + 1} rate` }}
                      onChange={(e) => update(index, { ratePct: e.target.value })}
                    />
                  </TableCell>
                  <TableCell align="right">
                    <IconButton
                      aria-label={`remove band ${index + 1}`}
                      onClick={() => {
                        setSaved(false);
                        setRows((r) => r?.filter((_, i) => i !== index));
                      }}
                    >
                      <DeleteIcon />
                    </IconButton>
                  </TableCell>
                </TableRow>
              ))}
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={3}>
                    <Typography color="text.secondary">
                      No bands: no demurrage is charged for this currency.
                    </Typography>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      {rows !== undefined && (
        <Stack direction="row" spacing={2}>
          <Button
            startIcon={<AddIcon />}
            onClick={() => {
              setSaved(false);
              setRows((r) => [...(r ?? []), { fromAmount: '', ratePct: '' }]);
            }}
          >
            Add band
          </Button>
          <Button variant="contained" onClick={() => void save()}>
            Save
          </Button>
        </Stack>
      )}

      {formError !== undefined && <Alert severity="error">{formError}</Alert>}
      {saved && <Alert severity="success">Bands saved.</Alert>}

      {runs !== undefined && (
        <>
          <Typography variant="h6">Run history</Typography>
          <TableContainer component={Paper}>
            <Table size="small" aria-label="run history">
              <TableHead>
                <TableRow>
                  <TableCell>Period</TableCell>
                  <TableCell>Status</TableCell>
                  <TableCell>Started</TableCell>
                  <TableCell>Completed</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {runs.map((run) => (
                  <TableRow key={run.id}>
                    <TableCell>{run.period}</TableCell>
                    <TableCell>
                      <Chip
                        label={run.status}
                        size="small"
                        color={run.status === 'completed' ? 'success' : 'warning'}
                      />
                    </TableCell>
                    <TableCell>{new Date(run.startedAt).toLocaleString()}</TableCell>
                    <TableCell>
                      {run.completedAt === undefined
                        ? '—'
                        : new Date(run.completedAt).toLocaleString()}
                    </TableCell>
                  </TableRow>
                ))}
                {runs.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={4}>
                      <Typography color="text.secondary">No runs yet.</Typography>
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </TableContainer>
        </>
      )}
    </Stack>
  );
}
