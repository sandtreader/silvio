// Market: browse active listings and post a new one via the FAB. An
// authenticated tab like the rest (decision #12: public browse lives on the
// brochure site, not in the app). Listing cards carry a photo strip
// (decision #14 phase 3); owners manage their own photos inline. A debounced
// search box narrows the loaded browse to the FTS matches (#18), and owners
// see their listing's expiry with a one-tap renew (#18 shelf life).
import AddIcon from '@mui/icons-material/Add';
import AddPhotoAlternateIcon from '@mui/icons-material/AddPhotoAlternate';
import CloseIcon from '@mui/icons-material/Close';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Fab from '@mui/material/Fab';
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import { formatAmount, parseAmount } from '@silvio/ui-shared';
import type {
  AccountSummary,
  Category,
  Listing,
  ListingInput,
  ListingType,
} from '@silvio/ui-shared';
import { useCallback, useEffect, useState } from 'react';
import type { ChangeEvent } from 'react';
import { useAuth } from '../api/auth';
import { useClient } from '../api/client';
import { useFeedback } from '../api/feedback';
import { useApi } from '../api/useApi';
import { PageContainer } from '../components/PageContainer';
import { resizeImage } from '../resize';
import { scaleForCurrency, scaleOf } from '../scale';

type Filter = 'all' | ListingType;

// Listing photos (decision #14 phase 3): server caps at 5 per listing and
// 1MB each; the client downscales to a 1200px long edge before upload.
const MAX_LISTING_PHOTOS = 5;
const LISTING_PHOTO_EDGE = 1200;

// Search-as-you-type settles for this long before hitting GET /search (#18).
const SEARCH_DEBOUNCE_MS = 300;

/** "6 Jan 2027" — compact day-month-year for the listing expiry. */
function formatExpiry(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

export function Market() {
  const client = useClient();
  const { me } = useAuth();
  const { run, busy } = useApi();
  const feedback = useFeedback();
  const [filter, setFilter] = useState<Filter>('all');
  const [listings, setListings] = useState<Listing[] | null>(null);
  const [posting, setPosting] = useState(false);
  const [query, setQuery] = useState('');
  // Ids matched by the last search; null means no search is active so the
  // full browse shows. The browse data stays loaded — search only narrows it,
  // keeping photo/category rendering identical (#18).
  const [matchIds, setMatchIds] = useState<Set<string> | null>(null);

  const load = useCallback(async () => {
    const result = await run(() =>
      client.browse(filter === 'all' ? {} : { type: filter }),
    );
    if (result !== undefined) setListings(result.listings);
  }, [client, run, filter]);

  useEffect(() => {
    void load();
  }, [load]);

  // Debounced search-as-you-type (#18); empty text restores the full browse.
  useEffect(() => {
    const q = query.trim();
    if (q === '') {
      setMatchIds(null);
      return;
    }
    const timer = setTimeout(() => {
      void run(() => client.search('listings', q)).then((result) => {
        if (result !== undefined)
          setMatchIds(new Set(result.items.map((item) => item.id)));
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, client, run]);

  if (me === null) return null;

  const visible =
    listings === null
      ? null
      : matchIds === null
        ? listings
        : listings.filter((listing) => matchIds.has(listing.id));

  const renew = async (listing: Listing) => {
    const result = await run(() => client.renewListing(listing.id));
    if (result !== undefined) {
      feedback.show('Listing renewed', 'success');
      void load();
    }
  };

  return (
    <PageContainer title="Market">
      <ToggleButtonGroup
        exclusive
        fullWidth
        size="small"
        value={filter}
        onChange={(_event, value: Filter | null) => {
          if (value !== null) setFilter(value);
        }}
        sx={{ mb: 2 }}
      >
        <ToggleButton value="all">All</ToggleButton>
        <ToggleButton value="offer">Offers</ToggleButton>
        <ToggleButton value="want">Wants</ToggleButton>
      </ToggleButtonGroup>

      <TextField
        fullWidth
        size="small"
        placeholder="Search listings"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        sx={{ mb: 2 }}
        slotProps={{
          htmlInput: { 'aria-label': 'search listings' },
          input: {
            endAdornment:
              query === '' ? undefined : (
                <InputAdornment position="end">
                  <IconButton
                    size="small"
                    aria-label="clear search"
                    onClick={() => setQuery('')}
                  >
                    <CloseIcon fontSize="small" />
                  </IconButton>
                </InputAdornment>
              ),
          },
        }}
      />

      {visible === null ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', mt: 4 }}>
          <CircularProgress />
        </Box>
      ) : visible.length === 0 ? (
        <Typography color="text.secondary">
          {matchIds === null ? 'No listings yet.' : 'No matches'}
        </Typography>
      ) : (
        visible.map((listing) => (
          <Card key={listing.id} sx={{ mb: 2 }}>
            <CardContent>
              <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
                <Chip
                  size="small"
                  label={listing.type === 'offer' ? 'Offer' : 'Want'}
                  color={listing.type === 'offer' ? 'success' : 'info'}
                />
                <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
                  {listing.title}
                </Typography>
                {/* Admin-verified badges (#8) */}
                {listing.badges.map((badge) => (
                  <Chip
                    key={badge}
                    size="small"
                    variant="outlined"
                    color="success"
                    label={badge === 'professional' ? 'Professional' : 'Qualified'}
                  />
                ))}
              </Stack>
              {listing.priceAmount !== undefined ? (
                <Typography variant="body2" sx={{ mb: 0.5 }}>
                  {formatAmount(
                    listing.priceAmount,
                    scaleForCurrency(me.accounts, listing.priceCurrencyId),
                  )}
                </Typography>
              ) : listing.rateText !== undefined ? (
                <Typography variant="body2" sx={{ mb: 0.5 }}>
                  {listing.rateText}
                </Typography>
              ) : null}
              <Typography variant="body2" color="text.secondary">
                {listing.description}
              </Typography>
              {listing.memberId === me.member.id &&
                listing.expiresAt !== undefined && (
                  <Stack
                    direction="row"
                    spacing={1}
                    alignItems="center"
                    sx={{ mt: 1 }}
                  >
                    <Typography variant="body2" color="text.secondary">
                      Expires {formatExpiry(listing.expiresAt)}
                    </Typography>
                    <Button
                      size="small"
                      disabled={busy}
                      onClick={() => void renew(listing)}
                    >
                      Renew
                    </Button>
                  </Stack>
                )}
              <ListingPhotos
                listing={listing}
                own={listing.memberId === me.member.id}
                onChanged={() => void load()}
              />
            </CardContent>
          </Card>
        ))
      )}

      <Fab
        color="primary"
        aria-label="post listing"
        onClick={() => setPosting(true)}
        sx={{ position: 'fixed', right: 16, bottom: 72 }}
      >
        <AddIcon />
      </Fab>
      <PostListingDialog
        open={posting}
        onClose={() => setPosting(false)}
        onPosted={() => {
          setPosting(false);
          void load();
        }}
        priceAccount={me.accounts[0]}
      />
    </PageContainer>
  );
}

/** Thumbnail strip for a listing card; owners get add/remove controls. */
function ListingPhotos({
  listing,
  own,
  onChanged,
}: {
  listing: Listing;
  own: boolean;
  onChanged: () => void;
}) {
  const client = useClient();
  const { run, busy } = useApi();
  const feedback = useFeedback();
  const photoIds = listing.photoIds ?? [];

  const addPhoto = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = ''; // allow re-selecting the same file
    if (file === undefined) return;
    // Downscale client-side before upload (decision #14): the server only
    // validates, it never resizes. Listings use the 1200px cap, not 512.
    let resized;
    try {
      resized = await resizeImage(file, LISTING_PHOTO_EDGE);
    } catch {
      feedback.show('Could not read that image', 'error');
      return;
    }
    const result = await run(() =>
      client.addListingPhoto(listing.id, resized.blob, resized.mime),
    );
    if (result !== undefined) onChanged();
  };

  const removePhoto = async (imageId: string) => {
    const result = await run(() => client.removeListingPhoto(listing.id, imageId));
    if (result !== undefined) onChanged();
  };

  if (photoIds.length === 0 && !own) return null;

  return (
    <Stack direction="row" spacing={1} sx={{ mt: 1, overflowX: 'auto' }}>
      {photoIds.map((photoId) => (
        <Box key={photoId} sx={{ position: 'relative', flexShrink: 0 }}>
          <Box
            component="img"
            src={`/i/${photoId}`}
            alt=""
            loading="lazy"
            sx={{ height: 72, borderRadius: 1, display: 'block' }}
          />
          {own && (
            <IconButton
              size="small"
              aria-label="remove photo"
              disabled={busy}
              onClick={() => void removePhoto(photoId)}
              sx={{
                position: 'absolute',
                top: 2,
                right: 2,
                p: 0.25,
                bgcolor: 'background.paper',
                '&:hover': { bgcolor: 'background.paper' },
              }}
            >
              <CloseIcon sx={{ fontSize: 16 }} />
            </IconButton>
          )}
        </Box>
      ))}
      {own && photoIds.length < MAX_LISTING_PHOTOS && (
        <Button
          component="label"
          size="small"
          disabled={busy}
          startIcon={<AddPhotoAlternateIcon />}
          sx={{ flexShrink: 0, alignSelf: 'center' }}
        >
          Add photo
          <input
            hidden
            type="file"
            accept="image/*"
            onChange={(event) => void addPhoto(event)}
          />
        </Button>
      )}
    </Stack>
  );
}

function PostListingDialog({
  open,
  onClose,
  onPosted,
  priceAccount,
}: {
  open: boolean;
  onClose: () => void;
  onPosted: () => void;
  priceAccount: AccountSummary | undefined;
}) {
  const client = useClient();
  const { run, busy } = useApi();
  const feedback = useFeedback();
  const [categories, setCategories] = useState<Category[]>([]);
  const [type, setType] = useState<ListingType>('offer');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [priceText, setPriceText] = useState('');
  const [rateText, setRateText] = useState('');
  const [priceError, setPriceError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    void run(() => client.categories()).then((result) => {
      if (result !== undefined) setCategories(result.categories);
    });
  }, [open, client, run]);

  const submit = async () => {
    const input: ListingInput = { type, title, description, categoryId };
    if (priceText.trim() !== '') {
      let amount: number;
      try {
        amount = parseAmount(priceText, scaleOf(priceAccount));
      } catch (error) {
        setPriceError(error instanceof Error ? error.message : String(error));
        return;
      }
      input.priceAmount = amount;
      if (priceAccount !== undefined) input.priceCurrencyId = priceAccount.currencyId;
    } else if (rateText.trim() !== '') {
      input.rateText = rateText.trim();
    }
    setPriceError(null);
    const result = await run(() => client.postListing(input));
    if (result !== undefined) {
      feedback.show('Listing posted', 'success');
      setTitle('');
      setDescription('');
      setPriceText('');
      setRateText('');
      onPosted();
    }
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth>
      <DialogTitle>New listing</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <ToggleButtonGroup
            exclusive
            fullWidth
            size="small"
            value={type}
            onChange={(_event, value: ListingType | null) => {
              if (value !== null) setType(value);
            }}
          >
            <ToggleButton value="offer">Offer</ToggleButton>
            <ToggleButton value="want">Want</ToggleButton>
          </ToggleButtonGroup>
          <TextField
            label="Title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            required
          />
          <TextField
            label="Description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            multiline
            minRows={2}
          />
          <TextField
            select
            label="Category"
            value={categoryId}
            onChange={(event) => setCategoryId(event.target.value)}
            required
          >
            {categories.map((category) => (
              <MenuItem key={category.id} value={category.id}>
                {category.name}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            label="Price (optional)"
            value={priceText}
            onChange={(event) => setPriceText(event.target.value)}
            error={priceError !== null}
            helperText={priceError ?? 'Leave blank to use a rate instead'}
            slotProps={{ htmlInput: { inputMode: 'decimal' } }}
          />
          <TextField
            label="Rate (optional)"
            placeholder="e.g. 10/hour, negotiable"
            value={rateText}
            onChange={(event) => setRateText(event.target.value)}
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="contained"
          onClick={() => void submit()}
          disabled={busy || title.trim() === '' || categoryId === ''}
        >
          Post
        </Button>
      </DialogActions>
    </Dialog>
  );
}
