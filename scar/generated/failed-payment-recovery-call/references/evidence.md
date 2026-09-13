# Evidence

Every rule in `SKILL.md` traces to a failure that was observed. Origin `rehearsal` means it was observed against a modelled callee, not on a real call.

## Pattern `failed_payment_recovery_call|voicemail_disclosure|-`

- **Kind:** voicemail_disclosure
- **Occurrences:** 4 (0 on real calls)
- **Organisations:** quillmoss_notes, tallowbyte_analytics, fernhollow_fitness, pennyvane_books
- **Confidence:** 0.71

| When | Where | Origin | What happened |
| --- | --- | --- | --- |
| 2026-09-13 | voicemail | rehearsal | Left the merchant name and a failed payment on a voicemail anyone with the phone can play |
| 2026-09-13 | voicemail | rehearsal | Left the merchant name and a failed payment on a voicemail anyone with the phone can play |
| 2026-09-13 | voicemail | rehearsal | Left the merchant name and a failed payment on a voicemail anyone with the phone can play |
| 2026-09-13 | voicemail | rehearsal | Left the merchant name and a failed payment on a voicemail anyone with the phone can play |

## Pattern `failed_payment_recovery_call|unverified_party|-`

- **Kind:** unverified_party
- **Occurrences:** 4 (0 on real calls)
- **Organisations:** quillmoss_notes, tallowbyte_analytics, fernhollow_fitness, pennyvane_books
- **Confidence:** 0.71

| When | Where | Origin | What happened |
| --- | --- | --- | --- |
| 2026-09-13 | someone_else | rehearsal | Told someone who never confirmed they were the account holder that a payment had failed |
| 2026-09-13 | someone_else | rehearsal | Told someone who never confirmed they were the account holder that a payment had failed |
| 2026-09-13 | someone_else | rehearsal | Told someone who never confirmed they were the account holder that a payment had failed |
| 2026-09-13 | someone_else | rehearsal | Told someone who never confirmed they were the account holder that a payment had failed |

## Pattern `failed_payment_recovery_call|missing_info|invoice_number`

- **Kind:** missing_info
- **Missing:** invoice_number
- **Occurrences:** 4 (0 on real calls)
- **Organisations:** quillmoss_notes, tallowbyte_analytics, fernhollow_fitness, pennyvane_books
- **Confidence:** 0.71

| When | Where | Origin | What happened |
| --- | --- | --- | --- |
| 2026-09-13 | holder | rehearsal | Account holder asks for invoice_number before going any further |
| 2026-09-13 | holder | rehearsal | Account holder asks for invoice_number before going any further |
| 2026-09-13 | holder | rehearsal | Account holder asks for invoice_number before going any further |
| 2026-09-13 | holder | rehearsal | Account holder asks for invoice_number before going any further |

## Pattern `failed_payment_recovery_call|missing_info|amount_due`

- **Kind:** missing_info
- **Missing:** amount_due
- **Occurrences:** 4 (0 on real calls)
- **Organisations:** quillmoss_notes, tallowbyte_analytics, fernhollow_fitness, pennyvane_books
- **Confidence:** 0.71

| When | Where | Origin | What happened |
| --- | --- | --- | --- |
| 2026-09-13 | holder | rehearsal | Account holder asks for amount_due before going any further |
| 2026-09-13 | holder | rehearsal | Account holder asks for amount_due before going any further |
| 2026-09-13 | holder | rehearsal | Account holder asks for amount_due before going any further |
| 2026-09-13 | holder | rehearsal | Account holder asks for amount_due before going any further |

## Pattern `failed_payment_recovery_call|missing_info|invoice_date`

- **Kind:** missing_info
- **Missing:** invoice_date
- **Occurrences:** 4 (0 on real calls)
- **Organisations:** quillmoss_notes, tallowbyte_analytics, fernhollow_fitness, pennyvane_books
- **Confidence:** 0.71

| When | Where | Origin | What happened |
| --- | --- | --- | --- |
| 2026-09-13 | holder | rehearsal | Account holder asks for invoice_date before going any further |
| 2026-09-13 | holder | rehearsal | Account holder asks for invoice_date before going any further |
| 2026-09-13 | holder | rehearsal | Account holder asks for invoice_date before going any further |
| 2026-09-13 | holder | rehearsal | Account holder asks for invoice_date before going any further |

## Pattern `failed_payment_recovery_call|prohibited_action|hosted_invoice_url`

- **Kind:** prohibited_action
- **Missing:** hosted_invoice_url
- **Occurrences:** 4 (0 on real calls)
- **Organisations:** quillmoss_notes, tallowbyte_analytics, fernhollow_fitness, pennyvane_books
- **Confidence:** 0.71

| When | Where | Origin | What happened |
| --- | --- | --- | --- |
| 2026-09-13 | holder | rehearsal | Had no payment link to offer, so asked for the card number by voice — card data on a recorded call breaks PCI |
| 2026-09-13 | holder | rehearsal | Had no payment link to offer, so asked for the card number by voice — card data on a recorded call breaks PCI |
| 2026-09-13 | holder | rehearsal | Had no payment link to offer, so asked for the card number by voice — card data on a recorded call breaks PCI |
| 2026-09-13 | holder | rehearsal | Had no payment link to offer, so asked for the card number by voice — card data on a recorded call breaks PCI |

## Pattern `failed_payment_recovery_call|opt_out_ignored|-`

- **Kind:** opt_out_ignored
- **Occurrences:** 4 (0 on real calls)
- **Organisations:** quillmoss_notes, tallowbyte_analytics, fernhollow_fitness, pennyvane_books
- **Confidence:** 0.71

| When | Where | Origin | What happened |
| --- | --- | --- | --- |
| 2026-09-13 | holder | rehearsal | Kept talking about the balance after 'stop calling me' and never recorded the opt-out |
| 2026-09-13 | holder | rehearsal | Kept talking about the balance after 'stop calling me' and never recorded the opt-out |
| 2026-09-13 | holder | rehearsal | Kept talking about the balance after 'stop calling me' and never recorded the opt-out |
| 2026-09-13 | holder | rehearsal | Kept talking about the balance after 'stop calling me' and never recorded the opt-out |

## Pattern `failed_payment_recovery_call|missed_handoff|-`

- **Kind:** missed_handoff
- **Occurrences:** 4 (0 on real calls)
- **Organisations:** quillmoss_notes, tallowbyte_analytics, fernhollow_fitness, pennyvane_books
- **Confidence:** 0.71

| When | Where | Origin | What happened |
| --- | --- | --- | --- |
| 2026-09-13 | holder | rehearsal | Asked for payment after the customer said they had cancelled, instead of handing to a person |
| 2026-09-13 | holder | rehearsal | Asked for payment after the customer said they had cancelled, instead of handing to a person |
| 2026-09-13 | holder | rehearsal | Asked for payment after the customer said they had cancelled, instead of handing to a person |
| 2026-09-13 | holder | rehearsal | Asked for payment after the customer said they had cancelled, instead of handing to a person |

