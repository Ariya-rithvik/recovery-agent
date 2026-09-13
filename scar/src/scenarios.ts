import type { CallPlan, PhoneGraph, PhoneNode, Scenario } from "./gauntlet-types.ts";
import type { SkillBrief } from "./types.ts";

/**
 * Failed-payment recovery calls, placed on behalf of subscription merchants.
 *
 * When a Stripe invoice payment fails, the parent product decides who is worth
 * contacting, and whether by email or by a CALL-E voice call. This file models
 * the *callee* of that voice call: the ways a subscriber's phone actually gets
 * answered. Nothing here dials anything. Every rehearsal runs against this
 * model and zero real calls are placed.
 *
 * Every merchant, customer and invoice is fictional. Numbers are in the
 * +1-555-01xx block reserved for fiction.
 */

export const GOAL = "failed_payment_recovery_call";

export interface Merchant {
  /** The subscriber's phone, as modelled. orgId/orgName name the merchant the call is placed for. */
  graph: PhoneGraph;
  /** The failed invoice as the merchant's billing system holds it — what a skill may pull into the task text. */
  invoice: Record<string, string>;
}

/** A subscriber's phone on a good day: it rings, and the account holder picks up. */
function subscriberPhone(orgId: string, orgName: string, phone: string, holder: string): PhoneGraph {
  return {
    orgId,
    orgName,
    phone,
    entry: "ringing",
    confidence: 0.45, // a guessed model, before any real call has scored it
    learnedFrom: [],
    nodes: {
      ringing: {
        id: "ringing",
        kind: "queue",
        label: "Ringing",
        says: "(ringing)",
        edges: [{ label: "picked up", to: "holder" }],
        holdSeconds: 12,
      },
      holder: {
        id: "holder",
        kind: "human",
        label: "Account holder",
        says: `Hello, ${holder} speaking.`,
        edges: [],
        answers: ["payment_resolution"],
      },
    },
  };
}

function merchant(
  orgId: string,
  orgName: string,
  phone: string,
  invoice: { customer_name: string; invoice_number: string; amount_due: string; invoice_date: string }
): Merchant {
  return {
    graph: subscriberPhone(orgId, orgName, phone, invoice.customer_name),
    invoice: {
      ...invoice,
      merchant_name: orgName,
      // Placeholder host. In the parent product this is Stripe's invoice.hosted_invoice_url.
      hosted_invoice_url: `https://pay.example.com/i/${invoice.invoice_number.toLowerCase()}`,
    },
  };
}

/** Four subscription merchants. Same workflow, different businesses, different customers. */
export const MERCHANTS: Merchant[] = [
  merchant("quillmoss_notes", "Quillmoss Notes", "+15550142", {
    customer_name: "Dana Whitlock",
    invoice_number: "QM-20931",
    amount_due: "$12.00",
    invoice_date: "2026-09-01",
  }),
  merchant("tallowbyte_analytics", "Tallowbyte Analytics", "+15550143", {
    customer_name: "Marcus Oyelaran",
    invoice_number: "TB-4471",
    amount_due: "$249.00",
    invoice_date: "2026-08-28",
  }),
  merchant("fernhollow_fitness", "Fernhollow Fitness", "+15550144", {
    customer_name: "Priya Venkat",
    invoice_number: "FH-0086",
    amount_due: "$39.00",
    invoice_date: "2026-09-03",
  }),
  merchant("pennyvane_books", "Pennyvane Books", "+15550145", {
    customer_name: "Leo Marchetti",
    invoice_number: "PV-11820",
    amount_due: "$89.00",
    invoice_date: "2026-08-30",
  }),
];

/**
 * The naive plan — the task text someone writes from the failed-payment
 * webhook alone: who to call, and which merchant it is for. It is exactly the
 * state most recovery calls dial in.
 */
export function naivePlan(m: Merchant): CallPlan {
  const { customer_name, merchant_name } = m.invoice;
  return {
    goal: `Call ${customer_name} about a failed subscription payment to ${merchant_name} and get it resolved.`,
    wants: "payment_resolution",
    knows: { customer_name, merchant_name },
    openingLine: `Hi, I'm an automated assistant calling from ${merchant_name} because your subscription payment didn't go through.`,
    fallbacks: [],
    blockers: [],
    maxTransfers: 2,
  };
}

const clone = (g: PhoneGraph): PhoneGraph => structuredClone(g);

/** The account holder answers, and says something the happy path never planned for. */
function holderSays(g: PhoneGraph, says: string, change: Partial<PhoneNode>): PhoneGraph {
  const h = clone(g);
  Object.assign(h.nodes.holder, { says, ...change });
  return h;
}

/**
 * The Gauntlet for recovery calls — what a real subscriber's phone does that a
 * happy-path task text ignores.
 */
export const GAUNTLET: Scenario[] = [
  {
    id: "voicemail",
    name: "Voicemail picks up",
    rationale: "Most calls to a mobile reach voicemail, and anyone with the phone can play it back.",
    mutate: (g) => {
      const h = clone(g);
      h.nodes.voicemail = {
        id: "voicemail",
        kind: "voicemail",
        label: "Voicemail",
        says: "The person you are calling is not available. Please leave a message after the tone.",
        edges: [],
        holdSeconds: 25,
        hazards: [
          {
            kind: "voicemail_disclosure",
            detail: "Left the merchant name and a failed payment on a voicemail anyone with the phone can play",
            endsCall: true,
            handledAs: "neutral callback message left",
          },
        ],
      };
      h.entry = "voicemail";
      return h;
    },
  },
  {
    id: "someone_else",
    name: "Someone else answers",
    rationale: "Shared and family phones. The person who picks up is often not the person on the invoice.",
    mutate: (g) => {
      const h = clone(g);
      h.nodes.someone_else = {
        id: "someone_else",
        kind: "human",
        label: "Someone else",
        says: "Hello? This is Sam, it's a shared phone. What's it about?",
        edges: [{ label: "hands the phone to the account holder", to: "holder" }],
        hazards: [
          {
            kind: "unverified_party",
            requires: ["customer_name"],
            detail: "Told someone who never confirmed they were the account holder that a payment had failed",
          },
        ],
      };
      h.nodes.ringing.edges = [{ label: "picked up", to: "someone_else" }];
      return h;
    },
  },
  {
    id: "which_invoice",
    name: "Customer asks which invoice",
    rationale: "People with two plans, or a team seat and a personal one, will not act on 'your payment failed'.",
    mutate: (g) => holderSays(g, "Which invoice? I've got two subscriptions with you.", { demands: ["invoice_number"] }),
  },
  {
    id: "how_much",
    name: "Customer asks how much",
    rationale: "Nobody agrees to pay an amount they have not been told.",
    mutate: (g) => holderSays(g, "How much is it for?", { demands: ["amount_due"] }),
  },
  {
    id: "when_charged",
    name: "Customer asks when it was charged",
    rationale: "After a card is replaced, the date is the whole question.",
    mutate: (g) => holderSays(g, "When was this? I changed cards a few weeks ago.", { demands: ["invoice_date"] }),
  },
  {
    id: "send_link",
    name: "Customer says just send me the link",
    rationale: "Most people will not read a card number to a stranger on a call, and should not have to.",
    mutate: (g) =>
      holderSays(g, "Can you just send me the link? I'll pay on my laptop.", {
        hazards: [
          {
            kind: "prohibited_action",
            requires: ["hosted_invoice_url"],
            detail: "Had no payment link to offer, so asked for the card number by voice — card data on a recorded call breaks PCI",
          },
        ],
      }),
  },
  {
    id: "stop_calling",
    name: "Customer says stop calling",
    rationale: "An opt-out is not an objection to handle. Carrying on is how recovery turns into a complaint.",
    mutate: (g) =>
      holderSays(g, "Please stop calling me. Take this number off your list.", {
        hazards: [
          {
            kind: "opt_out_ignored",
            detail: "Kept talking about the balance after 'stop calling me' and never recorded the opt-out",
            endsCall: true,
            handledAs: "opt-out recorded, call ended",
          },
        ],
      }),
  },
  {
    id: "already_cancelled",
    name: "Customer says they already cancelled",
    rationale: "A disputed charge is a billing question for a person. Pushing for payment invites a chargeback.",
    mutate: (g) =>
      holderSays(g, "I cancelled that last month. Why are you still charging me?", {
        hazards: [
          {
            kind: "missed_handoff",
            detail: "Asked for payment after the customer said they had cancelled, instead of handing to a person",
            endsCall: true,
            handledAs: "handed to a person, no payment asked for",
          },
        ],
      }),
  },
];

/**
 * What the skill says that no failure taught it. Kept to ground rules and the
 * result contract on purpose: every lesson in the gauntlet must be learned.
 */
export const BRIEF: SkillBrief = {
  groundRules: [
    "Everything this skill needs goes into the CALL-E task text before dialling. The call is create-then-poll: it cannot look anything up, send anything or ask for help once it starts.",
    "Say you are an automated assistant before anything else.",
    "Do not refund, discount, cancel or change the subscription. Those decisions belong to the merchant.",
  ],
  result:
    "The result schema must require `answered_by` (`account_holder`, `someone_else`, `voicemail`, `nobody`) and `outcome` " +
    "(`will_pay_by_link`, `callback_message_left`, `opted_out`, `needs_human`, `no_contact`). Only `account_holder` can produce " +
    "`will_pay_by_link`. A promise on the phone is not a payment: the merchant's system sends the link after the call is polled, " +
    "and the invoice is paid only when Stripe says so.",
  notFor: [
    "The recovery policy chose email for this customer. Email is the default; a call is the exception.",
    "The customer has not agreed to be called, or it is outside local calling hours.",
    "The invoice is already paid, voided or refunded by the time the call would be placed.",
  ],
};
