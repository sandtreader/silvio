// Email verification: emailed link lands here as /verify?token=... and the
// token goes to POST /auth/verify on mount. The token is single-use, so a
// ref guards against StrictMode's double effect run firing it twice.
import Box from '@mui/material/Box';
import Link from '@mui/material/Link';
import Typography from '@mui/material/Typography';
import { useEffect, useRef, useState } from 'react';
import { Link as RouterLink, useSearchParams } from 'react-router';
import { useClient } from '../api/client';

export function Verify() {
  const client = useClient();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [state, setState] = useState<'pending' | 'ok' | 'failed'>('pending');
  const fired = useRef(false);

  useEffect(() => {
    if (fired.current) return;
    fired.current = true;
    client.verifyEmail(token).then(
      () => setState('ok'),
      () => setState('failed'),
    );
  }, [client, token]);

  return (
    <Box sx={{ maxWidth: 400, mx: 'auto', p: 3, pt: 8 }}>
      {state === 'pending' && <Typography>Confirming your email address…</Typography>}
      {state === 'ok' && (
        <>
          <Typography variant="h5" sx={{ mb: 2 }}>
            Email address confirmed
          </Typography>
          <Typography sx={{ mb: 3 }}>
            Thanks — your email address has been verified.
          </Typography>
        </>
      )}
      {state === 'failed' && (
        <>
          <Typography variant="h5" sx={{ mb: 2 }}>
            Verification failed
          </Typography>
          <Typography sx={{ mb: 3 }}>
            That verification link is invalid, expired or already used.
          </Typography>
        </>
      )}
      {state !== 'pending' && (
        <Link component={RouterLink} to="/login">
          Go to login
        </Link>
      )}
    </Box>
  );
}
