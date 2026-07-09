// Forgot password: email -> POST /auth/forgot. The server always answers
// ok (no account enumeration), so the page always shows the same neutral
// message whether or not the address has an account.
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Link from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link as RouterLink } from 'react-router';
import { useClient } from '../api/client';
import { useApi } from '../api/useApi';

export function Forgot() {
  const client = useClient();
  const { run, busy } = useApi();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const result = await run(() => client.forgotPassword(email));
    if (result !== undefined) setSent(true);
  };

  if (sent) {
    return (
      <Box sx={{ maxWidth: 400, mx: 'auto', p: 3, pt: 8 }}>
        <Typography variant="h5" sx={{ mb: 2 }}>
          Check your email
        </Typography>
        <Typography sx={{ mb: 3 }}>
          If that address has an account here, a reset link is on its way.
        </Typography>
        <Link component={RouterLink} to="/login">
          Back to login
        </Link>
      </Box>
    );
  }

  return (
    <Box sx={{ maxWidth: 400, mx: 'auto', p: 3, pt: 8 }}>
      <Typography variant="h4" sx={{ mb: 3 }}>
        Reset your password
      </Typography>
      <Typography sx={{ mb: 3 }}>
        Enter your email address and we will send you a link to choose a new
        password.
      </Typography>
      <form onSubmit={(event) => void submit(event)}>
        <Stack spacing={2}>
          <TextField
            label="Email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
            autoComplete="email"
          />
          <Button type="submit" variant="contained" size="large" disabled={busy}>
            Send reset link
          </Button>
        </Stack>
      </form>
      <Box sx={{ mt: 3 }}>
        <Link component={RouterLink} to="/login">
          Back to login
        </Link>
      </Box>
    </Box>
  );
}
