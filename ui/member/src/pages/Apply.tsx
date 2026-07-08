// Apply: membership application (decision #7: applied -> admin approves).
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

export function Apply() {
  const client = useClient();
  const { run, busy } = useApi();
  const [displayName, setDisplayName] = useState('');
  const [personName, setPersonName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [applied, setApplied] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const result = await run(() =>
      client.apply({ displayName, personName, email, password }),
    );
    if (result !== undefined) setApplied(true);
  };

  if (applied) {
    return (
      <Box sx={{ maxWidth: 400, mx: 'auto', p: 3, pt: 8 }}>
        <Typography variant="h5" sx={{ mb: 2 }}>
          Application received
        </Typography>
        <Typography sx={{ mb: 3 }}>
          Thanks — your application is awaiting approval. You will be able to
          log in once an admin has approved it.
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
        Join this LETS
      </Typography>
      <form onSubmit={(event) => void submit(event)}>
        <Stack spacing={2}>
          <TextField
            label="Display name"
            helperText="How you appear in the directory"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            required
          />
          <TextField
            label="Your name"
            value={personName}
            onChange={(event) => setPersonName(event.target.value)}
            required
          />
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
            autoComplete="new-password"
          />
          <Button type="submit" variant="contained" size="large" disabled={busy}>
            Apply
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
