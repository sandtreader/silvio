// Tokens: personal API tokens for connecting AI agents and other apps over
// MCP (decision #9). Tokens act as this membership with member-granted
// scopes; trade:autonomous is bounded by per-token caps set at grant time.
// The raw token appears exactly once, in the create dialog — never again.
import AddIcon from '@mui/icons-material/Add';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
import IconButton from '@mui/material/IconButton';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { formatAmount, parseAmount } from '@silvio/ui-shared';
import type {
  AccountSummary,
  ApiScope,
  ApiToken,
  CreateTokenInput,
} from '@silvio/ui-shared';
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../api/auth';
import { useClient } from '../api/client';
import { useFeedback } from '../api/feedback';
import { useApi } from '../api/useApi';
import { PageContainer } from '../components/PageContainer';
import { scaleOf } from '../scale';

// One-line explanations for the member-grantable scopes (decision #9).
// trade:autonomous is the deliberate extra step: it moves money within the
// caps without the usual pending -> confirm human act, so it reads as a
// warning and requires a per-transaction cap (the server enforces this too).
const SCOPES: { scope: ApiScope; description: string; warning?: boolean }[] = [
  { scope: 'marketplace:read', description: 'Browse offers and wants' },
  { scope: 'directory:read', description: 'See the member directory' },
  {
    scope: 'account:read',
    description: 'See your balances, statement and pending items',
  },
  { scope: 'listings:write', description: 'Post and update your own listings' },
  {
    scope: 'trade:request',
    description:
      'Propose payments and invoices — nothing moves until you confirm it here',
  },
  {
    scope: 'trade:autonomous',
    description:
      'Move money without asking you first, up to the caps below. Grant with care.',
    warning: true,
  },
];

/** "6 Jan 2027" — compact day-month-year, as elsewhere in the app. */
function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

export function Tokens() {
  const client = useClient();
  const { me } = useAuth();
  const { run } = useApi();
  const [tokens, setTokens] = useState<ApiToken[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<ApiToken | null>(null);

  const load = useCallback(async () => {
    const result = await run(() => client.myTokens());
    if (result !== undefined) setTokens(result.tokens);
  }, [client, run]);

  useEffect(() => {
    void load();
  }, [load]);

  if (me === null) return null;
  const account = me.accounts[0];

  const active = tokens?.filter((token) => token.revokedAt === undefined) ?? [];
  const revoked = tokens?.filter((token) => token.revokedAt !== undefined) ?? [];

  return (
    <PageContainer title="API tokens">
      <Typography color="text.secondary" sx={{ mb: 2 }}>
        Tokens let AI agents and other apps connect to your account over MCP —
        grant each one only the scopes it needs, and revoke it here any time.
      </Typography>

      {tokens === null ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', mt: 4 }}>
          <CircularProgress />
        </Box>
      ) : (
        <>
          {active.length === 0 && revoked.length === 0 && (
            <Typography color="text.secondary" sx={{ mb: 2 }}>
              No tokens yet.
            </Typography>
          )}
          {active.map((token) => (
            <TokenCard
              key={token.id}
              token={token}
              account={account}
              onRevoke={() => setRevoking(token)}
            />
          ))}
          {revoked.length > 0 && (
            <>
              <Typography variant="h6" sx={{ mb: 1, mt: 2 }}>
                Revoked tokens
              </Typography>
              {revoked.map((token) => (
                <TokenCard key={token.id} token={token} account={account} />
              ))}
            </>
          )}
        </>
      )}

      <Button
        variant="contained"
        startIcon={<AddIcon />}
        onClick={() => setCreating(true)}
        sx={{ mt: 1 }}
      >
        New token
      </Button>

      <CreateTokenDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={() => void load()}
        account={account}
      />
      <RevokeTokenDialog
        token={revoking}
        onClose={() => setRevoking(null)}
        onRevoked={() => {
          setRevoking(null);
          void load();
        }}
      />
    </PageContainer>
  );
}

/** One token: label, scope chips, dates and caps; greyed once revoked. */
function TokenCard({
  token,
  account,
  onRevoke,
}: {
  token: ApiToken;
  account: AccountSummary | undefined;
  onRevoke?: () => void;
}) {
  const scale = scaleOf(account);
  const unit = account === undefined ? '' : ` ${account.currencyCode}`;
  const isRevoked = token.revokedAt !== undefined;

  const caps: string[] = [];
  if (token.maxTxAmount !== undefined) {
    caps.push(`${formatAmount(token.maxTxAmount, scale)}${unit} per transaction`);
  }
  if (token.maxPeriodAmount !== undefined && token.periodDays !== undefined) {
    caps.push(
      `${formatAmount(token.maxPeriodAmount, scale)}${unit} per ${token.periodDays} days`,
    );
  }

  return (
    <Card sx={{ mb: 2, opacity: isRevoked ? 0.6 : 1 }}>
      <CardContent>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 600, flexGrow: 1 }}>
            {token.label}
          </Typography>
          {isRevoked ? (
            <Chip size="small" label="Revoked" />
          ) : (
            onRevoke && (
              <Button size="small" color="error" onClick={onRevoke}>
                Revoke
              </Button>
            )
          )}
        </Stack>
        <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" sx={{ mb: 1 }}>
          {token.scopes.map((scope) => (
            <Chip
              key={scope}
              size="small"
              label={scope}
              color={scope === 'trade:autonomous' ? 'warning' : 'default'}
            />
          ))}
        </Stack>
        {caps.length > 0 && (
          <Typography variant="body2" color="text.secondary">
            Caps: {caps.join(' · ')}
          </Typography>
        )}
        <Typography variant="body2" color="text.secondary">
          Created {formatDate(token.createdAt)}
          {token.lastUsedAt !== undefined
            ? ` · Last used ${formatDate(token.lastUsedAt)}`
            : ' · Never used'}
          {token.expiresAt !== undefined && ` · Expires ${formatDate(token.expiresAt)}`}
        </Typography>
      </CardContent>
    </Card>
  );
}

function RevokeTokenDialog({
  token,
  onClose,
  onRevoked,
}: {
  token: ApiToken | null;
  onClose: () => void;
  onRevoked: () => void;
}) {
  const client = useClient();
  const { run, busy } = useApi();
  const feedback = useFeedback();

  const revoke = async () => {
    if (token === null) return;
    const result = await run(() => client.revokeToken(token.id));
    if (result !== undefined) {
      feedback.show('Token revoked', 'success');
      onRevoked();
    }
  };

  return (
    <Dialog open={token !== null} onClose={onClose} fullWidth>
      <DialogTitle>Revoke token?</DialogTitle>
      <DialogContent>
        <DialogContentText>
          Anything connected with “{token?.label}” will stop working immediately.
          This cannot be undone.
        </DialogContentText>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          color="error"
          variant="contained"
          disabled={busy}
          onClick={() => void revoke()}
        >
          Revoke token
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function CreateTokenDialog({
  open,
  onClose,
  onCreated,
  account,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
  account: AccountSummary | undefined;
}) {
  const client = useClient();
  const { run, busy } = useApi();
  const feedback = useFeedback();
  const [label, setLabel] = useState('');
  const [scopes, setScopes] = useState<ApiScope[]>([]);
  const [maxTxText, setMaxTxText] = useState('');
  const [maxPeriodText, setMaxPeriodText] = useState('');
  const [periodDaysText, setPeriodDaysText] = useState('30');
  const [expiryDate, setExpiryDate] = useState(''); // yyyy-mm-dd or ''
  const [capError, setCapError] = useState<string | null>(null);
  // The raw token, present only between creation and dialog close — the one
  // and only time it is ever visible (the server stores a hash).
  const [rawToken, setRawToken] = useState<string | null>(null);

  const scale = scaleOf(account);
  const unit = account === undefined ? '' : ` (${account.currencyCode})`;

  const toggleScope = (scope: ApiScope, checked: boolean) => {
    // Keep SCOPES order so the request is stable regardless of click order.
    setScopes((current) => {
      const next = new Set(current);
      if (checked) next.add(scope);
      else next.delete(scope);
      return SCOPES.map((entry) => entry.scope).filter((candidate) =>
        next.has(candidate),
      );
    });
  };

  const reset = () => {
    setLabel('');
    setScopes([]);
    setMaxTxText('');
    setMaxPeriodText('');
    setPeriodDaysText('30');
    setExpiryDate('');
    setCapError(null);
    setRawToken(null);
  };

  const close = () => {
    reset(); // discards the raw token for good
    onClose();
  };

  // trade:autonomous must carry a per-transaction cap (decision #9); the
  // rolling cap needs both an amount and a period. Mirror the server's rules
  // so the button only enables for requests that can succeed.
  const autonomous = scopes.includes('trade:autonomous');
  const incomplete =
    label.trim() === '' ||
    scopes.length === 0 ||
    (autonomous && maxTxText.trim() === '') ||
    (maxPeriodText.trim() !== '' && periodDaysText.trim() === '');

  const submit = async () => {
    const input: CreateTokenInput = { label: label.trim(), scopes };
    try {
      if (maxTxText.trim() !== '') {
        input.maxTxAmount = parseAmount(maxTxText, scale);
      }
      if (maxPeriodText.trim() !== '') {
        input.maxPeriodAmount = parseAmount(maxPeriodText, scale);
        input.periodDays = Number(periodDaysText);
      }
    } catch (error) {
      setCapError(error instanceof Error ? error.message : String(error));
      return;
    }
    setCapError(null);
    if (expiryDate !== '') {
      // Expiry is a calendar date to the member; make it end-of-day UTC.
      input.expiresAt = new Date(`${expiryDate}T23:59:59Z`).toISOString();
    }
    const result = await run(() => client.createToken(input));
    if (result !== undefined) {
      setRawToken(result.token);
      onCreated();
    }
  };

  const copy = () => {
    if (rawToken === null) return;
    void navigator.clipboard?.writeText(rawToken);
    feedback.show('Token copied', 'success');
  };

  if (rawToken !== null) {
    // Post-create phase: show the raw value once, then it is gone forever.
    return (
      <Dialog open={open} onClose={close} fullWidth>
        <DialogTitle>Token created</DialogTitle>
        <DialogContent>
          <Alert severity="warning" sx={{ mb: 2 }}>
            Copy this token now — you won’t see it again.
          </Alert>
          <Stack direction="row" spacing={1} alignItems="center">
            <Box
              component="code"
              sx={{
                fontFamily: 'monospace',
                fontSize: '0.85rem',
                wordBreak: 'break-all',
                bgcolor: 'action.hover',
                borderRadius: 1,
                p: 1,
                flexGrow: 1,
              }}
            >
              {rawToken}
            </Box>
            <IconButton aria-label="copy token" onClick={copy}>
              <ContentCopyIcon />
            </IconButton>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button variant="contained" onClick={close}>
            Done
          </Button>
        </DialogActions>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onClose={close} fullWidth>
      <DialogTitle>New token</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <TextField
            label="Label"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            required
            placeholder="e.g. Claude via MCP"
          />
          <Box>
            <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
              Scopes
            </Typography>
            {SCOPES.map(({ scope, description, warning }) => (
              <FormControlLabel
                key={scope}
                sx={{ display: 'flex', alignItems: 'flex-start', mb: 1 }}
                control={
                  <Checkbox
                    size="small"
                    checked={scopes.includes(scope)}
                    onChange={(_event, checked) => toggleScope(scope, checked)}
                    sx={{ pt: 0 }}
                  />
                }
                label={
                  <Box>
                    <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
                      {scope}
                    </Typography>
                    <Typography
                      variant="caption"
                      color={warning === true ? 'warning.main' : 'text.secondary'}
                    >
                      {description}
                    </Typography>
                  </Box>
                }
              />
            ))}
          </Box>
          <TextField
            label={`Max per transaction${unit}`}
            value={maxTxText}
            onChange={(event) => setMaxTxText(event.target.value)}
            required={autonomous}
            error={capError !== null}
            helperText={
              capError ??
              (autonomous
                ? 'Required for trade:autonomous'
                : 'Optional spending cap')
            }
            slotProps={{ htmlInput: { inputMode: 'decimal' } }}
          />
          <Stack direction="row" spacing={2}>
            <TextField
              label={`Max per period${unit}`}
              value={maxPeriodText}
              onChange={(event) => setMaxPeriodText(event.target.value)}
              helperText="Optional rolling cap"
              slotProps={{ htmlInput: { inputMode: 'decimal' } }}
              sx={{ flexGrow: 1 }}
            />
            <TextField
              label="Period (days)"
              value={periodDaysText}
              onChange={(event) => setPeriodDaysText(event.target.value)}
              disabled={maxPeriodText.trim() === ''}
              slotProps={{ htmlInput: { inputMode: 'numeric' } }}
              sx={{ width: 120 }}
            />
          </Stack>
          <TextField
            label="Expires (optional)"
            type="date"
            value={expiryDate}
            onChange={(event) => setExpiryDate(event.target.value)}
            slotProps={{ inputLabel: { shrink: true } }}
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={close}>Cancel</Button>
        <Button
          variant="contained"
          onClick={() => void submit()}
          disabled={busy || incomplete}
        >
          Create token
        </Button>
      </DialogActions>
    </Dialog>
  );
}
