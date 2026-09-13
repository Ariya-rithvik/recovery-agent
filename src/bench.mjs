/**
 * The benchmark that decides whether this project has a thesis.
 *
 *   node src/bench.mjs
 *
 * Claim under test: ranking customers by INCREMENTAL response beats ranking them
 * by probability of converting — the thing every marketing tool actually does.
 *
 * Protocol, kept deliberately strict so the result means something:
 *   - customers are split three ways: train / validate / deploy
 *   - the uplift model sees ONLY randomised assignment + binary outcome on the
 *     train split, never the generator's parameters
 *   - Qini is computed on the untouched validate split
 *   - every policy is scored on the deploy split, which no model has seen
 *   - all policies are compared at the SAME number of targeted customers, so a
 *     win cannot come from simply spending more
 */

import { generateCustomers, featurise } from './twin.mjs';
import { fitUplift, quadrant, qini, selectTargets, evaluatePolicy, QUADRANT_COPY } from './uplift.mjs';
import { rng } from './twin.mjs';
import { usd } from './money.mjs';

/**
 * Economics of a digital subscription merchant. Amounts are in cents. Margin is high, so a 10% offer CAN pay for itself, but only on the
 * customers it actually moves. At a physical-goods margin of 35% the same offer
 * is under water for almost everyone, which is itself a true and useful finding:
 * run bench with MARGIN=0.35 and the engine correctly refuses to spend anything.
 */
const MARGIN = 0.60;      // gross margin on an order
const DISCOUNT = 0.10;    // the offer we are deciding whether to hand out
const N = 14000;

const pad = (s, w) => String(s).padEnd(w);
const rpad = (s, w) => String(s).padStart(w);

/* ─────────────────────────── build the world ─────────────────────────── */

const customers = generateCustomers({ n: N, seed: 11 });
const feats = new Map(customers.map(c => [c.id, featurise(c)]));

const rnd = rng(99);
const shuffled = [...customers].sort(() => rnd() - 0.5);
const train = shuffled.slice(0, Math.floor(N * 0.4));
const valid = shuffled.slice(Math.floor(N * 0.4), Math.floor(N * 0.6));
const deploy = shuffled.slice(Math.floor(N * 0.6));

/** Run a randomised experiment: coin-flip assignment, outcome sampled from truth. */
function runRCT(group, seed) {
  const r = rng(seed);
  return group.map(c => {
    const treated = r() < 0.5 ? 1 : 0;
    const p = treated ? c.truth.p1 : c.truth.p0;
    return { id: c.id, x: feats.get(c.id).x, treated, converted: r() < p ? 1 : 0 };
  });
}

const trainRows = runRCT(train, 4242);
const validRows = runRCT(valid, 777);

console.log('');
console.log('  BEHAVIOURAL TWIN — incrementality benchmark on a Stripe coupon');
console.log('  ' + '─'.repeat(72));
console.log('  synthetic customers  ' + N + '   (labelled synthetic; method is what is under test)');
console.log('  train / validate / deploy   ' + train.length + ' / ' + valid.length + ' / ' + deploy.length);
console.log('  margin ' + (MARGIN * 100) + '%   discount ' + (DISCOUNT * 100) + '%');

/* ──────────────────────────── fit the model ──────────────────────────── */

const model = fitUplift(trainRows);
if (!model.ok) { console.error('  model refused to fit: ' + model.reason); process.exit(1); }

const q = qini(validRows.map(r => ({ ...r, score: model.uplift(r.x) })));
console.log('');
console.log('  MODEL   trained on ' + model.n.treated + ' treated / ' + model.n.control + ' control');
console.log('          Qini coefficient ' + q.coefficient + '   (0 = no better than random targeting)');

/* ───────────────────── score the untouched deploy set ───────────────────── */

const scored = deploy.map(c => {
  const f = feats.get(c.id);
  const pC = model.pControl(f.x);
  const pT = model.pTreated(f.x);
  return { id: c.id, aov: f.aov, pControl: pC, pTreated: pT, tau: pT - pC, truth: c.truth, kind: c.kind };
});

/* ───────────────────────────── the policy ───────────────────────────── */

const totalAov = scored.reduce((s, c) => s + c.aov, 0);
const budget = Math.round(totalAov * DISCOUNT * 0.12);      // a real, binding cap

const policy = selectTargets(scored, {
  budget, discountRate: DISCOUNT, marginRate: MARGIN,
  minExpectedGain: 0, maxShare: 0.5,
  blockQuadrants: ['sleeping_dog', 'sure_thing'],
});

const K = policy.chosen.length;

/* ────────────────────────── competing policies ────────────────────────── */

const byPropensity = [...scored].sort((a, b) => b.pTreated - a.pTreated).slice(0, K).map(c => c.id);
const byUpliftOnly = [...scored].sort((a, b) => b.tau - a.tau).slice(0, K).map(c => c.id);
const rndPick = (() => { const r = rng(5); return [...scored].sort(() => r() - 0.5).slice(0, K).map(c => c.id); })();

const policies = [
  ['Do nothing', []],
  ['Discount everyone', scored.map(c => c.id)],
  ['Random ' + K, rndPick],
  ['Propensity top ' + K, byPropensity],
  ['Uplift top ' + K, byUpliftOnly],
  ['Policy engine (gated)', policy.chosen.map(c => c.id)],
];

const base = evaluatePolicy(deploy, [], { discountRate: DISCOUNT, marginRate: MARGIN });

console.log('');
console.log('  ' + pad('POLICY', 24) + rpad('TARGETED', 9) + rpad('DISCOUNT', 12)
  + rpad('NET MARGIN', 13) + rpad('VS NOTHING', 12) + rpad('RETURN/$', 10));
console.log('  ' + '─'.repeat(80));

const results = [];
for (const [name, ids] of policies) {
  const r = evaluatePolicy(deploy, ids, { discountRate: DISCOUNT, marginRate: MARGIN });
  const lift = ((r.net - base.net) / base.net) * 100;
  // What each dollar of discount actually bought. Negative means the offer
  // destroyed more margin than it created - which blanket discounting does.
  const perDollar = r.discountSpend ? (r.net - base.net) / r.discountSpend : null;
  results.push({ name, ...r, lift, perDollar });
  console.log('  ' + pad(name, 24) + rpad(r.targeted, 9) + rpad(usd(r.discountSpend), 12)
    + rpad(usd(r.net), 13) + rpad((lift >= 0 ? '+' : '') + lift.toFixed(1) + '%', 12)
    + rpad(perDollar === null ? '—' : (perDollar >= 0 ? '+' : '') + perDollar.toFixed(2), 10));
}

/* ───────────────────────────── the verdict ───────────────────────────── */

const prop = results.find(r => r.name.startsWith('Propensity'));
const gated = results.find(r => r.name.startsWith('Policy engine'));
const all = results.find(r => r.name === 'Discount everyone');

console.log('');
console.log('  ' + '─'.repeat(72));
if (gated.net > prop.net && gated.net > all.net) {
  console.log('  THESIS HOLDS');
  console.log('  vs discounting everyone: ' + usd(gated.net - all.net) + ' more net margin, '
    + ((1 - gated.targeted / all.targeted) * 100).toFixed(0) + '% fewer customers discounted,');
  console.log('  ' + usd(all.discountSpend - gated.discountSpend) + ' less spent on discounts.');
  console.log('  vs propensity targeting at the same volume: ' + usd(gated.net - prop.net) + ' more net margin.');
} else {
  console.log('  THESIS DOES NOT HOLD ON THIS RUN — reporting it rather than tuning until it does.');
  console.log('  gated ' + usd(gated.net) + '  propensity ' + usd(prop.net) + '  blanket ' + usd(all.net));
}

/* ─────────────────── who the model refused to touch, and why ─────────────────── */

console.log('');
console.log('  AUDIENCE  ' + Object.entries(policy.byQuadrant)
  .map(([k, v]) => k.replace('_', ' ') + ' ' + v).join('   ·   '));
console.log('  TARGETED  ' + (Object.entries(policy.chosenByQuadrant)
  .map(([k, v]) => k.replace('_', ' ') + ' ' + v).join('   ·   ') || 'none'));
console.log('  BUDGET    ' + usd(policy.spend) + ' of ' + usd(policy.budget)
  + '   (' + (policy.share * 100).toFixed(1) + '% of the base contacted)');

console.log('');
console.log('  SAMPLE DECISIONS — every action carries its reason');
for (const c of policy.chosen.slice(0, 2)) {
  console.log('   ✓ ' + c.id + '  ' + c.reason);
}
for (const c of policy.rejected.slice(0, 3)) {
  console.log('   ✗ ' + c.id + '  ' + c.reason + '  — ' + QUADRANT_COPY[c.quadrant]);
}

/* ─────────── did the quadrants actually recover the latent types? ─────────── */

const conf = {};
for (const c of scored) {
  const predicted = quadrant(c.pControl, c.tau);
  (conf[c.kind] ??= {});
  conf[c.kind][predicted] = (conf[c.kind][predicted] ?? 0) + 1;
}
console.log('');
console.log('  RECOVERY — did the model find the archetypes it was never told about?');
for (const [kind, row] of Object.entries(conf)) {
  const top = Object.entries(row).sort((a, b) => b[1] - a[1])[0];
  const total = Object.values(row).reduce((a, b) => a + b, 0);
  console.log('   ' + pad(kind, 20) + '-> ' + pad(top[0], 14)
    + ' ' + ((top[1] / total) * 100).toFixed(0) + '% of ' + total);
}
console.log('');
