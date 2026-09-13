/**
 * Scar — phone agents fail the same way twice.
 *
 * The repository already has projects that rehearse a call (`call-rehearsal`),
 * attack it adversarially (`redline`), and grade the result against reality
 * (`otherend`). All of them end at the same place: a report about *this* call,
 * or at most a minimal edit to *this* task text.
 *
 * Nothing turns a repeated failure into a new, installable skill that the next
 * agent gets for free. That is the loop Scar closes.
 */

/** One call that did not achieve its goal, recorded in a comparable shape. */
export interface FailureRecord {
  id: string;
  /** Where it came from: a free rehearsal, or a real CALL-E call that failed. */
  origin: "rehearsal" | "live";
  orgId: string;
  orgName: string;
  /** The class of task being attempted — the unit a skill is written for. */
  goalClass: string;
  /** What went wrong, in the gauntlet's vocabulary. */
  kind: string;
  /** The specific thing the agent lacked or hit, when there is one. */
  detail: string;
  /** Info key the other side demanded, or the correct handling required, that the agent could not supply. */
  needs?: string;
  /** Node where it broke. */
  atNode: string;
  observedAt: string;
  /** Free-text evidence: transcript span for live, scenario name for rehearsal. */
  evidence: string;
}

/**
 * A failure that has happened enough times, in enough places, to be worth
 * writing down. One-off failures are noise; the threshold is what separates
 * a lesson from an anecdote.
 */
export interface Pattern {
  signature: string;
  goalClass: string;
  kind: string;
  needs?: string;
  /** Every failure that rolls up into this pattern. */
  occurrences: FailureRecord[];
  /** Distinct organisations it happened at — a pattern seen at one org may be local. */
  orgs: string[];
  /** How many of the occurrences were real calls rather than rehearsals. */
  liveCount: number;
  confidence: number;
}

/** A skill folder, as files, ready to be written to disk and installed. */
export interface GeneratedSkill {
  slug: string;
  title: string;
  oneLiner: string;
  /** path within the skill folder -> file contents */
  files: Record<string, string>;
  bornFrom: string;
  patternSignature: string;
}

export type CheckStatus = "pass" | "fail";

export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface ValidationReport {
  slug: string;
  checks: Check[];
  /** Failures from the corpus replayed against the new skill. */
  replayed: number;
  replayFixed: number;
  accepted: boolean;
  rejectedBecause?: string;
}

/**
 * The corrected procedure a generated skill encodes. Kept as data rather than
 * prose so it can be replayed against the corpus that produced it — a skill
 * that cannot be tested against its own origin story is just a document.
 */
export interface Procedure {
  goalClass: string;
  /** Info that must be in hand BEFORE the call is placed. */
  collectFirst: string[];
  /** Recovery lines, each naming the failure kind it answers. */
  recoveries: { kind: string; when: string; then: string }[];
  /** Hard stops — conditions under which the agent must not dial at all. */
  refuseIf: string[];
  maxTransfers: number;
}

/**
 * The domain prose a skill needs that no failure can teach: who the call is
 * for, the ground rules it was always going to follow, and the result contract.
 *
 * Deliberately holds nothing a failure *did* teach. Every rule the gauntlet
 * surfaced has to come out of `compile`, or the evidence check means nothing.
 */
export interface SkillBrief {
  groundRules: string[];
  result: string;
  notFor: string[];
}
