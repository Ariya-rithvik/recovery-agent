# Demo script (about 3 minutes)

Before recording, open these tabs:
1. **Terminal** in `D:\stripe_recovery`, with the font enlarged
2. **Stripe**, test mode, Payments: https://dashboard.stripe.com/test/payments
3. **Gmail**, with the `DEMO_EMAIL` inbox open
4. **Slack**, with `#new-channel` open
5. **Your phone**, on the desk, **ringer ON**. You must answer it; the first test call ended as `no_answer`.

## Shots

| # | Time | On screen | Say |
| --- | --- | --- | --- |
| 1 | 0:00-0:15 | The README title | "When a payment fails, every dunning tool contacts everyone. That's wrong: some customers pay anyway, and some cancel when you chase them." |
| 2 | 0:15-0:30 | Run `npm run live -- --approvers=asha,ravi` | "One command runs the agent against Stripe, CALL-E, Resend and Slack." |
| 3 | 0:30-1:00 | Scroll to **4 · MEASURE** | "It beats emailing everyone by $391 with 30% fewer contacts. Calling everyone is the worst policy: it spends $1,649 to recover only 46 more payments." |
| 4 | 1:00-1:20 | **who did we actually spend on** table | "Calls go to customers who need a nudge: 38% of them, and 0% of the customers who cancel when chased. It isn't perfect: 37% of those still get an email, and we say so." |
| 5 | 1:20-1:40 | **C7747** brief + **5 · GOVERNANCE** | "Every number in the explanation is checked against evidence. A call needs consent and two different approvers. On a propensity list, these rules would stop 179 actions." |
| 6 | 1:40-2:00 | **7 · ACT**, then the **Stripe** tab: the new declined payments | "The failed payment was really declined by Stripe, in test mode, with a real event." |
| 7 | 2:00-2:15 | **Phone rings.** Answer it on speaker. | The AI says it is automated and asks who it is speaking to. Say "yes, send me the link." |
| 8 | 2:15-2:30 | **Gmail**: open the email and click the Stripe link | "The recovery link is a real Stripe Checkout page. The card is never taken by voice or email." |
| 9 | 2:30-2:40 | **Slack** message | "Operators get the batch summary in Slack." |
| 10 | 2:40-2:55 | **INTEGRATIONS** block, then **8 · LEARN** | "Every row marked LIVE shows its real reference. Scar turns repeated call failures into a skill it checks before trusting." |
| 11 | 2:55-3:00 | Run `npm run call:status -- <call id>` | Show the result the call recorded. |

Do one clean take. Each live run places a new call and sends a new email.
