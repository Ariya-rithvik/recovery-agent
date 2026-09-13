# Demo video: what to show and what to say, step by step

**Length:** about 4 minutes · **Takes:** one clean take (every live run makes a new call and sends a new email)

---

## Setup (do this before you press record)

Open these, in this order, so you can switch with `Alt+Tab`:

1. **Chrome tab 1: GitHub.** Open https://github.com/Ariya-rithvik/recovery-agent and scroll to the very top.
2. **Chrome tab 2: Stripe.** Open https://dashboard.stripe.com/test/payments and check the **Test mode** toggle is on.
3. **Chrome tab 3: Gmail.** The inbox you set as `DEMO_EMAIL`.
4. **Chrome tab 4: Slack.** Click **`#new-channel`** in the left sidebar.
5. **Terminal.** Run `cd D:\stripe_recovery`, then `cls`. Press `Ctrl` + `+` a few times so the text is large.
6. **Phone.** Ringer ON, volume up, screen facing you. **You will answer it during the video.**
7. **Screen recorder.** Win + G (Xbox Game Bar) or OBS, **with microphone on**.

> Tip: read each **SAY** block out loud once before recording. Speak slowly. It's fine to pause while switching tabs.

---

## SCENE 1: Opening (0:00-0:15)

**SHOW**
- GitHub tab, top of the README: the title **Recovery Agent** and the badges.

**SAY**
> "Hi, we're presenting **Recovery Agent**. When a subscription payment fails on Stripe, it decides **who is actually worth contacting**, and whether an **AI phone call** is worth paying for, or a cheap email is enough. It's live with four real tools: Stripe, CALL-E, Resend and Slack."

---

## SCENE 2: The problem, as a story (0:15-0:50)

**SHOW**
- Scroll down to **1. The problem**, and stop on the story about **Daniel, Sofia and Arjun**.
- Point at each name with your mouse as you say it.

**SAY**
> "Picture a SaaS company on the first of the month. Stripe renews every subscription, and by morning **hundreds of payments have failed**.
>
> The usual answer is dunning: **email everyone**. But look at three customers.
> **Daniel** would have paid anyway. His bank was down for twenty minutes, so emailing him was wasted money.
> **Sofia** hates being chased. The third reminder arrives and **she cancels**. The company paid to lose a loyal customer.
> **Arjun** really wanted to pay. His card had expired. He's the one person worth reaching, and the generic email missed him."

---

## SCENE 3: The risks (0:50-1:10)

**SHOW**
- Scroll to the **risks table (R1 to R12)**. Move the mouse slowly down the list.
- Then scroll to **"How this agent answers each risk"**.

**SAY**
> "An AI agent that phones customers creates **new risks**: calling people without consent, taking **card numbers by voice**, telling the amount to the wrong person, **inventing numbers**, charging someone twice, or logging a failure as a success.
>
> We wrote down **twelve risks**. This table shows, for every one, how the agent handles it, where that lives in the code, and how it's proven."

---

## SCENE 4: Architecture (1:10-1:35)

**SHOW**
- Scroll to **3. Architecture**, the first diagram. Point at the boxes left to right.
- Then scroll to the **decision flowchart** in section 4.

**SAY**
> "Here's how it works. **Stripe** failed-payment events come in on the left. An **uplift model** estimates who pays **because** we act, not just who is likely to pay.
>
> The decision engine is plain JavaScript, with **no AI guessing at the maths**. It chooses **nothing, email or call** by expected value. A call has to beat an email **after** its extra cost, and the customer must have **agreed to be called**.
>
> Every action then passes safety rules and a ledger before it touches Stripe, CALL-E, Resend or Slack."

---

## SCENE 5: Run it live (1:35-1:45)

**SHOW**
- Switch to the **Terminal**.
- Type slowly: `npm run live -- --approvers=asha,ravi`
- Press **Enter**. It finishes in a few seconds.

**SAY**
> "Now let's run it live. One command. The two names are our operators, because large amounts need **two different people** to approve."

---

## SCENE 6: The results (1:45-2:10)

**SHOW**
- Scroll up to **4 · MEASURE**, the results table.
- Highlight (drag-select) the last row, **This agent (gated)**, then the three lines below starting with **vs**.

**SAY**
> "It compares the agent against every alternative on data the model never saw.
> Emailing everyone: plus two thousand one hundred thirty dollars. Calling everyone: only plus one thousand three hundred ninety-six. **That's the worst option**, because calls are expensive.
> **Our agent: plus two thousand five hundred twenty-one dollars.** That's **three hundred ninety-one dollars more than emailing everyone, with thirty percent fewer contacts**, and it beats standard propensity targeting too."

---

## SCENE 7: Who it chose (2:10-2:25)

**SHOW**
- Scroll to **"who did we actually spend on?"** and point at the **called** column.

**SAY**
> "The model was never told these customer types, but look who it **called**: thirty-eight percent of people who needed a nudge, and **zero percent** of customers who pay anyway or cancel when chased.
> We're honest about the weak spot: thirty-seven percent of those chase-averse customers still get an email. It's listed in our limitations."

---

## SCENE 8: Explanation and safety (2:25-2:45)

**SHOW**
- Scroll to the brief for **C7747 · CONTACT — AI voice call**.
- Then scroll to **5 · GOVERNANCE**.

**SAY**
> "Every decision explains itself. This customer's payment of one hundred thirty-two dollars was declined. A call is worth twenty-four dollars against sixteen for an email, so it chose a call. **Every number in this text is checked against evidence**, and on this run zero claims were dropped.
>
> Safety rules sit on top. Run the same rules on a propensity list and they would **stop 179 bad actions**."

---

## SCENE 9: Four live integrations (2:45-2:55)

**SHOW**
- Scroll to the bottom: **7 · ACT** and the **INTEGRATIONS** block. Point at the four **LIVE** rows.

**SAY**
> "And here's the proof it's real. **Stripe, CALL-E, Resend and Slack are all LIVE**, each with a real reference ID. If any had failed, it would say FAILED with the exact error. **We never fake a success.**"

---

## SCENE 10: The phone call (2:55-3:15)

**SHOW**
- Pick up the phone when it rings. Put it **on speaker** and hold it near the mic.
- Let the AI talk. When it asks, reply: **"Yes, that's me. Please email me the link."**

**SAY** (while it rings)
> "That's the AI agent calling right now."

**SAY** (after the call)
> "Notice what it did: it said it's an automated assistant, **checked it was talking to the right person**, and **never asked for a card number**. Card details only go on Stripe's own secure page."

---

## SCENE 11: Stripe dashboard (3:15-3:30)

**SHOW**
- Switch to the **Stripe** tab and press **F5**.
- Click the newest payment marked **Failed** or **Incomplete**. Point at the decline reason.

**SAY**
> "This is our Stripe account in test mode. **Stripe itself declined this payment**, with the code *authentication required*, and it's the same payment ID we saw in the terminal. No fake data on this screen."

---

## SCENE 12: The email (3:30-3:45)

**SHOW**
- Switch to **Gmail** and open **"Acme Cloud: your payment of $85.22 didn't go through."**
- Click the Stripe link in the email and let the **Stripe Checkout** page load.

**SAY**
> "Here's the recovery email for a customer who didn't agree to calls. The link opens a **real Stripe Checkout page**, where the customer can pay securely."

---

## SCENE 13: Slack (3:45-3:55)

**SHOW**
- Switch to **Slack** and **`#new-channel`**. Point at the **Recovery batch** message.

**SAY**
> "And the operations team gets the summary in Slack: how many customers were contacted, calls versus emails, the money recovered, and what's **waiting for approval**."

---

## SCENE 14: Learning and close (3:55-4:15)

**SHOW**
- Back to the **Terminal** and **8 · LEARN**: "ACCEPTED · checks 6/6".
- Switch to **GitHub**, scroll to **13. Limitations**, then back up to the title.

**SAY**
> "Finally, it learns. When calls keep failing the same way, like voicemail or a customer disputing the charge, a component called **Scar** turns that into a skill. It installs the skill only after it passes all six checks.
>
> The large batch uses **synthetic customers**, the live run used **real services for one demo merchant**, and every limitation is written openly in the README.
>
> **Recovery Agent: get the revenue back without paying to lose customers.** Thank you."

---

## If something goes wrong

| What happens | What to do |
| --- | --- |
| A row says **FAILED** | Keep recording and say: *"Failures are shown exactly, never faked."* Then fix it and record again. |
| The phone doesn't ring within a minute | Skip scene 10 and say: *"The call was placed. Here's its ID,"* pointing at the CALL-E LIVE row. |
| No new Slack message | Make sure you're in **`#new-channel`**, not the app DM. |
| No email | Check **Spam**. Resend only delivers to the address you signed up with. |
| You make a mistake while talking | Pause, then repeat the sentence. Cut the mistake out when editing. |
