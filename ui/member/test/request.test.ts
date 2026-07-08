// QR payment-request payload round-trip and strict decoding.
import { describe, expect, it } from 'vitest';
import { decodeRequest, encodeRequest } from '../src/pay/request';

describe('payment request payload', () => {
  it('round-trips', () => {
    const request = {
      v: 1 as const,
      kind: 'silvio-request' as const,
      payee: 'm1',
      amount: 1500,
      currencyId: 'c1',
      reference: 'veg box',
    };
    expect(decodeRequest(encodeRequest(request))).toEqual(request);
  });

  it('rejects junk', () => {
    expect(decodeRequest('not json')).toBeNull();
    expect(decodeRequest('{}')).toBeNull();
    expect(decodeRequest('"hello"')).toBeNull();
    expect(
      decodeRequest(
        JSON.stringify({ v: 2, kind: 'silvio-request', payee: 'm1', amount: 1, currencyId: 'c1' }),
      ),
    ).toBeNull();
    expect(
      decodeRequest(
        JSON.stringify({ v: 1, kind: 'silvio-request', payee: 'm1', amount: 1.5, currencyId: 'c1' }),
      ),
    ).toBeNull();
    expect(
      decodeRequest(
        JSON.stringify({ v: 1, kind: 'silvio-request', payee: 'm1', amount: -5, currencyId: 'c1' }),
      ),
    ).toBeNull();
  });
});
