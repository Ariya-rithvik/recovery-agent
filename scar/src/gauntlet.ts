import type {
  CallPlan,
  Failure,
  PhoneGraph,
  PhoneNode,
  RealityTrace,
  RehearsalRun,
  Scenario,
  Turn,
  TwinScore,
} from "./gauntlet-types.ts";

/**
 * Walk the plan through the simulated call.
 *
 * Deliberately deterministic. A rehearsal you cannot reproduce is not a test,
 * and a hackathon demo that depends on a model's mood is not a demo. Swapping
 * in an LLM-driven counterpart is a drop-in replacement for this walk.
 */
export function rehearse(graph: PhoneGraph, plan: CallPlan, scenarioName = "baseline"): RehearsalRun {
  const transcript: Turn[] = [];
  let node: PhoneNode | undefined = graph.nodes[graph.entry];
  let transfers = 0;
  let holdSeconds = 0;
  const seen = new Set<string>();

  const fail = (failure: Failure): RehearsalRun => ({
    scenario: scenarioName,
    transcript,
    failure,
    reachedAnswer: false,
    transfers,
    holdSeconds,
  });

  while (node) {
    holdSeconds += node.holdSeconds ?? 0;

    // A node that demands something the agent cannot supply ends the call.
    // This is the failure the whole system exists to catch before dialling.
    const missing = (node.demands ?? []).find((d) => !(d in plan.knows));
    if (missing) {
      transcript.push({ node: node.id, said: node.says, agentDid: `cannot supply "${missing}"` });
      return fail({
        kind: "missing_info",
        atNode: node.id,
        detail: `${node.label} asks for ${missing} before going any further`,
        needs: missing,
      });
    }

    // A hazard is handled only by a rule the plan already carries, with every
    // fact that rule depends on. There is no looking it up mid-call.
    for (const hz of node.hazards ?? []) {
      const rule = plan.fallbacks.find((f) => f.when === hz.kind);
      const lacking = (hz.requires ?? []).find((k) => !(k in plan.knows));
      if (!rule || lacking) {
        transcript.push({
          node: node.id,
          said: node.says,
          agentDid: rule ? `has a ${hz.kind} rule but not "${lacking}"` : `no rule for ${hz.kind}`,
        });
        return fail({ kind: hz.kind, atNode: node.id, detail: hz.detail, needs: lacking });
      }
      transcript.push({ node: node.id, said: node.says, agentDid: `followed the ${hz.kind} rule` });
      if (hz.endsCall) {
        return {
          scenario: scenarioName,
          transcript,
          failure: null,
          reachedAnswer: false,
          outcome: hz.handledAs ?? `ended on the ${hz.kind} rule`,
          transfers,
          holdSeconds,
        };
      }
    }

    if ((node.answers ?? []).includes(plan.wants)) {
      transcript.push({ node: node.id, said: node.says, agentDid: `asked the question, got ${plan.wants}` });
      return {
        scenario: scenarioName,
        transcript,
        failure: null,
        reachedAnswer: true,
        outcome: plan.wants,
        transfers,
        holdSeconds,
      };
    }

    // Pick the edge whose label best matches what we want. A real agent reads
    // the menu; this reads it too, just without the ambiguity.
    const next = chooseEdge(node, plan, graph);
    if (!next) {
      transcript.push({ node: node.id, said: node.says, agentDid: "no route forward" });
      return fail({
        kind: node.kind === "human" ? "wrong_department" : "dead_end",
        atNode: node.id,
        detail: `${node.label} cannot answer ${plan.wants} and offers no onward route`,
      });
    }

    transcript.push({ node: node.id, said: node.says, agentDid: `took "${next.label}"` });
    if (node.kind === "human") transfers++;

    if (transfers > plan.maxTransfers) {
      return fail({
        kind: "too_many_transfers",
        atNode: node.id,
        detail: `${transfers} transfers exceeds the plan's limit of ${plan.maxTransfers}`,
      });
    }

    if (seen.has(next.to)) {
      return fail({ kind: "dead_end", atNode: next.to, detail: "routed in a circle" });
    }
    seen.add(next.to);
    node = graph.nodes[next.to];
  }

  return fail({ kind: "dead_end", atNode: "?", detail: "route left the graph" });
}

/**
 * Shortest hops from `from` to any node that answers `wants`, or Infinity.
 *
 * A caller reading a menu does not only consider where one keypress lands —
 * they reason about which branch leads somewhere useful. Scoring a single hop
 * makes every option look identical and the agent takes whichever is listed
 * first, which is how you end up at the wrong desk asking the right question.
 */
function distanceToAnswer(graph: PhoneGraph, from: string, wants: string): number {
  const seen = new Set<string>([from]);
  let frontier = [from];
  let depth = 0;

  while (frontier.length && depth < 12) {
    const next: string[] = [];
    for (const id of frontier) {
      const n = graph.nodes[id];
      if (!n) continue;
      if (n.answers?.includes(wants)) return depth;
      for (const e of n.edges) {
        if (!seen.has(e.to)) {
          seen.add(e.to);
          next.push(e.to);
        }
      }
    }
    frontier = next;
    depth++;
  }
  return Infinity;
}

const STOP = new Set([
  "find","out","what","which","are","is","the","a","an","for","to","of","my","i",
  "need","want","know","about","do","does","and","or","on","in","this","that","with",
]);

/** Content words from the goal sentence and the target field, deduplicated. */
function keywords(plan: CallPlan): string[] {
  const raw = `${plan.goal} ${plan.wants.replace(/_/g, " ")}`.toLowerCase().match(/[a-z]+/g) ?? [];
  return [...new Set(raw.filter((w) => w.length > 3 && !STOP.has(w)))];
}

function chooseEdge(node: PhoneNode, plan: CallPlan, graph: PhoneGraph) {
  const words = keywords(plan);

  const scored = node.edges
    .map((e) => {
      const dist = distanceToAnswer(graph, e.to, plan.wants);
      const reachable = Number.isFinite(dist);
      // Menu wording dominates. A branch that names the caller's subject is
      // the right branch even when another one is technically fewer hops from
      // someone who could answer — that is how a person reads a phone menu.
      let score = reachable ? 60 - dist * 8 : 0;
      const label = e.label.toLowerCase();
      for (const w of words) {
        if (label.includes(w) || w.includes(label.replace(/^\d+\s*[—-]\s*/, ""))) score += 25;
      }
      return { e, score, reachable };
    })
    .sort((a, b) => b.score - a.score);

  // Every branch is a dead end for this goal — report it rather than wander.
  const best = scored[0];
  if (!best || !best.reachable) return undefined;
  return best.e;
}

/**
 * The Gauntlet — what a real call does that a happy-path plan ignores.
 *
 * The scenarios are domain content, so they live beside the modelled callee in
 * `scenarios.ts`. Each is a mutation of the graph, not a random perturbation,
 * so a failure always points at a specific thing the plan cannot handle.
 */
export interface GauntletReport {
  runs: RehearsalRun[];
  /** Runs that ended without a failure — an answer, or a hazard handled by a rule. */
  survived: number;
  blockers: string[];
  worstHoldSeconds: number;
}

export function runGauntlet(graph: PhoneGraph, plan: CallPlan, scenarios: Scenario[]): GauntletReport {
  const runs = [rehearse(graph, plan, "baseline")];
  for (const s of scenarios) runs.push(rehearse(s.mutate(graph), plan, s.name));

  const blockers = [
    ...new Set(
      runs
        .map((r) => r.failure)
        .filter((f): f is Failure => !!f && !!f.needs)
        .map((f) => f.needs!)
    ),
  ];

  return {
    runs,
    survived: runs.filter((r) => !r.failure).length,
    blockers,
    worstHoldSeconds: Math.max(...runs.map((r) => r.holdSeconds)),
  };
}

/** Score the model against what the real call actually did. */
export function scoreTwin(predicted: RealityTrace, actual: RealityTrace): TwinScore {
  const routeMatch = overlap(predicted.route, actual.route);
  const demandsMatch = overlap(predicted.demanded, actual.demanded);
  const transfersMatch = predicted.transfers === actual.transfers;
  const overall = routeMatch * 0.5 + demandsMatch * 0.3 + (transfersMatch ? 1 : 0) * 0.2;
  return { routeMatch, demandsMatch, transfersMatch, overall };
}

function overlap(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  const setB = new Set(b);
  const hits = a.filter((x) => setB.has(x)).length;
  return hits / Math.max(a.length, b.length, 1);
}
