/**
 * CALL-E adapter — AI voice calls through https://api.heycall-e.com (REST).
 *
 * Ported to plain ESM from our CALL-E adapter in earned-call. CALL-E is
 * create-then-poll: a call gets a task text and a result schema, and there is no
 * tool use mid-call. So everything the voice agent may say has to be in the task
 * before it dials — and so does everything it must not do.
 *
 * SAFETY — enforced in code, not only written into the prompt:
 *   - refuses a customer with no consent to be called (the pacer checks it too)
 *   - dials only numbers on CALLE_ALLOWED_NUMBERS: the team's own phones
 *   - refuses any task text that instructs the agent to collect card details.
 *     The customer fixes their card on Stripe's page, never by voice (PCI).
 *   - the task tells the agent to say it is automated, verify identity before
 *     disclosing anything, keep the amount off voicemail, and honour an opt-out
 *
 *   node --env-file=.env src/calle.mjs <call_id>     fetch one call's result
 */

import { pathToFileURL } from 'node:url';
import { usd } from './money.mjs';

export const CALLE_BASE_URL = process.env.CALLE_BASE_URL ?? 'https://api.heycall-e.com';

export class CalleError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'CalleError';
    this.status = status;
    this.body = body;
  }
}

/* ─────────────────────────────── the task ─────────────────────────────── */

const PLAIN_REASON = {
  authentication_required: 'the bank asked for an extra security check that was not completed',
  expired_card: 'the card on file has expired',
  insufficient_funds: 'the bank declined it for insufficient funds',
  lost_card: 'the card on file was reported lost',
  generic_decline: 'the bank declined it without giving a reason',
  processing_error: 'a temporary processing error',
  issuer_not_available: 'the bank could not be reached at the time',
};

export const SAFETY_RULES = [
  'Say at the start that you are an automated assistant calling on behalf of the merchant.',
  'Never ask for, read back, or accept card numbers, expiry dates or security codes. The customer updates payment details only on the secure link.',
  'Do not mention the payment, the amount or the reason to anyone but the account holder. Confirm you are speaking to them first.',
  'If you reach voicemail, leave only a request to call back. Do not mention the amount.',
  'If they ask not to be called again, confirm it, record it, and end the call.',
  'If they say they already paid, cancelled, or do not recognise the charge, apologise, do not push for payment, and record it for a human to review.',
].join('\n');

/**
 * Matches an instruction to COLLECT card data: a collecting verb followed closely
 * by a card-data noun. The safety rules above are appended after this check runs,
 * because they necessarily name the same nouns in order to forbid them.
 */
const COLLECTS_CARD = /\b(ask|collect|take|get|read|repeat|confirm|note|record|write)\b[^.\n]{0,40}\b(card number|card details|cvv|cvc|security code|expiry date|expiration date|full card)/i;

export function assertNoCardCollection(taskBody) {
  const m = String(taskBody).match(COLLECTS_CARD);
  if (m) throw new CalleError(`refusing a call task that collects card details by voice (PCI): "${m[0]}"`);
}

export function buildRecoveryTask(o, { merchant, customerName, link }) {
  const body = [
    `You are calling ${customerName} on behalf of ${merchant} about a subscription payment that did not go through.`,
    '',
    'Facts you may share ONLY with the account holder, after they confirm who they are:',
    `- Invoice ${o.invoice_id} for ${usd(o.amount)}`,
    `- Why it failed: ${PLAIN_REASON[o.reason] ?? 'the bank declined it'}`,
    `- ${link ? 'A secure Stripe payment link is ready' : 'A secure payment link can be prepared'} and can be emailed to the address on file.`,
    '',
    'Goal: offer to email the secure payment link, and record what they want to happen.',
  ].join('\n');
  assertNoCardCollection(body);
  return body + '\n\nRules:\n' + SAFETY_RULES;
}

export const RESULT_SCHEMA = {
  type: 'object',
  required: ['answered_by', 'outcome', 'evidence_quote'],
  properties: {
    answered_by: {
      type: 'string',
      enum: ['account_holder', 'someone_else', 'voicemail', 'no_answer', 'refused'],
      description: 'Who or what actually answered. Only account_holder makes the outcome meaningful.',
    },
    outcome: {
      type: 'string',
      enum: ['send_link', 'will_update_card', 'already_paid', 'disputes_charge', 'do_not_call', 'call_back_later', 'unclear'],
      description: 'What the account holder wants to happen. Record "unclear" rather than guessing.',
    },
    evidence_quote: {
      type: 'string',
      description: 'Short verbatim quote from the call that supports the outcome. Empty if none.',
    },
  },
};

/* ─────────────────────────────── guards ─────────────────────────────── */

const clean = p => String(p ?? '').replace(/[\s()-]/g, '');
const mask = p => (p.length > 4 ? '*'.repeat(p.length - 4) + p.slice(-4) : '****');

export function allowedNumbers() {
  return (process.env.CALLE_ALLOWED_NUMBERS || process.env.DEMO_PHONE || '')
    .split(',').map(clean).filter(Boolean);
}

export function assertAllowedNumber(phone) {
  const p = clean(phone);
  if (!/^\+\d{8,15}$/.test(p)) throw new CalleError(`refusing to dial ${mask(p)}: not an E.164 number (+countrycode...)`);
  if (!allowedNumbers().includes(p)) {
    throw new CalleError(`refusing to dial ${mask(p)}: not on CALLE_ALLOWED_NUMBERS (demo calls go to the team's own phones only)`);
  }
  return p;
}

export function regionFor(phone) {
  if (phone.startsWith('+91')) return { region: 'IN', locale: 'en-IN' };
  if (phone.startsWith('+44')) return { region: 'GB', locale: 'en-GB' };
  if (phone.startsWith('+1')) return { region: 'US', locale: 'en-US' };
  return { region: process.env.CALLE_REGION ?? 'US', locale: process.env.CALLE_LOCALE ?? 'en-US' };
}

/* ─────────────────────────────── transport ─────────────────────────────── */

function apiKey() {
  const key = process.env.CALLE_API_KEY;
  if (!key) throw new CalleError('CALLE_API_KEY is not set');
  return key;
}

async function request(path, init = {}) {
  const res = await fetch(CALLE_BASE_URL + path, {
    ...init,
    headers: { Authorization: 'Bearer ' + apiKey(), 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  if (!res.ok) throw new CalleError(`CALL-E ${init.method ?? 'GET'} ${path} -> HTTP ${res.status}: ${text.slice(0, 300)}`, res.status, text);
  try { return JSON.parse(text); } catch { throw new CalleError(`CALL-E returned non-JSON from ${path}`, res.status, text.slice(0, 300)); }
}

export const createCall = input => request('/v1/calls', { method: 'POST', body: JSON.stringify(input) });
export const getCall = id => request('/v1/calls/' + encodeURIComponent(id));

/**
 * Place one recovery call. SIDE EFFECT: this dials a real phone and spends a call
 * from the account balance. It returns as soon as CALL-E accepts the call; the
 * outcome arrives later (see the CLI at the bottom). The ledger guards replays
 * before this is ever reached, because CALL-E has no idempotency key of its own.
 */
export async function placeRecoveryCall(o, { merchant, customerName, link, phone = process.env.DEMO_PHONE } = {}) {
  apiKey();                                                     // not configured -> say so first
  if (o.consent !== true) throw new CalleError('refusing to call: no consent to be called on file');
  const to = assertAllowedNumber(phone);
  const task = buildRecoveryTask(o, { merchant, customerName, link });

  const created = await createCall({
    task,
    recipients: [{ phones: [to], ...regionFor(to) }],
    result_schema: RESULT_SCHEMA,
  });
  const id = created.call_id ?? created.id;
  if (!id) throw new CalleError('CALL-E did not return a call id', undefined, JSON.stringify(created).slice(0, 300));
  return { external_ref: id, status: created.status ?? 'created', to: mask(to) };
}

/* ─────────────────────────────── CLI ─────────────────────────────── */

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const id = process.argv[2];
  if (!id) { console.log('usage: node --env-file=.env src/calle.mjs <call_id>'); process.exit(2); }
  try {
    const r = await getCall(id);
    console.log(JSON.stringify({ id, status: r.status, task_completed: r.task_completed, structured_result: r.structured_result }, null, 2));
  } catch (e) {
    console.log('ERR ' + e.message);
    process.exit(1);
  }
}
