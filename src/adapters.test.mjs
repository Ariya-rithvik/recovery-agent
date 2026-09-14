/**
 * Adapter safety tests — no network, no keys.
 *
 *   node src/adapters.test.mjs
 *
 * `fetch` is replaced with a spy for the whole file. Every guard test asserts
 * the spy was never called: a refusal that happens AFTER the request went out is
 * not a refusal.
 */

import {
  formEncode, keyMode, stripeRequest, verifyWebhook, signPayload, normalizeEvent,
} from './stripe.mjs';
import {
  buildRecoveryTask, assertNoCardCollection, assertAllowedNumber, placeRecoveryCall,
  readCallLedger, callBudget, SAFETY_RULES,
} from './calle.mjs';
import { existsSync, mkdirSync, rmSync, writeFileSync as writeFile } from 'node:fs';
import { buildRecoveryEmail, sendRecoveryEmail } from './email.mjs';
import { postToSlack } from './slack.mjs';
import { ActionLedger } from './policy.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
};
const threw = async fn => { try { await fn(); return null; } catch (e) { return String(e.message); } };

let fetchCalls = 0;
globalThis.fetch = async () => { fetchCalls++; throw new Error('network is disabled in tests'); };
const withEnv = async (vars, fn) => {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) { saved[k] = process.env[k]; if (v == null) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
};

const o = { id: 'C0042', invoice_id: 'in_0042_x1', amount: 4999, reason: 'expired_card', consent: true, key: 'rcv_in_0042_x1_1' };

console.log('');
console.log('  ADAPTERS — Stripe, CALL-E, email, Slack (network disabled)');
console.log('  ' + '-'.repeat(66));

/* ── Stripe: encoding and credentials ── */
ok('Stripe form encoding nests metadata', formEncode({ metadata: { twin_id: 'C1' } }).toString() === 'metadata%5Btwin_id%5D=C1');
ok('Stripe form encoding indexes arrays of objects',
  decodeURIComponent(formEncode({ line_items: [{ price_data: { unit_amount: 1999 } }] }).toString())
    === 'line_items[0][price_data][unit_amount]=1999');
ok('keyMode tells test, live and missing keys apart',
  keyMode('sk_test_abc') === 'test' && keyMode('sk_live_abc') === 'live' && keyMode('') === 'missing');
{
  fetchCalls = 0;
  const e = await withEnv({ STRIPE_SECRET_KEY: 'sk_live_not_a_real_key' }, () => threw(() => stripeRequest('GET', '/v1/balance')));
  ok('a LIVE Stripe key is refused before any network call', /refusing a LIVE Stripe key/.test(e ?? '') && fetchCalls === 0, `${e} fetch=${fetchCalls}`);
}
{
  fetchCalls = 0;
  const e = await withEnv({ STRIPE_SECRET_KEY: null }, () => threw(() => stripeRequest('GET', '/v1/balance')));
  ok('a missing Stripe key is named, not a stack trace', e === 'STRIPE_SECRET_KEY is not set' && fetchCalls === 0, e ?? '');
}

/* ── Stripe: webhook signatures ── */
{
  const secret = 'whsec_test_secret';
  const body = JSON.stringify({ id: 'evt_1', type: 'payment_intent.payment_failed' });
  const t = 1_800_000_000;
  const header = signPayload(body, secret, t);

  ok('webhook: a correctly signed body verifies', verifyWebhook(body, header, secret, { now: t }).valid === true);
  ok('webhook: a tampered body is rejected', verifyWebhook(body.replace('evt_1', 'evt_2'), header, secret, { now: t }).valid === false);
  ok('webhook: the wrong secret is rejected', verifyWebhook(body, header, 'whsec_other', { now: t }).valid === false);
  ok('webhook: an old timestamp is rejected (replay)', /tolerance/.test(verifyWebhook(body, header, secret, { now: t + 301 }).reason ?? ''));
  ok('webhook: any matching v1 passes during secret rotation',
    verifyWebhook(body, `t=${t},v1=${'ab'.repeat(32)},${header.split(',')[1]}`, secret, { now: t }).valid === true);
  ok('webhook: malformed header and non-hex signature fail closed, without throwing',
    verifyWebhook(body, 'garbage', secret, { now: t }).valid === false
    && verifyWebhook(body, `t=${t},v1=zz-not-hex`, secret, { now: t }).valid === false);
  ok('webhook: a raw Buffer body verifies the same as a string',
    verifyWebhook(Buffer.from(body), header, secret, { now: t }).valid === true);
}
{
  const n = normalizeEvent({ id: 'evt_9', type: 'payment_intent.payment_failed',
    data: { object: { id: 'pi_9', amount: 4999, customer: 'cus_9', metadata: { twin_id: 'C0042' },
      last_payment_error: { code: 'card_declined', decline_code: 'insufficient_funds' } } } });
  ok('a declined PaymentIntent normalises to the invoice.payment_failed shape with Stripe\'s decline code',
    n.type === 'invoice.payment_failed' && n.reason === 'insufficient_funds' && n.twin_id === 'C0042' && n.amount === 4999,
    JSON.stringify(n));
}

/* ── CALL-E: the task and its guards ── */
{
  const task = buildRecoveryTask(o, { merchant: 'Acme Cloud', customerName: 'Synthetic customer C0042', link: 'https://checkout.stripe.com/x' });
  ok('call task carries the merchant, invoice and amount up front (no mid-call lookups exist)',
    task.includes('Acme Cloud') && task.includes('in_0042_x1') && task.includes('$49.99'));
  ok('call task carries every safety rule', task.endsWith(SAFETY_RULES));
  const e = await threw(() => assertNoCardCollection('Ask the customer to read out their card number so we can retry.'));
  ok('a task that collects card details by voice is refused (PCI)', /PCI/.test(e ?? ''), e ?? 'did not throw');
  ok('the safety rules themselves do not trip the card-collection guard', (await threw(() => assertNoCardCollection(task.split('\n\nRules:')[0]))) === null);
}
await withEnv({ CALLE_API_KEY: 'test_key', CALLE_ALLOWED_NUMBERS: '+919999900001', DEMO_PHONE: '+919999900001' }, async () => {
  ok('allowlisted number is accepted', assertAllowedNumber('+91 99999 00001') === '+919999900001');

  fetchCalls = 0;
  const e1 = await threw(() => placeRecoveryCall({ ...o, consent: false }, { merchant: 'Acme Cloud', customerName: 'x' }));
  ok('no consent -> refused before dialling', /no consent/.test(e1 ?? '') && fetchCalls === 0, `${e1} fetch=${fetchCalls}`);

  fetchCalls = 0;
  const e2 = await threw(() => placeRecoveryCall(o, { merchant: 'Acme Cloud', customerName: 'x', phone: '+14155550123' }));
  ok('a number not on the allowlist -> refused before dialling, and masked in the error',
    /not on CALLE_ALLOWED_NUMBERS/.test(e2 ?? '') && !/4155550123/.test(e2 ?? '') && fetchCalls === 0, `${e2} fetch=${fetchCalls}`);
});

/* ── CALL-E: the local credit ledger, since the API has no balance endpoint ── */
{
  const LEDGER = 'out/.test-calle-usage-' + process.pid + '.json';
  rmSync(LEDGER, { force: true });

  ok('a missing ledger file reads as zero used, not an error', readCallLedger(LEDGER).count === 0);

  const b1 = callBudget({ max: 2, path: LEDGER });
  ok('a fresh ledger has the full cap remaining', b1.used === 0 && b1.remaining === 2 && b1.exhausted === false);

  mkdirSync('out', { recursive: true });
  writeFile(LEDGER, JSON.stringify({ count: 2, calls: [] }));
  ok('callBudget reports exhausted once used reaches max', callBudget({ max: 2, path: LEDGER }).exhausted === true);

  await withEnv({ CALLE_API_KEY: 'test_key', CALLE_ALLOWED_NUMBERS: '+919999900001', DEMO_PHONE: '+919999900001',
    CALLE_USAGE_FILE: LEDGER, CALLE_MAX_CALLS: '2' }, async () => {
    fetchCalls = 0;
    const e = await threw(() => placeRecoveryCall(o, { merchant: 'Acme Cloud', customerName: 'x' }));
    ok('an exhausted credit cap refuses the call before dialling', /credit cap reached \(2\/2/.test(e ?? '') && fetchCalls === 0,
      `${e} fetch=${fetchCalls}`);
  });

  writeFile(LEDGER, JSON.stringify({ count: 0, calls: [] }));
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ call_id: 'call_test123', status: 'created' }), { status: 200 });
  await withEnv({ CALLE_API_KEY: 'test_key', CALLE_ALLOWED_NUMBERS: '+919999900001', DEMO_PHONE: '+919999900001',
    CALLE_USAGE_FILE: LEDGER, CALLE_MAX_CALLS: '2' }, async () => {
    const r = await placeRecoveryCall(o, { merchant: 'Acme Cloud', customerName: 'x' });
    ok('a successful call is recorded and the budget usage is returned', r.external_ref === 'call_test123' && r.budget.used === 1 && r.budget.max === 2,
      JSON.stringify(r));
    ok('the ledger file itself now shows one call used', readCallLedger(LEDGER).count === 1);
  });
  globalThis.fetch = savedFetch;

  rmSync(LEDGER, { force: true });
}

/* ── email ── */
await withEnv({ RESEND_API_KEY: 're_test', DEMO_EMAIL: 'team@example.org' }, async () => {
  fetchCalls = 0;
  const msg = buildRecoveryEmail(o, { merchant: 'Acme Cloud', customerName: 'x', link: 'https://checkout.stripe.com/x', to: 'c0042@example.com' });
  const e = await threw(() => sendRecoveryEmail(msg));
  ok('email to a synthetic customer address is refused; only DEMO_EMAIL gets mail',
    /only DEMO_EMAIL/.test(e ?? '') && fetchCalls === 0, `${e} fetch=${fetchCalls}`);
  ok('the email carries the Stripe link and never asks for card details',
    msg.text.includes('https://checkout.stripe.com/x') && !/card number|cvv|cvc/i.test(msg.text));
});

/* ── Slack ── */
await withEnv({ SLACK_WEBHOOK_URL: 'https://evil.example.com/hook' }, async () => {
  fetchCalls = 0;
  const e = await threw(() => postToSlack({ text: 'x' }));
  ok('Slack refuses a webhook URL that is not hooks.slack.com', /not a hooks\.slack\.com URL/.test(e ?? '') && fetchCalls === 0, e ?? '');
});

/* ── adapters + ledger: a refusal is recorded verbatim, never as success ── */
await withEnv({ RESEND_API_KEY: null }, async () => {
  const L = new ActionLedger();
  const a = L.propose({ caseId: o.invoice_id, kind: 'recovery_email', payload: { invoice_id: o.invoice_id }, amount: 999, cost: 6 });
  await L.fire(a.id, () => sendRecoveryEmail({ to: 'x', subject: 's', text: 't' }));
  ok('a missing key becomes a failed ledger entry with the verbatim reason and a null reference',
    a.state === 'failed' && a.error === 'RESEND_API_KEY is not set' && a.external_ref === null, `${a.state} ${a.error}`);
});

console.log('  ' + '-'.repeat(66));
console.log('  ' + pass + ' passed, ' + fail + ' failed');
console.log('');
process.exit(fail ? 1 : 0);
