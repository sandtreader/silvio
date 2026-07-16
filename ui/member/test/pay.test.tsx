// Pay page, signed QR flow (#22): Request mints an opaque payload server-side
// and shows it as QR + copyable text; Scan decodes it server-side for a
// verified confirm screen (trusted payee name) and pays via /payments/scan.
// jsdom has no BarcodeDetector, so Scan exercises the paste fallback.
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@silvio/ui-shared';
import QRCode from 'qrcode';
import { Pay } from '../src/pages/Pay';
import { renderWithClient, testMe } from './helpers';

// jsdom has no canvas 2D context; assert the payload reaches the renderer.
vi.mock('qrcode', () => ({
  default: { toCanvas: vi.fn().mockResolvedValue(undefined) },
}));

const fixedDecoded = {
  payeeMemberId: 'm2',
  payeeName: '#3 Bob',
  currencyId: 'c1',
  amount: 1500,
  reference: 'veg box',
};

describe('Pay: Request tab', () => {
  it('mints a signed payload and renders it as QR plus copyable text', async () => {
    const client = {
      me: vi.fn().mockResolvedValue(testMe),
      mintPaymentRequest: vi.fn().mockResolvedValue({ payload: 'abc.sig' }),
    };
    renderWithClient(<Pay />, client);

    fireEvent.click(await screen.findByRole('tab', { name: 'Request' }));
    fireEvent.change(await screen.findByLabelText(/Amount/), {
      target: { value: '15.00' },
    });
    fireEvent.change(screen.getByLabelText(/Description/), {
      target: { value: 'veg box' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Show QR code' }));

    await waitFor(() =>
      expect(client.mintPaymentRequest).toHaveBeenCalledWith({
        currencyId: 'c1',
        amount: 1500, // minor units at the account's scale (2)
        reference: 'veg box',
      }),
    );
    // The opaque payload shows as a QR and as copyable text.
    expect(await screen.findByText('abc.sig')).toBeTruthy();
    expect(screen.getByLabelText('payment request QR code')).toBeTruthy();
    await waitFor(() =>
      expect(vi.mocked(QRCode.toCanvas)).toHaveBeenCalledWith(
        expect.anything(),
        'abc.sig',
        expect.anything(),
      ),
    );
  });

  it('mints an open-amount code when the amount is left blank', async () => {
    const client = {
      me: vi.fn().mockResolvedValue(testMe),
      mintPaymentRequest: vi.fn().mockResolvedValue({ payload: 'open.sig' }),
    };
    renderWithClient(<Pay />, client);

    fireEvent.click(await screen.findByRole('tab', { name: 'Request' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Show QR code' }));

    await waitFor(() =>
      expect(client.mintPaymentRequest).toHaveBeenCalledWith({ currencyId: 'c1' }),
    );
    expect(await screen.findByText('open.sig')).toBeTruthy();
  });
});

describe('Pay: Scan tab', () => {
  it('decodes a pasted payload, shows the verified payee, and pays on confirm', async () => {
    const client = {
      me: vi.fn().mockResolvedValue(testMe),
      decodePaymentRequest: vi.fn().mockResolvedValue(fixedDecoded),
      scanPayment: vi.fn().mockResolvedValue({ transaction: { id: 'tx-1' } }),
    };
    renderWithClient(<Pay />, client);

    fireEvent.change(await screen.findByLabelText(/Paste code/), {
      target: { value: 'abc.sig' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Use pasted code' }));
    await waitFor(() =>
      expect(client.decodePaymentRequest).toHaveBeenCalledWith('abc.sig'),
    );

    // The confirm sheet shows the server-verified name, amount and reference.
    expect(await screen.findByText('#3 Bob')).toBeTruthy();
    expect(screen.getByText('15.00')).toBeTruthy();
    expect(screen.getByText('veg box')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Pay' }));
    // Fixed amount rides in the payload — none sent alongside.
    await waitFor(() =>
      expect(client.scanPayment).toHaveBeenCalledWith('abc.sig', undefined),
    );
    expect(await screen.findByText('Payment sent')).toBeTruthy();
  });

  it('asks for the amount on an open-amount code and sends it', async () => {
    const client = {
      me: vi.fn().mockResolvedValue(testMe),
      decodePaymentRequest: vi.fn().mockResolvedValue({
        payeeMemberId: 'm2',
        payeeName: '#3 Bob',
        currencyId: 'c1',
      }),
      scanPayment: vi.fn().mockResolvedValue({ transaction: { id: 'tx-2' } }),
    };
    renderWithClient(<Pay />, client);

    fireEvent.change(await screen.findByLabelText(/Paste code/), {
      target: { value: 'open.sig' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Use pasted code' }));
    expect(await screen.findByText('#3 Bob')).toBeTruthy();

    // No amount yet: Pay stays disabled until the payer enters one.
    const pay = screen.getByRole('button', { name: 'Pay' });
    expect(pay.hasAttribute('disabled')).toBe(true);
    fireEvent.change(screen.getByLabelText(/Amount/), {
      target: { value: '12.50' },
    });
    expect(pay.hasAttribute('disabled')).toBe(false);

    fireEvent.click(pay);
    await waitFor(() =>
      expect(client.scanPayment).toHaveBeenCalledWith('open.sig', 1250),
    );
  });

  it('rejects an invalid payload with a clear message', async () => {
    const client = {
      me: vi.fn().mockResolvedValue(testMe),
      decodePaymentRequest: vi
        .fn()
        .mockRejectedValue(new ApiError('INVALID_PAYLOAD', 'bad signature', 400)),
      scanPayment: vi.fn(),
    };
    renderWithClient(<Pay />, client);

    fireEvent.change(await screen.findByLabelText(/Paste code/), {
      target: { value: 'not-a-real-code' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Use pasted code' }));

    expect(await screen.findByText(/isn't valid here/)).toBeTruthy();
    // No confirm sheet, nothing paid.
    expect(screen.queryByText('Confirm payment')).toBeNull();
    expect(client.scanPayment).not.toHaveBeenCalled();
  });
});

describe('Pay: Manual tab', () => {
  const directory = {
    members: [
      { id: 'm1', memberNo: 7, displayName: 'Alice' }, // the payer: excluded
      { id: 'm2', memberNo: 2, displayName: 'Bob Jones' },
      { id: 'm3', memberNo: 3, displayName: 'Kavita Baker' },
      { id: 'm4', memberNo: 4, displayName: 'Zoe Ward' },
    ],
  };

  it('filters the pay-to picker live by typing, then pays the choice', async () => {
    const client = {
      me: vi.fn().mockResolvedValue(testMe),
      members: vi.fn().mockResolvedValue(directory),
      pay: vi.fn().mockResolvedValue({ transaction: { id: 't1' } }),
    };
    renderWithClient(<Pay />, client);
    fireEvent.click(await screen.findByRole('tab', { name: 'Manual' }));

    // Typing filters the member list live (fireEvent.change can't drive an
    // MUI Autocomplete — it needs real keystrokes).
    const input = await screen.findByLabelText(/Pay to/);
    await userEvent.type(input, 'kav');
    expect(await screen.findByText('#3 Kavita Baker')).toBeTruthy();
    expect(screen.queryByText('#2 Bob Jones')).toBeNull();

    await userEvent.click(screen.getByText('#3 Kavita Baker'));
    fireEvent.change(screen.getByLabelText(/Amount/), { target: { value: '5.00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Pay' }));

    await waitFor(() =>
      expect(client.pay).toHaveBeenCalledWith({
        payeeMemberId: 'm3',
        currencyId: 'c1',
        amount: 500,
      }),
    );
  });
});
