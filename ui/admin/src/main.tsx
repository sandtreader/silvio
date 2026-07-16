// Silvio admin app entry (decision #11): Rafiki Framework shell over the
// same-origin cookie-session API. Served at /admin/ by the Silvio server.

import React from 'react';
import ReactDOM from 'react-dom/client';
import { CssBaseline } from '@mui/material';
import { Framework } from '@sandtreader/rafiki';
import { api, client } from './api';
import { SilvioAuthenticationProvider } from './auth';
import { HeaderStatus } from './HeaderStatus';
import { buildMenu } from './menu';
import { SnackbarHost } from './SnackbarHost';

const silvioAuth = new SilvioAuthenticationProvider(client);
const menu = buildMenu();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <CssBaseline />
    <Framework
      authProvider={silvioAuth}
      menuProvider={menu}
      title="Silvio Admin"
      headerStatus={(session) => <HeaderStatus api={api} session={session} />}
    />
    <SnackbarHost />
  </React.StrictMode>,
);
