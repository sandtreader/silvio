// The QR payment-request payload (decision #5: a QR is an invoice — payee
// shows {payee, amount, reference}, payer scans and authorises). v1 commits
// the payment directly via POST /payments; payload signing is a server todo,
// so the payload is plain JSON for now.

export interface PaymentRequest {
  v: 1;
  kind: 'silvio-request';
  /** Payee member id. */
  payee: string;
  /** Minor units, positive. */
  amount: number;
  currencyId: string;
  reference?: string;
}

export function encodeRequest(request: PaymentRequest): string {
  return JSON.stringify(request);
}

/** Strictly parse scanned/pasted text; null for anything else. */
export function decodeRequest(text: string): PaymentRequest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (record['v'] !== 1 || record['kind'] !== 'silvio-request') return null;
  const payee = record['payee'];
  const amount = record['amount'];
  const currencyId = record['currencyId'];
  if (typeof payee !== 'string' || payee === '') return null;
  if (typeof currencyId !== 'string' || currencyId === '') return null;
  if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount <= 0) {
    return null;
  }
  const request: PaymentRequest = {
    v: 1,
    kind: 'silvio-request',
    payee,
    amount,
    currencyId,
  };
  const reference = record['reference'];
  if (typeof reference === 'string' && reference !== '') {
    request.reference = reference;
  }
  return request;
}
