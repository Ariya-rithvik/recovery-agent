/**
 * Pacer — round-level policy auditor for the recovery batch.
 *
 * Ported from the pacer in Manthan (github.com/akash-mondal/manthan), our team's
 * dispute-investigation agent. The design there is right and the reasoning is
 * worth restating, because it is the opposite of what most agent projects do:
 *
 *   The model is the brain. This is a narrow set of RULES that watch the
 *   running state and step in when the brain is about to finalise on shaky
 *   ground.
 *
 * Why rules instead of more bullet points in a prompt:
 *   - A prompt is read once per round. It cannot observe cross-round state
 *     ("has this batch ever checked the budget?", "is this the third identical
 *     proposal?"). The pacer can.
 *   - Each rule is testable without an LLM in the loop.
 *   - Money-moving decisions need stronger pre-conclude invariants than a
 *     read-only report does. This is where they live.
 *
 * Design contract, kept from the original:
 *   - PURE. No I/O, no model calls, no clock. State in, decision out.
 *   - IDEMPOTENT. Each nudge fires at most once per batch; the caller passes the
 *     already-fired ids so the same nudge cannot spam.
 *   - ESCAPE HATCH. A nudge that has already fired once lets the batch through
 *     rather than deadlocking when the condition cannot be satisfied.
 *
 * One change from the first port: HALTS ARE CHECKED BEFORE NUDGES. The first
 * version evaluated the missing-arithmetic nudge first and returned early, so an
 * action with no numbers in its brief AND a negative estimated effect came back
 * as a warning — and a warning does not block. A rule that can be shadowed by a
 * softer rule is not a gate.
 */

import { usd } from './money.mjs';

/** @typedef {'proceed'|'nudge'|'halt'} PaceKind */

const proceed = () => ({ kind: 'proceed', rule: null, message: null });
const nudge = (rule, message, reason) => ({ kind: 'nudge', rule, message, reason });
const halt = (rule, message, reason) => ({ kind: 'halt', rule, message, reason });

/**
 * Manthan gates a refund on a finding that contains the arithmetic. Ours is the
 * same shape: a voice call costs about 25 times an email, so the brief must show
 * the sum that justified it. A number with no visible derivation is a number
 * nobody checked.
 */
const MATH_HINT = /(?:[-+]?\d[\d,]*(?:\.\d+)?\s*(?:pp|%)|-?\$\s?-?\d|[\d.]+\s*[x×*]\s*[\d.]+|=\s*-?[\d$])/;

/* ───────────────────────── per-decision rules ───────────────────────── */

/**
 * Gate a single proposed action before it reaches the ledger.
 *
 * @param d      the scored decision { tau, pControl, pTreated, amount, action, ev, consent, brief }
 * @param fired  Set of rule ids already fired for this batch
 */
export function judgeDecision(d, fired = new Set()) {
  const once = id => fired.has(id);
  const contacting = d.action && d.action !== 'none';

  /* ── halts: these block, so they go first ── */

  // D5 — an automated voice call needs consent on file. Email does not.
  if (d.action === 'call' && d.consent !== true) {
    return halt('D5_call_without_consent',
      'No recorded consent to be called. An automated voice call needs it; '
      + 'send the recovery link by email instead.',
      'call without consent');
  }

  // D2 — never spend on a negative estimated effect, whatever the ranking says.
  if (contacting && d.tau < 0) {
    return halt('D2_negative_uplift',
      `Estimated effect is ${(d.tau * 100).toFixed(1)}pp — contacting this customer is `
      + 'expected to REDUCE recovery. Refusing.',
      'tau < 0 with a contact action');
  }

  // D4 — the expected value must actually be positive. A ranking can be right
  // about the ORDER and still put a loss-making action at the top.
  if (contacting && d.ev != null && d.ev <= 0) {
    return halt('D4_negative_ev',
      `Expected value ${usd(d.ev)} — the action costs more than it returns.`,
      'ev <= 0');
  }

  /* ── nudges: these warn and let the action through ── */

  // D1 — a call is the expensive channel; the brief must show the arithmetic.
  if (d.action === 'call' && !once('D1_call_math_missing')) {
    if (!MATH_HINT.test(briefText(d))) {
      return nudge('D1_call_math_missing',
        `Proposing a voice call on ${usd(d.amount)} but the brief shows no arithmetic. `
        + 'Record the uplift and expected value that justified it before approving.',
        'call without math-shaped brief');
    }
  }

  // D3 — an effect inside the noise band is not a reason to spend money.
  if (contacting && Math.abs(d.tau) < 0.02 && !once('D3_noise_band')) {
    return nudge('D3_noise_band',
      `Estimated effect ${(d.tau * 100).toFixed(1)}pp is inside the noise band. `
      + 'Spending here buys nothing measurable.',
      '|tau| < 2pp');
  }

  return proceed();
}

/* ───────────────────────── pre-conclude rules ───────────────────────── */

/**
 * Gate the whole batch before it is declared finished. These are the invariants
 * that only make sense across the run. Halts first, for the same reason as above.
 *
 * @param s { approved, rejected, spend, budget, contactedByQuadrant, qini }
 */
export function judgeBatch(s, fired = new Set()) {
  const once = id => fired.has(id);

  // B1 — a budget that was never binding was never a stopping rule.
  if (s.budget == null || s.budget === Infinity) {
    return halt('B1_no_budget',
      'This batch ran without a budget. "Bounded" is a claim the run cannot support.',
      'budget missing');
  }

  // B2 — spending past the cap is the failure the cap exists to prevent.
  if (s.spend > s.budget) {
    return halt('B2_budget_exceeded',
      `Spent ${usd(s.spend)} against a cap of ${usd(s.budget)}.`,
      'spend > budget');
  }

  // B4 — a sleeping dog is an action with negative expected value by definition.
  const dogs = s.contactedByQuadrant?.sleeping_dog ?? 0;
  if (dogs > 0) {
    return halt('B4_sleeping_dog_contacted',
      `${dogs} approved contact(s) go to customers whose recovery FALLS when chased.`,
      'sleeping_dog contacted');
  }

  // B5 — a model no better than random must not be used to allocate money.
  if (s.qini != null && s.qini <= 0) {
    return halt('B5_model_no_better_than_random',
      `Qini ${s.qini} — this model does not rank better than contacting at random. `
      + 'Contact everyone or nobody, but do not pretend this is targeting.',
      'qini <= 0');
  }

  // B3 — money aimed at people who recover anyway is the classic dunning bug.
  const sure = s.contactedByQuadrant?.sure_thing ?? 0;
  const total = s.approved || 1;
  if (sure / total > 0.15 && !once('B3_sure_thing_leak')) {
    return nudge('B3_sure_thing_leak',
      `${Math.round((sure / total) * 100)}% of approved contacts are customers who recover `
      + 'unprompted. That spend buys nothing.',
      'sure_thing share > 15%');
  }

  // B6 — a batch that approves everything has not made a decision.
  if (s.approved > 0 && s.rejected === 0 && !once('B6_no_selection')) {
    return nudge('B6_no_selection',
      'Every candidate was approved. Either the gates are not binding or the '
      + 'budget is too large to be a constraint.',
      'zero rejections');
  }

  return proceed();
}

/* ─────────────────────────────── helpers ─────────────────────────────── */

function briefText(d) {
  if (typeof d.brief === 'string') return d.brief;
  if (d.brief?.claims) return d.brief.claims.map(c => c.text).join(' ');
  if (d.rationale) return String(d.rationale);
  return '';
}

/**
 * Convenience: run every decision through the pacer, collecting the verdicts and
 * honouring idempotency across the batch. Returns the decisions the pacer
 * allowed plus everything it stopped, with reasons.
 */
export function pace(decisions) {
  const fired = new Set();
  const allowed = [], stopped = [], nudges = [];
  for (const d of decisions) {
    const v = judgeDecision(d, fired);
    if (v.kind === 'proceed') { allowed.push(d); continue; }
    fired.add(v.rule);
    if (v.kind === 'halt') stopped.push({ ...d, pacer: v });
    else { nudges.push({ ...d, pacer: v }); allowed.push(d); }   // a nudge warns, it does not block
  }
  return { allowed, stopped, nudges, fired: [...fired] };
}
