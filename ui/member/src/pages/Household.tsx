// Household: the persons sharing a joint membership (decision #23). Each
// has their own login but they all act as the one member — same balance,
// same listings. Adding an email with no Silvio account sends a 7-day
// invite (an existing account links silently); removal only revokes access
// to this membership, never the person's login. No "you" marker on the
// list: the session (GET /me) doesn't expose the caller's person/user id,
// so we don't guess.
import PersonRemoveIcon from '@mui/icons-material/PersonRemove';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import IconButton from '@mui/material/IconButton';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemText from '@mui/material/ListItemText';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import type { Person } from '@silvio/ui-shared';
import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useClient } from '../api/client';
import { useFeedback } from '../api/feedback';
import { useApi } from '../api/useApi';
import { PageContainer } from '../components/PageContainer';

export function Household() {
  const client = useClient();
  const { run, busy } = useApi();
  const feedback = useFeedback();
  const [persons, setPersons] = useState<Person[] | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [removing, setRemoving] = useState<Person | null>(null);

  const load = useCallback(async () => {
    const result = await run(() => client.myPersons());
    if (result !== undefined) setPersons(result.persons);
  }, [client, run]);

  useEffect(() => {
    void load();
  }, [load]);

  const add = async (event: FormEvent) => {
    event.preventDefault();
    const result = await run(() => client.addPerson(name.trim(), email.trim()));
    if (result !== undefined) {
      // userId present means an existing account linked straight away;
      // otherwise the server emailed a 7-day invite.
      feedback.show(
        result.person.userId === undefined
          ? `Invitation sent to ${result.person.email ?? 'them'}`
          : `${result.person.name} added`,
        'success',
      );
      setName('');
      setEmail('');
      void load();
    }
  };

  return (
    <PageContainer title="Household">
      <Typography color="text.secondary" sx={{ mb: 2 }}>
        Everyone here shares this membership — its balance and its listings —
        each with their own login.
      </Typography>

      {persons === null ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', mt: 4 }}>
          <CircularProgress />
        </Box>
      ) : (
        <List dense disablePadding sx={{ mb: 2 }}>
          {persons.map((person) => (
            <ListItem
              key={person.id}
              disableGutters
              divider
              secondaryAction={
                <IconButton
                  edge="end"
                  color="error"
                  aria-label={`Remove ${person.name}`}
                  onClick={() => setRemoving(person)}
                >
                  <PersonRemoveIcon />
                </IconButton>
              }
            >
              <ListItemText primary={person.name} secondary={person.email} />
              {/* No userId yet: their invite is still outstanding (#23). */}
              {person.userId === undefined && (
                <Chip size="small" label="Invited" sx={{ mr: 1 }} />
              )}
            </ListItem>
          ))}
        </List>
      )}

      <Typography variant="h6" sx={{ mb: 1 }}>
        Add a person
      </Typography>
      <form onSubmit={(event) => void add(event)}>
        <Stack spacing={2}>
          <TextField
            label="Name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
          />
          <TextField
            label="Email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
            helperText="If they don't have a Silvio login yet, we'll email them an invitation (valid for 7 days)"
          />
          <Button
            type="submit"
            variant="contained"
            disabled={busy || name.trim() === '' || email.trim() === ''}
          >
            Add person
          </Button>
        </Stack>
      </form>

      <RemovePersonDialog
        person={removing}
        onClose={() => setRemoving(null)}
        onRemoved={() => {
          setRemoving(null);
          void load();
        }}
      />
    </PageContainer>
  );
}

/** Confirm removal, spelling out what it revokes (#23). The last-person 422
 * surfaces the server's message via the snackbar and the dialog stays. */
function RemovePersonDialog({
  person,
  onClose,
  onRemoved,
}: {
  person: Person | null;
  onClose: () => void;
  onRemoved: () => void;
}) {
  const client = useClient();
  const { run, busy } = useApi();
  const feedback = useFeedback();

  const remove = async () => {
    if (person === null) return;
    const result = await run(() => client.removePerson(person.id));
    if (result !== undefined) {
      feedback.show(`${person.name} removed`, 'success');
      onRemoved();
    }
  };

  return (
    <Dialog open={person !== null} onClose={onClose} fullWidth>
      <DialogTitle>Remove {person?.name}?</DialogTitle>
      <DialogContent>
        <DialogContentText>
          They keep their Silvio login but lose access to this membership —
          its balance, listings and activity.
        </DialogContentText>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          color="error"
          variant="contained"
          disabled={busy}
          onClick={() => void remove()}
        >
          Remove person
        </Button>
      </DialogActions>
    </Dialog>
  );
}
