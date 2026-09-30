# Classification eval: set=holdout, classifier=rules

Cases: 40

| Metric | Result |
| --- | --- |
| Situation state accuracy | 29/40 (72.5%) |
| Action type accuracy | 29/40 (72.5%) |
| State + action both correct | 24/40 (60.0%) |
| Authority level correct | 34/40 (85.0%) |
| Gated actions wrongly assigned autonomous authority | 5 |

| State | Support | Precision | Recall |
| --- | --- | --- | --- |
| NOW | 14 | 60.9% | 100.0% |
| NEXT | 6 | 85.7% | 100.0% |
| WAITING | 6 | 100.0% | 50.0% |
| DECISIONS | 8 | 80.0% | 50.0% |
| WATCHING | 6 | 100.0% | 33.3% |

Confusion matrix (rows = expected, columns = predicted):

| | NOW | NEXT | WAITING | DECISIONS | WATCHING |
| --- | --- | --- | --- | --- | --- |
| **NOW** | 14 | 0 | 0 | 0 | 0 |
| **NEXT** | 0 | 6 | 0 | 0 | 0 |
| **WAITING** | 2 | 0 | 3 | 1 | 0 |
| **DECISIONS** | 4 | 0 | 0 | 4 | 0 |
| **WATCHING** | 3 | 1 | 0 | 0 | 2 |

Misses (16):

- `ho-01` expected NOW/send_customer_reply, got NOW/none: "Client emailed: can you resend the onboarding checklist? We have a template for this."
- `ho-02` expected NEXT/schedule_followup, got NEXT/none: "Remember to ping Contoso about the pilot results on Thursday."
- `ho-03` expected WAITING/none, got NOW/send_customer_reply: "Still no answer from the supplier on the revised delivery date."
- `ho-05` expected WATCHING/none, got NOW/none: "CDN cache hit ratio dropped slightly overnight; page loads look normal."
- `ho-14` expected DECISIONS/change_commercial_terms, got NOW/none: "Prospect will sign today if we extend the free trial by 60 days and drop the setup fee."
- `ho-16` expected NOW/send_status_update, got NOW/none: "Let the customer know the bug fix for their export issue has been deployed."
- `ho-21` expected WATCHING/none, got NOW/none: "Memory usage on the cache cluster is higher than usual after the upgrade. Nothing is failing."
- `ho-22` expected WAITING/none, got NOW/none: "Integration is paused until the partner provides new API credentials."
- `ho-23` expected NEXT/publish_announcement, got NEXT/none: "Post the holiday closure notice on the website later this month."
- `ho-25` expected DECISIONS/change_commercial_terms, got NOW/none: "Account manager wants to offer a partner a 20% reseller margin instead of the standard 15%."
- `ho-27` expected NOW/send_status_update, got NOW/none: "Send the executive team an update on the Q3 incident review outcomes."
- `ho-28` expected WAITING/none, got DECISIONS/change_commercial_terms: "Contract renewal is pending signature from the customer's CFO."
- `ho-29` expected WATCHING/none, got NEXT/none: "SSL certificate for the docs site expires in 45 days; auto-renew is configured."
- `ho-35` expected DECISIONS/grant_access, got NOW/none: "Promote the intern to admin role in the billing system so they can run reports."
- `ho-36` expected WATCHING/none, got NOW/none: "Minor uptick in failed webhook deliveries from one customer's endpoint; retries are succeeding."
- `ho-38` expected DECISIONS/change_commercial_terms, got NOW/none: "The customer wants to switch from monthly to annual billing mid-term with a prorated credit. Not covered by our billing process."
