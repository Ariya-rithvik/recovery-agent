/**
 * Policy engine + action ledger — "every money action explainable, bounded and
 * gated", which is the bar any agent that moves money has to meet.
 *
 * The patterns here are ported from the action worker in Manthan
 * (github.com/akash-mondal/manthan), our team's dispute-investigation agent,
 * re-implemented for this codebase. Four of them
 * matter and each exists because the obvious version is unsafe:
 *
 *  1. IDEMPOTENCY IS A HASH, NOT A STRING CONCAT.
 *     sha256([case, kind, payload]) with sorted keys. Two callers building the
 *     same action from the same facts land on the same key even if they built
 *     the payload in a different order — which is exactly when a retry storm
 *     would otherwise double-charge someone.
 *
 *  2. THE LEDGER IS CHECKED BEFORE THE CALL, not just after.
 *     Upstream idempotency is a bonus, not a guarantee: a payment-link create
 *     has none. Guarding on our own ledger is what actually prevents the second
 *     charge.
 *
 *  3. A FAILED ACTION IS RECORDED VERBATIM AND KEEPS A NULL external_ref.
 *     Never synthesise a success reference. An audit trail that quietly invents
 *     receipt ids is worse than no audit trail, because it is believed.
 *
 *  4. TWO-PERSON APPROVAL MEANS TWO DISTINCT PEOPLE.
 *     A tier ladder that accepts the same approver twice is theatre. This
 *     rejects it.
 *
 * No dependencies beyond node:crypto.
 */

import { createHash } from 'node:crypto';

/* ─────────────────────────── approval tiers ─────────────────────────── */

/** Amounts in cents, as Stripe sends them. Ordered low to high; first match wins. */
export const TIERS = [
  { id: 'auto', max: 2500, approvals: 0, label: 'auto-approved' },
  { id: 'one_click', max: 10000, approvals: 1, label: 'operator one-click' },
  { id: 'two_person', max: Infinity, approvals: 2, label: 'two-person approval' },
];

export const tierFor = amount => TIERS.find(t => amount <= t.max);

/* ─────────────────────────── idempotency ─────────────────────────── */

/** Stable stringify: key order must not change the hash. */
function stable(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
}

export function idempotencyKey(caseId, kind, payload) {
  return createHash('sha256')
    .update(stable([String(caseId), kind, payload ?? {}]))
    .digest('hex')
    .slice(0, 32);
}

/* ─────────────────────────────── ledger ─────────────────────────────── */

export class ActionError extends Error {
  constructor(message, { retriable = false } = {}) { super(message); this.retriable = retriable; }
}

/**
 * States: proposed -> approved -> firing -> succeeded | failed
 * A skipped action never leaves `proposed`; it carries the reason it was gated.
 */
export class ActionLedger {
  constructor({ budget = Infinity, clock = () => new Date().toISOString() } = {}) {
    this.actions = new Map();     // id -> action
    this.byKey = new Map();       // idempotency key -> id
    this.log = [];                // append-only
    this.budget = budget;
    this.spent = 0;
    this.clock = clock;
    this._seq = 0;
  }

  _record(event, action, extra = {}) {
    this.log.push({ at: this.clock(), event, action_id: action.id, kind: action.kind, ...extra });
  }

  /**
   * Register an intended action. Returns it whether or not it is allowed to
   * proceed — a refusal is a first-class outcome with a reason attached, not a
   * silent drop.
   */
  propose({ caseId, kind, payload, amount, cost = 0, rationale = null }) {
    const key = idempotencyKey(caseId, kind, payload);

    // (2) guard on our own ledger BEFORE anything is called upstream
    if (this.byKey.has(key)) {
      const prior = this.actions.get(this.byKey.get(key));
      const dup = {
        id: 'act_' + (++this._seq), caseId, kind, payload, amount, cost, key, rationale,
        state: 'proposed', skipped: 'duplicate of ' + prior.id + ' (same idempotency key)',
        tier: tierFor(amount), approvals: [], external_ref: null, error: null,
      };
      this.actions.set(dup.id, dup);
      this._record('skipped', dup, { reason: dup.skipped });
      return dup;
    }

    const tier = tierFor(amount);
    const a = {
      id: 'act_' + (++this._seq), caseId, kind, payload, amount, cost, key, tier, rationale,
      state: 'proposed', skipped: null, approvals: [], external_ref: null, error: null,
    };

    if (this.spent + cost > this.budget) {
      a.skipped = 'budget exhausted (' + Math.round(this.spent) + ' of ' + Math.round(this.budget) + ')';
      this.actions.set(a.id, a);
      this._record('skipped', a, { reason: a.skipped });
      return a;
    }

    this.actions.set(a.id, a);
    this.byKey.set(key, a.id);
    this._record('proposed', a, { amount, tier: tier.id, requires: tier.approvals });
    if (tier.approvals === 0) { a.state = 'approved'; this._record('auto_approved', a); }
    return a;
  }

  /** (4) Two-person means two DISTINCT people. */
  approve(id, approver) {
    const a = this.actions.get(id);
    if (!a) throw new ActionError('unknown action ' + id);
    if (a.skipped) throw new ActionError('cannot approve a skipped action: ' + a.skipped);
    if (a.state !== 'proposed') throw new ActionError('action is ' + a.state + ', not awaiting approval');
    if (!approver) throw new ActionError('approver required');
    if (a.approvals.includes(approver)) {
      throw new ActionError(approver + ' has already approved ' + id
        + '; ' + a.tier.label + ' requires ' + a.tier.approvals + ' distinct approvers');
    }
    a.approvals.push(approver);
    this._record('approval', a, { approver, have: a.approvals.length, need: a.tier.approvals });
    if (a.approvals.length >= a.tier.approvals) {
      a.state = 'approved';
      this._record('approved', a, { approvers: [...a.approvals] });
    }
    return a;
  }

  /**
   * Execute. `adapter` is an async fn returning { external_ref }. Anything it
   * throws is recorded verbatim; we never invent a reference.
   */
  async fire(id, adapter) {
    const a = this.actions.get(id);
    if (!a) throw new ActionError('unknown action ' + id);
    if (a.state === 'succeeded') { this._record('replayed', a, { external_ref: a.external_ref }); return a; }
    if (a.state !== 'approved') throw new ActionError('refusing to fire an action in state ' + a.state);

    a.state = 'firing';
    this._record('firing', a, { idempotency_key: a.key });
    try {
      const res = await adapter({ ...a.payload, idempotency_key: a.key });
      const ref = res?.external_ref ?? res?.id ?? res?.short_url ?? null;
      // (3) a "success" with nothing to point at is not a success
      if (!ref) throw new ActionError('adapter returned no external reference');
      a.external_ref = ref;
      a.state = 'succeeded';
      this.spent += a.cost;
      this._record('succeeded', a, { external_ref: ref, spent: Math.round(this.spent) });
    } catch (e) {
      a.state = 'failed';
      a.error = String(e?.message ?? e);        // verbatim, not summarised
      a.external_ref = null;
      this._record('failed', a, { error: a.error, retriable: !!e?.retriable });
    }
    return a;
  }

  /* ───────────────────────────── reporting ───────────────────────────── */

  all() { return [...this.actions.values()]; }
  byState(s) { return this.all().filter(a => a.state === s && !a.skipped); }
  skipped() { return this.all().filter(a => a.skipped); }

  summary() {
    const s = { proposed: 0, approved: 0, firing: 0, succeeded: 0, failed: 0, skipped: 0 };
    for (const a of this.all()) { if (a.skipped) s.skipped++; else s[a.state]++; }
    const queue = {};
    for (const a of this.all()) {
      if (a.skipped || a.state !== 'proposed') continue;
      queue[a.tier.id] = (queue[a.tier.id] ?? 0) + 1;
    }
    return {
      ...s,
      awaiting_approval: queue,
      spent: Math.round(this.spent),
      budget: this.budget === Infinity ? null : Math.round(this.budget),
      events: this.log.length,
    };
  }

  /** Append-only trail, newest last. This is the artefact a reviewer reads. */
  audit({ limit = 50 } = {}) { return this.log.slice(-limit); }
}
