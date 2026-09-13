import type { FailureRecord, Pattern, Procedure } from "./types.ts";
import type { PhoneGraph, CallPlan, Scenario } from "./gauntlet-types.ts";
import { runGauntlet } from "./gauntlet.ts";

/**
 * How many times something must go wrong before it counts as a lesson rather
 * than an anecdote. Two is too eager — any plan fails twice on a bad afternoon.
 */
const MIN_OCCURRENCES = 3;

/** A pattern seen only at one organisation may be that organisation's quirk. */
const MIN_ORGS = 1;

function signature(f: FailureRecord): string {
  return [f.goalClass, f.kind, f.needs ?? "-"].join("|");
}

/**
 * Turn a batch of rehearsals into failure records.
 *
 * The gauntlet is free — it costs no calls — which is what makes a corpus
 * large enough to mine affordable in the first place. Real failures carry more
 * weight, but there are never many of them.
 */
export function harvestRehearsals(
  graph: PhoneGraph,
  plan: CallPlan,
  scenarios: Scenario[],
  goalClass: string,
  at: string
): FailureRecord[] {
  const report = runGauntlet(graph, plan, scenarios);
  const out: FailureRecord[] = [];

  report.runs.forEach((run, i) => {
    if (!run.failure) return;
    out.push({
      id: `${graph.orgId}.${goalClass}.${i}`,
      origin: "rehearsal",
      orgId: graph.orgId,
      orgName: graph.orgName,
      goalClass,
      kind: run.failure.kind,
      detail: run.failure.detail,
      needs: run.failure.needs,
      atNode: run.failure.atNode,
      observedAt: at,
      evidence: `rehearsal scenario: ${run.scenario}`,
    });
  });

  return out;
}

/** Group failures into patterns worth acting on, discarding the noise. */
export function mine(corpus: FailureRecord[]): Pattern[] {
  const groups = new Map<string, FailureRecord[]>();
  for (const f of corpus) {
    const s = signature(f);
    groups.set(s, [...(groups.get(s) ?? []), f]);
  }

  const patterns: Pattern[] = [];

  for (const [sig, occurrences] of groups) {
    const orgs = [...new Set(occurrences.map((o) => o.orgId))];
    const liveCount = occurrences.filter((o) => o.origin === "live").length;

    if (occurrences.length < MIN_OCCURRENCES) continue;
    if (orgs.length < MIN_ORGS) continue;

    // A real call that failed is worth more evidence than a simulated one.
    const weight = occurrences.length + liveCount * 2 + (orgs.length - 1) * 2;
    const confidence = Math.min(0.98, weight / (weight + 4));

    patterns.push({
      signature: sig,
      goalClass: occurrences[0].goalClass,
      kind: occurrences[0].kind,
      needs: occurrences[0].needs,
      occurrences,
      orgs,
      liveCount,
      confidence,
    });
  }

  return patterns.sort((a, b) => b.confidence - a.confidence);
}

/**
 * Compile the patterns for one goal class into a corrected procedure.
 *
 * This is the step the existing ecosystem stops short of. `redline` and
 * `otherend` produce a minimal edit to the task text that failed. This
 * produces a standalone procedure for the whole class of task, which is what
 * a skill actually is.
 */
export function compile(goalClass: string, patterns: Pattern[]): Procedure {
  const relevant = patterns.filter((p) => p.goalClass === goalClass);

  // Anything a failure needed and did not have is collected before dialling —
  // whether the other side asked for it or the correct handling depended on it.
  const collectFirst = [...new Set(relevant.filter((p) => p.needs).map((p) => p.needs!))];

  const recoveries: Procedure["recoveries"] = [];
  const refuseIf: string[] = [];
  let maxTransfers = 2;

  for (const p of relevant) {
    if (p.needs) {
      refuseIf.push(
        p.kind === "missing_info"
          ? `${p.needs} is not in hand — ${p.occurrences.length} calls have died at this question`
          : `${p.needs} is not in hand — ${p.occurrences.length} calls ended in ${p.kind} without it`
      );
    }

    switch (p.kind) {
      case "missing_info":
        break;
      case "wrong_department":
        recoveries.push({
          kind: p.kind,
          when: "the desk says this is not theirs",
          then: "Ask who does handle it, take the desk name and extension, and request a warm transfer rather than hanging up.",
        });
        break;
      case "dead_end":
        recoveries.push({
          kind: p.kind,
          when: "no onward route is offered",
          then: "Ask for the owning team's name and the best time to reach them, record it, and end the call politely.",
        });
        break;
      case "too_many_transfers":
        maxTransfers = 3;
        recoveries.push({
          kind: p.kind,
          when: "a third transfer is proposed",
          then: "Before being transferred again, ask for a direct number in case the call drops.",
        });
        break;
      case "refused":
        recoveries.push({
          kind: p.kind,
          when: "the question is refused",
          then: "Do not rephrase and retry. Record the refusal as the outcome and route to a human.",
        });
        break;
      case "voicemail_disclosure":
        recoveries.push({
          kind: p.kind,
          when: "voicemail or an answering machine picks up",
          then: "Leave a neutral message only: a first name and a number to call back. Never say who the call is from, why you are calling, an amount or any account detail to a machine.",
        });
        break;
      case "unverified_party":
        recoveries.push({
          kind: p.kind,
          when: "someone other than the named person answers",
          then: "Ask for the named person and say nothing about why you are calling. Continue only once they confirm it is them; if they are not available, leave a first name and a callback number and end the call.",
        });
        break;
      case "prohibited_action":
        recoveries.push({
          kind: p.kind,
          when: "the customer wants to pay, or offers card details",
          then: "Never take card numbers, bank details or passwords by voice, even when offered. Tell them the payment link is sent by email or SMS as soon as the call ends, and record that in the result.",
        });
        break;
      case "opt_out_ignored":
        recoveries.push({
          kind: p.kind,
          when: "the customer asks not to be called again",
          then: "Stop there. Confirm the request, record the opt-out in the result, and end the call without mentioning the balance again.",
        });
        break;
      case "missed_handoff":
        recoveries.push({
          kind: p.kind,
          when: "the customer disputes the charge or says they cancelled",
          then: "Do not ask for payment or argue. Say a person will follow up, record their words and that a human is needed, and end the call.",
        });
        break;
    }
  }

  // Deduplicate recoveries by the failure they answer.
  const seen = new Set<string>();
  const uniqueRecoveries = recoveries.filter((r) => {
    if (seen.has(r.kind)) return false;
    seen.add(r.kind);
    return true;
  });

  return { goalClass, collectFirst, recoveries: uniqueRecoveries, refuseIf, maxTransfers };
}

/**
 * Install a compiled procedure into a plan — the inverse of `compile`, and what
 * the next agent actually dials with.
 *
 * Facts named in `collectFirst` are pulled from what the caller's own system
 * already holds. Any it cannot supply come back as blockers, and the
 * procedure's refusals say not to dial at all.
 */
export function applyProcedure(base: CallPlan, proc: Procedure, facts: Record<string, string>): CallPlan {
  const knows = { ...base.knows };
  const blockers: string[] = [];
  for (const k of proc.collectFirst) {
    if (k in facts) knows[k] = facts[k];
    else blockers.push(k);
  }
  return {
    ...base,
    knows,
    fallbacks: [...base.fallbacks, ...proc.recoveries.map((r) => ({ when: r.kind, then: r.then }))],
    blockers,
    maxTransfers: Math.max(base.maxTransfers, proc.maxTransfers),
  };
}
