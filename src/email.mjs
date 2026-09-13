/**
 * Email channel — Resend REST (POST https://api.resend.com/emails).
 *
 * The demo sends ONLY to DEMO_EMAIL. Synthetic customers carry example.com
 * addresses that must never receive mail, and the guard below makes that a code
 * path rather than a promise. Resend's free tier also only delivers to the
 * account owner's address until a domain is verified, which suits a demo.
 *
 * The email never asks for card details. It carries the Stripe Checkout link,
 * and the card is entered on Stripe's page.
 */

import { usd } from './money.mjs';

export function buildRecoveryEmail(o, { merchant, customerName, link, to }) {
  const subject = `${merchant}: your payment of ${usd(o.amount)} didn't go through`;
  const text = [
    `Hi ${customerName},`,
    '',
    `We couldn't collect ${usd(o.amount)} for invoice ${o.invoice_id}.`,
    link
      ? `You can pay, or update your card, securely on Stripe here: ${link}`
      : 'Reply to this email and we will send you a secure payment link.',
    '',
    'We will never ask for your card details by email or phone.',
    '',
    `— ${merchant}`,
  ].join('\n');
  return { to, subject, text };
}

export function assertDemoRecipient(to) {
  const demo = String(process.env.DEMO_EMAIL ?? '').trim().toLowerCase();
  if (!demo) throw new Error("DEMO_EMAIL is not set: the demo only emails the team's own inbox");
  if (String(to ?? '').trim().toLowerCase() !== demo) {
    throw new Error(`refusing to email ${to}: only DEMO_EMAIL receives demo mail`);
  }
}

export async function sendRecoveryEmail({ to, subject, text }, { idempotencyKey } = {}) {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error('RESEND_API_KEY is not set');
  assertDemoRecipient(to);

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + key,
      'Content-Type': 'application/json',
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM || 'Recovery Agent <onboarding@resend.dev>',
      to: [to],
      subject,
      text,
    }),
    signal: AbortSignal.timeout(20000),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Resend HTTP ${res.status}: ${body.slice(0, 300)}`);
  let id = null;
  try { id = JSON.parse(body).id ?? null; } catch { /* fall through */ }
  if (!id) throw new Error('Resend accepted the request but returned no email id: ' + body.slice(0, 200));
  return { external_ref: id };
}
