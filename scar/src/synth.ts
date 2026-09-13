import type { GeneratedSkill, Pattern, Procedure, SkillBrief } from "./types.ts";

/**
 * Compile a corrected procedure into a skill folder.
 *
 * The repository's template is `SKILL.md` + `references/` + `scripts/`, so
 * that is what comes out — not a report, not a diff against an existing task,
 * but a directory another agent can install.
 */

function slugify(goalClass: string): string {
  return goalClass.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function titleize(goalClass: string): string {
  return goalClass
    .split(/[_\s-]+/)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

export function synthesize(
  goalClass: string,
  proc: Procedure,
  patterns: Pattern[],
  at: string,
  brief: SkillBrief
): GeneratedSkill {
  const slug = slugify(goalClass);
  const title = titleize(goalClass);
  const relevant = patterns.filter((p) => p.goalClass === goalClass);
  const totalFailures = relevant.reduce((n, p) => n + p.occurrences.length, 0);
  const liveFailures = relevant.reduce((n, p) => n + p.liveCount, 0);

  const oneLiner =
    `Places a ${goalClass.replace(/_/g, " ")} that survives the ${relevant.length} ` +
    `failure pattern${relevant.length === 1 ? "" : "s"} this workflow has actually hit, ` +
    `and refuses to dial when the task text is missing what the call is known to need.`;

  const skillMd = `---
name: ${slug}
description: ${oneLiner}
---

# ${title}

${oneLiner}

## Why this skill exists

This skill was not written by hand. It was compiled from **${totalFailures} observed failures** ${
    liveFailures
      ? `(${liveFailures} of them on real calls)`
      : "(all from rehearsals against a modelled callee — none on real calls)"
  } of the same workflow, grouped into ${relevant.length} recurring pattern${
    relevant.length === 1 ? "" : "s"
  } and turned into a procedure that survives them.

Generated ${at.slice(0, 10)}.

## Before dialling

${
  proc.collectFirst.length
    ? proc.collectFirst.map((c) => `- Put **${c}** in the task text. Do not place the call without it.`).join("\n")
    : "- Nothing beyond the recipient's number and the purpose of the call."
}

${
  proc.refuseIf.length
    ? `### Refuse the call if\n\n${proc.refuseIf.map((r) => `- ${r}`).join("\n")}\n`
    : ""
}
## During the call

${brief.groundRules.map((r) => `- ${r}`).join("\n")}

${
  proc.recoveries.length
    ? `### When it goes wrong\n\n${proc.recoveries
        .map((r) => `**When ${r.when}**\n\n> ${r.then}\n`)
        .join("\n")}`
    : ""
}
Stop after ${proc.maxTransfers} transfers. A call that has been passed on more times than that is not going to resolve on this attempt.

## Result

${brief.result}

## When NOT to use this skill

${brief.notFor.map((r) => `- ${r}`).join("\n")}

## Provenance

See [references/evidence.md](references/evidence.md) for the failures this procedure was compiled from.
`;

  const evidenceMd = `# Evidence

Every rule in \`SKILL.md\` traces to a failure that was observed. Origin \`rehearsal\` means it was observed against a modelled callee, not on a real call.

${relevant
  .map(
    (p) => `## Pattern \`${p.signature}\`

- **Kind:** ${p.kind}${p.needs ? `\n- **Missing:** ${p.needs}` : ""}
- **Occurrences:** ${p.occurrences.length} (${p.liveCount} on real calls)
- **Organisations:** ${p.orgs.join(", ")}
- **Confidence:** ${p.confidence.toFixed(2)}

| When | Where | Origin | What happened |
| --- | --- | --- | --- |
${p.occurrences
  .map(
    (o) =>
      `| ${o.observedAt.slice(0, 10)} | ${o.atNode} | ${o.origin} | ${o.detail.replace(/\|/g, "\\|")} |`
  )
  .join("\n")}
`
  )
  .join("\n")}
`;

  const procedureJson = JSON.stringify(proc, null, 2);

  const replayJs = `#!/usr/bin/env node
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

// Mirrors \`handles\` in Scar's validate.ts.
function handles(f) {
  if (f.needs && !proc.collectFirst.includes(f.needs)) return false;
  if (f.kind === "missing_info") return !!f.needs;
  if (f.kind === "too_many_transfers") return proc.maxTransfers >= 3;
  return proc.recoveries.some((r) => r.kind === f.kind);
}

const fixed = corpus.filter(handles).length;

console.log(\`\${fixed}/\${corpus.length} of the originating failures are handled by this procedure.\`);
process.exit(fixed === corpus.length ? 0 : 1);
`;

  const corpusJson = JSON.stringify(
    relevant.flatMap((p) => p.occurrences),
    null,
    2
  );

  return {
    slug,
    title,
    oneLiner,
    bornFrom: `${totalFailures} failures across ${new Set(relevant.flatMap((p) => p.orgs)).size} organisation(s)`,
    patternSignature: relevant.map((p) => p.signature).join(" + "),
    files: {
      "SKILL.md": skillMd,
      "references/evidence.md": evidenceMd,
      "references/procedure.json": procedureJson,
      "references/corpus.json": corpusJson,
      "scripts/replay.mjs": replayJs,
    },
  };
}
