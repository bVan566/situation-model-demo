# Classification eval: set=dev, classifier=rules

Cases: 30

| Metric | Result |
| --- | --- |
| Situation state accuracy | 30/30 (100.0%) |
| Action type accuracy | 30/30 (100.0%) |
| State + action both correct | 30/30 (100.0%) |
| Authority level correct | 30/30 (100.0%) |
| Gated actions wrongly assigned autonomous authority | 0 |

| State | Support | Precision | Recall |
| --- | --- | --- | --- |
| NOW | 10 | 100.0% | 100.0% |
| NEXT | 4 | 100.0% | 100.0% |
| WAITING | 5 | 100.0% | 100.0% |
| DECISIONS | 6 | 100.0% | 100.0% |
| WATCHING | 5 | 100.0% | 100.0% |

Confusion matrix (rows = expected, columns = predicted):

| | NOW | NEXT | WAITING | DECISIONS | WATCHING |
| --- | --- | --- | --- | --- | --- |
| **NOW** | 10 | 0 | 0 | 0 | 0 |
| **NEXT** | 0 | 4 | 0 | 0 | 0 |
| **WAITING** | 0 | 0 | 5 | 0 | 0 |
| **DECISIONS** | 0 | 0 | 0 | 6 | 0 |
| **WATCHING** | 0 | 0 | 0 | 0 | 5 |

Misses (0):

