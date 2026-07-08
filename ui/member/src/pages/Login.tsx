// Login: email + password -> POST /auth/login -> reload /me. Logged-out
// visitors can still browse the market, or apply to join.
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Link from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link as RouterLink, Navigate, useNavigate } from 'react-router';
import { useAuth } from '../api/auth';
import { useClient } from '../api/client';
import { useApi } from '../api/useApi';

export function Login() {
  const client = useClient();
  const { me, refresh } = useAuth();
  const { run, busy } = useApi();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  if (me !== null) return <Navigate to="/" replace />;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const result = await run(() => client.login(email, password));
    if (result !== undefined) {
      await refresh();
      void navigate('/');
    }
  };

  return (
    <Box sx={{ maxWidth: 400, mx: 'auto', p: 3, pt: 8 }}>
      <Typography variant="h4" sx={{ mb: 3 }}>
        Silvio
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
          <TextField
            label="Password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
            autoComplete="current-password"
          />
          <Button type="submit" variant="contained" size="large" disabled={busy}>
            Log in
          </Button>
        </Stack>
      </form>
      <Stack spacing={1} sx={{ mt: 3 }}>
        <Link component={RouterLink} to="/apply">
          Join this LETS
        </Link>
        <Link component={RouterLink} to="/market">
          Browse the market
        </Link>
      </Stack>
    </Box>
  );
}
