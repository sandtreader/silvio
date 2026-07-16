// Pay: Scan (camera QR via native BarcodeDetector, with paste fallback),
// Request (mint a signed payment-request QR), Manual (pick a member and pay).
// Decision #22: the QR payload is opaque and server-signed — the payee mints
// it via POST /me/payment-requests, the payer decodes it server-side for a
// *verified* payee name/amount, then commits via POST /payments/scan
// (idempotent per payload).
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Drawer from '@mui/material/Drawer';
import Autocomplete from '@mui/material/Autocomplete';
import Stack from '@mui/material/Stack';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { ApiError, formatAmount, parseAmount } from '@silvio/ui-shared';
import type {
  DecodedPaymentRequest,
  DirectoryMember,
  PayInput,
  PaymentRequestInput,
} from '@silvio/ui-shared';
import QRCode from 'qrcode';
import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../api/auth';
import { useClient } from '../api/client';
import { useFeedback } from '../api/feedback';
import { useApi } from '../api/useApi';
import { PageContainer } from '../components/PageContainer';
import { scaleForCurrency } from '../scale';

export function Pay() {
  const [tab, setTab] = useState(0);

  return (
    <PageContainer title="Pay">
      <Tabs
        value={tab}
        onChange={(_event, value: number) => setTab(value)}
        variant="fullWidth"
        sx={{ mb: 2 }}
      >
        <Tab label="Scan" />
        <Tab label="Request" />
        <Tab label="Manual" />
      </Tabs>
      {tab === 0 && <ScanTab />}
      {tab === 1 && <RequestTab />}
      {tab === 2 && <ManualTab />}
    </PageContainer>
  );
}

// --- Scan --------------------------------------------------------------------

const scannerSupported = () =>
  typeof window !== 'undefined' &&
  'BarcodeDetector' in window &&
  navigator.mediaDevices !== undefined;

/** A decoded, server-verified request plus the raw payload /payments/scan needs. */
interface ScannedRequest {
  payload: string;
  decoded: DecodedPaymentRequest;
}

// The server 400s on bad-signature / foreign-group / expired payloads (#22).
const INVALID_CODE_MESSAGE =
  "This code isn't valid here — it may be for another group or expired.";

function ScanTab() {
  const client = useClient();
  const feedback = useFeedback();
  const [scanned, setScanned] = useState<ScannedRequest | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [pasted, setPasted] = useState('');
  const [pasteError, setPasteError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const supported = scannerSupported();

  // Camera + detection loop: getUserMedia -> draw frames to a canvas ->
  // BarcodeDetector.detect every 500ms; a detected payload goes to the server
  // decode (#22) — one in flight at a time, rejected payloads not retried.
  useEffect(() => {
    if (!supported || scanned !== null) return;
    const video = videoRef.current;
    if (video === null) return;
    let cancelled = false;
    let stream: MediaStream | undefined;
    let timer: number | undefined;
    let decoding = false;
    let rejected: string | undefined;

    const start = async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
        });
      } catch {
        setCameraError('Camera unavailable — paste a payment code instead.');
        return;
      }
      if (cancelled) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      video.srcObject = stream;
      await video.play().catch(() => undefined);
      const detector = new BarcodeDetector({ formats: ['qr_code'] });
      const canvas = document.createElement('canvas');
      timer = window.setInterval(() => {
        if (video.readyState < 2 || video.videoWidth === 0) return;
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const context = canvas.getContext('2d');
        if (context === null) return;
        context.drawImage(video, 0, 0);
        detector
          .detect(canvas)
          .then((codes) => {
            const raw = codes[0]?.rawValue;
            if (raw === undefined || decoding || raw === rejected) return;
            decoding = true;
            client
              .decodePaymentRequest(raw)
              .then((decoded) => {
                if (!cancelled) setScanned({ payload: raw, decoded });
              })
              .catch(() => {
                rejected = raw; // the same QR stays in frame — don't re-ask
                if (!cancelled) feedback.show(INVALID_CODE_MESSAGE, 'error');
              })
              .finally(() => {
                decoding = false;
              });
          })
          .catch(() => undefined); // transient detection errors are fine
      }, 500);
    };
    void start();

    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearInterval(timer);
      stream?.getTracks().forEach((track) => track.stop());
      video.srcObject = null;
    };
  }, [supported, scanned, client, feedback]);

  const usePasted = async () => {
    const payload = pasted.trim();
    try {
      const decoded = await client.decodePaymentRequest(payload);
      setPasteError(null);
      setScanned({ payload, decoded });
    } catch (error) {
      if (error instanceof ApiError && error.status === 400) {
        setPasteError(INVALID_CODE_MESSAGE);
      } else {
        setPasteError(error instanceof Error ? error.message : String(error));
      }
    }
  };

  return (
    <Box>
      {supported && cameraError === null ? (
        <video
          ref={videoRef}
          muted
          playsInline
          style={{ width: '100%', borderRadius: 8, background: '#000' }}
        />
      ) : (
        <Typography color="text.secondary" sx={{ mb: 2 }}>
          {cameraError ??
            'QR scanning is not supported by this browser — paste a payment code instead.'}
        </Typography>
      )}
      <Stack spacing={1} sx={{ mt: 2 }}>
        <TextField
          label="Paste code"
          value={pasted}
          onChange={(event) => setPasted(event.target.value)}
          error={pasteError !== null}
          helperText={pasteError}
          multiline
          minRows={2}
        />
        <Button
          variant="outlined"
          onClick={() => void usePasted()}
          disabled={pasted.trim() === ''}
        >
          Use pasted code
        </Button>
      </Stack>
      <ConfirmPaySheet scanned={scanned} onDone={() => setScanned(null)} />
    </Box>
  );
}

/** Bottom sheet: server-verified payee name, amount and reference (#22).
 * Open-amount requests take the amount here; confirm -> POST /payments/scan. */
function ConfirmPaySheet({
  scanned,
  onDone,
}: {
  scanned: ScannedRequest | null;
  onDone: () => void;
}) {
  const client = useClient();
  const { me } = useAuth();
  const { run, busy } = useApi();
  const feedback = useFeedback();
  const [amountText, setAmountText] = useState('');
  const [amountError, setAmountError] = useState<string | null>(null);

  // Fresh open-amount entry for each new scan.
  useEffect(() => {
    setAmountText('');
    setAmountError(null);
  }, [scanned]);

  const decoded = scanned?.decoded;
  const scale = scaleForCurrency(me?.accounts, decoded?.currencyId);

  const confirm = async () => {
    if (scanned === null || decoded === undefined) return;
    let amount: number | undefined; // fixed amounts ride in the payload
    if (decoded.amount === undefined) {
      try {
        amount = parseAmount(amountText, scale);
      } catch (error) {
        setAmountError(error instanceof Error ? error.message : String(error));
        return;
      }
      if (amount <= 0) {
        setAmountError('Amount must be positive');
        return;
      }
      setAmountError(null);
    }
    const result = await run(() => client.scanPayment(scanned.payload, amount));
    if (result !== undefined) {
      feedback.show('Payment sent', 'success');
      onDone();
    }
  };

  return (
    <Drawer anchor="bottom" open={scanned !== null} onClose={onDone}>
      {decoded !== undefined && (
        <Box sx={{ p: 3, pb: 4 }}>
          <Typography variant="h6">Confirm payment</Typography>
          <Typography sx={{ mt: 1 }}>
            Pay <strong>{decoded.payeeName}</strong>
          </Typography>
          {decoded.amount !== undefined ? (
            <Typography variant="h4" sx={{ my: 1 }}>
              {formatAmount(decoded.amount, scale)}
            </Typography>
          ) : (
            <TextField
              label="Amount"
              value={amountText}
              onChange={(event) => setAmountText(event.target.value)}
              error={amountError !== null}
              helperText={amountError}
              slotProps={{ htmlInput: { inputMode: 'decimal' } }}
              fullWidth
              sx={{ my: 1 }}
            />
          )}
          {decoded.reference !== undefined && (
            <Typography color="text.secondary">{decoded.reference}</Typography>
          )}
          <Stack direction="row" spacing={2} sx={{ mt: 3 }}>
            <Button fullWidth onClick={onDone}>
              Cancel
            </Button>
            <Button
              fullWidth
              variant="contained"
              onClick={() => void confirm()}
              disabled={
                busy ||
                (decoded.amount === undefined && amountText.trim() === '')
              }
            >
              Pay
            </Button>
          </Stack>
        </Box>
      )}
    </Drawer>
  );
}

// --- Request -----------------------------------------------------------------

function RequestTab() {
  const client = useClient();
  const { me } = useAuth();
  const { run, busy } = useApi();
  const feedback = useFeedback();
  const [amountText, setAmountText] = useState('');
  const [description, setDescription] = useState('');
  const [amountError, setAmountError] = useState<string | null>(null);
  const [payload, setPayload] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const account = me?.accounts[0];

  // Mint the signed payload server-side (#22). Amount is optional: blank
  // means an open-amount code where the payer enters it.
  const generate = async () => {
    if (account === undefined) return;
    const input: PaymentRequestInput = { currencyId: account.currencyId };
    if (amountText.trim() !== '') {
      let amount: number;
      try {
        amount = parseAmount(amountText, account.scale);
      } catch (error) {
        setAmountError(error instanceof Error ? error.message : String(error));
        return;
      }
      if (amount <= 0) {
        setAmountError('Amount must be positive');
        return;
      }
      input.amount = amount;
    }
    setAmountError(null);
    if (description.trim() !== '') input.reference = description.trim();
    const result = await run(() => client.mintPaymentRequest(input));
    if (result !== undefined) setPayload(result.payload);
  };

  // Render the QR whenever the payload changes; the canvas is in the DOM
  // only while `payload` is set.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (payload === null || canvas === null) return;
    QRCode.toCanvas(canvas, payload, { width: 280, margin: 2 }).catch(
      (error: unknown) => {
        feedback.show(
          error instanceof Error ? error.message : String(error),
          'error',
        );
      },
    );
  }, [payload, feedback]);

  if (account === undefined) {
    return <Typography color="text.secondary">No account to receive into.</Typography>;
  }

  return (
    <Stack spacing={2}>
      <TextField
        label="Amount"
        value={amountText}
        onChange={(event) => setAmountText(event.target.value)}
        error={amountError !== null}
        helperText={amountError ?? 'Leave blank to let the payer enter the amount'}
        slotProps={{ htmlInput: { inputMode: 'decimal' } }}
      />
      <TextField
        label="Description"
        value={description}
        onChange={(event) => setDescription(event.target.value)}
      />
      <Button variant="contained" onClick={() => void generate()} disabled={busy}>
        Show QR code
      </Button>
      {payload !== null && (
        <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <canvas ref={canvasRef} aria-label="payment request QR code" />
          <Typography variant="caption" color="text.secondary">
            Ask the payer to scan this code, or copy the text below
          </Typography>
          <Typography
            variant="caption"
            sx={{ mt: 1, wordBreak: 'break-all', fontFamily: 'monospace' }}
          >
            {payload}
          </Typography>
        </Box>
      )}
    </Stack>
  );
}

// --- Manual ------------------------------------------------------------------

function ManualTab() {
  const client = useClient();
  const { me } = useAuth();
  const { run, busy } = useApi();
  const feedback = useFeedback();
  const [members, setMembers] = useState<DirectoryMember[]>([]);
  const [payeeId, setPayeeId] = useState('');
  const [amountText, setAmountText] = useState('');
  const [description, setDescription] = useState('');
  const [amountError, setAmountError] = useState<string | null>(null);

  useEffect(() => {
    void run(() => client.members()).then((result) => {
      if (result !== undefined) setMembers(result.members);
    });
  }, [client, run]);

  const account = me?.accounts[0];
  const choices = members.filter((member) => member.id !== me?.member.id);

  const submit = async () => {
    if (account === undefined) return;
    let amount: number;
    try {
      amount = parseAmount(amountText, account.scale);
    } catch (error) {
      setAmountError(error instanceof Error ? error.message : String(error));
      return;
    }
    if (amount <= 0) {
      setAmountError('Amount must be positive');
      return;
    }
    setAmountError(null);
    const input: PayInput = {
      payeeMemberId: payeeId,
      currencyId: account.currencyId,
      amount,
    };
    if (description.trim() !== '') input.description = description.trim();
    const result = await run(() => client.pay(input));
    if (result !== undefined) {
      feedback.show('Payment sent', 'success');
      setPayeeId('');
      setAmountText('');
      setDescription('');
    }
  };

  if (account === undefined) {
    return <Typography color="text.secondary">No account to pay from.</Typography>;
  }

  return (
    <Stack spacing={2}>
      {/* Autocomplete, not a select: the whole directory is loaded, so the
          picker must filter as you type rather than scroll hundreds. */}
      <Autocomplete
        options={choices}
        getOptionLabel={(member) => `#${member.memberNo} ${member.displayName}`}
        value={choices.find((member) => member.id === payeeId) ?? null}
        onChange={(_, chosen) => setPayeeId(chosen?.id ?? '')}
        renderInput={(params) => <TextField {...params} label="Pay to" />}
      />
      <TextField
        label="Amount"
        value={amountText}
        onChange={(event) => setAmountText(event.target.value)}
        error={amountError !== null}
        helperText={amountError}
        slotProps={{ htmlInput: { inputMode: 'decimal' } }}
      />
      <TextField
        label="Description"
        value={description}
        onChange={(event) => setDescription(event.target.value)}
      />
      <Button
        variant="contained"
        onClick={() => void submit()}
        disabled={busy || payeeId === '' || amountText.trim() === ''}
      >
        Pay
      </Button>
    </Stack>
  );
}
