// Header status (top-right of the Rafiki app bar): which group this admin
// console is signed into and who is signed in. Group identity comes from the
// public session-aware GET /shell (#15); the user from the Rafiki session.
// Colours are inherited so the block matches whatever the AppBar wears.

import { useEffect, useState } from 'react';
import { Icon, Stack, Typography } from '@mui/material';
import type { SessionState } from '@sandtreader/rafiki';
import type { ShellInfo } from '@silvio/ui-shared';
import type { AdminApi } from './api';

export interface HeaderStatusProps {
  api: AdminApi;
  session?: SessionState;
}

export function HeaderStatus({ api, session }: HeaderStatusProps) {
  const [shell, setShell] = useState<ShellInfo | undefined>();

  useEffect(() => {
    void api.shellInfo().then(setShell);
  }, [api]);

  return (
    <Stack alignItems="flex-end" spacing={0}>
      {shell && (
        <Stack direction="row" alignItems="center" spacing={0.5}>
          <Icon fontSize="small">groups</Icon>
          <Typography variant="body2">{shell.group.name}</Typography>
        </Stack>
      )}
      {session?.loggedIn && (
        <Stack direction="row" alignItems="center" spacing={0.5}>
          <Icon fontSize="small">person</Icon>
          <Typography variant="body2">{session.userName}</Typography>
        </Stack>
      )}
    </Stack>
  );
}
