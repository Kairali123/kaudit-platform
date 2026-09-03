# June 2026 earnings email template

Use this draft only after the June 2026 billing cycle is complete and the
authoritative report has passed its release gates. Replace every `{{...}}`
placeholder with a value from that report. Do not reconstruct or compare May
2026 figures; the May data was deleted.

## Subject

Kairali June 2026 verified earnings report

## Email

Hello {{recipient_name_or_team}},

The billing review for 1-30 June 2026 is complete. Based on the approved rate
card and final audited calculations, Kairali's verified billable revenue for
June was **INR {{verified_billable_revenue}}**.

### June financial summary

- Verified billable revenue (what Kairali earned): **INR {{verified_billable_revenue}}**
- Vendor invoice claim: INR {{invoice_claimed_amount}}
- Variance identified: INR {{revenue_variance_vs_invoice}}
- Finally paid to KServe: {{finally_paid_amount_or_status}}
- Savings versus KServe billed amount: {{settlement_savings_or_status}}

The report covers {{total_calls}} calls, including {{independently_audited_calls}}
independently audited calls and {{accepted_as_billed_calls}} calls accepted as
billed because independent evidence was unavailable.

The attached PDF contains the management summary, and the Excel workbook
contains the call-level backup. Positive variance means the vendor invoice
claim exceeds Kairali's independently verified billable revenue. An identified
variance is not recorded as savings unless the final settlement supports it.

No May comparison is included because the May 2026 data was deleted.

Regards,

Kairali Digital Media
Billing Audit Team

## Placeholder source map

| Placeholder | Authoritative report field |
| --- | --- |
| `{{verified_billable_revenue}}` | `summary.verifiedBillableRevenue` |
| `{{invoice_claimed_amount}}` | `summary.invoiceClaimedAmount` |
| `{{revenue_variance_vs_invoice}}` | `summary.revenueVarianceVsInvoice` |
| `{{finally_paid_amount_or_status}}` | `settlement.finallyPaidAmount`, or the report's unavailable/not-recorded wording |
| `{{settlement_savings_or_status}}` | `settlement.savingsAmount`, or the report's unavailable/not-recorded wording |
| `{{total_calls}}` | `summary.totalCalls` |
| `{{independently_audited_calls}}` | `summary.independentlyAuditedCalls` |
| `{{accepted_as_billed_calls}}` | `summary.acceptedAsBilledCalls` |
