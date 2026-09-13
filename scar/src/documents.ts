import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import type { Claim, EvidenceRef } from "./envelope.ts";

/**
 * Putting a document on a phone call.
 *
 * This is the case that exposes how thin a voice channel is. A caller asks the
 * bank whether a charge is valid, and the answer lives in a 40-page card
 * agreement. Over voice the only options are to read it aloud, to paraphrase it
 * (and be wrong), or to give up and post it.
 *
 * So the agent does what a person would do if they could: it reads the document
 * first, extracts the handful of claims that bear on the question, and carries
 * a *verifiable pointer* to the source rather than the source itself.
 */

export function digestOf(bytes: Buffer | string): string {
  return "sha256:" + createHash("sha256").update(bytes).digest("hex").slice(0, 32);
}

const MEDIA: Record<string, string> = {
  ".pdf": "application/pdf",
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".json": "application/json",
  ".html": "text/html",
};

/** Content-address a local file so the other side can prove it got the right one. */
export function attach(path: string, label?: string): EvidenceRef {
  const bytes = readFileSync(path);
  return {
    digest: digestOf(bytes),
    mediaType: MEDIA[extname(path).toLowerCase()] ?? "application/octet-stream",
    bytes: statSync(path).size,
    uri: `file://${path.replace(/\\/g, "/")}`,
    label: label ?? basename(path),
  };
}

/** Attach in-memory content — used when the document is generated, not read. */
export function attachText(label: string, text: string, mediaType = "text/plain"): EvidenceRef {
  return {
    digest: digestOf(text),
    mediaType,
    bytes: Buffer.byteLength(text, "utf8"),
    uri: `inline:${label}`,
    label,
  };
}

/**
 * Pull the lines of a document that bear on a question, and cite where each came
 * from. Deliberately mechanical: a term-overlap scan with a line locator.
 *
 * The point is not the extraction quality. It is that every claim leaving this
 * function carries a locator, so the receiving agent can check it against the
 * bytes it was given rather than believing a sentence it heard.
 */
export function extractClaims(
  ref: EvidenceRef,
  text: string,
  question: string,
  limit = 4
): Claim[] {
  const stop = new Set(["the", "and", "for", "with", "this", "that", "from", "are", "was", "will", "your", "you", "any", "all", "can", "not", "has", "have"]);
  const terms = [
    ...new Set(
      question
        .toLowerCase()
        .match(/[a-z]{3,}/g)
        ?.filter((w) => !stop.has(w)) ?? []
    ),
  ];

  const lines = text.split(/\r?\n/);
  const scored = lines
    .map((line, i) => {
      const lower = line.toLowerCase();
      const hits = terms.filter((t) => lower.includes(t)).length;
      return { line: line.trim(), no: i + 1, hits };
    })
    .filter((x) => x.hits > 0 && x.line.length > 25)
    .sort((a, b) => b.hits - a.hits || a.no - b.no)
    .slice(0, limit);

  return scored.map((s, i) => ({
    id: `c${i + 1}`,
    text: s.line.length > 220 ? s.line.slice(0, 217) + "…" : s.line,
    evidence: ref.digest,
    locator: `line ${s.no}`,
    // Overlap is weak evidence and the number says so. A receiver that treats
    // 0.6 as certainty is making its own mistake, not inheriting ours.
    asserted: Math.min(0.9, 0.45 + s.hits * 0.12),
  }));
}

export interface VerificationResult {
  ok: boolean;
  detail: string;
}

/**
 * The receiving side's check. A claim is only worth as much as the bytes behind
 * it, so: does the document we fetched actually hash to what we were told, and
 * does the cited line actually say what was claimed?
 */
export function verifyClaim(claim: Claim, ref: EvidenceRef, text: string): VerificationResult {
  if (claim.evidence !== ref.digest) {
    return { ok: false, detail: "claim cites a digest we were not given" };
  }
  const actual = digestOf(text);
  if (actual !== ref.digest) {
    return { ok: false, detail: `content does not match its digest (${actual} vs ${ref.digest})` };
  }
  const m = /line (\d+)/.exec(claim.locator);
  if (!m) return { ok: false, detail: "no usable locator" };

  const line = text.split(/\r?\n/)[Number(m[1]) - 1];
  if (!line) return { ok: false, detail: `${claim.locator} does not exist in the document` };

  const quoted = claim.text.replace(/…$/, "").trim();
  const ok = line.trim().startsWith(quoted.slice(0, Math.min(60, quoted.length)));
  return ok
    ? { ok: true, detail: `${claim.locator} matches` }
    : { ok: false, detail: `${claim.locator} does not contain the claimed text` };
}
