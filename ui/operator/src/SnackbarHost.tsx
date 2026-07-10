// Renders API-layer errors as a snackbar. One instance lives beside the
// Rafiki Framework in main.tsx; the api layer never throws into pages.

import { useEffect, useState } from 'react';
import { Alert, Snackbar } from '@mui/material';
import { onApiError } from './api';

export function SnackbarHost() {
  const [message, setMessage] = useState<string>();

  useEffect(() => onApiError(setMessage), []);

  const close = () => setMessage(undefined);

  return (
    <Snackbar
      open={message !== undefined}
      autoHideDuration={6000}
      onClose={close}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
    >
      <Alert severity="error" variant="filled" onClose={close}>
        {message}
      </Alert>
    </Snackbar>
  );
}
