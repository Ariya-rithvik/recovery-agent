/**
 * Safety tests for the policy engine.  node src/policy.test.mjs
 *
 * These are the properties the track's bar actually rests on. If any of them
 * fail, the phrase "every money action explainable, bounded and gated" is a
 * claim rather than a fact, so this exits non-zero and the build should stop.
 */

import { ActionLedger, idempotencyKey, tierFor, TIERS } from './policy.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
};
const threw = async fn => { try { await fn(); return null; } catch (e) { return String(e.message); } };

console.log('');
console.log('  POLICY ENGINE — safety properties');
console.log('  ' + '-'.repeat(66));

/* ── idempotency ── */
const k1 = idempotencyKey('case1', 'payment_link', { amount: 100, notes: { a: 1, b: 2 } });
const k2 = idempotencyKey('case1', 'payment_link', { notes: { b: 2, a: 1 }, amount: 100 });
ok('same facts, different key order -> same idempotency key', k1 === k2, k1 + ' vs ' + k2);
ok('different amount -> different key',
  k1 !== idempotencyKey('case1', 'payment_link', { amount: 101, notes: { a: 1, b: 2 } }));
ok('different case -> different key',
  k1 !== idempotencyKey('case2', 'payment_link', { amount: 100, notes: { a: 1, b: 2 } }));

/* ── tiers ── */
ok('$25.00 is auto-approved', tierFor(2500).id === 'auto');
ok('$100.00 is one-click', tierFor(10000).id === 'one_click');
ok('$100.01 needs two people', tierFor(10001).id === 'two_person');
ok('tiers are ordered and cover everything', TIERS[TIERS.length - 1].max === Infinity);

/* ── the adapter must not be called twice for the same action ── */
{
  const L = new ActionLedger();
  let calls = 0;
  const adapter = async () => { calls++; return { external_ref: 'plink_1' }; };
  const a = L.propose({ caseId: 'c1', kind: 'payment_link', payload: { amt: 10 }, amount: 100, cost: 6 });
  await L.fire(a.id, adapter);
  await L.fire(a.id, adapter);                      // replay
  ok('firing a succeeded action does not call the adapter again', calls === 1, 'calls=' + calls);

  const dup = L.propose({ caseId: 'c1', kind: 'payment_link', payload: { amt: 10 }, amount: 100, cost: 6 });
  ok('same facts proposed twice is marked duplicate', !!dup.skipped, dup.skipped ?? 'not skipped');
  ok('duplicate is never approved', dup.state === 'proposed');
}

/* ── failure is recorded verbatim, with no invented reference ── */
{
  const L = new ActionLedger();
  const a = L.propose({ caseId: 'c2', kind: 'payment_link', payload: {}, amount: 100, cost: 6 });
  await L.fire(a.id, async () => { throw new Error('Amount must be at least $0.50 usd'); });
  ok('failed action keeps external_ref null', a.external_ref === null, String(a.external_ref));
  ok('failed action stores the upstream message verbatim',
    a.error === 'Amount must be at least $0.50 usd', a.error);
  ok('failed action does not consume budget', L.spent === 0, String(L.spent));
  ok('failure is in the audit trail', L.audit().some(e => e.event === 'failed'));
}

/* ── an adapter that returns nothing useful is a failure, not a success ── */
{
  const L = new ActionLedger();
  const a = L.propose({ caseId: 'c3', kind: 'payment_link', payload: {}, amount: 100, cost: 6 });
  await L.fire(a.id, async () => ({ ok: true }));            // no ref of any kind
  ok('success with no external reference is treated as failure', a.state === 'failed', a.state);
}

/* ── approval gates ── */
{
  const L = new ActionLedger();
  const big = L.propose({ caseId: 'c4', kind: 'refund', payload: {}, amount: 25000, cost: 0 });
  ok('two-person action starts unapproved', big.state === 'proposed');

  const e1 = await threw(() => L.fire(big.id, async () => ({ external_ref: 'x' })));
  ok('cannot fire without approval', /refusing to fire/.test(e1 ?? ''), e1 ?? 'did not throw');

  L.approve(big.id, 'asha');
  ok('one approval is not enough for two-person', big.state === 'proposed');

  const e2 = await threw(() => L.approve(big.id, 'asha'));
  ok('the same person cannot approve twice', /already approved/.test(e2 ?? ''), e2 ?? 'did not throw');

  L.approve(big.id, 'ravi');
  ok('two distinct approvers unlock it', big.state === 'approved', big.state);
}

/* ── the budget is a hard stop ── */
{
  const L = new ActionLedger({ budget: 100 });
  const fired = [];
  for (let i = 0; i < 5; i++) {
    const a = L.propose({ caseId: 'c' + i, kind: 'payment_link', payload: { i }, amount: 100, cost: 40 });
    if (!a.skipped) { await L.fire(a.id, async () => ({ external_ref: 'p' + i })); fired.push(a); }
  }
  ok('budget stops the batch mid-way', fired.length === 2, 'fired=' + fired.length);
  ok('spend never exceeds the budget', L.spent <= 100, String(L.spent));
  ok('the stop is recorded, not silent', L.skipped().some(a => /budget exhausted/.test(a.skipped)));
}

/* ── audit completeness ── */
{
  const L = new ActionLedger();
  const a = L.propose({ caseId: 'c9', kind: 'payment_link', payload: {}, amount: 3000, cost: 6,
    rationale: 'uplift +31pp' });
  L.approve(a.id, 'asha');
  await L.fire(a.id, async () => ({ external_ref: 'plink_9' }));
  const events = L.audit().map(e => e.event);
  ok('audit covers propose -> approve -> fire -> succeed',
    ['proposed', 'approval', 'approved', 'firing', 'succeeded'].every(e => events.includes(e)),
    events.join(','));
  ok('every action carries its rationale', a.rationale === 'uplift +31pp');
}

console.log('  ' + '-'.repeat(66));
console.log('  ' + pass + ' passed, ' + fail + ' failed');
console.log('');
process.exit(fail ? 1 : 0);
