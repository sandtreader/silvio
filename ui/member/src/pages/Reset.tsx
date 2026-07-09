// Reset password: emailed link lands here as /reset?token=... and the new
// password goes to POST /auth/reset. A 400 means the link is invalid,
// expired or already used, so the page offers a way to request another.
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

export function Reset() {
  const client = useClient();
  const { run, busy } = useApi();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [done, setDone] = useState(false);
  const [failed, setFailed] = useState(false);

  const mismatch = confirm !== '' && confirm !== password;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (password !== confirm) return; // client-side match check
    const result = await run(() => client.resetPassword(token, password));
    if (result !== undefined) setDone(true);
    else setFailed(true); // run() has already shown the server's message
  };

  if (done) {
    return (
      <Box sx={{ maxWidth: 400, mx: 'auto', p: 3, pt: 8 }}>
        <Typography variant="h5" sx={{ mb: 2 }}>
          Password changed
        </Typography>
        <Typography sx={{ mb: 3 }}>
          Your new password is set — you can log in with it now.
        </Typography>
        <Link component={RouterLink} to="/login">
          Go to login
        </Link>
      </Box>
    );
  }

  return (
    <Box sx={{ maxWidth: 400, mx: 'auto', p: 3, pt: 8 }}>
      <Typography variant="h4" sx={{ mb: 3 }}>
        Choose a new password
      </Typography>
      <form onSubmit={(event) => void submit(event)}>
        <Stack spacing={2}>
          <TextField
            label="New password"
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
            Set password
          </Button>
        </Stack>
      </form>
      <Stack spacing={1} sx={{ mt: 3 }}>
        {failed && (
          <Typography color="error">
            That reset link may have expired or already been used.{' '}
            <Link component={RouterLink} to="/forgot">
              Request another
            </Link>
          </Typography>
        )}
        <Link component={RouterLink} to="/login">
          Back to login
        </Link>
      </Stack>
    </Box>
  );
}
