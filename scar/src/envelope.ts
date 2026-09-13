/**
 * SCAR/1 — what two agents say to each other once they stop pretending to be human.
 *
 * GibberLink proved two agents on a call can detect each other and leave speech
 * for a data channel. What it carried over that channel was still conversation,
 * only faster.
 *
 * The interesting question is not "can we talk faster". It is: what can this
 * channel carry that a voice channel *fundamentally cannot*?
 *
 *   - A document. You cannot read a 40-page policy PDF down a phone line.
 *   - Evidence you can verify. Speech carries claims; it cannot carry a hash.
 *   - A learned skill. A procedure, its provenance, and the failures that
 *     produced it — so the receiving agent does not have to learn it the
 *     expensive way.
 *
 * That last one is the point. Scar's whole thesis is that the first agent pays
 * for a lesson and everyone after should inherit it. The handshake is how the
 * lesson travels.
 */

export const PROTOCOL = "SCAR/1";

/** What an endpoint is willing to do once the channel is structured. */
export type Capability = "query" | "answer" | "evidence" | "skill" | "document";

export const ALL_CAPABILITIES: Capability[] = ["query", "answer", "evidence", "skill", "document"];

/**
 * The spoken banner. Deliberately sayable out loud, because the detection has
 * to survive the medium it is escaping: this is uttered as speech, and only if
 * the other side answers in kind does anything change.
 *
 * A human hearing this hears a slightly odd sentence and says "sorry, what?" —
 * which is exactly the signal that the channel must stay human.
 */
export function banner(caps: Capability[]): string {
  return `Protocol ${PROTOCOL}, capabilities ${caps.join(" ")}.`;
}

const BANNER_RE = /protocol\s+scar\s*\/?\s*1[,.]?\s*capabilities\s+([a-z\s]+)/i;

export function parseBanner(spoken: string): { protocol: string; caps: Capability[] } | null {
  const m = BANNER_RE.exec(spoken);
  if (!m) return null;
  const caps = m[1]
    .trim()
    .split(/\s+/)
    .filter((c): c is Capability => (ALL_CAPABILITIES as string[]).includes(c));
  if (!caps.length) return null;
  return { protocol: PROTOCOL, caps };
}

/** A pointer to content, not the content. Verifiable, and small enough to send. */
export interface EvidenceRef {
  /** sha256 of the bytes, so the receiver can prove it got what was meant. */
  digest: string;
  mediaType: string;
  bytes: number;
  /** Where to fetch it. Out-of-band — the audio channel carries the pointer only. */
  uri: string;
  /** Human-readable, for the transcript and the audit trail. */
  label: string;
}

/** A claim the sender asserts a document supports, with the span that supports it. */
export interface Claim {
  id: string;
  text: string;
  /** Which evidence backs it, and where inside that evidence. */
  evidence: string;
  locator: string;
  /** The sender's confidence. Never taken on trust by the receiver. */
  asserted: number;
}

export type Envelope =
  | {
      v: typeof PROTOCOL;
      kind: "query";
      id: string;
      /** The structured question, not a sentence. */
      subject: string;
      predicate: string;
      /** Context the other side may need to answer, as fields rather than prose. */
      context: Record<string, string>;
      /** Documents the asker is putting on the table. */
      attachments: EvidenceRef[];
    }
  | {
      v: typeof PROTOCOL;
      kind: "answer";
      id: string;
      inReplyTo: string;
      value: string | number | boolean | null;
      /** Who or what produced it — the abstention discipline survives the protocol. */
      answeredBy: "agent" | "system-of-record" | "unknown";
      claims: Claim[];
      evidence: EvidenceRef[];
      confidence: number;
    }
  | {
      v: typeof PROTOCOL;
      kind: "skill-offer";
      id: string;
      slug: string;
      goalClass: string;
      /** Cheap summary so the receiver can decline without a transfer. */
      bornFrom: string;
      patternSignature: string;
      digest: string;
    }
  | {
      v: typeof PROTOCOL;
      kind: "skill";
      id: string;
      inReplyTo: string;
      slug: string;
      goalClass: string;
      /** The procedure itself, plus the failures that justify every rule in it. */
      procedure: unknown;
      corpus: unknown[];
      evidence: EvidenceRef[];
      digest: string;
    }
  | {
      v: typeof PROTOCOL;
      kind: "decline";
      id: string;
      inReplyTo: string;
      reason: string;
    };

/**
 * Encode an envelope for the data channel.
 *
 * The transport is deliberately abstracted. GibberLink used ggwave to put bits
 * through the audio path; a provider that exposes a side channel can carry the
 * same bytes without the modem. Nothing above this line cares which.
 */
export function encode(e: Envelope): string {
  return JSON.stringify(e);
}

export function decode(s: string): Envelope | null {
  try {
    const e = JSON.parse(s);
    if (e?.v !== PROTOCOL || typeof e?.kind !== "string") return null;
    return e as Envelope;
  } catch {
    return null;
  }
}

/** Roughly how long this payload would take to speak aloud, at 150 wpm. */
export function spokenSeconds(e: Envelope): number {
  const words = JSON.stringify(e).split(/\W+/).filter(Boolean).length;
  return Math.round((words / 150) * 60);
}

/** How long the same payload takes on a ~1.4 kbit/s audio data channel. */
export function encodedSeconds(e: Envelope): number {
  const bits = encode(e).length * 8;
  return Math.max(1, Math.round(bits / 1400));
}
