// More: profile, settings (confirm-incoming toggle, decision #5), member
// directory, logout.
import LogoutIcon from '@mui/icons-material/Logout';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import CircularProgress from '@mui/material/CircularProgress';
import FormControlLabel from '@mui/material/FormControlLabel';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemText from '@mui/material/ListItemText';
import Switch from '@mui/material/Switch';
import Typography from '@mui/material/Typography';
import type { DirectoryMember } from '@silvio/ui-shared';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { useAuth } from '../api/auth';
import { useClient } from '../api/client';
import { useApi } from '../api/useApi';
import { PageContainer } from '../components/PageContainer';

export function More() {
  const client = useClient();
  const { me, refresh, clear } = useAuth();
  const { run, busy } = useApi();
  const navigate = useNavigate();
  const [members, setMembers] = useState<DirectoryMember[] | null>(null);

  useEffect(() => {
    void run(() => client.members()).then((result) => {
      if (result !== undefined) setMembers(result.members);
    });
  }, [client, run]);

  if (me === null) return null;

  const toggleConfirmIncoming = async (confirmIncoming: boolean) => {
    const result = await run(() => client.updateMe({ confirmIncoming }));
    if (result !== undefined) await refresh();
  };

  const logout = async () => {
    await run(() => client.logout());
    clear();
    void navigate('/login');
  };

  return (
    <PageContainer title="More">
      <Card sx={{ mb: 2 }}>
        <CardContent>
          <Typography variant="h6">{me.member.displayName}</Typography>
          <Typography color="text.secondary">
            Member #{me.member.memberNo}
          </Typography>
        </CardContent>
      </Card>

      <Typography variant="h6" sx={{ mb: 1 }}>
        Settings
      </Typography>
      <FormControlLabel
        control={
          <Switch
            checked={me.member.confirmIncoming}
            disabled={busy}
            onChange={(_event, checked) => void toggleConfirmIncoming(checked)}
          />
        }
        label="Confirm incoming payments"
        sx={{ mb: 2 }}
      />

      <Typography variant="h6" sx={{ mb: 1 }}>
        Directory
      </Typography>
      {members === null ? (
        <CircularProgress size={24} />
      ) : (
        <List dense disablePadding sx={{ mb: 2 }}>
          {members.map((member) => (
            <ListItem key={member.id} disableGutters divider>
              <ListItemText
                primary={member.displayName}
                secondary={`#${member.memberNo}`}
              />
            </ListItem>
          ))}
        </List>
      )}

      <Button
        variant="outlined"
        color="error"
        startIcon={<LogoutIcon />}
        onClick={() => void logout()}
        fullWidth
      >
        Log out
      </Button>
    </PageContainer>
  );
}
