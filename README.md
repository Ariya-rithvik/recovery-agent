# Stripe Recovery Agent

**A failed-payment recovery agent that knows who *not* to contact — and when an AI voice call is worth $1.50.**

```bash
npm run demo        # the whole pipeline, offline, no keys, no install
```

No dependencies. Node 22.18+ (Scar runs TypeScript natively). **No API key is needed for anything above** —
`npm run demo:check` re-runs everything with all 14 environment variables deleted: **11/11 pass.**

---

## The problem

A payment fails. Every dunning tool does the same thing: **contact everyone.** That is wrong in two
directions, and both are ordinary in real payment data:

- **Self-recoverers** pay on Stripe's next automatic retry. Contacting them costs money and buys nothing.
- **Chase-averse customers cancel when chased.** Contacting them has *negative* value.

And once an AI voice agent can make the call, there is a third mistake: **calling someone an email would have
recovered.** A call costs ~25× an email. So the question is not *"who will pay?"* — it is:

> **Who pays *because* we acted — and is the extra recovery from a call worth the call?**

```
tau(x) = P(recover | contacted, x) − P(recover | left alone, x)       # the incremental effect
```

## The flow

```
 Stripe decline ──> uplift model ──> channel decision ──> gates ──> ledger ──> Stripe link ──> email / AI call
 (invoice.payment_  (who pays         (email 6¢ or          (5 per-   (idempotent,  (Checkout      (Resend / CALL-E)
  failed + decline   BECAUSE we act)   call $1.50, by        decision  approval      Session)             │
  code)                                expected value)       rules)    tiers)                             v
                                                                                  Slack summary    Scar learns from
                                                                                                   failed calls
```

## The result — measured, held-out, same contact volume

Synthetic customers (labelled everywhere), Stripe decline codes, held-out split. The ranking baselines get
**the same channel logic as the agent**, so the table isolates *who* gets contacted.

| Policy | Contacted | Calls | Recovered | Spent | Net margin | vs nothing |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Contact nobody | 0 | 0 | 496 | $0.00 | $9,218 | — |
| Email everyone (dunning) | 1,555 | 0 | 618 | $93.30 | $11,348 | +$2,130 |
| Everyone, call if allowed | 1,555 | 1,080 | 664 | $1,649 | $10,614 | +$1,396 |
| Propensity top 1,096 | 1,096 | 196 | 628 | $348.00 | $11,455 | +$2,237 |
| Uplift top 1,096 (ungated) | 1,096 | 232 | 646 | $399.84 | $11,739 | +$2,521 |
| **This agent (gated)** | **1,096** | **232** | **646** | **$399.84** | **$11,739** | **+$2,521** |

**+$391 over emailing everyone** (the strongest blanket baseline) with **30% fewer contacts**, and **+$284 over
propensity targeting** at the same volume. Qini **31.1** on the held-out split.

**Calling everyone is the worst contact policy in the table.** $1,556 more spend than emailing everyone buys 46
more recoveries. The agent places 232 calls, and puts them where they pay:

```
archetype        in batch  contacted  called   true uplift   (the model never saw these labels)
nudge_needed          518       100%     38%     +33.0pp     wants to pay, needs to fix the card
hard_fail             383        65%      9%      +5.5pp     card or funds genuinely dead
self_recoverer        431        57%      0%      +2.0pp     recovers on Stripe's next automatic retry
annoyed               223        37%      0%     -11.5pp     cancels when chased
```

### What this result does *not* show — read before quoting it

- **37% of chase-averse customers still get an email.** Their true effect is −11.5pp, but the model estimates it
  as positive for them. This is the largest known error, and no call is ever placed on them.
- **The gates added no margin on this run.** The gated agent and the plain uplift ranking choose the same 1,096
  customers. The gates are there for safety: on the propensity list, the same rules halt **179** actions.
- **Two inputs are assumptions, not measurements:** the call cost ($1.50, set `CALL_COST_CENTS`) and the share of
  the effect an email captures on its own (65%). The randomised test measured "contacted" as a whole; a two-arm
  test would measure the split.
- **The uplift floor is 3pp** — the model's measured calibration error (2.97pp), fixed before reading this table.
  Without it, a 6¢ email makes any positive estimate look profitable, and 51% of chase-averse customers were
  contacted. That run is not the one reported above; this note is here so nobody has to wonder.

---

## How it decides

```js
const full  = tau * amount * MARGIN;
const email = { gain: full * EMAIL_SHARE, cost: 6 };      // cents
const call  = { gain: full,               cost: 150 };    // cents
// call only with consent on file, and only if call.ev > email.ev
// decline if tau < 3pp (inside the model's measured error) or ev <= 0
```

A call wins when `(1 − EMAIL_SHARE) × tau × amount × margin > call cost − email cost` — a persuadable customer on a
large invoice. On a small invoice it loses even when the customer is highly persuadable.

Every decision produces a brief whose **every number is validated against its evidence list** — a sentence with an
unsupported number is dropped, not softened. **0 dropped** on this run:

> **C7747 · CONTACT — AI voice call.** Payment of $132.43 was declined (authentication required), after 3 attempt(s).
> Left alone, this customer recovers 22% of the time. Contacting them lifts recovery to 54%, an incremental +32.1pp.
> A voice call is worth $24.04 here against $16.54 for an email. Requires two-person approval.

## Governance

A **pacer** of pure rules (no model calls, each tested on its own) gates every action. **Halts are checked before
nudges** — the first port checked a nudge first, so an action with no arithmetic *and* negative uplift came back as
a warning, and warnings don't block. That bug is fixed and has a test.

```
D5 halt   AI voice call with no consent on file          D1 nudge  a call whose brief shows no arithmetic
D2 halt   contact with negative estimated effect         D3 nudge  effect inside the noise band
D4 halt   expected value <= 0
B1 halt   no budget      B2 halt  spend over budget      B3 nudge  >15% of contacts are sure things
B4 halt   any sleeping dog contacted                     B5 halt   Qini <= 0      B6 nudge  nothing rejected
```

The **action ledger**: sha256 idempotency checked against our own ledger *before* the upstream call, approval tiers
(auto ≤ $25 · one-click ≤ $100 · two distinct people above), and **verbatim failure** — a failed call records the
upstream error and a null reference. We never synthesise a success.

## The external apps

| App | What it does here | Enforced in code |
| --- | --- | --- |
| **Stripe** (test mode) | Mirrors a failed payment: a test customer and a PaymentIntent **Stripe itself declines**, read back with Stripe's decline code and event id. Then a **Checkout Session** as the recovery link. Webhook signature verification. | Refuses `sk_live_` before any request. Idempotency-Key on every POST. |
| **CALL-E** (AI voice) | Places the recovery call. Task text carries invoice, amount and reason up front, since CALL-E allows no mid-call lookups. Result schema: `answered_by · outcome · evidence_quote`. | No consent → no call. Only allowlisted numbers are dialled. **A task that collects card details by voice is refused (PCI).** Identity before disclosure; nothing on voicemail; opt-out honoured. |
| **Resend** (email) | Sends the Stripe recovery link. | Only `DEMO_EMAIL` receives mail. Never asks for card details. |
| **Slack** | Posts the batch summary and approval queue to the operator channel. | Notification only — a webhook cannot tell us *who* clicked, so it approves nothing. |

**Status, stated precisely.** Every guard above is covered by **24 adapter tests with the network disabled**, and
all four apps have returned real responses in a live run (2026-09-14, Stripe test mode):

| App | Live result | Reference |
| --- | --- | --- |
| Stripe | 2 customers, 2 PaymentIntents **declined by Stripe with `authentication_required`** (read back, event ids found), 2 Checkout recovery links | `pi_3UFL6t3KGHkj4q0e0eZqDCZI`, `evt_3UFL6t3KGHkj4q0e05s99IVG` |
| CALL-E | call accepted after two distinct approvals | `call_NjZaL57MP3RCnC3RF_VYiA` |
| Resend | recovery email with the real Checkout link, delivered to the demo inbox | `11e7a738-7945-4690-85ae-ce798d7149bb` |
| Slack | batch summary posted | HTTP 200 `ok` (webhooks return no id) |

"Accepted" is what CALL-E confirms at dial time; what the person on the phone said comes later from
`npm run call:status -- <call_id>`. The customers are still synthetic — only these sample rows touched the APIs.

## Learning from failed calls — Scar

[`scar/`](scar/) watches recovery calls fail the same way across merchants and writes the fix down as an
installable skill. It then refuses to trust the skill until the skill handles the failures that produced it.

```
4 fictional merchants · 36 rehearsals · 32 failures · 8 patterns · 0 real calls placed
skill: failed-payment-recovery-call   checks 6/6   naive plan 0/32 -> with skill 32/32
```

Honest limits: rehearsals run against a **modelled** callee, so 32/32 shows the loop closes, not that real customers
behave this way. The rehearsals decide *which* rules a skill gets; the wording of each rule is written per failure
kind.

## Calibration

```
usable 10 of 10 · mean abs error 2.97pp · bias 1.41pp · rank corr 0.916 · WELL CALIBRATED
```

The tool **refuses to print a number** for a decile too thin to support one.

---

## Run it

```bash
npm run demo                              # detect -> qualify -> decide -> gate -> measure -> govern -> audit -> act -> learn
npm test                                  # 69 safety properties: 25 ledger + 20 pacer + 24 adapters
npm run demo:check                        # everything with all keys deleted — 11/11
npm run calibrate                         # predicted vs delivered uplift, by decile
npm run bench                             # the same thesis on a Stripe coupon: THESIS HOLDS
npm run learn                             # Scar, human-readable

cp .env.example .env                      # fill in only what you have
npm run live -- --approvers=asha,ravi     # mirror a two-row sample into Stripe test mode and act on it
npm run call:status -- <call_id>          # fetch a CALL-E call's structured result
```

On Windows, double-click **`demo.cmd`** — it switches the console to UTF-8 first.

Every run writes **`out/run.json`**: the table, the pacer verdicts, integration status and the full ledger audit trail.

| Variable | Unlocks | Without it |
| --- | --- | --- |
| `STRIPE_SECRET_KEY` (`sk_test_`) | mirrored declines + Checkout recovery links | Stripe row `NOT SET`; emails say a link will follow |
| `RESEND_API_KEY` + `DEMO_EMAIL` | the recovery email, to your own inbox | email row `NOT SET` |
| `CALLE_API_KEY` + `DEMO_PHONE` | the recovery call, to your own phone | call row `NOT SET` |
| `SLACK_WEBHOOK_URL` | the batch summary in Slack | Slack row `NOT SET` |

## What is real and what is not

**Real:** the method, the held-out evaluation, the calibration, the governance, and every guard in the adapters.

**Synthetic:** the customers — in Stripe's own event shapes (`invoice.paid`, `invoice.payment_failed`,
`checkout.session.*`), real decline codes, amounts in cents. `featurise()` consumes those events, so pointing it at
real Stripe data changes nothing downstream.

**Assumed:** call cost, and the email/call split of the contact effect (see above).

**Exercised live:** all four external APIs, on a two-row sample (see *Status* above).

**We did not tune until it passed.** Where a run did not flatter us — the gates adding no margin, chase-averse
customers still emailed — it is in the table and in this file.

## Architecture

```
src/
  recover.mjs          the submission: the whole batch, end to end
  twin.mjs             synthetic customers in Stripe event shapes; featurise()
  uplift.mjs           class-variable-transformation uplift model, Qini, quadrants
  calibration.mjs      predicted vs delivered, by decile, refuses thin deciles
  explain.mjs          cited briefs + the number validator
  pacer.mjs            governance rules — pure, halts before nudges
  policy.mjs           action ledger: idempotency, approval tiers, verbatim failure
  stripe.mjs           Stripe REST: preflight, mirrored declines, Checkout links, webhooks
  calle.mjs            CALL-E: task, result schema, consent / allowlist / PCI guards
  email.mjs slack.mjs  Resend and Slack
  money.mjs            cents -> "$1.50", in one place
  *.test.mjs           69 safety properties
scar/                  learning from failed recovery calls (TypeScript, native)
tools/demo-check.mjs   the whole runbook with every key deleted
```

## Credits

Built by the Manthan team. **The governance patterns — pure pacer rules, the pre-call idempotency ledger, verbatim
failure, and cited briefs — come from [Manthan](https://github.com/akash-mondal/manthan)**, our dispute-investigation
agent for Stripe, and were re-implemented here. Manthan investigates a dispute *after* it lands; this agent decides
*before* anyone is contacted. The uplift engine, ledger and pacer were first written by us for an earlier hackathon
entry on a different payment provider and ported to Stripe here; Scar and the CALL-E adapter began as our CALL-E
project. No Manthan code ships in this repository.

MIT — see [LICENSE](LICENSE).
