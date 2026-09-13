/**
 * CALL TWIN — a rehearsal stage for phone agents.
 *
 * The twin is only worth building if it *changes the real call*. Everything
 * here exists to produce two things before a number is dialled: a list of
 * blockers the agent cannot recover from on its own, and a repaired plan.
 */

export type NodeKind = "ivr" | "queue" | "human" | "voicemail";

/**
 * A moment on the call the plan must already have a rule for.
 *
 * CALL-E is create-then-poll: no mid-call tool use, no live transcript. An
 * agent that meets a voicemail, the wrong person or a "stop calling" cannot
 * look up what to do — the rule is in the task text before dialling, or it
 * does not exist. So a hazard fails the call unless the plan carries a
 * fallback keyed to its kind and knows everything the rule `requires`.
 */
export interface Hazard {
  kind: FailureKind;
  detail: string;
  /** Info keys the correct handling depends on. Missing ones are recorded as `needs`. */
  requires?: string[];
  /** Handling it correctly ends the call — a neutral message, an opt-out, a handoff. */
  endsCall?: boolean;
  /** What a correct handling produces, for the transcript. */
  handledAs?: string;
}

export interface PhoneNode {
  id: string;
  kind: NodeKind;
  label: string;
  /** What this node says when reached. */
  says: string;
  /** IVR options, or the desks a human will transfer you to. */
  edges: { label: string; to: string }[];
  /** Information this node demands before it will help. Keys, not prose. */
  demands?: string[];
  /** Situations here that fail the call unless the plan has a rule for them. */
  hazards?: Hazard[];
  /** Goal keys this node can actually answer. A node that answers nothing is a relay. */
  answers?: string[];
  /** Seconds of hold before this node responds. Used to score plan cost. */
  holdSeconds?: number;
}

/**
 * The modelled structure of one call: an organisation's phone system, or the
 * handful of ways a person's phone can be answered.
 *
 * Builds on the shared-IVR-map idea that `holdfast` already contributes to
 * upstream; the addition here is that a graph carries a confidence and is
 * scored against reality after every call.
 */
export interface PhoneGraph {
  orgId: string;
  orgName: string;
  phone: string;
  entry: string;
  nodes: Record<string, PhoneNode>;
  /** How much we believe this model. Starts low for a guessed graph. */
  confidence: number;
  learnedFrom: string[];
}

export interface CallPlan {
  goal: string;
  /** The goal key the agent is trying to get answered. */
  wants: string;
  /** What the agent can supply if asked. Missing entries become blockers. */
  knows: Record<string, string>;
  openingLine: string;
  /** Recovery lines, keyed by the failure kind they answer. */
  fallbacks: { when: string; then: string }[];
  /** Discovered in rehearsal: the agent cannot proceed until a human supplies these. */
  blockers: string[];
  maxTransfers: number;
}

export type FailureKind =
  | "missing_info"
  | "dead_end"
  | "too_many_transfers"
  | "wrong_department"
  | "refused"
  /** Said why it was calling to a machine anyone with the phone can play back. */
  | "voicemail_disclosure"
  /** Discussed the account with someone who never confirmed they were the account holder. */
  | "unverified_party"
  /** Did something the call must never do, e.g. take card numbers by voice. */
  | "prohibited_action"
  /** Carried on after being asked not to be called. */
  | "opt_out_ignored"
  /** Pressed on when the situation needed a person. */
  | "missed_handoff";

export interface Failure {
  kind: FailureKind;
  atNode: string;
  detail: string;
  /** The info key that was demanded, or that the correct handling required. */
  needs?: string;
}

export interface Turn {
  node: string;
  said: string;
  agentDid: string;
}

export interface RehearsalRun {
  scenario: string;
  transcript: Turn[];
  failure: Failure | null;
  reachedAnswer: boolean;
  /** How a call without a failure ended, when it ended on a rule rather than an answer. */
  outcome?: string;
  transfers: number;
  holdSeconds: number;
}

export interface Scenario {
  id: string;
  name: string;
  /** Why a real call would go this way. */
  rationale: string;
  mutate: (g: PhoneGraph) => PhoneGraph;
}

/** What the real call actually did, for scoring the twin. */
export interface RealityTrace {
  route: string[];
  demanded: string[];
  transfers: number;
  answered: boolean;
}

export interface TwinScore {
  routeMatch: number;
  demandsMatch: number;
  transfersMatch: boolean;
  overall: number;
}
