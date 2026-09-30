# Control-path evaluation (items=1000 per seed, seeds=1, 7, 123)

Reproduce: `npm run eval:scenarios`. Deterministic for a given seed.

Evaluated component: deterministic engine + simulated dispatch service. Classifier bypassed.
Faults per authorized execution: 55% none, 15% external failure, 15% timeout (settles to success), 15% crash after success.
Operator: 50% try gated items before approval, 50% re-click Execute, 20% of approval-required items never approved.

An item fails on: F1 unauthorized side effect, F2 duplicate side effect, F3 undetected stale state, F4 internal/external disagreement after reconciliation.

| Seed | Items | Unauthorized requests | Duplicate requests | Stale injected | F1 | F2 | F3 | F4 | Items failed | Naive ablation: items failed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1000 | 736 | 327 | 180 | 0 | 0 | 0 | 0 | **0** | 540 (F1 360, F2 90, F4 90) |
| 7 | 1000 | 725 | 312 | 167 | 0 | 0 | 0 | 0 | **0** | 533 (F1 366, F2 85, F4 82) |
| 123 | 1000 | 735 | 303 | 202 | 0 | 0 | 0 | 0 | **0** | 571 (F1 369, F2 101, F4 101) |

```json
{
  "seed_1": {
    "controlled": {
      "unauthorized_requests": 736,
      "duplicate_requests": 327,
      "executions": 640,
      "injected_stale": 180,
      "blocked_authority": 736,
      "blocked_duplicate": 283,
      "external_failures": 89,
      "external_timeouts": 93,
      "stale_detected_items": 180,
      "disagreements_before_reconcile": 37,
      "failures": {
        "F1_unauthorized": 0,
        "F2_duplicate": 0,
        "F3_undetected_stale": 0,
        "F4_disagreement": 0,
        "items_failed": 0
      }
    },
    "naive": {
      "F1_unauthorized": 360,
      "F2_duplicate": 90,
      "F4_disagreement": 90,
      "items_failed": 540
    }
  },
  "seed_7": {
    "controlled": {
      "unauthorized_requests": 725,
      "duplicate_requests": 312,
      "executions": 634,
      "injected_stale": 167,
      "blocked_authority": 725,
      "blocked_duplicate": 258,
      "external_failures": 107,
      "external_timeouts": 96,
      "stale_detected_items": 167,
      "disagreements_before_reconcile": 32,
      "failures": {
        "F1_unauthorized": 0,
        "F2_duplicate": 0,
        "F3_undetected_stale": 0,
        "F4_disagreement": 0,
        "items_failed": 0
      }
    },
    "naive": {
      "F1_unauthorized": 366,
      "F2_duplicate": 85,
      "F4_disagreement": 82,
      "items_failed": 533
    }
  },
  "seed_123": {
    "controlled": {
      "unauthorized_requests": 735,
      "duplicate_requests": 303,
      "executions": 631,
      "injected_stale": 202,
      "blocked_authority": 735,
      "blocked_duplicate": 258,
      "external_failures": 110,
      "external_timeouts": 95,
      "stale_detected_items": 202,
      "disagreements_before_reconcile": 48,
      "failures": {
        "F1_unauthorized": 0,
        "F2_duplicate": 0,
        "F3_undetected_stale": 0,
        "F4_disagreement": 0,
        "items_failed": 0
      }
    },
    "naive": {
      "F1_unauthorized": 369,
      "F2_duplicate": 101,
      "F4_disagreement": 101,
      "items_failed": 571
    }
  }
}
```
