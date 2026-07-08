import { describe, expect, it } from 'vitest';
import { formatAmount, parseAmount } from '../src/money.js';

describe('formatAmount', () => {
  it('formats scale-2 amounts', () => {
    expect(formatAmount(12345, 2)).toBe('123.45');
    expect(formatAmount(-12345, 2)).toBe('-123.45');
    expect(formatAmount(100, 2)).toBe('1.00');
    expect(formatAmount(1, 2)).toBe('0.01');
    expect(formatAmount(-1, 2)).toBe('-0.01');
    expect(formatAmount(0, 2)).toBe('0.00');
  });

  it('formats scale-0 amounts as plain integers', () => {
    expect(formatAmount(-12345, 0)).toBe('-12345');
    expect(formatAmount(0, 0)).toBe('0');
    expect(formatAmount(7, 0)).toBe('7');
  });

  it('handles other scales', () => {
    expect(formatAmount(5, 3)).toBe('0.005');
    expect(formatAmount(-1234567, 4)).toBe('-123.4567');
  });

  it('avoids float traps by using string arithmetic', () => {
    // 1.15 * 100 === 114.99999999999999 — must still format exactly
    expect(formatAmount(115, 2)).toBe('1.15');
    expect(formatAmount(999999999999999, 2)).toBe('9999999999999.99');
  });

  it('rejects non-integer and unsafe amounts', () => {
    expect(() => formatAmount(1.5, 2)).toThrow(RangeError);
    expect(() => formatAmount(Number.MAX_SAFE_INTEGER + 1, 2)).toThrow(RangeError);
    expect(() => formatAmount(NaN, 2)).toThrow(RangeError);
  });

  it('rejects bad scales', () => {
    expect(() => formatAmount(100, -1)).toThrow(RangeError);
    expect(() => formatAmount(100, 1.5)).toThrow(RangeError);
  });
});

describe('parseAmount', () => {
  it('parses decimal text at scale 2', () => {
    expect(parseAmount('123.45', 2)).toBe(12345);
    expect(parseAmount('123', 2)).toBe(12300);
    expect(parseAmount('-5', 2)).toBe(-500);
    expect(parseAmount('0.01', 2)).toBe(1);
    expect(parseAmount('-0.01', 2)).toBe(-1);
    expect(parseAmount('0', 2)).toBe(0);
  });

  it('parses at scale 0', () => {
    expect(parseAmount('123', 0)).toBe(123);
    expect(parseAmount('-45', 0)).toBe(-45);
  });

  it('accepts short fractions, bare points and leading points', () => {
    expect(parseAmount('1.5', 2)).toBe(150);
    expect(parseAmount('.5', 2)).toBe(50);
    expect(parseAmount('5.', 2)).toBe(500);
    expect(parseAmount('+2.50', 2)).toBe(250);
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseAmount('  12.34 ', 2)).toBe(1234);
  });

  it('avoids float traps', () => {
    expect(parseAmount('1.15', 2)).toBe(115); // 1.15 * 100 !== 115 in floats
    expect(parseAmount('0.29', 2)).toBe(29);
    expect(parseAmount('9999999999999.99', 2)).toBe(999999999999999);
  });

  it('rejects too many decimal places', () => {
    expect(() => parseAmount('1.234', 2)).toThrow(RangeError);
    expect(() => parseAmount('1.5', 0)).toThrow(RangeError);
  });

  it('rejects non-numeric input', () => {
    for (const bad of ['', ' ', 'abc', '1,50', '1.2.3', '--5', '1e3', '£5', '.']) {
      expect(() => parseAmount(bad, 2), `input '${bad}'`).toThrow(RangeError);
    }
  });

  it('rejects unsafe magnitudes', () => {
    expect(() => parseAmount('99999999999999999', 2)).toThrow(RangeError);
  });

  it('round-trips with formatAmount', () => {
    for (const [minor, scale] of [
      [12345, 2],
      [-12345, 2],
      [0, 2],
      [1, 2],
      [-7, 0],
      [5, 3],
      [999999999999999, 2],
    ] as const) {
      expect(parseAmount(formatAmount(minor, scale), scale)).toBe(minor);
    }
  });
});
