/**
 * recover.mjs — the submission. One batch of failed Stripe payments, end to end:
 *
 *   detect -> qualify -> choose a channel -> gate -> measure -> govern -> audit -> act -> learn
 *
 *   npm run demo                                   dry run: no keys, no network
 *   npm run live -- --approvers=asha,ravi          act on a two-row sample, test mode
 *
 * WHAT IS REAL AND WHAT IS NOT
 * The customers are synthetic, generated in Stripe's own shapes — invoice.* and
 * checkout.session.* events, real Stripe decline codes, amounts in cents. The
 * method, the evaluation and the governance are real. With --live, a two-row
 * sample is mirrored into a Stripe TEST account (a customer, plus a
 * PaymentIntent that Stripe itself declines), read back, and acted on through
 * the same ledger. Every external call either returns a real reference or is
 * recorded as failed, verbatim. The INTEGRATIONS block at the end says which.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateCustomers, featurise, rng } from './twin.mjs';
import { fitUplift, quadrant, qini } from './uplift.mjs';
import { explain, validate, phrase, render } from './explain.mjs';
import { ActionLedger, tierFor, TIERS } from './policy.mjs';
import { pace, judgeBatch } from './pacer.mjs';
import { buildRecoveryTask, placeRecoveryCall, SAFETY_RULES } from './calle.mjs';
import { buildRecoveryEmail, sendRecoveryEmail } from './email.mjs';
import { postToSlack, batchMessage } from './slack.mjs';
import { usd } from './money.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/* ─────────────────────────── economics ─────────────────────────── */

/*
 * All money is in cents. Two of these numbers are ASSUMPTIONS, not measurements,
 * and they are the first two a merchant should replace:
 *   CALL_COST    what one AI voice call costs. Set CALL_COST_CENTS to your rate.
 *   EMAIL_SHARE  how much of the contact effect an email captures on its own.
 *                The randomised test measured "contacted" as a whole; it did not
 *                split the effect by channel. A two-arm test would.
 */
const MARGIN = 0.60;            // SaaS gross margin
const EMAIL_COST = 6;           // 6 cents: the email plus amortised support load
const CALL_COST = Number(process.env.CALL_COST_CENTS || 150);
const EMAIL_SHARE = 0.65;
/*
 * The smallest estimated effect worth acting on. A 6-cent email makes almost any
 * positive estimate look profitable, so without a floor the cheap channel lets in
 * customers whose estimated effect is smaller than the model's own error — and
 * some of those are customers who cancel when chased. The floor is the model's
 * MEASURED calibration error on held-out data (`npm run calibrate`: mean absolute
 * error 2.97pp), fixed before looking at this table, not picked to improve it.
 */
const MIN_UPLIFT = 0.03;
const N = 9000;
const MERCHANT = process.env.MERCHANT_NAME || 'Acme Cloud';

const pad = (s, w) => String(s).padEnd(w);
const rp = (s, w) => String(s).padStart(w);
const LIVE = process.argv.includes('--live');
const APPROVERS = (process.argv.find(a => a.startsWith('--approvers='))?.split('=')[1] ?? '')
  .split(',').map(s => s.trim()).filter(Boolean);

/* ───────────────────── 1 · DETECT revenue at risk ───────────────────── */

/**
 * Why a payment was declined is observable and it matters — but it does NOT
 * determine recoverability on its own, which is the trap. A bank that could not
 * be reached and a missed 3DS challenge both look "transient" and behave
 * completely differently. Every key below is a real Stripe decline code.
 */
const FAILURES = {
  issuer_not_available: { weight: 0.17, archetype: 'self_recoverer' },
  processing_error: { weight: 0.11, archetype: 'self_recoverer' },
  authentication_required: { weight: 0.19, archetype: 'nudge_needed' },
  expired_card: { weight: 0.14, archetype: 'nudge_needed' },
  insufficient_funds: { weight: 0.16, archetype: 'hard_fail' },
  lost_card: { weight: 0.09, archetype: 'hard_fail' },
  generic_decline: { weight: 0.14, archetype: 'annoyed' },
};

/** Ground truth the model never sees. p0 = self-recovery; tau = effect of contact. */
const ARCH = {
  self_recoverer: { p0: 0.72, tau: 0.020, note: "recovers on Stripe's next automatic retry" },
  nudge_needed: { p0: 0.17, tau: 0.330, note: 'wants to pay, needs to fix the card' },
  hard_fail: { p0: 0.06, tau: 0.055, note: 'card or funds genuinely dead' },
  annoyed: { p0: 0.41, tau: -0.115, note: 'cancels when chased' },
};

function buildBatch(seed = 21) {
  const rnd = rng(seed);
  const rc = rng(seed + 1);          // consent has its own stream, so adding it moved no other number
  const people = generateCustomers({ n: N, seed });
  const keys = Object.keys(FAILURES);
  const batch = [];

  for (const c of people) {
    // only a slice of customers have a failed payment in the window
    if (rnd() > 0.34) continue;

    let r = rnd(), reason = keys[keys.length - 1], acc = 0;
    for (const k of keys) { acc += FAILURES[k].weight; if (r <= acc) { reason = k; break; } }
    const arch = FAILURES[reason].archetype;
    const a = ARCH[arch];

    const f = featurise(c);
    const amount = Math.max(199, Math.round(f.aov * (0.7 + rnd() * 0.7))) || 1499;   // cents

    // Behaviour modulates the archetype: an engaged repeat payer self-recovers
    // more readily; a stale one needs the nudge. Both are observable.
    const engaged = f.x[1];                       // successful payments / 10
    const stale = Math.min(1, f.daysSince / 90);
    const p0 = Math.max(0.02, Math.min(0.95, a.p0 + engaged * 0.10 - stale * 0.12 + (rnd() - 0.5) * 0.06));
    const tau = a.tau + (arch === 'nudge_needed' ? stale * 0.06 : 0) + (rnd() - 0.5) * 0.03;

    batch.push({
      id: c.id,
      invoice_id: 'in_' + c.id.slice(1) + '_' + Math.floor(rnd() * 1e5).toString(36),
      amount,
      reason,
      archetype: arch,
      attempts: 1 + Math.floor(rnd() * 3),
      consent: rc() < 0.7,           // 70% have agreed to be called; the rest can only be emailed
      // model input: behavioural history + observable failure context
      x: [...f.x, ...oneHot(reason, keys), Math.log1p(amount) / 10, (1 + Math.floor(rnd() * 3)) / 3],
      feat: f,                       // kept for the explainer's citations, never for the model
      truth: { p0, p1: Math.max(0.01, Math.min(0.98, p0 + tau)), tau },
    });
  }
  return batch;
}

const oneHot = (v, keys) => keys.map(k => (k === v ? 1 : 0));

/* ────────────────── 2 · QUALIFY — who is worth contacting ────────────────── */

const batch = buildBatch();
const rnd = rng(99);
const shuffled = [...batch].sort(() => rnd() - 0.5);
const train = shuffled.slice(0, Math.floor(batch.length * 0.5));
const deploy = shuffled.slice(Math.floor(batch.length * 0.5));

/** A prior recovery experiment: half the failures were contacted, half were not. */
function runRCT(rows, seed) {
  const r = rng(seed);
  return rows.map(o => {
    const treated = r() < 0.5 ? 1 : 0;
    const p = treated ? o.truth.p1 : o.truth.p0;
    return { id: o.id, x: o.x, treated, converted: r() < p ? 1 : 0 };
  });
}

const trainRows = runRCT(train, 4242);
const model = fitUplift(trainRows);

console.log('');
console.log('  STRIPE FAILED-PAYMENT RECOVERY — batch run' + (LIVE ? '  [LIVE, test mode]' : '  [DRY RUN]'));
console.log('  ' + '='.repeat(76));
console.log('  customers are SYNTHETIC, in Stripe\'s event schema · money in cents, shown in USD');
console.log('');
console.log('  1 · DETECT');
console.log('      ' + batch.length + ' invoice.payment_failed events in the window, '
  + usd(batch.reduce((s, o) => s + o.amount, 0)) + ' at risk');
const byReason = {};
for (const o of batch) byReason[o.reason] = (byReason[o.reason] ?? 0) + 1;
console.log('      ' + Object.entries(byReason).sort((a, b) => b[1] - a[1])
  .map(([k, v]) => k + ' ' + v).join(' · '));

if (!model.ok) { console.error('\n  model refused to fit: ' + model.reason + '\n'); process.exit(1); }

const validRows = runRCT(deploy, 777);
const q = qini(validRows.map(r => ({ ...r, score: model.uplift(r.x) })));

console.log('');
console.log('  2 · QUALIFY');
console.log('      uplift model trained on ' + model.n.treated + ' contacted / ' + model.n.control
  + ' not contacted (prior randomised recovery test)');
console.log('      Qini ' + q.coefficient + ' on a held-out split   (0 = no better than contacting at random)');

const scored = deploy.map(o => {
  const pC = model.pControl(o.x);
  const pT = model.pTreated(o.x);
  return { ...o, pControl: pC, pTreated: pT, tau: pT - pC, quadrant: quadrant(pC, pT - pC) };
});

const qTally = {};
for (const o of scored) qTally[o.quadrant] = (qTally[o.quadrant] ?? 0) + 1;
console.log('      ' + Object.entries(qTally).map(([k, v]) => k.replace('_', ' ') + ' ' + v).join(' · '));

/* ───────────── 3 · DECIDE + EXECUTE — bounded, gated, idempotent ───────────── */

/*
 * The budget is a fraction of what the most expensive blanket policy would
 * ACTUALLY cost — calling everyone who allows it and emailing the rest — not a
 * fraction of the head-count. Sizing it per head ignores that a call costs 25
 * times an email, and then the cap stops meaning anything.
 */
const spendIfContactAll = scored.reduce((s, o) => s + (o.consent ? CALL_COST : EMAIL_COST), 0);
const budget = Math.round(spendIfContactAll * 0.35);

/**
 * "Determine the RIGHT intervention" — there are two channels, and they are not
 * interchangeable.
 *
 *   email  the Stripe recovery link by email. 6 cents. Captures EMAIL_SHARE of
 *          the effect, because most failures are friction, not intent.
 *   call   an AI voice call (CALL-E) plus the same link. CALL_COST. Captures all
 *          of it.
 *
 * A call only earns its keep when the extra recovery it buys beats its extra cost:
 *
 *     (1 - EMAIL_SHARE) x tau x amount x margin  >  CALL_COST - EMAIL_COST
 *
 * For a persuadable customer on a large invoice that is true; on a small invoice
 * it is false even when the customer is highly persuadable. And without consent
 * on file a call is not an option at all.
 */
function decide(o) {
  const full = o.tau * o.amount * MARGIN;
  const email = { action: 'email', gain: full * EMAIL_SHARE, cost: EMAIL_COST };
  const call = { action: 'call', gain: full, cost: CALL_COST };
  email.ev = email.gain - email.cost;
  call.ev = call.gain - call.cost;

  const best = o.consent && call.ev > email.ev ? call : email;
  const alt = best === call ? email : (o.consent ? call : null);
  return { ...o, ...best, alt, tier: tierFor(o.amount) };
}

const idempotencyKey = o => 'rcv_' + o.invoice_id + '_' + o.attempts;

function runPolicy(candidates, { gated }) {
  const ranked = candidates.map(decide).sort((a, b) => b.ev - a.ev);
  const approved = [], rejected = [];
  const seen = new Set();
  let spend = 0;

  for (const o of ranked) {
    let why = null;
    const key = idempotencyKey(o);

    if (seen.has(key)) why = 'duplicate action for this invoice+attempt (idempotency)';
    else if (gated && (o.quadrant === 'sleeping_dog')) why = 'blocked: chasing this customer historically reduces recovery';
    else if (gated && o.quadrant === 'sure_thing') why = 'blocked: recovers unprompted — outreach buys nothing';
    else if (gated && o.tau < MIN_UPLIFT) why = "inside the model's measured error — estimated effect "
      + (o.tau * 100).toFixed(1) + 'pp, floor ' + (MIN_UPLIFT * 100).toFixed(1) + 'pp';
    else if (gated && o.ev <= 0) why = 'expected value ' + usd(o.ev) + ' — not worth the outreach';
    else if (spend + o.cost > budget) why = 'budget exhausted (stopping rule)';

    if (why) { rejected.push({ ...o, why }); continue; }
    seen.add(key);
    spend += o.cost;
    approved.push({ ...o, key });
  }
  return { approved, rejected, spend };
}

/* ─────────────── 4 · MEASURE — against what really happens ─────────────── */

/**
 * Scored on TRUE response. In production this is the held-out arm instead.
 * @param plan Map<id, 'email' | 'call'>  which channel each contacted customer gets
 */
function measure(plan) {
  let recovered = 0, gross = 0, spent = 0, calls = 0;
  for (const o of scored) {
    const act = plan.get(o.id);
    const p = !act ? o.truth.p0
      : act === 'email' ? Math.max(0.01, Math.min(0.98, o.truth.p0 + EMAIL_SHARE * o.truth.tau))
        : o.truth.p1;
    recovered += p;
    gross += p * o.amount * MARGIN;
    if (act === 'email') spent += EMAIL_COST;
    if (act === 'call') { spent += CALL_COST; calls++; }
  }
  return { recovered, gross, spent, net: gross - spent, contacted: plan.size, calls };
}

const gated = runPolicy(scored, { gated: true });
const K = gated.approved.length;
const decided = new Map(scored.map(o => [o.id, decide(o)]));
/*
 * The ranking baselines get the SAME channel logic as the agent, so the table
 * isolates WHO is targeted. Giving them the expensive channel for everyone would
 * make them look worse than they are.
 */
const sameChannels = ids => new Map(ids.map(id => [id, decided.get(id).action]));
const allIds = scored.map(o => o.id);
const byPropensity = [...scored].sort((a, b) => b.pTreated - a.pTreated).slice(0, K).map(o => o.id);
const byUplift = [...scored].sort((a, b) => b.tau - a.tau).slice(0, K).map(o => o.id);

const rows = [
  { name: 'Contact nobody', m: measure(new Map()) },
  { name: 'Email everyone (dunning)', m: measure(new Map(allIds.map(id => [id, 'email']))), blanket: true },
  { name: 'Everyone, call if allowed', m: measure(new Map(scored.map(o => [o.id, o.consent ? 'call' : 'email']))), blanket: true },
  { name: 'Propensity top ' + K, m: measure(sameChannels(byPropensity)) },
  { name: 'Uplift top ' + K + ' (ungated)', m: measure(sameChannels(byUplift)) },
  { name: 'This agent (gated)', m: measure(new Map(gated.approved.map(o => [o.id, o.action]))) },
];
const nothing = rows[0].m;

console.log('');
console.log('  3 · DECIDE   budget ' + usd(budget) + '   call ' + usd(CALL_COST) + ' vs email ' + usd(EMAIL_COST)
  + '   tiers: auto <=' + usd(TIERS[0].max) + ' · one-click <=' + usd(TIERS[1].max) + ' · two-person above');
console.log('');
console.log('  4 · MEASURE');
console.log('  ' + pad('POLICY', 28) + rp('CONTACTED', 10) + rp('CALLS', 7) + rp('RECOVERED', 11)
  + rp('SPENT', 10) + rp('NET MARGIN', 12) + rp('VS NOTHING', 12));
console.log('  ' + '-'.repeat(90));
for (const { name, m } of rows) {
  const d = m.net - nothing.net;
  console.log('  ' + pad(name, 28) + rp(m.contacted, 10) + rp(m.calls, 7) + rp(m.recovered.toFixed(0), 11)
    + rp(usd(m.spent), 10) + rp(usd(m.net), 12) + rp((d >= 0 ? '+' : '') + usd(d), 12));
}

const prop = rows.find(r => r.name.startsWith('Propensity')).m;
const pol = rows.find(r => r.name.startsWith('This agent')).m;

/*
 * Compare against the BEST blanket policy, not a chosen one. Beating the weaker
 * blanket is the flattering half of the comparison; naming the stronger one and
 * beating it is the stricter test.
 */
const best = rows.filter(r => r.blanket).reduce((a, b) => (b.m.net > a.m.net ? b : a));

console.log('');
console.log('  ' + '-'.repeat(76));
if (pol.net > best.m.net && pol.net > prop.net) {
  console.log('  ' + pad('vs doing nothing', 30) + rp('+' + usd(pol.net - nothing.net), 12)
    + '   the headline number');
  console.log('  ' + pad('vs propensity targeting', 30) + rp('+' + usd(pol.net - prop.net), 12)
    + '   same contact volume, same channel logic'
    + (prop.net < nothing.net ? ' — and propensity LOSES ' + usd(nothing.net - prop.net) + ' vs doing nothing' : ''));
  console.log('  ' + pad('vs ' + best.name, 30) + rp('+' + usd(pol.net - best.m.net), 12)
    + '   strongest blanket baseline, at ' + Math.round((1 - pol.contacted / best.m.contacted) * 100)
    + '% fewer contacts');
} else {
  console.log('  The gated agent did NOT win on this run. Reporting it rather than tuning until it does.');
  console.log('  gated ' + usd(pol.net) + ' · propensity ' + usd(prop.net)
    + ' · best blanket (' + best.name + ') ' + usd(best.m.net));
}

/* ───────────────────── 5 · GOVERNANCE + 6 · AUDIT ───────────────────── */

const qCount = { auto: 0, one_click: 0, two_person: 0 };
for (const o of gated.approved) qCount[o.tier.id]++;

/*
 * Each decision is explained from its own evidence and then validated: any
 * sentence containing a number that is not in the evidence list is dropped, not
 * softened. That gate is what makes this an audit trail rather than a summary.
 */
let dropped = 0;
const briefs = new Map();
function briefFor(o) {
  // Keyed by DECISION, not customer: the same customer is scored as approved,
  // declined and on the ungated list, and a brief cached by id alone printed one
  // decision's verdict under another's.
  const k = o.id + '|' + o.action + '|' + (o.why ?? '');
  if (!briefs.has(k)) {
    const b = validate(explain(o, o.feat));
    dropped += b.dropped.length;
    briefs.set(k, b);
  }
  return briefs.get(k);
}
async function brief(o) {
  return render(await phrase(briefFor(o), null));   // null = deterministic
}

// Each approved row carries its own brief so rule D1 can check the arithmetic.
const paced = pace(gated.approved.map(o => ({ ...o, brief: briefFor(o) })));

const contactedByQuadrant = {};
for (const o of paced.allowed) {
  contactedByQuadrant[o.quadrant] = (contactedByQuadrant[o.quadrant] ?? 0) + 1;
}
const batchVerdict = judgeBatch({
  approved: paced.allowed.length,
  rejected: gated.rejected.length + paced.stopped.length,
  spend: gated.spend,
  budget,
  qini: q.coefficient,
  contactedByQuadrant,
});

// Every surviving action goes through the ledger: hashed idempotency key,
// approval tier, and a state machine that refuses to fire twice.
const ledger = new ActionLedger({ budget });
for (const o of paced.allowed) {
  ledger.propose({
    caseId: o.invoice_id, kind: 'recovery_' + o.action,
    payload: { invoice_id: o.invoice_id, amount_cents: o.amount, action: o.action, reason: o.reason },
    amount: o.amount, cost: o.cost,
    rationale: 'uplift ' + (o.tau * 100).toFixed(1) + 'pp · EV ' + usd(o.ev) + ' · ' + o.action,
  });
}
const led = ledger.summary();

/*
 * Defence in depth. The pacer is the LAST line, so on a healthy run it should
 * catch nothing — the quadrant gates and the EV floor already did. So we also
 * run it over the propensity list: the one a team would ship with a model and
 * no gates. What it catches there is what the pacer is actually for.
 */
const ungated = [...scored].sort((a, b) => b.pTreated - a.pTreated).slice(0, K)
  .map(decide).map(o => ({ ...o, brief: briefFor(o) }));
const pacedUngated = pace(ungated);

console.log('');
console.log('  5 · GOVERNANCE');
console.log('      pacer      ' + paced.stopped.length + ' halted · ' + paced.nudges.length
  + ' nudged · rules fired: ' + (paced.fired.join(', ') || 'none — earlier gates caught everything'));
console.log('      same rules on the PROPENSITY list: '
  + pacedUngated.stopped.length + ' would have been halted, '
  + pacedUngated.nudges.length + ' nudged');
for (const st of pacedUngated.stopped.slice(0, 2)) {
  console.log('        would HALT ' + st.id + '  ' + st.pacer.message);
}
for (const st of paced.stopped.slice(0, 2)) {
  console.log('        HALT ' + st.id + '  ' + st.pacer.message);
}
for (const nd of paced.nudges.slice(0, 1)) {
  console.log('        NUDGE ' + nd.id + '  ' + nd.pacer.message);
}
console.log('      batch      ' + batchVerdict.kind.toUpperCase()
  + (batchVerdict.message ? ' — ' + batchVerdict.message : ' — all invariants hold'));
console.log('      ledger     ' + led.skipped + ' skipped (duplicate/budget) · awaiting approval: '
  + (Object.entries(led.awaiting_approval).map(([k, v]) => k.replace('_', '-') + ' ' + v).join(' · ') || 'none'));
console.log('      auto-approved ' + ledger.byState('approved').length
  + ' at or under ' + usd(TIERS[0].max) + '; everything above needs a human');

console.log('');
console.log('  6 · AUDIT TRAIL');
console.log('      approved ' + gated.approved.length + '   ('
  + Object.entries(qCount).map(([k, v]) => k.replace('_', '-') + ' ' + v).join(' · ') + ')'
  + '   calls ' + gated.approved.filter(o => o.action === 'call').length
  + ' · emails ' + gated.approved.filter(o => o.action === 'email').length);
console.log('      declined ' + gated.rejected.length + '   spend ' + usd(gated.spend) + ' of ' + usd(budget));
console.log('');
const showcase = [gated.approved.find(o => o.action === 'call'), gated.approved.find(o => o.action === 'email')].filter(Boolean);
for (const o of showcase) {
  console.log(await brief(o));
  console.log('      idempotency ' + o.key + '  ·  ' + o.tier.label);
  console.log('');
}
const shown = new Set();
for (const o of gated.rejected) {
  const kind = o.why.split('(')[0].split('—')[0].trim();
  if (shown.has(kind) || shown.size >= 3) continue;
  shown.add(kind);
  console.log(await brief(o));
  console.log('');
}
console.log('      claims dropped for unsupported numbers: ' + dropped
  + (dropped === 0 ? '   (every sentence traces to evidence)' : ''));

/* ───────── who did we actually spend on — the archetypes the model was never told ───────── */

const contactedSet = new Set(gated.approved.map(o => o.id));
const calledSet = new Set(gated.approved.filter(o => o.action === 'call').map(o => o.id));

console.log('');
console.log('      who did we actually spend on?   (the model was never told these labels)');
console.log('       ' + pad('archetype', 16) + rp('in batch', 9) + rp('contacted', 11)
  + rp('called', 8) + '   true uplift');
for (const [arch, meta] of Object.entries(ARCH)) {
  const of = scored.filter(o => o.archetype === arch);
  if (!of.length) continue;
  const c = of.filter(o => contactedSet.has(o.id)).length;
  const called = of.filter(o => calledSet.has(o.id)).length;
  console.log('       ' + pad(arch, 16) + rp(of.length, 9)
    + rp(Math.round((c / of.length) * 100) + '%', 11)
    + rp(Math.round((called / of.length) * 100) + '%', 8)
    + rp((meta.tau >= 0 ? '+' : '') + (meta.tau * 100).toFixed(1) + 'pp', 14)
    + '   ' + meta.note);
}

/* ───────────────────── 7 · ACT — the external apps ───────────────────── */

const integrations = {
  stripe: { name: 'Stripe (test mode)', key: 'STRIPE_SECRET_KEY' },
  email: { name: 'Resend (email)', key: 'RESEND_API_KEY' },
  call: { name: 'CALL-E (AI voice)', key: 'CALLE_API_KEY' },
  slack: { name: 'Slack (webhook)', key: 'SLACK_WEBHOOK_URL' },
};
const setStatus = (k, state, detail) => { integrations[k].state = state; integrations[k].detail = detail; };
const notSet = msg => /is not set/.test(String(msg));
const customerName = o => 'Synthetic customer ' + o.id;

// The top approved call and the top approved email: one of each channel.
const sample = [paced.allowed.find(o => o.action === 'call'), paced.allowed.find(o => o.action === 'email')].filter(Boolean);

console.log('');
console.log('  7 · ACT' + (LIVE ? '   [LIVE — Stripe test mode · demo inbox and allowlisted phones only]'
  : '   [DRY RUN — nothing is sent; this is exactly what --live would send]'));

function preview(o, link) {
  console.log('   ' + pad(o.action.toUpperCase(), 6) + o.id + '  ' + usd(o.amount) + ' · '
    + o.reason.replace(/_/g, ' ') + ' · EV ' + usd(o.ev) + ' · ' + o.tier.label);
  if (o.action === 'call') {
    const task = buildRecoveryTask(o, { merchant: MERCHANT, customerName: customerName(o), link });
    for (const line of task.split('\n\nRules:')[0].split('\n').filter(Boolean)) console.log('        | ' + line);
    console.log('        | + ' + SAFETY_RULES.split('\n').length + ' safety rules (automated disclosure, identity first, '
      + 'no card details by voice, nothing on voicemail, opt-out, disputes to a human)');
    console.log('        | result schema: answered_by · outcome · evidence_quote');
  } else {
    const m = buildRecoveryEmail(o, { merchant: MERCHANT, customerName: customerName(o), link, to: process.env.DEMO_EMAIL || '<DEMO_EMAIL>' });
    console.log('        | to: ' + m.to + '   subject: ' + m.subject);
    for (const line of m.text.split('\n').slice(2, 5).filter(Boolean)) console.log('        | ' + line);
  }
}

if (!LIVE) {
  for (const o of sample) preview(o, null);
  for (const k of Object.keys(integrations)) {
    setStatus(k, 'dry_run', process.env[integrations[k].key] ? 'key present — run with --live' : 'no key');
  }
} else {
  const links = new Map();

  // Stripe first: the recovery link is what both channels deliver.
  const { preflight, mirrorFailedPayment, createRecoveryLink } = await import('./stripe.mjs');
  const pf = await preflight();
  if (!pf.ok) {
    setStatus('stripe', pf.configured ? 'failed' : 'not_set', pf.reason);
    console.log('   STRIPE  ' + (pf.configured ? 'ABORTED — ' : 'skipped — ') + pf.reason);
  } else {
    const refs = [], errors = [];
    for (const o of sample) {
      try {
        const m = await mirrorFailedPayment(o, { merchant: MERCHANT });
        console.log('   STRIPE  ' + o.id + '  ' + m.customer + '  ' + m.payment_intent + '  status ' + m.status);
        console.log('           Stripe declined it: ' + (m.decline_code ?? 'no decline code')
          + (m.matched ? '' : '   (intended ' + o.reason + ')')
          + (m.event ? '   event ' + m.event : '   event not listed yet'));
        const link = await createRecoveryLink(o, m.customer, { merchant: MERCHANT });
        links.set(o.id, link.url);
        console.log('           recovery link ' + link.id);
        refs.push(m.payment_intent, link.id);
      } catch (e) {
        console.log('   STRIPE  ' + o.id + '  ERR ' + e.message);
        errors.push(e.message);
      }
    }
    if (refs.length && !errors.length) setStatus('stripe', 'live', refs.join(' '));
    else if (refs.length) setStatus('stripe', 'partial', refs.join(' ') + ' · ERR ' + errors[0]);
    else setStatus('stripe', 'failed', errors[0] ?? 'no objects created');
  }

  for (const o of sample) {
    const k = o.action;
    const a = ledger.all().find(x => x.caseId === o.invoice_id && !x.skipped);
    if (!a) continue;

    for (const who of APPROVERS) {
      if (a.state !== 'proposed') break;
      try { ledger.approve(a.id, who); } catch (e) { console.log('   approval refused: ' + e.message); }
    }
    if (a.state !== 'approved') {
      const msg = 'awaiting ' + a.tier.label + ' (' + a.approvals.length + '/' + a.tier.approvals
        + ') — pass --approvers=name1,name2';
      console.log('   ' + pad(k.toUpperCase(), 6) + '  ' + o.id + '  ' + msg);
      setStatus(k, 'awaiting_approval', msg);
      continue;
    }

    preview(o, links.get(o.id) ?? null);
    const link = links.get(o.id) ?? null;
    const adapter = k === 'call'
      ? () => placeRecoveryCall(o, { merchant: MERCHANT, customerName: customerName(o), link })
      : p => sendRecoveryEmail(
        buildRecoveryEmail(o, { merchant: MERCHANT, customerName: customerName(o), link, to: process.env.DEMO_EMAIL }),
        { idempotencyKey: p.idempotency_key });
    await ledger.fire(a.id, adapter);

    if (a.state === 'succeeded') {
      console.log('        -> SENT  ref ' + a.external_ref + '   approved by ' + (a.approvals.join(' + ') || 'auto tier')
        + (link ? '' : '   (no Stripe link: Stripe not connected)'));
      setStatus(k, 'live', a.external_ref);
    } else {
      console.log('        -> NOT SENT  ' + a.error);
      setStatus(k, notSet(a.error) ? 'not_set' : 'failed', a.error);
    }
  }

  try {
    const r = await postToSlack(batchMessage({
      failed: scored.length, atRisk: scored.reduce((s, o) => s + o.amount, 0),
      contacted: pol.contacted, calls: pol.calls, emails: pol.contacted - pol.calls,
      declined: gated.rejected.length, netVsNothing: pol.net - nothing.net,
      awaiting: Object.entries(led.awaiting_approval).map(([t, v]) => t.replace('_', '-') + ' ' + v).join(', '),
      pacer: batchVerdict.kind + (batchVerdict.message ? ' — ' + batchVerdict.message : ''),
      live: true,
    }));
    setStatus('slack', 'live', 'HTTP ' + r.status + ' "' + r.body + '" (incoming webhooks return no message id)');
  } catch (e) {
    setStatus('slack', notSet(e.message) ? 'not_set' : 'failed', e.message);
  }
}

/* ───────────────────── 8 · LEARN — Scar ───────────────────── */

console.log('');
console.log('  8 · LEARN   repeated recovery-call failures -> an installable skill (Scar)');
const scarEntry = join(ROOT, 'scar', 'src', 'index.ts');
let scar = null;
if (!existsSync(scarEntry)) {
  console.log('      scar/ is not present — skipped');
} else {
  const r = spawnSync(process.execPath, [scarEntry, '--json'], { cwd: join(ROOT, 'scar'), encoding: 'utf8', timeout: 90000 });
  try {
    scar = JSON.parse(r.stdout);
    const checks = Array.isArray(scar.checks) ? scar.checks : [];
    const passed = checks.filter(c => c.pass ?? c.ok ?? c.passed).length;
    console.log('      ' + (scar.accepted ? 'ACCEPTED' : 'REJECTED') + '   skill ' + (scar.skill ?? '?')
      + '   checks ' + passed + '/' + checks.length + '   (rehearsals against a modelled callee, 0 calls spent)');
    if (scar.before && scar.after) {
      console.log('      failures handled: naive call plan ' + scar.before.handled + '/' + scar.before.total
        + '  ->  with the learned skill ' + scar.after.handled + '/' + scar.after.total);
    }
    if (scar.path) console.log('      written to scar/' + scar.path);
  } catch {
    console.log('      Scar did not return JSON: ' + ((r.stderr || r.stdout || 'no output').trim().split('\n')[0]));
  }
}

/* ───────────────────── integrations: what actually happened ───────────────────── */

const LABEL = { live: 'LIVE', partial: 'PARTIAL', dry_run: 'DRY RUN', not_set: 'NOT SET', failed: 'FAILED', awaiting_approval: 'WAITING' };
console.log('');
console.log('  INTEGRATIONS — what actually happened on this run');
for (const it of Object.values(integrations)) {
  console.log('   ' + pad(it.name, 22) + pad(LABEL[it.state] ?? '-', 9) + (it.detail ?? ''));
}
console.log('   ' + pad('Scar (learning)', 22) + pad(scar ? (scar.accepted ? 'RAN' : 'REJECTED') : 'SKIPPED', 9)
  + 'local rehearsal, no external calls');
console.log('   customers are SYNTHETIC. Only rows marked LIVE touched a real API, and each shows its reference.');

mkdirSync(join(ROOT, 'out'), { recursive: true });
writeFileSync(join(ROOT, 'out', 'run.json'), JSON.stringify({
  generated_at: new Date().toISOString(),
  mode: LIVE ? 'live' : 'dry_run',
  customers: 'synthetic (Stripe event schema)',
  economics: {
    margin: MARGIN, email_cost_cents: EMAIL_COST, call_cost_cents: CALL_COST, email_share: EMAIL_SHARE,
    assumptions: ['call_cost_cents', 'email_share'],
  },
  batch: { failed_payments: batch.length, decided: scored.length, at_risk_cents: batch.reduce((s, o) => s + o.amount, 0) },
  qini: q.coefficient,
  budget_cents: budget,
  table: rows.map(({ name, m }) => ({
    policy: name, contacted: m.contacted, calls: m.calls, recovered: +m.recovered.toFixed(1),
    spent_cents: Math.round(m.spent), net_margin_cents: Math.round(m.net), vs_nothing_cents: Math.round(m.net - nothing.net),
  })),
  pacer: { halted: paced.stopped.length, nudged: paced.nudges.length, batch: batchVerdict.kind, on_propensity_list_halted: pacedUngated.stopped.length },
  integrations: Object.fromEntries(Object.entries(integrations).map(([k, v]) => [k, { state: v.state, detail: v.detail ?? null }])),
  scar,
  audit: ledger.audit({ limit: 1000 }),
}, null, 2));
console.log('   full run: out/run.json');
console.log('');
