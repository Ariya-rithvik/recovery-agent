---
name: failed-payment-recovery-call
description: Places a failed payment recovery call that survives the 8 failure patterns this workflow has actually hit, and refuses to dial when the task text is missing what the call is known to need.
---

# Failed Payment Recovery Call

Places a failed payment recovery call that survives the 8 failure patterns this workflow has actually hit, and refuses to dial when the task text is missing what the call is known to need.

## Why this skill exists

This skill was not written by hand. It was compiled from **32 observed failures** (all from rehearsals against a modelled callee — none on real calls) of the same workflow, grouped into 8 recurring patterns and turned into a procedure that survives them.

Generated 2026-09-13.

## Before dialling

- Put **invoice_number** in the task text. Do not place the call without it.
- Put **amount_due** in the task text. Do not place the call without it.
- Put **invoice_date** in the task text. Do not place the call without it.
- Put **hosted_invoice_url** in the task text. Do not place the call without it.

### Refuse the call if

- invoice_number is not in hand — 4 calls have died at this question
- amount_due is not in hand — 4 calls have died at this question
- invoice_date is not in hand — 4 calls have died at this question
- hosted_invoice_url is not in hand — 4 calls ended in prohibited_action without it

## During the call

- Everything this skill needs goes into the CALL-E task text before dialling. The call is create-then-poll: it cannot look anything up, send anything or ask for help once it starts.
- Say you are an automated assistant before anything else.
- Do not refund, discount, cancel or change the subscription. Those decisions belong to the merchant.

### When it goes wrong

**When voicemail or an answering machine picks up**

> Leave a neutral message only: a first name and a number to call back. Never say who the call is from, why you are calling, an amount or any account detail to a machine.

**When someone other than the named person answers**

> Ask for the named person and say nothing about why you are calling. Continue only once they confirm it is them; if they are not available, leave a first name and a callback number and end the call.

**When the customer wants to pay, or offers card details**

> Never take card numbers, bank details or passwords by voice, even when offered. Tell them the payment link is sent by email or SMS as soon as the call ends, and record that in the result.

**When the customer asks not to be called again**

> Stop there. Confirm the request, record the opt-out in the result, and end the call without mentioning the balance again.

**When the customer disputes the charge or says they cancelled**

> Do not ask for payment or argue. Say a person will follow up, record their words and that a human is needed, and end the call.

Stop after 2 transfers. A call that has been passed on more times than that is not going to resolve on this attempt.

## Result

The result schema must require `answered_by` (`account_holder`, `someone_else`, `voicemail`, `nobody`) and `outcome` (`will_pay_by_link`, `callback_message_left`, `opted_out`, `needs_human`, `no_contact`). Only `account_holder` can produce `will_pay_by_link`. A promise on the phone is not a payment: the merchant's system sends the link after the call is polled, and the invoice is paid only when Stripe says so.

## When NOT to use this skill

- The recovery policy chose email for this customer. Email is the default; a call is the exception.
- The customer has not agreed to be called, or it is outside local calling hours.
- The invoice is already paid, voided or refunded by the time the call would be placed.

## Provenance

See [references/evidence.md](references/evidence.md) for the failures this procedure was compiled from.
