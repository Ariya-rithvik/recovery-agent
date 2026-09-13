/**
 * Slack — an incoming webhook for the operator channel.
 *
 * Notification only. It posts the batch summary and the approval queue; it does
 * not approve anything, because a webhook cannot tell us WHO clicked, and
 * two-person approval means two distinct, identified people (see policy.mjs).
 *
 * An incoming webhook answers `ok` with no message id, so there is no external
 * reference to put in the ledger. The run reports the HTTP status and body
 * verbatim instead of inventing one.
 */

import { usd } from './money.mjs';

export async function postToSlack({ text, blocks }) {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) throw new Error('SLACK_WEBHOOK_URL is not set');
  if (!/^https:\/\/hooks\.slack\.com\//.test(url)) throw new Error('SLACK_WEBHOOK_URL is not a hooks.slack.com URL');

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, blocks }),
    signal: AbortSignal.timeout(15000),
  });
  const body = await res.text();
  if (!res.ok || body.trim() !== 'ok') throw new Error(`Slack HTTP ${res.status}: ${body.slice(0, 200)}`);
  return { status: res.status, body: body.trim() };
}

/** @param s { failed, atRisk, contacted, calls, emails, declined, netVsNothing, awaiting, pacer, live } */
export function batchMessage(s) {
  const text = `Recovery batch: ${s.failed} failed payments (${usd(s.atRisk)} at risk). `
    + `Contacting ${s.contacted} (${s.calls} calls, ${s.emails} emails), declined ${s.declined}. `
    + `Net margin vs doing nothing: ${s.netVsNothing >= 0 ? '+' : ''}${usd(s.netVsNothing)}.`;
  const lines = [
    `*Recovery batch* ${s.live ? '' : '_(dry run)_'}`,
    `• *${s.failed}* failed payments · *${usd(s.atRisk)}* at risk (synthetic customers)`,
    `• contacting *${s.contacted}*: ${s.calls} AI voice calls, ${s.emails} emails · declined *${s.declined}*`,
    `• net margin vs doing nothing: *${s.netVsNothing >= 0 ? '+' : ''}${usd(s.netVsNothing)}*`,
    `• awaiting approval: ${s.awaiting || 'none'}`,
    `• pacer: ${s.pacer}`,
  ];
  return { text, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } }] };
}
