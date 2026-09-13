# Scar

**Recovery calls fail the same way twice. Scar makes sure only the first one has to.**

## The story

A subscriber's card fails on a Stripe invoice. The recovery policy decides a call is worth it, and a voice agent dials through CALL-E with a task text written from the webhook: *who to call, and for which merchant.*

- **Voicemail picks up.** The agent says the merchant's name and that a payment failed, on a recording anyone with the phone can play.
- **A flatmate answers.** The agent tells them too.
- **"Which invoice? How much? When?"** The agent doesn't know, so it's *"I'll check and call you back."*
- **"Just send me the link."** The agent has no link, so it offers to take the card number by voice. On a recorded line, that's a PCI failure.
- **"Stop calling me."** It keeps talking.
- **"I cancelled last month."** It asks for payment anyway.

CALL-E is create-then-poll, with no mid-call tool use and no live transcript. Whatever the agent needs has to be in the task text **before it dials**. Today, when one of these calls fails, the lesson is lost with the call and the next merchant's agent repeats the mistake.

Scar rehearses the call against the modelled customers of four fictional merchants. Each of the eight failures above shows up at all four, so Scar compiles them into an installable skill, `failed-payment-recovery-call`. The skill is only installed if it fixes every failure it was built from.

## The loop

```
failures  →  patterns  →  a procedure  →  a skill folder  →  6-check validation  →  installed
```

| Stage | What happens |
| --- | --- |
| **Harvest** | The naive task text is rehearsed against 9 situations (the happy path plus 8 failure scenarios) for each of 4 merchants. No calls are placed. |
| **Mine** | Failures are grouped by signature. A signature needs at least 3 occurrences to count as a pattern; below that it's noise. |
| **Compile** | The patterns become a procedure: facts to put in the task text, when to refuse to dial, and a rule for each situation. |
| **Synthesise** | The procedure becomes `SKILL.md`, `references/` (evidence, procedure, corpus) and `scripts/replay.mjs`. |
| **Validate** | Six checks: structure, replay, evidence, confidence, coherence, scope. If any check fails, **nothing is written**. |

## Run it

Needs Node 24+. TypeScript runs natively, with no build step and no install.

```bash
node src/index.ts                                          # staged, human-readable
node src/index.ts --json                                   # one JSON object on stdout, nothing else
node generated/failed-payment-recovery-call/scripts/replay.mjs
npm install && npx tsc --noEmit                            # optional typecheck
```

What it currently prints:

```
4 merchants × 9 rehearsals          32 failures, 0 calls placed
8 patterns                          each 4× across 4 merchants, confidence 0.71
put in the task text                invoice_number, amount_due, invoice_date, hosted_invoice_url
validation                          6/6 PASS → ACCEPTED (replay 32/32)
before → after (re-rehearsed)       naive 0/32 → with skill 32/32
```

The output folder is anchored to Scar's own directory (`generated/`), whatever the cwd. Set `SCAR_OUT` to write somewhere else, and `SCAR_NOW` to pin the timestamp.

## JSON output (`--json`)

stdout carries exactly one JSON object and a trailing newline. The exit code is 0 even when the skill is rejected, so read `accepted`.

| Field | Meaning |
| --- | --- |
| `skill`, `goalClass` | `"failed-payment-recovery-call"`, `"failed_payment_recovery_call"` |
| `accepted`, `rejectedBecause` | Whether all 6 checks passed; if not, a comma-separated list of the failed check names (otherwise `null`) |
| `checks` | `[{ "name": "replay", "pass": true, "detail": "32/32 originating failures handled" }, …]`, in order: structure, replay, evidence, confidence, coherence, scope |
| `callee`, `realCallsPlaced` | Always `"modelled"` and `0`. Nothing in this pipeline dials. |
| `merchants`, `rehearsals` | The fictional merchant names, and the number of rehearsals run (36) |
| `failures`, `patterns`, `discarded` | Size of the failure corpus (32), patterns mined (8), and failures below threshold (0) |
| `learned` | `{ collectFirst: [...], refuseIf: [...], rules: [{ kind, when, then }], maxTransfers }` |
| `before`, `after` | `{ "handled": N, "total": N }` from re-rehearsing every failed run with the naive plan and then with the skill installed |
| `byScenario` | `[{ scenario, total, before, after, outcome }]`, one row for each of the 8 failure scenarios |
| `path` | `"generated/failed-payment-recovery-call"`, relative to Scar's folder, or `null` if nothing was written |
| `generatedAt` | ISO timestamp |

```bash
node src/index.ts --json | node -e "const r=JSON.parse(require('fs').readFileSync(0,'utf8')); console.log(r.accepted, r.after)"
```

## What is real, and what is modelled

- **Every call is a rehearsal against a modelled customer** (`src/scenarios.ts`). Zero real calls are placed, CALL-E is never contacted, and the pipeline uses no network or credentials.
- **Merchants, customers, invoices and links are fictional.** Numbers are in the `+1-555-01xx` block reserved for fiction, and payment links use `pay.example.com` as a placeholder for Stripe's `hosted_invoice_url`.
- **Learned vs authored.** Which facts go into the task text, which refusals apply and which situations need a rule all come from the evidence: remove a scenario and its rule disappears, and the evidence check rejects any requirement that has no failure behind it. The *wording* of each rule, for example "never take card numbers by voice", is written once per failure kind in `compile` (`src/mine.ts`). The ground rules and result contract that no failure teaches are in `BRIEF`.
- **Two different "handled" numbers.** The `replay` check (also `scripts/replay.mjs`) measures rule coverage: does the procedure hold the fact and the rule each failure needed? `before`/`after` is behavioural: every failed run is walked again through the same modelled callee. Both are measured against the model that produced the failures. So 32/32 shows the loop closes, not that real customers behave like the model.
- **Real calls are future work.** `src/calle.ts` is a create-then-poll REST adapter for `api.heycall-e.com`, but this pipeline does not call it. Live failures (`origin: "live"`) are part of the data model and are weighted higher in mining, but none exist yet.

## Layout

```
src/
  index.ts          the staged run, and --json
  scenarios.ts      domain: merchants, the modelled subscriber phone, the 8-scenario gauntlet, the naive plan, BRIEF
  gauntlet.ts       deterministic walker: demands, hazards (a rule must exist before dialling), transfers
  gauntlet-types.ts graph, plan, hazard and failure-kind types
  mine.ts           harvest → mine patterns → compile a procedure → apply it to a plan
  synth.ts          procedure → skill folder
  validate.ts       the six checks
  types.ts          failure records, patterns, procedures, skills
  calle.ts          CALL-E REST adapter (not wired into this pipeline)
  handshake.ts, envelope.ts, documents.ts
                    SCAR/1 agent-to-agent protocol sketch; unused here, and cannot run on CALL-E
generated/failed-payment-recovery-call/
  SKILL.md  references/{evidence.md,procedure.json,corpus.json}  scripts/replay.mjs
```

## Prior art

Rehearsing a call against a modelled line, and patching the task text that failed, have both been done before. What Scar adds is narrower: it compiles **repeated observed failures** into a new installable skill, and refuses to install that skill unless it handles the failures it came from.

## Licence

MIT.
