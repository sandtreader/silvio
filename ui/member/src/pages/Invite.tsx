// Joint-member invite acceptance (decision #23): the invite email lands
// here as /invite?token=... and the invitee chooses a password, posted with
// the token to POST /auth/accept-invite. The token is single-use, so a
// failure is terminal: the form goes away — no retry loop.
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Link from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link as RouterLink, useSearchParams } from 'react-router';
import { useClient } from '../api/client';
import { useApi } from '../api/useApi';

export function Invite() {
  const client = useClient();
  const { run, busy } = useApi();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [state, setState] = useState<'form' | 'ok' | 'failed'>('form');

  const mismatch = confirm !== '' && confirm !== password;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (password !== confirm) return; // client-side match check
    const result = await run(() => client.acceptInvite(token, password));
    // Either way the token is spent: success or a terminal failure.
    setState(result !== undefined ? 'ok' : 'failed');
  };

  if (state === 'ok') {
    return (
      <Box sx={{ maxWidth: 400, mx: 'auto', p: 3, pt: 8 }}>
        <Typography variant="h5" sx={{ mb: 2 }}>
          Invitation accepted
        </Typography>
        <Typography sx={{ mb: 3 }}>
          Your password is set — log in with the email address the invitation
          was sent to.
        </Typography>
        <Link component={RouterLink} to="/login">
          Go to login
        </Link>
      </Box>
    );
  }

  if (state === 'failed') {
    return (
      <Box sx={{ maxWidth: 400, mx: 'auto', p: 3, pt: 8 }}>
        <Typography variant="h5" sx={{ mb: 2 }}>
          Invitation not accepted
        </Typography>
        <Typography sx={{ mb: 3 }}>
          That invitation link is invalid, expired or already used — ask the
          member who invited you to send a new one.
        </Typography>
        <Link component={RouterLink} to="/login">
          Go to login
        </Link>
      </Box>
    );
  }

  return (
    <Box sx={{ maxWidth: 400, mx: 'auto', p: 3, pt: 8 }}>
      <Typography variant="h4" sx={{ mb: 2 }}>
        Accept your invitation
      </Typography>
      <Typography color="text.secondary" sx={{ mb: 3 }}>
        You've been invited to share a membership. Choose a password to
        activate your login.
      </Typography>
      <form onSubmit={(event) => void submit(event)}>
        <Stack spacing={2}>
          <TextField
            label="Choose a password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
            autoComplete="new-password"
            helperText="At least 8 characters"
          />
          <TextField
            label="Confirm password"
            type="password"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            required
            autoComplete="new-password"
            error={mismatch}
            helperText={mismatch ? 'Passwords do not match' : undefined}
          />
          <Button
            type="submit"
            variant="contained"
            size="large"
            disabled={busy || mismatch}
          >
            Accept invitation
          </Button>
        </Stack>
      </form>
    </Box>
  );
}
