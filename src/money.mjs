/**
 * Money is carried in cents everywhere, because that is what Stripe sends and
 * accepts. This is the one place a cent value becomes a string.
 *
 * Under $1,000 the cents are shown, so a $1.50 call cost is not rounded to $2.
 * Above it they are dropped, so batch totals stay readable.
 */
export function usd(cents) {
  const n = (Number(cents) || 0) / 100;
  if (Math.abs(n) < 0.005) return '$0.00';
  const abs = Math.abs(n);
  const body = abs >= 1000 ? Math.round(abs).toLocaleString('en-US') : abs.toFixed(2);
  return (n < 0 ? '-' : '') + '$' + body;
}
