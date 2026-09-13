import { usd } from './money.mjs';

/**
 * Incrementality engine — who converts BECAUSE of the intervention.
 *
 * This is the thesis of the whole project. Every marketing tool ranks customers
 * by P(convert). That is the wrong quantity. The right one is
 *
 *     tau(x) = P(convert | treated, x) - P(convert | not treated, x)
 *
 * because a discount given to someone who would have bought anyway is margin
 * handed away for nothing, and a discount given to a discount-averse loyalist
 * actively costs you the sale. Both are invisible to a propensity model, and
 * both are ordinary in real merchant data.
 *
 * Estimator: T-learner (one model per arm), trained ONLY on randomised
 * assignment + observed binary outcome — exactly what a merchant has after
 * running one bounded test-mode experiment. No dependency on the generator.
 */

/* ─────────────────────── logistic regression ─────────────────────── */

const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const sig = z => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));

export function fitLogistic(X, y, { epochs = 400, lr = 0.35, l2 = 2e-3 } = {}) {
  const d = X[0].length;
  const w = new Array(d).fill(0);
  let b = 0;
  for (let e = 0; e < epochs; e++) {
    const gw = new Array(d).fill(0);
    let gb = 0;
    for (let i = 0; i < X.length; i++) {
      const err = sig(b + dot(w, X[i])) - y[i];
      for (let j = 0; j < d; j++) gw[j] += err * X[i][j];
      gb += err;
    }
    for (let j = 0; j < d; j++) w[j] -= lr * (gw[j] / X.length + l2 * w[j]);
    b -= lr * (gb / X.length);
  }
  return { w, b, predict: x => sig(b + dot(w, x)) };
}

/* ───────────────────────────── T-learner ───────────────────────────── */

/**
 * @param rows [{ x, treated: 0|1, converted: 0|1 }]  one row per customer in the
 *        randomised experiment. Nothing else. This is the honest input.
 */
export function fitUplift(rows, opts) {
  const t = rows.filter(r => r.treated === 1);
  const c = rows.filter(r => r.treated === 0);
  if (t.length < 30 || c.length < 30) {
    return { ok: false, reason: `too few in an arm (treated ${t.length}, control ${c.length}); need 30+ each` };
  }

  // Baseline propensity comes from the control arm - that is what "would have
  // happened anyway" means, and the quadrant test needs it.
  const mC = fitLogistic(c.map(r => r.x), c.map(r => r.converted), opts);

  /*
   * Uplift itself is estimated by class-variable transformation rather than by
   * subtracting two fitted curves. A T-learner has to find a few percentage
   * points of effect in the DIFFERENCE of two independently-fitted models, and
   * on a few thousand binary outcomes that difference is mostly variance - it
   * was ranking worse than random here, and calling habitual buyers persuadable.
   *
   * With balanced 50/50 assignment, define Z = 1 when the outcome "agrees" with
   * the arm (treated and converted, or untreated and did not). Then
   * tau(x) = 2 * P(Z = 1 | x) - 1, so a single classifier targets the effect
   * directly. (Jaskowski & Jaroszewicz.)
   */
  const share = t.length / rows.length;
  if (Math.abs(share - 0.5) > 0.08) {
    return { ok: false, reason: `assignment is ${(share * 100).toFixed(0)}/${(100 - share * 100).toFixed(0)}; `
      + 'the transform assumes balanced randomisation' };
  }
  const zx = rows.map(r => r.x);
  const zy = rows.map(r => ((r.treated === 1) === (r.converted === 1) ? 1 : 0));
  const mZ = fitLogistic(zx, zy, { epochs: 700, lr: 0.5, l2: 1e-3, ...opts });

  const uplift = x => 2 * mZ.predict(x) - 1;
  const pControl = x => mC.predict(x);
  return {
    ok: true,
    n: { treated: t.length, control: c.length },
    estimator: 'class-variable-transformation',
    pControl,
    uplift,
    // kept consistent with the two above rather than fitted separately
    pTreated: x => Math.max(0, Math.min(1, pControl(x) + uplift(x))),
  };
}

/* ────────────────────────────── quadrants ──────────────────────────── */

/**
 * The four kinds of customer. Naming them is what makes the output explainable
 * to a merchant, and "sleeping dog" is the one that turns a targeting list from
 * merely inefficient into actively harmful.
 */
export function quadrant(pControl, tau, { eps = 0.02, high = 0.45 } = {}) {
  if (tau < -eps) return 'sleeping_dog';   // pushing makes it worse
  if (tau > eps) return 'persuadable';     // the only group worth paying for
  return pControl >= high ? 'sure_thing' : 'lost_cause';
}

export const QUADRANT_COPY = {
  persuadable: 'Converts because of the offer. Spend here.',
  sure_thing: 'Converts anyway. Discounting them is margin given away.',
  lost_cause: 'Unlikely either way. Spending changes almost nothing.',
  sleeping_dog: 'Responds worse when pushed. Leave alone.',
};

/* ───────────────────────────── Qini curve ─────────────────────────── */

/**
 * Qini is the standard way to score an uplift model, and unlike AUC it can be
 * computed from ordinary randomised-experiment data: no ground-truth tau needed.
 * A merchant can therefore run this on their own real test and see whether the
 * model is any good.
 */
export function qini(scored, bins = 20) {
  const s = [...scored].sort((a, b) => b.score - a.score);
  const N = s.length;
  const points = [];
  let cumT = 0, cumC = 0, nT = 0, nC = 0;
  const totT = s.filter(r => r.treated === 1).length;
  const totC = N - totT;

  for (let i = 0; i < N; i++) {
    if (s[i].treated === 1) { cumT += s[i].converted; nT++; } else { cumC += s[i].converted; nC++; }
    if ((i + 1) % Math.ceil(N / bins) === 0 || i === N - 1) {
      const gain = cumT - (nC ? cumC * (nT / Math.max(1, nC)) : 0);
      points.push({ depth: +((i + 1) / N).toFixed(3), gain: +gain.toFixed(2) });
    }
  }
  // area between the model curve and the random-targeting diagonal
  const overall = cumT - (totC ? cumC * (totT / totC) : 0);
  let area = 0;
  let prevD = 0, prevG = 0;
  for (const p of points) {
    const rand = overall * p.depth;
    area += ((p.gain - rand) + (prevG - overall * prevD)) / 2 * (p.depth - prevD);
    prevD = p.depth; prevG = p.gain;
  }
  return { points, coefficient: +area.toFixed(4), overallGain: +overall.toFixed(2) };
}

/* ────────────────────────── policy engine ────────────────────────── */

/**
 * Budget-bounded, explainable, gated selection — the three words the brief asks
 * for. Every customer selected carries a reason; every customer rejected carries
 * a reason; the budget is a hard stop, not a suggestion.
 *
 * @param candidates [{ id, aov, pControl, tau }]
 * @param rules { budget, discountRate, marginRate, minExpectedGain, maxShare, blockQuadrants }
 */
export function selectTargets(candidates, rules) {
  const {
    budget, discountRate = 0.10, marginRate = 0.35,
    minExpectedGain = 0, maxShare = 1, blockQuadrants = ['sleeping_dog', 'sure_thing'],
  } = rules;

  const scored = candidates.map(c => {
    const q = quadrant(c.pControl, c.tau);
    // Expected incremental margin, net of the discount we pay on every
    // treated conversion - including the ones that would have happened anyway.
    const gain = c.tau * c.aov * marginRate - c.pTreated * c.aov * discountRate;
    return { ...c, quadrant: q, expectedGain: gain, cost: c.pTreated * c.aov * discountRate };
  }).sort((a, b) => b.expectedGain - a.expectedGain);

  const cap = Math.floor(candidates.length * maxShare);
  const chosen = [];
  const rejected = [];
  let spent = 0;

  for (const c of scored) {
    let reason = null;
    if (blockQuadrants.includes(c.quadrant)) reason = `blocked: ${c.quadrant.replace('_', ' ')}`;
    else if (c.expectedGain <= minExpectedGain) reason = `expected gain ${usd(c.expectedGain)} below floor`;
    else if (chosen.length >= cap) reason = `audience cap reached (${(maxShare * 100).toFixed(0)}%)`;
    else if (spent + c.cost > budget) reason = 'budget exhausted';

    if (reason) { rejected.push({ ...c, reason }); continue; }
    spent += c.cost;
    chosen.push({
      ...c,
      reason: `${c.quadrant.replace('_', ' ')} · uplift ${(c.tau * 100).toFixed(1)}pp · `
        + `expected +${usd(c.expectedGain)} for ${usd(c.cost)} of coupon`,
    });
  }

  return {
    chosen, rejected,
    spend: Math.round(spent),
    budget,
    share: +(chosen.length / candidates.length).toFixed(4),
    byQuadrant: tally(scored.map(c => c.quadrant)),
    chosenByQuadrant: tally(chosen.map(c => c.quadrant)),
  };
}

const tally = arr => arr.reduce((m, k) => { m[k] = (m[k] ?? 0) + 1; return m; }, {});

/* ───────────────────────────── scoring ───────────────────────────── */

/**
 * Expected net margin of a targeting decision, evaluated against TRUE response.
 * Legitimate here because we control the generator; on real data this is exactly
 * what the held-out arm of the experiment measures instead.
 */
export function evaluatePolicy(customers, targetedIds, { discountRate = 0.10, marginRate = 0.35 } = {}) {
  const set = targetedIds instanceof Set ? targetedIds : new Set(targetedIds);
  let net = 0, conversions = 0, discountSpend = 0;
  for (const c of customers) {
    const targeted = set.has(c.id);
    const p = targeted ? c.truth.p1 : c.truth.p0;
    const perOrder = c.aovTrue * marginRate - (targeted ? c.aovTrue * discountRate : 0);
    net += p * perOrder;
    conversions += p;
    if (targeted) discountSpend += p * c.aovTrue * discountRate;
  }
  return {
    net: Math.round(net),
    conversions: +conversions.toFixed(1),
    discountSpend: Math.round(discountSpend),
    targeted: set.size,
  };
}
