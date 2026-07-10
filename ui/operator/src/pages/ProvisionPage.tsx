// Provision page (decision #21): create a new tenant via POST
// /operator/groups — group slug/name, optional hostname, its currency, and
// optionally an initial admin (server semantics, provisioning.ts: an
// existing user by email is linked as-is, a new email needs a password; the
// server emails a welcome). Blank optional fields are omitted so server
// defaults apply (currency scale defaults to 2).

import { useState } from 'react';
import {
  Alert,
  Button,
  Divider,
  FormControlLabel,
  Paper,
  Snackbar,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import type { CreateGroupInput } from '@silvio/ui-shared';
import { api as realApi, type OperatorApi } from '../api';

export function ProvisionPage({ api = realApi }: { api?: OperatorApi }) {
  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [hostname, setHostname] = useState('');
  const [currencyCode, setCurrencyCode] = useState('');
  const [currencyName, setCurrencyName] = useState('');
  const [currencyScale, setCurrencyScale] = useState('');

  // Initial admin is optional; the switch reveals its (then required) fields
  const [withAdmin, setWithAdmin] = useState(false);
  const [adminDisplayName, setAdminDisplayName] = useState('');
  const [adminPersonName, setAdminPersonName] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [adminPassword, setAdminPassword] = useState('');

  const [notice, setNotice] = useState<string>();

  const complete =
    slug.trim() !== '' &&
    name.trim() !== '' &&
    currencyCode.trim() !== '' &&
    currencyName.trim() !== '' &&
    (!withAdmin ||
      (adminDisplayName.trim() !== '' &&
        adminPersonName.trim() !== '' &&
        adminEmail.trim() !== ''));

  const reset = () => {
    setSlug('');
    setName('');
    setHostname('');
    setCurrencyCode('');
    setCurrencyName('');
    setCurrencyScale('');
    setWithAdmin(false);
    setAdminDisplayName('');
    setAdminPersonName('');
    setAdminEmail('');
    setAdminPassword('');
  };

  const provision = async () => {
    const input: CreateGroupInput = {
      slug: slug.trim(),
      name: name.trim(),
      currency: { code: currencyCode.trim(), name: currencyName.trim() },
    };
    const scale = Number.parseInt(currencyScale, 10);
    if (!Number.isNaN(scale)) input.currency.scale = scale;
    const host = hostname.trim();
    if (host !== '') input.hostname = host;
    if (withAdmin) {
      input.admin = {
        displayName: adminDisplayName.trim(),
        personName: adminPersonName.trim(),
        email: adminEmail.trim(),
      };
      if (adminPassword !== '') input.admin.password = adminPassword;
    }
    const result = await api.provisionGroup(input);
    if (result === undefined) return;
    setNotice(
      host === ''
        ? `Group ${result.group.name} provisioned — no hostname was set, add ` +
            'domains on the Groups page'
        : `Group ${result.group.name} provisioned`,
    );
    reset();
  };

  return (
    <Stack spacing={2} sx={{ marginTop: 2, maxWidth: 800 }}>
      <Typography variant="h5">Provision group</Typography>

      <Paper sx={{ padding: 2 }}>
        <Stack spacing={2}>
          <TextField
            label="Slug"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            helperText="URL name for /g/{slug} tenancy, e.g. camlets"
            required
            fullWidth
          />
          <TextField
            label="Group name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            fullWidth
          />
          <TextField
            label="Hostname"
            value={hostname}
            onChange={(e) => setHostname(e.target.value)}
            placeholder="lets.example.org"
            helperText="Optional custom domain for Host-header tenancy; more can be added later on the Groups page"
            fullWidth
          />

          <Divider />
          <Typography variant="subtitle1">Currency</Typography>
          <TextField
            label="Code"
            value={currencyCode}
            onChange={(e) => setCurrencyCode(e.target.value)}
            placeholder="CAM"
            required
            fullWidth
          />
          <TextField
            label="Currency name"
            value={currencyName}
            onChange={(e) => setCurrencyName(e.target.value)}
            placeholder="Cams"
            required
            fullWidth
          />
          <TextField
            label="Scale"
            type="number"
            value={currencyScale}
            onChange={(e) => setCurrencyScale(e.target.value)}
            placeholder="2"
            helperText="Decimal places; blank uses the server default (2)"
            inputProps={{ min: 0, max: 6 }}
            fullWidth
          />

          <Divider />
          <FormControlLabel
            control={
              <Switch
                checked={withAdmin}
                onChange={(e) => setWithAdmin(e.target.checked)}
              />
            }
            label="Create initial admin"
          />
          {withAdmin && (
            <>
              <TextField
                label="Display name"
                value={adminDisplayName}
                onChange={(e) => setAdminDisplayName(e.target.value)}
                required
                fullWidth
              />
              <TextField
                label="Person name"
                value={adminPersonName}
                onChange={(e) => setAdminPersonName(e.target.value)}
                required
                fullWidth
              />
              <TextField
                label="Email"
                type="email"
                value={adminEmail}
                onChange={(e) => setAdminEmail(e.target.value)}
                helperText="An existing account is linked as-is; the server emails a welcome"
                required
                fullWidth
              />
              <TextField
                label="Password"
                type="password"
                value={adminPassword}
                onChange={(e) => setAdminPassword(e.target.value)}
                helperText="Required only when the email is new to the platform; ignored for an existing account"
                fullWidth
              />
            </>
          )}

          <Stack direction="row" justifyContent="flex-end">
            <Button
              variant="contained"
              disabled={!complete}
              onClick={() => void provision()}
            >
              Provision
            </Button>
          </Stack>
        </Stack>
      </Paper>

      {/* Success confirmation */}
      <Snackbar
        open={notice !== undefined}
        autoHideDuration={8000}
        onClose={() => setNotice(undefined)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert severity="success" variant="filled" onClose={() => setNotice(undefined)}>
          {notice}
        </Alert>
      </Snackbar>
    </Stack>
  );
}
