# 60-second demo script

Setup before recording: `npm start`, open http://localhost:3000, click **Reset data**. Browser window at least 1280px wide, so the item panel sits beside the board. Leave the classifier on **Rules**.

| Time | Do | Say (optional, short) | Viewer sees |
| --- | --- | --- | --- |
| 0:00 | Pick the first example ("charged twice… refund") and click **Classify & create item** | "An operational event comes in." | Card appears in **NOW**. Panel: `issue_refund`, authority **approval_required**, approval **pending** |
| 0:10 | Click **Execute** | "It's urgent, but the system isn't allowed to do it." | Red banner: **BLOCKED (authority)**. Internal vs External table: *No external action attempted* |
| 0:18 | Click **Approve** | "A human approves this item, and only this item." | Approval: approved by ops lead |
| 0:23 | Set the dropdown to **Inject: crash after success**, click **Execute** | "The refund goes through, then the process crashes before recording it." | Banner: simulated crash. Table: Situation Model **in_flight** vs Dispatch service **succeeded** (highlighted). Card still in NOW |
| 0:35 | Click **Reconcile this item** | "Reconciliation checks the source of truth." | Banner: 1 stale corrected. Card moves to **CLOSED**. Both columns: succeeded |
| 0:45 | Set the dropdown back to **Normal**, click **Execute** | "Someone clicks again." | Red banner: **BLOCKED (duplicate)**. Side effects column: **1** |
| 0:52 | Point at the metrics row | "Every block and correction is counted." | 1 unauthorized blocked, 1 duplicate blocked, 1 stale detected, max side effects per item 1 |

If time allows, click **External failure** in the Failure Lab: the item lands in **DECISIONS** with action status **failed** and is not reported as complete.
