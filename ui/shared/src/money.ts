// Money display and entry. Amounts are integer minor units (decision #6);
// conversion to and from decimal text is pure string arithmetic — never
// float multiplication or division, which mangles classics like 1.15 * 100.

/**
 * Format integer minor units as a plain decimal string.
 * formatAmount(-12345, 2) === '-123.45'; formatAmount(-12345, 0) === '-12345'.
 */
export function formatAmount(minorUnits: number, scale: number): string {
  if (!Number.isSafeInteger(minorUnits)) {
    throw new RangeError(`amount must be a safe integer, got ${minorUnits}`);
  }
  if (!Number.isInteger(scale) || scale < 0) {
    throw new RangeError(`scale must be a non-negative integer, got ${scale}`);
  }
  const sign = minorUnits < 0 ? '-' : '';
  const digits = Math.abs(minorUnits).toString();
  if (scale === 0) return sign + digits;
  const padded = digits.padStart(scale + 1, '0');
  const whole = padded.slice(0, padded.length - scale);
  const fraction = padded.slice(padded.length - scale);
  return `${sign}${whole}.${fraction}`;
}

/**
 * Parse decimal text into integer minor units. Accepts '123.45', '123',
 * '-5', '.5', '5.'; throws RangeError on non-numeric input or more decimal
 * places than the scale allows.
 */
export function parseAmount(text: string, scale: number): number {
  if (!Number.isInteger(scale) || scale < 0) {
    throw new RangeError(`scale must be a non-negative integer, got ${scale}`);
  }
  const match = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))$/.exec(text.trim());
  if (match === null) {
    throw new RangeError(`not a valid amount: '${text}'`);
  }
  const sign = match[1] === '-' ? -1 : 1;
  const whole = match[2] ?? '';
  const fraction = match[3] ?? match[4] ?? '';
  if (fraction.length > scale) {
    throw new RangeError(
      `too many decimal places in '${text}': at most ${scale} allowed`,
    );
  }
  const minor = Number((whole || '0') + fraction.padEnd(scale, '0'));
  if (!Number.isSafeInteger(minor)) {
    throw new RangeError(`amount out of range: '${text}'`);
  }
  return sign * minor;
}
