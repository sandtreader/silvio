// Silvio operator console entry (decision #21): Rafiki Framework shell over
// the same-origin cookie-session API. Served at /operator/ by the Silvio
// server.

import React from 'react';
import ReactDOM from 'react-dom/client';
import { CssBaseline } from '@mui/material';
import { Framework } from '@sandtreader/rafiki';
import { client } from './api';
import { OperatorAuthenticationProvider } from './auth';
import { buildMenu } from './menu';
import { SnackbarHost } from './SnackbarHost';

const operatorAuth = new OperatorAuthenticationProvider(client);
const menu = buildMenu();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <CssBaseline />
    <Framework
      authProvider={operatorAuth}
      menuProvider={menu}
      title="Silvio Operator"
    />
    <SnackbarHost />
  </React.StrictMode>,
);
