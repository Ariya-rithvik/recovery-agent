/**
 * Stripe adapter — REST, no SDK, TEST MODE ONLY.
 *
 * Zero dependencies: Node's global fetch plus node:crypto. Every amount is in
 * cents, the unit Stripe uses. What this module does, and nothing more:
 *
 *   preflight()                 prove the key authenticates before using it
 *   mirrorFailedPayment(o)      create a test customer and a PaymentIntent that is
 *                               genuinely declined by one of Stripe's test cards,
 *                               then read the decline back from Stripe
 *   createRecoveryLink(o, cus)  a Stripe Checkout Session the customer can pay on
 *   verifyWebhook(...)          Stripe-Signature check (t=..., v1=...), constant time
 *   normalizeEvent(evt)         Stripe events -> the shapes featurise() consumes
 *
 * SAFETY
 *   - Refuses sk_live_ / rk_live_ keys before any network call. The batch is
 *     synthetic and must never touch real money.
 *   - Every POST carries an Idempotency-Key derived from the ledger key, so a
 *     re-run replays Stripe's first answer instead of creating a second object.
 *   - 429 and 5xx retry with backoff; 4xx never retries.
 *   - Errors carry Stripe's own message verbatim.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

const API = 'https://api.stripe.com';
const SALT = process.env.STRIPE_IDEMPOTENCY_SALT ?? 'v1';   // bump to re-create objects after changing params

export class StripeError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = 'StripeError';
    Object.assign(this, extra);
  }
}

/* ─────────────────────────────── credentials ─────────────────────────────── */

export function keyMode(key = process.env.STRIPE_SECRET_KEY) {
  if (!key) return 'missing';
  if (/^(sk|rk)_test_/.test(key)) return 'test';
  if (/^(sk|rk)_live_/.test(key)) return 'live';
  return 'unknown';
}

function requireTestKey() {
  const key = process.env.STRIPE_SECRET_KEY;
  const mode = keyMode(key);
  if (mode === 'missing') throw new StripeError('STRIPE_SECRET_KEY is not set', { configured: false });
  if (mode === 'live') {
    throw new StripeError('refusing a LIVE Stripe key (sk_live_): this agent runs on synthetic customers '
      + 'and must never touch real money. Use a test key (sk_test_).', { configured: true });
  }
  if (mode !== 'test') throw new StripeError('STRIPE_SECRET_KEY is not a Stripe test key (expected sk_test_...)', { configured: true });
  return key;
}

/* ─────────────────────────────── transport ─────────────────────────────── */

/**
 * Stripe takes form encoding with bracketed nesting:
 *   metadata[twin_id]=C1   line_items[0][price_data][currency]=usd
 */
export function formEncode(obj, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj ?? {})) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (item !== null && typeof item === 'object') formEncode(item, `${key}[${i}]`, out);
        else out.append(`${key}[${i}]`, String(item));
      });
    } else if (typeof v === 'object') {
      formEncode(v, key, out);
    } else {
      out.append(key, String(v));
    }
  }
  return out;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function stripeRequest(method, path, params, { idempotencyKey, attempts = 3 } = {}) {
  const key = requireTestKey();                       // before ANY network call
  const encoded = params ? formEncode(params).toString() : '';
  const url = API + path + (method === 'GET' && encoded ? '?' + encoded : '');

  for (let i = 1; ; i++) {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: 'Bearer ' + key,
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(method === 'POST' && idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
      body: method === 'GET' ? undefined : encoded,
      signal: AbortSignal.timeout(20000),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON error page */ }
    if (res.ok) return json;

    const e = json?.error ?? {};
    const retriable = res.status === 429 || res.status >= 500;
    if (retriable && i < attempts) { await sleep(250 * 2 ** i); continue; }
    throw new StripeError(e.message ?? `Stripe ${method} ${path} -> HTTP ${res.status}: ${text.slice(0, 200)}`, {
      status: res.status, type: e.type, code: e.code, decline_code: e.decline_code,
      payment_intent: e.payment_intent ?? null, retriable, configured: true,
    });
  }
}

/* ─────────────────────────────── preflight ─────────────────────────────── */

/**
 * A key with the right prefix and length can still be dead. Only a real call
 * tells them apart, so this is the first thing --live does.
 */
export async function preflight() {
  try {
    const bal = await stripeRequest('GET', '/v1/balance');
    if (bal?.livemode) return { ok: false, configured: true, reason: 'key authenticated but reports livemode=true; refusing' };
    return { ok: true, configured: true, mode: 'test' };
  } catch (e) {
    return { ok: false, configured: e.configured !== false, reason: e.message };
  }
}

/* ───────────────────────── a real decline, in test mode ───────────────────────── */

/**
 * Stripe's test PaymentMethods that decline on confirm, by decline code.
 * Two codes have no direct test card: authentication_required goes through the
 * off-session 3DS card, and issuer_not_available falls back to a processing
 * error. The intended code is always kept in metadata, and the code Stripe
 * ACTUALLY returned is what gets reported.
 */
export const TEST_DECLINES = {
  insufficient_funds: 'pm_card_visa_chargeDeclinedInsufficientFunds',
  lost_card: 'pm_card_visa_chargeDeclinedLostCard',
  expired_card: 'pm_card_chargeDeclinedExpiredCard',
  processing_error: 'pm_card_chargeDeclinedProcessingError',
  issuer_not_available: 'pm_card_chargeDeclinedProcessingError',
  generic_decline: 'pm_card_visa_chargeDeclined',
  authentication_required: 'pm_card_authenticationRequired',
};

const idem = (kind, o) => `${kind}:${o.key}:${SALT}`;

/**
 * Mirror one synthetic failed payment into the Stripe test account: a customer
 * tagged with the synthetic id, and a PaymentIntent that Stripe itself declines.
 * Then read it back — the decline code reported is Stripe's, not ours.
 */
export async function mirrorFailedPayment(o, { merchant = 'Acme Cloud' } = {}) {
  const customer = await stripeRequest('POST', '/v1/customers', {
    name: 'Synthetic customer ' + o.id,
    email: o.id.toLowerCase() + '@example.com',
    description: 'Synthetic customer mirrored by the recovery-agent demo',
    metadata: { twin_id: o.id, synthetic: 'true' },
  }, { idempotencyKey: idem('cus', o) });

  const offSession = o.reason === 'authentication_required';
  let pmId = TEST_DECLINES[o.reason] ?? TEST_DECLINES.generic_decline;
  if (offSession) {
    // 3DS-required card: attach it, then charge off-session so Stripe declines
    // with authentication_required instead of pausing for a challenge.
    const pm = await stripeRequest('POST', `/v1/payment_methods/${pmId}/attach`,
      { customer: customer.id }, { idempotencyKey: idem('attach', o) });
    pmId = pm.id;
  }

  let pi;
  try {
    pi = await stripeRequest('POST', '/v1/payment_intents', {
      amount: o.amount,
      currency: 'usd',
      customer: customer.id,
      payment_method: pmId,
      payment_method_types: ['card'],
      confirm: 'true',
      ...(offSession ? { off_session: 'true' } : {}),
      description: `${merchant} invoice ${o.invoice_id} (synthetic)`,
      metadata: { twin_id: o.id, invoice_ref: o.invoice_id, intended_decline: o.reason },
    }, { idempotencyKey: idem('pi', o) });
  } catch (e) {
    // A card_error IS the expected outcome here; anything else is a real failure.
    if (!e.payment_intent) throw e;
    pi = e.payment_intent;
  }

  // Read back from Stripe rather than trusting what the create call returned.
  const fresh = await stripeRequest('GET', `/v1/payment_intents/${pi.id}`);
  const err = fresh.last_payment_error ?? {};
  const declined = err.decline_code ?? err.code ?? null;

  let event = null;
  try {
    const evts = await stripeRequest('GET', '/v1/events', { type: 'payment_intent.payment_failed', limit: 25 });
    event = evts.data?.find(ev => ev.data?.object?.id === fresh.id)?.id ?? null;
  } catch { /* the event list is corroboration, not a requirement */ }

  return {
    customer: customer.id,
    payment_intent: fresh.id,
    status: fresh.status,
    decline_code: declined,
    stripe_message: err.message ?? null,
    intended: o.reason,
    matched: declined === o.reason,
    event,
  };
}

/**
 * The recovery link: a Checkout Session for the failed amount, on the same test
 * customer. The customer enters a card on Stripe's page — never by email or voice.
 */
export async function createRecoveryLink(o, customerId, { merchant = 'Acme Cloud' } = {}) {
  const cs = await stripeRequest('POST', '/v1/checkout/sessions', {
    mode: 'payment',
    customer: customerId,
    line_items: [{
      quantity: 1,
      price_data: { currency: 'usd', unit_amount: o.amount, product_data: { name: `${merchant} invoice ${o.invoice_id}` } },
    }],
    success_url: 'https://example.com/recovered?session_id={CHECKOUT_SESSION_ID}',
    metadata: { twin_id: o.id, invoice_ref: o.invoice_id },
    payment_intent_data: { metadata: { twin_id: o.id, recovers_invoice: o.invoice_id } },
  }, { idempotencyKey: idem('cs', o) });
  if (!cs?.url) throw new StripeError('Checkout Session created without a url', { configured: true });
  return { id: cs.id, url: cs.url };
}

/* ─────────────────────────────── webhooks ─────────────────────────────── */

/**
 * Stripe-Signature: t=<unix>,v1=<hex hmac>[,v1=<hex hmac>...]
 * HMAC-SHA256 over `${t}.${rawBody}` with the endpoint secret. Several v1 values
 * appear during secret rotation; any one matching is enough. The timestamp
 * tolerance is the replay protection.
 */
export function verifyWebhook(rawBody, header, secret, { toleranceSec = 300, now = Math.floor(Date.now() / 1000) } = {}) {
  if (!rawBody || !header || !secret) return { valid: false, reason: 'missing body, header or secret' };

  const parts = String(header).split(',').map(p => p.trim().split('='));
  const t = Number(parts.find(([k]) => k === 't')?.[1]);
  const sigs = parts.filter(([k]) => k === 'v1').map(([, v]) => v ?? '');
  if (!Number.isFinite(t) || !sigs.length) return { valid: false, reason: 'malformed Stripe-Signature header' };
  if (Math.abs(now - t) > toleranceSec) return { valid: false, reason: 'timestamp outside tolerance (possible replay)' };

  const expected = createHmac('sha256', secret).update(t + '.').update(rawBody).digest();
  const valid = sigs.some(s => /^[0-9a-f]+$/i.test(s) && s.length === expected.length * 2
    && timingSafeEqual(Buffer.from(s, 'hex'), expected));
  if (!valid) return { valid: false, reason: 'no v1 signature matches' };

  let event = null;
  try { event = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody); } catch { /* keep null */ }
  return { valid: true, event };
}

/** Test helper and local simulator: produce the header Stripe would send. */
export function signPayload(rawBody, secret, t = Math.floor(Date.now() / 1000)) {
  const sig = createHmac('sha256', secret).update(t + '.').update(rawBody).digest('hex');
  return `t=${t},v1=${sig}`;
}

/**
 * Stripe events -> the event shapes the behavioural twin uses. A declined
 * PaymentIntent is normalised to the same invoice.payment_failed shape, because
 * featurise() cares about the failure, not which Stripe object carried it.
 */
export function normalizeEvent(evt) {
  const o = evt?.data?.object ?? {};
  const base = { stripe_event: evt?.id ?? null, id: o.id, customer: o.customer ?? null, twin_id: o.metadata?.twin_id ?? null };
  switch (evt?.type) {
    case 'payment_intent.payment_failed':
      return { ...base, type: 'invoice.payment_failed', amount: o.amount, method: 'card',
        reason: o.last_payment_error?.decline_code ?? o.last_payment_error?.code ?? 'unknown' };
    case 'invoice.payment_failed':
      return { ...base, type: 'invoice.payment_failed', amount: o.amount_due, method: 'card', reason: 'unknown' };
    case 'payment_intent.succeeded':
      return { ...base, type: 'invoice.paid', amount: o.amount_received ?? o.amount, method: 'card' };
    case 'invoice.paid':
      return { ...base, type: 'invoice.paid', amount: o.amount_paid, method: 'card' };
    case 'checkout.session.completed':
    case 'checkout.session.expired':
      return { ...base, type: evt.type, abandoned: evt.type.endsWith('expired') };
    default:
      return null;
  }
}
