/**
 * Pacer rules, tested individually and without an LLM — which is the whole
 * reason Manthan factored them out of the prompt in the first place.
 *
 *   node src/pacer.test.mjs
 */

import { judgeDecision, judgeBatch, pace } from './pacer.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
};

// amounts in cents: a $30.00 invoice, an expected value of $4.00
const base = { amount: 3000, tau: 0.30, pControl: 0.2, pTreated: 0.5, action: 'call', consent: true, ev: 400 };

console.log('');
console.log('  PACER — governance rules');
console.log('  ' + '-'.repeat(66));

/* D1 — a call must show its arithmetic */
{
  const noMath = judgeDecision({ ...base, brief: 'This customer seems worth calling.' });
  ok('D1 flags a voice call whose brief shows no arithmetic',
    noMath.kind === 'nudge' && noMath.rule === 'D1_call_math_missing', noMath.kind);

  const withMath = judgeDecision({ ...base, brief: 'Incremental +30.0pp, expected value $4.00.' });
  ok('D1 passes when the brief carries the numbers', withMath.kind === 'proceed', withMath.rule ?? '');

  const already = judgeDecision({ ...base, brief: 'no numbers here' }, new Set(['D1_call_math_missing']));
  ok('D1 is idempotent — fires at most once per batch', already.kind === 'proceed', already.rule ?? '');
}

/* D2 — never spend on a negative effect */
{
  const v = judgeDecision({ ...base, tau: -0.11, brief: 'uplift -11.0pp, ev $0.50' });
  ok('D2 halts a contact with negative estimated effect',
    v.kind === 'halt' && v.rule === 'D2_negative_uplift', v.kind);

  const none = judgeDecision({ ...base, tau: -0.11, action: 'none', brief: '-11.0pp' });
  ok('D2 does not fire when we are not contacting them', none.kind === 'proceed', none.rule ?? '');
}

/* D3 — noise band */
{
  const v = judgeDecision({ ...base, tau: 0.008, brief: 'uplift +0.8pp, ev $0.40' });
  ok('D3 nudges when the effect is inside the noise band',
    v.kind === 'nudge' && v.rule === 'D3_noise_band', v.kind);
}

/* D4 — expected value must be positive */
{
  const v = judgeDecision({ ...base, ev: -12, brief: 'uplift +30.0pp, ev -$0.12' });
  ok('D4 halts a loss-making action even when uplift is high',
    v.kind === 'halt' && v.rule === 'D4_negative_ev', v.kind);
}

/* D5 — a voice call needs consent; email does not */
{
  const v = judgeDecision({ ...base, consent: false, brief: 'uplift +30.0pp, ev $4.00' });
  ok('D5 halts a voice call with no consent on file',
    v.kind === 'halt' && v.rule === 'D5_call_without_consent', v.rule ?? v.kind);

  const e = judgeDecision({ ...base, action: 'email', consent: false, brief: 'uplift +30.0pp, ev $4.00' });
  ok('D5 still lets the same customer be emailed', e.kind === 'proceed', e.rule ?? '');
}

/* ordering — a softer rule must never shadow a halt */
{
  const v = judgeDecision({ ...base, tau: -0.11, brief: 'no numbers here' });
  ok('halts run before nudges: no arithmetic AND negative uplift is halted, not waved through',
    v.kind === 'halt' && v.rule === 'D2_negative_uplift', v.rule ?? v.kind);
}

/* ── batch invariants ── */
const okBatch = {
  approved: 500, rejected: 900, spend: 70000, budget: 78000, qini: 31,
  contactedByQuadrant: { persuadable: 495, sure_thing: 5 },
};

ok('B0 a healthy batch proceeds', judgeBatch(okBatch).kind === 'proceed',
  judgeBatch(okBatch).rule ?? '');

{
  const v = judgeBatch({ ...okBatch, budget: null });
  ok('B1 halts a batch that ran without a budget',
    v.kind === 'halt' && v.rule === 'B1_no_budget', v.rule ?? v.kind);
}
{
  const v = judgeBatch({ ...okBatch, spend: 99000 });
  ok('B2 halts when spend exceeded the cap',
    v.kind === 'halt' && v.rule === 'B2_budget_exceeded', v.rule ?? v.kind);
}
{
  const v = judgeBatch({ ...okBatch, contactedByQuadrant: { persuadable: 300, sure_thing: 200 } });
  ok('B3 nudges when too much spend goes to customers who recover anyway',
    v.kind === 'nudge' && v.rule === 'B3_sure_thing_leak', v.rule ?? v.kind);
}
{
  const v = judgeBatch({ ...okBatch, contactedByQuadrant: { persuadable: 499, sleeping_dog: 1 } });
  ok('B4 halts if even one sleeping dog is contacted',
    v.kind === 'halt' && v.rule === 'B4_sleeping_dog_contacted', v.rule ?? v.kind);
}
{
  const v = judgeBatch({ ...okBatch, qini: -2 });
  ok('B5 halts when the model is no better than random',
    v.kind === 'halt' && v.rule === 'B5_model_no_better_than_random', v.rule ?? v.kind);
}
{
  const v = judgeBatch({ ...okBatch, rejected: 0 });
  ok('B6 nudges when nothing was rejected',
    v.kind === 'nudge' && v.rule === 'B6_no_selection', v.rule ?? v.kind);
}

/* ── pace() over a mixed batch ── */
{
  const ds = [
    { ...base, id: 'a', brief: 'uplift +30.0pp ev $4.00' },
    { ...base, id: 'b', tau: -0.09, brief: 'uplift -9.0pp ev $0.10' },
    { ...base, id: 'c', ev: -5, brief: 'uplift +30.0pp ev -$0.05' },
    { ...base, id: 'd', brief: 'no numbers at all' },
  ];
  const r = pace(ds);
  ok('pace() stops the negative-uplift and negative-EV rows', r.stopped.length === 2,
    'stopped=' + r.stopped.map(x => x.id).join(','));
  ok('pace() lets a nudged row through with a warning attached',
    r.nudges.length === 1 && r.allowed.some(x => x.id === 'd'),
    'nudges=' + r.nudges.length);
  ok('pace() reports which rules fired', r.fired.length >= 2, r.fired.join(','));
}

console.log('  ' + '-'.repeat(66));
console.log('  ' + pass + ' passed, ' + fail + ' failed');
console.log('');
process.exit(fail ? 1 : 0);
