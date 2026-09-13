import type { Check, FailureRecord, GeneratedSkill, Pattern, Procedure, ValidationReport } from "./types.ts";

/**
 * Nothing generated gets used until it has been checked.
 *
 * The obvious criticism of any self-improving agent is that it will happily
 * learn something wrong and then apply it everywhere. The answer is not to
 * generate more carefully — it is to refuse to install anything that cannot
 * demonstrate it fixes the failures it was born from.
 */

const MIN_CONFIDENCE = 0.6;
const REQUIRED_FILES = ["SKILL.md", "references/evidence.md", "scripts/replay.mjs"];

/** Does this procedure actually handle a failure of this shape? */
export function handles(proc: Procedure, f: FailureRecord): boolean {
  // A failure that lacked a fact is only handled if that fact is now collected
  // before dialling. A rule without the fact it depends on is not a fix.
  if (f.needs && !proc.collectFirst.includes(f.needs)) return false;
  if (f.kind === "missing_info") return !!f.needs;
  if (f.kind === "too_many_transfers") return proc.maxTransfers >= 3;
  return proc.recoveries.some((r) => r.kind === f.kind);
}

export function validate(
  skill: GeneratedSkill,
  proc: Procedure,
  patterns: Pattern[],
  corpus: FailureRecord[]
): ValidationReport {
  const checks: Check[] = [];
  const relevant = patterns.filter((p) => p.goalClass === proc.goalClass);
  const origin = relevant.flatMap((p) => p.occurrences);

  // 1. Structure — does it match the repository's skill template at all?
  const missing = REQUIRED_FILES.filter((f) => !(f in skill.files));
  checks.push({
    name: "structure",
    status: missing.length ? "fail" : "pass",
    detail: missing.length ? `missing ${missing.join(", ")}` : `${Object.keys(skill.files).length} files, template satisfied`,
  });

  // 2. Replay — the load-bearing check. Does it fix what it was born from?
  const fixed = origin.filter((f) => handles(proc, f)).length;
  const replayOk = origin.length > 0 && fixed === origin.length;
  checks.push({
    name: "replay",
    status: replayOk ? "pass" : "fail",
    detail: `${fixed}/${origin.length} originating failures handled`,
  });

  // 3. Evidence — every rule must trace to something that happened.
  const unsupported = proc.collectFirst.filter(
    (c) => !origin.some((f) => f.needs === c)
  );
  checks.push({
    name: "evidence",
    status: unsupported.length ? "fail" : "pass",
    detail: unsupported.length
      ? `invented requirement with no failure behind it: ${unsupported.join(", ")}`
      : "every rule traces to an observed failure",
  });

  // 4. Confidence — a pattern seen three times in simulation is weaker than
  //    one seen once on a real call. Both are evidence; they are not equal.
  const weakest = Math.min(...relevant.map((p) => p.confidence));
  checks.push({
    name: "confidence",
    status: weakest >= MIN_CONFIDENCE ? "pass" : "fail",
    detail: `weakest supporting pattern ${weakest.toFixed(2)} (floor ${MIN_CONFIDENCE})`,
  });

  // 5. Contradiction — a skill must not tell the agent to refuse a call and
  //    also supply a recovery for continuing past that same condition.
  const contradictions = proc.refuseIf.filter((r) =>
    proc.recoveries.some((rec) => proc.collectFirst.some((c) => r.includes(c) && rec.then.includes(c)))
  );
  checks.push({
    name: "coherence",
    status: contradictions.length ? "fail" : "pass",
    detail: contradictions.length
      ? `refuses and recovers on the same condition: ${contradictions.join("; ")}`
      : "no rule contradicts another",
  });

  // 6. Scope — a procedure that refuses on everything is not a skill.
  const tooBroad = proc.refuseIf.length > 0 && proc.recoveries.length === 0 && proc.collectFirst.length > 3;
  checks.push({
    name: "scope",
    status: tooBroad ? "fail" : "pass",
    detail: tooBroad ? "refuses on almost every path — not actionable" : "leaves a workable path to an answer",
  });

  const failed = checks.filter((c) => c.status === "fail");

  return {
    slug: skill.slug,
    checks,
    replayed: origin.length,
    replayFixed: fixed,
    accepted: failed.length === 0,
    rejectedBecause: failed.length ? failed.map((c) => c.name).join(", ") : undefined,
  };
}
