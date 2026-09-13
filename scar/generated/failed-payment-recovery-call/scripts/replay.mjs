#!/usr/bin/env node
/**
 * Replay this skill against the failures it was compiled from.
 *
 * A generated skill that cannot be tested against its own origin story is just
 * a document. This script is what makes it a claim.
 *
 *   node scripts/replay.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const proc = JSON.parse(readFileSync(join(here, "..", "references", "procedure.json"), "utf8"));
const corpus = JSON.parse(readFileSync(join(here, "..", "references", "corpus.json"), "utf8"));

// Mirrors `handles` in Scar's validate.ts.
function handles(f) {
  if (f.needs && !proc.collectFirst.includes(f.needs)) return false;
  if (f.kind === "missing_info") return !!f.needs;
  if (f.kind === "too_many_transfers") return proc.maxTransfers >= 3;
  return proc.recoveries.some((r) => r.kind === f.kind);
}

const fixed = corpus.filter(handles).length;

console.log(`${fixed}/${corpus.length} of the originating failures are handled by this procedure.`);
process.exit(fixed === corpus.length ? 0 : 1);
