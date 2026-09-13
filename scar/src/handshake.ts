import {
  ALL_CAPABILITIES,
  PROTOCOL,
  banner,
  decode,
  encode,
  encodedSeconds,
  parseBanner,
  spokenSeconds,
} from "./envelope.ts";
import type { Capability, Envelope, EvidenceRef } from "./envelope.ts";

/**
 * The handshake, and the rule that keeps it honest.
 *
 * A human must never be dropped into a machine protocol. So detection is
 * conservative by construction: the banner is *spoken*, and the channel only
 * changes if the other side answers with a banner of its own. Silence, "sorry?",
 * a receptionist, voicemail, an IVR — all of it falls through to speech, which
 * is the behaviour we want when we are wrong.
 *
 * This is the opposite of the usual failure mode. Getting it wrong costs one
 * odd-sounding sentence, not a person being talked at in modem tones.
 */

export type Channel = "voice" | PROTOCOL_T;
type PROTOCOL_T = typeof PROTOCOL;

export interface HandshakeResult {
  channel: Channel;
  /** Capabilities both sides declared. Empty when we stayed on voice. */
  agreed: Capability[];
  reason: string;
  /** What we said, and what came back — kept for the transcript and the audit. */
  weSaid: string;
  theyReplied: string;
}

/** Heuristics that suggest a human, used only to *prevent* a switch, never to force one. */
const HUMAN_TELLS = [
  /\bsorry\b/i,
  /\bpardon\b/i,
  /\bwhat was that\b/i,
  /\bhello\?/i,
  /\bcan you repeat\b/i,
  /\bi don'?t understand\b/i,
  /\bwho is this\b/i,
];

export function looksHuman(reply: string): boolean {
  return HUMAN_TELLS.some((re) => re.test(reply));
}

/**
 * Offer the protocol, and read what comes back.
 *
 * `speak` is whatever puts a sentence on the call and returns what was heard —
 * a CALL-E turn in production, a scripted counterpart in rehearsal.
 */
export async function negotiate(
  speak: (utterance: string) => Promise<string>,
  offering: Capability[] = ALL_CAPABILITIES
): Promise<HandshakeResult> {
  const weSaid = banner(offering);
  const theyReplied = await speak(weSaid);

  if (looksHuman(theyReplied)) {
    return {
      channel: "voice",
      agreed: [],
      reason: "the other side answered like a person — staying in speech",
      weSaid,
      theyReplied,
    };
  }

  const parsed = parseBanner(theyReplied);
  if (!parsed) {
    return {
      channel: "voice",
      agreed: [],
      reason: "no protocol banner came back — staying in speech",
      weSaid,
      theyReplied,
    };
  }

  const agreed = offering.filter((c) => parsed.caps.includes(c));
  if (!agreed.length) {
    return {
      channel: "voice",
      agreed: [],
      reason: `both sides speak ${PROTOCOL} but share no capability — staying in speech`,
      weSaid,
      theyReplied,
    };
  }

  return {
    channel: PROTOCOL,
    agreed,
    reason: `both sides speak ${PROTOCOL}; agreed on ${agreed.join(", ")}`,
    weSaid,
    theyReplied,
  };
}

export interface Exchange {
  sent: Envelope;
  received: Envelope | null;
  /** Wall-clock saving versus saying the same payload out loud. */
  spokenSeconds: number;
  encodedSeconds: number;
}

/** Send one envelope over the agreed channel and read the reply. */
export async function exchange(
  send: (frame: string) => Promise<string>,
  e: Envelope
): Promise<Exchange> {
  const raw = await send(encode(e));
  return {
    sent: e,
    received: decode(raw),
    spokenSeconds: spokenSeconds(e),
    encodedSeconds: encodedSeconds(e),
  };
}

let seq = 0;
export const nextId = (prefix: string) => `${prefix}-${(++seq).toString().padStart(3, "0")}`;

/** A structured question, with any documents the asker is putting on the table. */
export function query(
  subject: string,
  predicate: string,
  context: Record<string, string> = {},
  attachments: EvidenceRef[] = []
): Envelope {
  return { v: PROTOCOL, kind: "query", id: nextId("q"), subject, predicate, context, attachments };
}

/**
 * Offer a learned skill.
 *
 * Offered before it is sent, and summarised cheaply, so the receiver can decline
 * on the strength of the summary. An agent that already has the skill, or does
 * not trust where it came from, should not have to accept the payload to find out.
 */
export function skillOffer(
  slug: string,
  goalClass: string,
  bornFrom: string,
  patternSignature: string,
  digest: string
): Envelope {
  return {
    v: PROTOCOL,
    kind: "skill-offer",
    id: nextId("so"),
    slug,
    goalClass,
    bornFrom,
    patternSignature,
    digest,
  };
}

export function skill(
  inReplyTo: string,
  slug: string,
  goalClass: string,
  procedure: unknown,
  corpus: unknown[],
  evidence: EvidenceRef[],
  digest: string
): Envelope {
  return {
    v: PROTOCOL,
    kind: "skill",
    id: nextId("sk"),
    inReplyTo,
    slug,
    goalClass,
    procedure,
    corpus,
    evidence,
    digest,
  };
}

export function decline(inReplyTo: string, reason: string): Envelope {
  return { v: PROTOCOL, kind: "decline", id: nextId("dc"), inReplyTo, reason };
}
