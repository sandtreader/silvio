// Group settings: the group name plus the per-group tunables stored in
// group.settings — payment auto-accept days, invoice expiry days (both
// 1..365), the listing shelf life in days (1..730, #18), and the digest
// default for new members. Absent keys fall back to platform defaults
// (14 / 30 / 180 / weekly), so a blank field means "use the default" and its
// key is omitted; the PATCH replaces the whole settings object. The
// per-group email sender stays on the Email templates page.
// API errors surface through the api layer's snackbar (decision #11).

import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  MenuItem,
  Paper,
  Snackbar,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import type { GroupSettings } from '@silvio/ui-shared';
import { api as realApi, type AdminApi } from '../api';

// Platform defaults when a settings key is absent (server settings.ts).
const DEFAULT_AUTO_ACCEPT_DAYS = 14;
const DEFAULT_INVOICE_EXPIRY_DAYS = 30;
const DEFAULT_LISTING_MAX_AGE_DAYS = 180;

const DIGEST_OPTIONS = [
  { value: '', label: 'Platform default (weekly)' },
  { value: 'none', label: 'None' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
] as const;

/** The set keys only: blank fields are omitted so defaults apply. */
function buildSettings(
  autoAcceptDays: string,
  invoiceExpiryDays: string,
  listingMaxAgeDays: string,
  digestDefault: string,
): GroupSettings {
  const settings: GroupSettings = {};
  const auto = Number.parseInt(autoAcceptDays, 10);
  if (!Number.isNaN(auto)) settings.autoAcceptDays = auto;
  const expiry = Number.parseInt(invoiceExpiryDays, 10);
  if (!Number.isNaN(expiry)) settings.invoiceExpiryDays = expiry;
  const shelfLife = Number.parseInt(listingMaxAgeDays, 10);
  if (!Number.isNaN(shelfLife)) settings.listingMaxAgeDays = shelfLife;
  if (digestDefault !== '')
    settings.digestDefault = digestDefault as NonNullable<
      GroupSettings['digestDefault']
    >;
  return settings;
}

export function SettingsPage({ api = realApi }: { api?: AdminApi }) {
  // Group name; undefined until the group loads (like the sender block, #16).
  const [name, setName] = useState<string>();

  // Settings fields as entered; '' means "use the platform default".
  const [autoAcceptDays, setAutoAcceptDays] = useState('');
  const [invoiceExpiryDays, setInvoiceExpiryDays] = useState('');
  const [listingMaxAgeDays, setListingMaxAgeDays] = useState('');
  const [digestDefault, setDigestDefault] = useState('');
  const [loaded, setLoaded] = useState(false);

  const [savedNotice, setSavedNotice] = useState<string>();

  useEffect(() => {
    void (async () => {
      const group = await api.adminGroup();
      if (group === undefined) return;
      setName(group.name);
      setAutoAcceptDays(group.settings?.autoAcceptDays?.toString() ?? '');
      setInvoiceExpiryDays(group.settings?.invoiceExpiryDays?.toString() ?? '');
      setListingMaxAgeDays(group.settings?.listingMaxAgeDays?.toString() ?? '');
      setDigestDefault(group.settings?.digestDefault ?? '');
      setLoaded(true);
    })();
  }, [api]);

  const saveName = async () => {
    const group = await api.patchAdminGroup({ name: (name ?? '').trim() });
    if (group !== undefined) {
      setName(group.name);
      setSavedNotice('Group name saved');
    }
  };

  const saveSettings = async () => {
    const group = await api.patchAdminGroup({
      settings: buildSettings(
        autoAcceptDays,
        invoiceExpiryDays,
        listingMaxAgeDays,
        digestDefault,
      ),
    });
    if (group !== undefined) {
      setAutoAcceptDays(group.settings?.autoAcceptDays?.toString() ?? '');
      setInvoiceExpiryDays(group.settings?.invoiceExpiryDays?.toString() ?? '');
      setListingMaxAgeDays(group.settings?.listingMaxAgeDays?.toString() ?? '');
      setDigestDefault(group.settings?.digestDefault ?? '');
      setSavedNotice('Settings saved');
    }
  };

  return (
    <Stack spacing={2} sx={{ marginTop: 2, maxWidth: 800 }}>
      <Typography variant="h5">Group settings</Typography>

      {/* Group name */}
      <Paper sx={{ padding: 2 }}>
        <Stack direction="row" spacing={2} alignItems="flex-start">
          <TextField
            label="Group name"
            value={name ?? ''}
            onChange={(e) => setName(e.target.value)}
            disabled={name === undefined}
            fullWidth
          />
          <Button
            variant="contained"
            disabled={name === undefined || name.trim() === ''}
            onClick={() => void saveName()}
            sx={{ marginTop: 1 }}
          >
            Save
          </Button>
        </Stack>
      </Paper>

      {/* Trading and digest tunables; blank fields use the platform default */}
      <Paper sx={{ padding: 2 }}>
        <Stack spacing={2}>
          <TextField
            label="Payment auto-accept days"
            type="number"
            value={autoAcceptDays}
            onChange={(e) => setAutoAcceptDays(e.target.value)}
            placeholder={String(DEFAULT_AUTO_ACCEPT_DAYS)}
            helperText={`Days before a held payment is auto-accepted; blank uses the platform default (${DEFAULT_AUTO_ACCEPT_DAYS})`}
            inputProps={{ min: 1, max: 365 }}
            disabled={!loaded}
            fullWidth
          />
          <TextField
            label="Invoice expiry days"
            type="number"
            value={invoiceExpiryDays}
            onChange={(e) => setInvoiceExpiryDays(e.target.value)}
            placeholder={String(DEFAULT_INVOICE_EXPIRY_DAYS)}
            helperText={`Days before an unanswered invoice expires; blank uses the platform default (${DEFAULT_INVOICE_EXPIRY_DAYS})`}
            inputProps={{ min: 1, max: 365 }}
            disabled={!loaded}
            fullWidth
          />
          <TextField
            label="Listing shelf life (days)"
            type="number"
            value={listingMaxAgeDays}
            onChange={(e) => setListingMaxAgeDays(e.target.value)}
            placeholder={String(DEFAULT_LISTING_MAX_AGE_DAYS)}
            helperText={`Days before a marketplace listing expires (#18); blank uses the platform default (${DEFAULT_LISTING_MAX_AGE_DAYS})`}
            inputProps={{ min: 1, max: 730 }}
            disabled={!loaded}
            fullWidth
          />
          <TextField
            select
            label="Digest default for new members"
            value={digestDefault}
            onChange={(e) => setDigestDefault(e.target.value)}
            SelectProps={{ displayEmpty: true }}
            InputLabelProps={{ shrink: true }}
            disabled={!loaded}
            fullWidth
          >
            {DIGEST_OPTIONS.map((option) => (
              <MenuItem key={option.value} value={option.value}>
                {option.label}
              </MenuItem>
            ))}
          </TextField>
          <Stack direction="row" justifyContent="flex-end">
            <Button
              variant="contained"
              disabled={!loaded}
              onClick={() => void saveSettings()}
            >
              Save settings
            </Button>
          </Stack>
        </Stack>
      </Paper>

      {/* Save confirmation */}
      <Snackbar
        open={savedNotice !== undefined}
        autoHideDuration={4000}
        onClose={() => setSavedNotice(undefined)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert
          severity="success"
          variant="filled"
          onClose={() => setSavedNotice(undefined)}
        >
          {savedNotice}
        </Alert>
      </Snackbar>
    </Stack>
  );
}
