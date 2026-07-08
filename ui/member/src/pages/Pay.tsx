// Pay: Scan (camera QR via native BarcodeDetector, with paste fallback),
// Request (generate a payment-request QR), Manual (pick a member and pay).
// Decision #5: the QR is an invoice — payee shows {payee, amount, reference},
// payer scans and authorises; v1 commits via a direct POST /payments.
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Drawer from '@mui/material/Drawer';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { formatAmount, parseAmount } from '@silvio/ui-shared';
import type { DirectoryMember, PayInput } from '@silvio/ui-shared';
import QRCode from 'qrcode';
import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../api/auth';
import { useClient } from '../api/client';
import { useFeedback } from '../api/feedback';
import { useApi } from '../api/useApi';
import { PageContainer } from '../components/PageContainer';
import { decodeRequest, encodeRequest } from '../pay/request';
import type { PaymentRequest } from '../pay/request';
import { DEFAULT_SCALE } from '../scale';

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

function ScanTab() {
  const [request, setRequest] = useState<PaymentRequest | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [pasted, setPasted] = useState('');
  const [pasteError, setPasteError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const supported = scannerSupported();

  // Camera + detection loop: getUserMedia -> draw frames to a canvas ->
  // BarcodeDetector.detect every 500ms until a valid request is seen.
  useEffect(() => {
    if (!supported || request !== null) return;
    const video = videoRef.current;
    if (video === null) return;
    let cancelled = false;
    let stream: MediaStream | undefined;
    let timer: number | undefined;

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
            if (raw === undefined) return;
            const decoded = decodeRequest(raw);
            if (decoded !== null) setRequest(decoded);
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
  }, [supported, request]);

  const usePasted = () => {
    const decoded = decodeRequest(pasted.trim());
    if (decoded === null) {
      setPasteError('Not a valid Silvio payment code');
      return;
    }
    setPasteError(null);
    setRequest(decoded);
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
          onClick={usePasted}
          disabled={pasted.trim() === ''}
        >
          Use pasted code
        </Button>
      </Stack>
      <ConfirmPaySheet request={request} onDone={() => setRequest(null)} />
    </Box>
  );
}

/** Bottom sheet: resolve payee name, show amount, confirm -> POST /payments. */
function ConfirmPaySheet({
  request,
  onDone,
}: {
  request: PaymentRequest | null;
  onDone: () => void;
}) {
  const client = useClient();
  const { run, busy } = useApi();
  const feedback = useFeedback();
  const [payeeName, setPayeeName] = useState<string | null>(null);

  useEffect(() => {
    if (request === null) return;
    setPayeeName(null);
    void run(() => client.members()).then((result) => {
      const found = result?.members.find((member) => member.id === request.payee);
      if (found !== undefined) setPayeeName(`#${found.memberNo} ${found.displayName}`);
    });
  }, [request, client, run]);

  const confirm = async () => {
    if (request === null) return;
    const input: PayInput = {
      payeeMemberId: request.payee,
      currencyId: request.currencyId,
      amount: request.amount,
    };
    if (request.reference !== undefined) input.description = request.reference;
    const result = await run(() => client.pay(input));
    if (result !== undefined) {
      feedback.show('Payment sent', 'success');
      onDone();
    }
  };

  return (
    <Drawer anchor="bottom" open={request !== null} onClose={onDone}>
      {request !== null && (
        <Box sx={{ p: 3, pb: 4 }}>
          <Typography variant="h6">Confirm payment</Typography>
          <Typography sx={{ mt: 1 }}>
            Pay <strong>{payeeName ?? request.payee}</strong>
          </Typography>
          <Typography variant="h4" sx={{ my: 1 }}>
            {formatAmount(request.amount, DEFAULT_SCALE)}
          </Typography>
          {request.reference !== undefined && (
            <Typography color="text.secondary">{request.reference}</Typography>
          )}
          <Stack direction="row" spacing={2} sx={{ mt: 3 }}>
            <Button fullWidth onClick={onDone}>
              Cancel
            </Button>
            <Button
              fullWidth
              variant="contained"
              onClick={() => void confirm()}
              disabled={busy}
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
  const { me } = useAuth();
  const feedback = useFeedback();
  const [amountText, setAmountText] = useState('');
  const [description, setDescription] = useState('');
  const [amountError, setAmountError] = useState<string | null>(null);
  const [encoded, setEncoded] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const account = me?.accounts[0];

  const generate = () => {
    if (me === null || account === undefined) return;
    let amount: number;
    try {
      amount = parseAmount(amountText, DEFAULT_SCALE);
    } catch (error) {
      setAmountError(error instanceof Error ? error.message : String(error));
      return;
    }
    if (amount <= 0) {
      setAmountError('Amount must be positive');
      return;
    }
    setAmountError(null);
    const request: PaymentRequest = {
      v: 1,
      kind: 'silvio-request',
      payee: me.member.id,
      amount,
      currencyId: account.currencyId,
    };
    if (description.trim() !== '') request.reference = description.trim();
    setEncoded(encodeRequest(request));
  };

  // Render the QR whenever the payload changes; the canvas is in the DOM
  // only while `encoded` is set.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (encoded === null || canvas === null) return;
    QRCode.toCanvas(canvas, encoded, { width: 280, margin: 2 }).catch(
      (error: unknown) => {
        feedback.show(
          error instanceof Error ? error.message : String(error),
          'error',
        );
      },
    );
  }, [encoded, feedback]);

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
        onClick={generate}
        disabled={amountText.trim() === ''}
      >
        Show QR code
      </Button>
      {encoded !== null && (
        <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <canvas ref={canvasRef} aria-label="payment request QR code" />
          <Typography variant="caption" color="text.secondary">
            Ask the payer to scan this code
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
      amount = parseAmount(amountText, DEFAULT_SCALE);
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
      <TextField
        select
        label="Pay to"
        value={payeeId}
        onChange={(event) => setPayeeId(event.target.value)}
      >
        {choices.map((member) => (
          <MenuItem key={member.id} value={member.id}>
            #{member.memberNo} {member.displayName}
          </MenuItem>
        ))}
      </TextField>
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
