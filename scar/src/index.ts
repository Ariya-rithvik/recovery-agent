import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { harvestRehearsals, mine, compile, applyProcedure } from "./mine.ts";
import { synthesize } from "./synth.ts";
import { validate } from "./validate.ts";
import { runGauntlet } from "./gauntlet.ts";
import { GOAL, MERCHANTS, GAUNTLET, BRIEF, naivePlan } from "./scenarios.ts";
import type { FailureRecord, Procedure } from "./types.ts";

const AT = process.env.SCAR_NOW ?? new Date().toISOString();
/** Scar's own folder. Output is anchored here, not to cwd, so a parent project can run it from anywhere. */
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT = process.env.SCAR_OUT ?? join(ROOT, "generated");

/**
 * `--json` prints exactly one JSON object to stdout and nothing else, for the
 * parent demo to read. All human-readable output goes through `log`, which is
 * silent in that mode.
 */
const JSON_MODE = process.argv.includes("--json");
const log = (...parts: unknown[]) => {
  if (!JSON_MODE) console.log(...parts);
};

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  amber: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const pad = (s: string, n: number) => s + " ".repeat(Math.max(0, n - strip(s).length));

let n = 0;
const stage = (t: string, sub = "") => {
  n++;
  log();
  log(C.dim("─".repeat(76)));
  log(`  ${C.bold(`${n}. ${t}`)}${sub ? "   " + C.dim(sub) : ""}`);
  log();
};

interface ScenarioTally {
  scenario: string;
  total: number;
  before: number;
  after: number;
  /** How the call ended once the skill was installed, when it ended well. */
  outcome: string | null;
}

/**
 * Before and after, measured by behaviour rather than by rule coverage: every
 * rehearsal that failed is run again, once with the naive plan and once with
 * the compiled procedure installed, against the same modelled customers.
 */
function reRehearse(proc: Procedure) {
  const rows = new Map<string, ScenarioTally>();
  let refusedToDial = 0;

  for (const m of MERCHANTS) {
    const base = naivePlan(m);
    const original = runGauntlet(m.graph, base, GAUNTLET);
    const naiveAgain = runGauntlet(m.graph, base, GAUNTLET);
    const skilled = applyProcedure(base, proc, m.invoice);
    // A skill that says "do not dial without X" is obeyed: no rehearsal, nothing handled.
    const withSkill = skilled.blockers.length ? null : runGauntlet(m.graph, skilled, GAUNTLET);
    if (!withSkill) refusedToDial++;

    original.runs.forEach((run, i) => {
      if (!run.failure) return; // only failed runs entered the corpus
      const row = rows.get(run.scenario) ?? { scenario: run.scenario, total: 0, before: 0, after: 0, outcome: null };
      row.total++;
      if (!naiveAgain.runs[i].failure) row.before++;
      const again = withSkill?.runs[i];
      if (again && !again.failure) {
        row.after++;
        row.outcome ??= again.outcome ?? null;
      }
      rows.set(run.scenario, row);
    });
  }

  const tallies = [...rows.values()];
  return {
    tallies,
    refusedToDial,
    total: tallies.reduce((a, r) => a + r.total, 0),
    before: tallies.reduce((a, r) => a + r.before, 0),
    after: tallies.reduce((a, r) => a + r.after, 0),
  };
}

function main() {
  log();
  log(C.bold("SCAR") + C.dim("   phone agents fail the same way twice"));
  log(C.dim("  Turning repeated recovery-call failures into a skill the next call gets for free."));
  log(C.dim("  Rehearsal only: every call below is against a modelled customer. Zero real calls are placed."));

  // ──────────────────────────────────────────────────────────────────────
  stage("The same call, failing over and over", "four merchants, modelled customers, zero calls placed");

  const corpus: FailureRecord[] = [];
  for (const m of MERCHANTS) {
    const found = harvestRehearsals(m.graph, naivePlan(m), GAUNTLET, GOAL, AT);
    corpus.push(...found);
    log(
      `  ${pad(m.graph.orgName, 24)} ${C.red(String(found.length))} of ${GAUNTLET.length + 1} rehearsals failed   ` +
        C.dim("only the happy path survived the naive task text")
    );
  }
  log();
  for (const s of GAUNTLET) log(`    ${C.dim("·")} ${s.name}`);
  log();
  log(C.dim(`  ${corpus.length} failures on record. Every one of them free — the gauntlet costs no calls.`));

  // ──────────────────────────────────────────────────────────────────────
  stage("What keeps going wrong?", "a lesson needs repetition; one bad afternoon is not evidence");

  const patterns = mine(corpus);
  const rejected = corpus.length - patterns.reduce((a, p) => a + p.occurrences.length, 0);

  for (const p of patterns) {
    log(
      `  ${C.amber("pattern")} ${pad(p.kind + (p.needs ? ` · ${p.needs}` : ""), 40)} ` +
        `${pad(`${p.occurrences.length}×`, 4)} ${pad(`${p.orgs.length} merchants`, 12)} ` +
        C.dim(`confidence ${p.confidence.toFixed(2)}`)
    );
  }
  if (rejected > 0) {
    log();
    log(C.dim(`  ${rejected} one-off failure(s) discarded — below the threshold to be worth writing down.`));
  }

  // ──────────────────────────────────────────────────────────────────────
  stage("Compiling a procedure", "not a patch to one task text — a standalone way of making this call");

  const proc = compile(GOAL, patterns);
  if (proc.collectFirst.length) {
    log(`  ${C.cyan("put in the task text before dialling")}`);
    for (const c of proc.collectFirst) log(`    · ${C.bold(c)}`);
  }
  if (proc.refuseIf.length) {
    log(`  ${C.red("refuse the call if")}`);
    for (const r of proc.refuseIf) log(`    · ${r}`);
  }
  if (proc.recoveries.length) {
    log(`  ${C.cyan("rules for when")}`);
    for (const r of proc.recoveries) log(`    · ${pad(r.when, 58)} ${C.dim(r.kind)}`);
  }
  log(`  ${C.dim("stop after")} ${proc.maxTransfers} transfers`);

  // ──────────────────────────────────────────────────────────────────────
  stage("Writing the skill", "a folder, not a report");

  const skill = synthesize(GOAL, proc, patterns, AT, BRIEF);
  log(`  ${C.bold(skill.slug)}`);
  log(`  ${C.dim(skill.oneLiner)}`);
  log();
  for (const path of Object.keys(skill.files)) {
    log(`    ${C.dim("+")} ${pad(path, 30)} ${C.dim(String(skill.files[path].length) + " bytes")}`);
  }

  // ──────────────────────────────────────────────────────────────────────
  stage("Would you install this?", "nothing generated gets used until it proves itself");

  const report = validate(skill, proc, patterns, corpus);
  const passed = report.checks.filter((c) => c.status === "pass").length;
  for (const c of report.checks) {
    const tag = c.status === "pass" ? C.green("PASS") : C.red("FAIL");
    log(`  ${tag}  ${pad(c.name, 14)} ${C.dim(c.detail)}`);
  }
  log();
  log(
    report.accepted
      ? `  ${C.green("ACCEPTED")} ${C.dim(`— ${passed}/${report.checks.length} checks; replayed against ${report.replayed} originating failures, ${report.replayFixed} now handled`)}`
      : `  ${C.red("REJECTED")} ${C.dim(`— ${passed}/${report.checks.length} checks; failed: ${report.rejectedBecause}`)}`
  );

  const root = join(OUT, skill.slug);
  const measured = reRehearse(proc);

  if (report.accepted) {
    // ────────────────────────────────────────────────────────────────────
    stage("On disk", "installable by any agent, from here on");

    for (const [rel, body] of Object.entries(skill.files)) {
      const full = join(root, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, body, "utf8");
      log(`  ${C.green("wrote")} ${rel}`);
    }
    log();
    log(`  ${C.dim(root)}`);

    // ────────────────────────────────────────────────────────────────────
    stage("Before and after", "every failed rehearsal run again, same merchants, same modelled customers");

    for (const t of measured.tallies) {
      log(
        `  ${pad(t.scenario, 38)} ${C.red(`${t.before}/${t.total}`)} ${C.dim("→")} ` +
          `${(t.after === t.total ? C.green : C.amber)(`${t.after}/${t.total}`)}   ${C.dim(t.outcome?.replace(/_/g, " ") ?? "")}`
      );
    }
    log();
    const pct = (x: number) => `${Math.round((x / Math.max(1, measured.total)) * 100)}%`;
    log(`  ${pad(C.dim("naive task text"), 26)} ${C.red(`${measured.before}/${measured.total}`)} handled  ${C.dim(pct(measured.before))}`);
    log(`  ${pad(C.dim("with the generated skill"), 26)} ${(measured.after === measured.total ? C.green : C.amber)(`${measured.after}/${measured.total}`)} handled  ${C.dim(pct(measured.after))}`);
    if (measured.refusedToDial) {
      log(C.amber(`  ${measured.refusedToDial} merchant(s) could not supply a required fact — the skill refused to dial for them.`));
    }
    log();
    log(
      C.dim(
        "  Measured against modelled customers, not real ones. No CALL-E call was placed.\n" +
          "  The next recovery call starts from here instead of learning by burning calls."
      )
    );
    log();
  } else {
    log();
    log(C.dim("  Nothing is written. A skill that cannot fix what it was born from is just a document."));
    log();
  }

  if (JSON_MODE) {
    const out = {
      skill: skill.slug,
      goalClass: GOAL,
      accepted: report.accepted,
      rejectedBecause: report.rejectedBecause ?? null,
      checks: report.checks.map((c) => ({ name: c.name, pass: c.status === "pass", detail: c.detail })),
      callee: "modelled",
      realCallsPlaced: 0,
      merchants: MERCHANTS.map((m) => m.graph.orgName),
      rehearsals: MERCHANTS.length * (GAUNTLET.length + 1),
      failures: corpus.length,
      patterns: patterns.length,
      discarded: rejected,
      learned: {
        collectFirst: proc.collectFirst,
        refuseIf: proc.refuseIf,
        rules: proc.recoveries.map((r) => ({ kind: r.kind, when: r.when, then: r.then })),
        maxTransfers: proc.maxTransfers,
      },
      before: { handled: measured.before, total: measured.total },
      after: { handled: measured.after, total: measured.total },
      byScenario: measured.tallies,
      // Relative to Scar's folder (or absolute when SCAR_OUT points elsewhere); null when nothing was written.
      path: report.accepted ? relative(ROOT, root).split(sep).join("/") : null,
      generatedAt: AT,
    };
    process.stdout.write(JSON.stringify(out) + "\n");
  }
}

main();
