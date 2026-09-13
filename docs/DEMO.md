# Demo video script (about 4 minutes)

## Before you press record

| Tab / device | What to have ready |
| --- | --- |
| 1. **GitHub** | The repo README, scrolled to the top: https://github.com/Ariya-rithvik/recovery-agent |
| 2. **Terminal** | Open in `D:\stripe_recovery`, font size 18 or larger, screen cleared |
| 3. **Stripe** | Test mode, Payments page: https://dashboard.stripe.com/test/payments |
| 4. **Gmail** | The `DEMO_EMAIL` inbox |
| 5. **Slack** | **`#new-channel`**, the channel you picked when you created the webhook. Not the "Stripe" app DM: webhook messages never show up there. |
| 6. **Phone** | Ringer ON, on the desk. **You must answer it.** The first test call ended as `no_answer`. |

Do one clean take. Every live run places a new call and sends a new email.

---

## Part 1: The story (0:00-0:45), on GitHub

| Time | On screen | Say |
| --- | --- | --- |
| 0:00 | README title and badges | "This is Recovery Agent. When a Stripe payment fails, it decides who to contact, and whether an AI phone call is worth paying for." |
| 0:10 | Scroll to **1. The problem**: the Daniel / Sofia / Arjun story | "On the 1st of the month, hundreds of renewals fail, and the usual fix is to email everyone. But Daniel would have paid anyway. Sofia cancels when she's chased. And Arjun, the one person who needed help, got a generic email that went to spam." |
| 0:30 | The **risks table** (R1-R12) | "An AI voice agent brings new risks: calling without consent, taking card numbers by voice, inventing amounts, charging twice. We named twelve risks, and the next table shows how each is handled and proven." |

## Part 2: How it works (0:45-1:15), on GitHub

| Time | On screen | Say |
| --- | --- | --- |
| 0:45 | **3. Architecture**, the system diagram | "Stripe events go into an uplift model, which estimates who pays *because* we act, not just who is likely to pay. Plain JavaScript picks nothing, email or call by expected value. Safety rules and a ledger then gate every action before Stripe, CALL-E, Resend or Slack is touched." |
| 1:05 | **4. How a decision is made**, the flowchart | "A call has to beat an email *after* its extra cost, and it needs consent on file." |

## Part 3: The live run (1:15-2:30), in the terminal

| Time | On screen | Say |
| --- | --- | --- |
| 1:15 | Type `npm run live -- --approvers=asha,ravi` and press Enter | "One command, live against four real services." |
| 1:25 | Scroll to **4 · MEASURE** | "On held-out data it beats emailing everyone by $391 with 30% fewer contacts, and beats propensity targeting by $284. Calling everyone is the worst policy: $1,649 spent for only 46 extra recoveries." |
| 1:45 | **who did we actually spend on** | "Calls go to customers who need a nudge. None go to self-recoverers or to customers who cancel when chased. It isn't perfect: 37% of those chase-averse customers still get an email, and the README says so." |
| 2:00 | The **C7747** brief | "Every decision comes with an explanation, and every number in it is checked against evidence. There are zero unsupported claims." |
| 2:10 | **5 · GOVERNANCE** | "Rules gate every action. A call on a large invoice needed two different approvers. On a propensity-targeted list, the same rules would stop 179 actions." |
| 2:20 | **7 · ACT** and **INTEGRATIONS**, all four LIVE | "Each app shows LIVE with a real reference ID. Anything that failed would show FAILED with the exact error. We never fake a success." |

## Part 4: Proof in each real tool (2:30-3:35)

| Time | Switch to | Show | Say |
| --- | --- | --- | --- |
| 2:30 | **Phone**, on speaker | It rings. Answer, let the agent speak, then say: "Yes, please email me the link." | "The AI agent says it's automated, confirms who it's talking to, and never asks for card details." |
| 2:50 | **Stripe** dashboard | Refresh Payments and open the newest declined payment | "Stripe itself declined this payment, in test mode, with `authentication_required`. It's the same payment ID the terminal showed." |
| 3:05 | **Gmail** | Open "Acme Cloud: your payment of $85.22 didn't go through" and click the link | "The recovery email leads to a real Stripe Checkout page, so the card is only ever entered on Stripe." |
| 3:20 | **Slack**, `#new-channel` | The "Recovery batch" message | "Operators get the batch summary in Slack: how many were contacted, calls versus emails, the money, and what's waiting for approval." |

## Part 5: Learning and close (3:35-4:00)

| Time | On screen | Say |
| --- | --- | --- |
| 3:35 | Terminal, **8 · LEARN** | "When calls keep failing the same way, Scar turns the pattern into a skill. It installs the skill only if it handles the failures that produced it, and it passed all six checks." |
| 3:45 | GitHub, **13. Limitations** | "The batch customers are synthetic. The live run used real services for one demo merchant, and we list every limitation openly." |
| 3:55 | README title | "Recovery Agent: recover the revenue, without paying to lose customers." |

---

## If something goes wrong while recording

| Problem | What to do |
| --- | --- |
| A row says `FAILED` | Don't cut it. Say "failures are recorded exactly, never faked", then fix it and re-record. |
| The phone doesn't ring within a minute | Check that `DEMO_PHONE` starts with `+91`. Keep going and show the call ID instead. |
| No Slack message | You're probably in the app DM. Open the webhook's channel (`#new-channel`). |
| No email in the inbox | Check spam. Resend only delivers to the address you signed up with. |
