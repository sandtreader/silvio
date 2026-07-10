// More: profile (with photo, decision #14 phase 2), settings
// (confirm-incoming toggle, decision #5; offers & wants digest cadence,
// decision #17; API tokens for MCP agents, decision #9), member directory,
// logout.
import BalanceIcon from '@mui/icons-material/Balance';
import KeyIcon from '@mui/icons-material/Key';
import LogoutIcon from '@mui/icons-material/Logout';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import CircularProgress from '@mui/material/CircularProgress';
import FormControlLabel from '@mui/material/FormControlLabel';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemAvatar from '@mui/material/ListItemAvatar';
import ListItemText from '@mui/material/ListItemText';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import type { DigestFrequency, DirectoryMember } from '@silvio/ui-shared';
import { useEffect, useState } from 'react';
import type { ChangeEvent } from 'react';
import { useNavigate } from 'react-router';
import { useAuth } from '../api/auth';
import { useClient } from '../api/client';
import { useFeedback } from '../api/feedback';
import { useApi } from '../api/useApi';
import { MemberAvatar } from '../components/MemberAvatar';
import { PageContainer } from '../components/PageContainer';
import { resizeImage } from '../resize';

export function More() {
  const client = useClient();
  const { me, refresh, clear } = useAuth();
  const { run, busy } = useApi();
  const feedback = useFeedback();
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

  const setDigestFrequency = async (digestFrequency: DigestFrequency) => {
    const result = await run(() => client.updateMe({ digestFrequency }));
    if (result !== undefined) await refresh();
  };

  const uploadPhoto = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = ''; // allow re-selecting the same file
    if (file === undefined) return;
    // Downscale client-side before upload (decision #14): the server only
    // validates, it never resizes.
    let resized;
    try {
      resized = await resizeImage(file);
    } catch {
      feedback.show('Could not read that image', 'error');
      return;
    }
    const result = await run(() => client.setMyPhoto(resized.blob, resized.mime));
    if (result !== undefined) await refresh();
  };

  const removePhoto = async () => {
    const result = await run(() => client.deleteMyPhoto());
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
        <CardContent sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <MemberAvatar
            name={me.member.displayName}
            photoId={me.member.photoId}
            size={56}
          />
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="h6">{me.member.displayName}</Typography>
            <Typography color="text.secondary">
              Member #{me.member.memberNo}
            </Typography>
            <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
              <Button component="label" size="small" disabled={busy}>
                {me.member.photoId === undefined ? 'Add photo' : 'Change photo'}
                <input
                  hidden
                  type="file"
                  accept="image/*"
                  onChange={(event) => void uploadPhoto(event)}
                />
              </Button>
              {me.member.photoId !== undefined && (
                <Button
                  size="small"
                  color="error"
                  disabled={busy}
                  onClick={() => void removePhoto()}
                >
                  Remove photo
                </Button>
              )}
            </Stack>
          </Box>
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

      {/* Offers & wants digest cadence (decision #17); default weekly */}
      <Typography sx={{ mb: 1 }}>Offers &amp; wants digest</Typography>
      <ToggleButtonGroup
        exclusive
        size="small"
        value={me.member.digestFrequency}
        disabled={busy}
        onChange={(_event, value: DigestFrequency | null) => {
          if (value !== null) void setDigestFrequency(value);
        }}
        aria-label="Offers & wants digest"
        sx={{ mb: 2 }}
      >
        <ToggleButton value="none">None</ToggleButton>
        <ToggleButton value="weekly">Weekly</ToggleButton>
        <ToggleButton value="monthly">Monthly</ToggleButton>
      </ToggleButtonGroup>

      {/* Personal API tokens for AI agents/apps over MCP (decision #9) */}
      <Typography variant="h6" sx={{ mb: 1 }}>
        Connected apps
      </Typography>
      <Button
        variant="outlined"
        startIcon={<KeyIcon />}
        onClick={() => void navigate('/tokens')}
        fullWidth
        sx={{ mb: 2 }}
      >
        API tokens
      </Button>

      <Typography variant="h6" sx={{ mb: 1 }}>
        Group
      </Typography>
      {/* Group balances transparency view (#19): always listed; the page
          itself explains when the group doesn't publish balances. */}
      <Button
        variant="outlined"
        startIcon={<BalanceIcon />}
        onClick={() => void navigate('/balances')}
        fullWidth
        sx={{ mb: 2 }}
      >
        Group balances
      </Button>

      <Typography variant="h6" sx={{ mb: 1 }}>
        Directory
      </Typography>
      {members === null ? (
        <CircularProgress size={24} />
      ) : (
        <List dense disablePadding sx={{ mb: 2 }}>
          {members.map((member) => (
            <ListItem key={member.id} disableGutters divider>
              <ListItemAvatar>
                <MemberAvatar
                  name={member.displayName}
                  photoId={member.photoId}
                  size={36}
                />
              </ListItemAvatar>
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
