// Control-path evaluation under fault injection.
//
// What it evaluates: the deterministic engine + simulated dispatch service. The classifier
// is bypassed (items are created with a fixed classification), so this says nothing about
// classification accuracy.
//
// Workload: seeded pseudo-random, therefore generated AND exactly reproducible. For each seed,
// N items are drawn with a random action type (all three authority levels), a random fault for
// the execution, and random operator behavior. Then reconciliation runs twice.
//
// An ITEM FAILS if any of these is true after reconciliation:
//   F1 unauthorized side effect: the dispatch ledger shows a side effect for a human-only item,
//      or for an approval-required item that was never approved
//   F2 duplicate side effect:    the dispatch ledger shows more than 1 side effect for the item
//   F3 undetected stale state:   the item's result was lost (crash after success) or unknown
//      (timeout that later succeeds) and the engine never logged stale_detected for it
//   F4 unresolved disagreement:  "closed as succeeded" in the Situation Model != "succeeded" in
//      the dispatch ledger
//
// The same workload also runs through a naive executor (no authority check, no stable
// idempotency key, no reconciliation) as an ablation.
//
//   node eval/run-scenarios.ts [--items 1000] [--seeds 1,7,123]

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type { ActionType, Classification } from '../src/domain.ts';
import { Engine, SimulatedCrash, type Fault } from '../src/engine.ts';
import { DispatchService, ExternalTimeoutError } from '../src/external/dispatch-service.ts';
import { policyFor } from '../src/policy.ts';
import { Store } from '../src/store.ts';

const { values } = parseArgs({ options: { items: { type: 'string', default: '1000' }, seeds: { type: 'string', default: '1,7,123' } } });
const N = Number(values.items);
const SEEDS = String(values.seeds).split(',').map(Number);

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ACTIONS: ActionType[] = ['send_customer_reply', 'send_status_update', 'issue_refund', 'restart_service', 'publish_announcement', 'change_commercial_terms', 'grant_access'];

interface Plan {
  action: ActionType;
  approve: boolean;            // a human approves (approval-required only), 80%
  unauthorizedFirst: boolean;  // operator tries to execute a gated item before approval, 50%
  fault: Fault;                // 55% none, 15% external failure, 15% timeout, 15% crash after success
  duplicateRequest: boolean;   // operator clicks execute again right after, 50%
}

function makePlans(seed: number): Plan[] {
  const r = rng(seed);
  return Array.from({ length: N }, () => {
    const action = ACTIONS[Math.floor(r() * ACTIONS.length)];
    const x = r();
    const fault: Fault = x < 0.55 ? 'none' : x < 0.7 ? 'external_failure' : x < 0.85 ? 'external_timeout' : 'crash_after_success';
    return { action, approve: r() < 0.8, unauthorizedFirst: r() < 0.5, fault, duplicateRequest: r() < 0.5 };
  });
}

const authorized = (p: Plan) => {
  const a = policyFor(p.action).authority;
  return a === 'autonomous' || (a === 'approval_required' && p.approve);
};

// ------------------------------------------------------------------ controlled run

async function runControlled(plans: Plan[]) {
  const external = new DispatchService(':memory:', { pendingPolls: 1 });
  const engine = new Engine(new Store(), external);
  const planById = new Map<string, Plan>();
  const ops = { unauthorized_requests: 0, duplicate_requests: 0, executions: 0, injected_stale: 0 };

  for (const p of plans) {
    const c: Classification = { state: 'NOW', action_type: p.action, summary: `sim ${p.action}`, next_action: 'sim', trigger: '', rationale: 'simulation' };
    const item = engine.createItem(`simulated ${p.action}`, c, 'simulation');
    planById.set(item.id, p);
    const authority = policyFor(p.action).authority;

    if (authority !== 'autonomous' && p.unauthorizedFirst) {
      ops.unauthorized_requests++;
      await engine.execute(item.id, 'none', 'operator');
    }
    if (!authorized(p)) {
      ops.unauthorized_requests++;
      await engine.execute(item.id, 'none', 'operator'); // always attempted: must never succeed
      continue;
    }
    if (authority === 'approval_required') engine.approve(item.id, 'sim-approver');
    ops.executions++;
    if (p.fault === 'crash_after_success' || p.fault === 'external_timeout') ops.injected_stale++;
    try {
      await engine.execute(item.id, p.fault, 'operator');
    } catch (err) {
      if (!(err instanceof SimulatedCrash)) throw err;
    }
    if (p.duplicateRequest) {
      ops.duplicate_requests++;
      await engine.execute(item.id, 'none', 'operator');
    }
  }

  const disagreementsBefore = engine.list().filter((i) => disagrees(engine, external, i.id)).length;
  await engine.reconcile();
  await engine.reconcile();

  const staleDetected = new Set(
    (engine.store.db.prepare("SELECT DISTINCT item_id FROM history WHERE kind = 'stale_detected'").all() as { item_id: string }[]).map((r) => r.item_id),
  );
  const sideEffects = external.sideEffectsByItem();
  const failures = { F1_unauthorized: 0, F2_duplicate: 0, F3_undetected_stale: 0, F4_disagreement: 0, items_failed: 0 };
  for (const item of engine.list()) {
    const p = planById.get(item.id)!;
    const n = sideEffects.get(item.id) ?? 0;
    const f1 = !authorized(p) && n > 0;
    const f2 = n > 1;
    const f3 = authorized(p) && (p.fault === 'crash_after_success' || p.fault === 'external_timeout') && !staleDetected.has(item.id);
    const f4 = disagrees(engine, external, item.id);
    failures.F1_unauthorized += +f1;
    failures.F2_duplicate += +f2;
    failures.F3_undetected_stale += +f3;
    failures.F4_disagreement += +f4;
    failures.items_failed += +(f1 || f2 || f3 || f4);
  }
  const m = engine.metrics();
  return {
    ...ops,
    blocked_authority: m.unauthorized_executions_blocked,
    blocked_duplicate: m.duplicate_executions_blocked,
    external_failures: m.external_failures,
    external_timeouts: m.external_timeouts,
    stale_detected_items: staleDetected.size,
    disagreements_before_reconcile: disagreementsBefore,
    failures,
  };
}

function disagrees(engine: Engine, external: DispatchService, id: string): boolean {
  const item = engine.get(id);
  const externallyDone = external.list(id).some((r) => r.status === 'succeeded');
  const internallyDone = item.state === 'CLOSED' && item.action_status === 'succeeded';
  return externallyDone !== internallyDone;
}

// ------------------------------------------------------------------ naive ablation

async function runNaive(plans: Plan[]) {
  const external = new DispatchService(':memory:', { pendingPolls: 1 });
  const done = new Map<string, boolean>();
  let seq = 0;

  const naiveExecute = async (id: string, action: ActionType, fault: Fault) => {
    if (done.get(id)) return; // trusts only its own (possibly stale) record
    const key = `${id}:${++seq}`; // no stable idempotency key
    try {
      const rec = await external.submit(key, id, action, fault === 'crash_after_success' ? 'none' : fault);
      if (fault === 'crash_after_success') return; // result lost; stays "not done"
      if (rec.status === 'succeeded') done.set(id, true);
    } catch (err) {
      if (!(err instanceof ExternalTimeoutError)) throw err; // timeout treated as "not done"
    }
  };

  for (const [i, p] of plans.entries()) {
    const id = `N-${i}`;
    await naiveExecute(id, p.action, authorized(p) ? p.fault : 'none'); // no authority check
    if (authorized(p) && p.duplicateRequest) await naiveExecute(id, p.action, 'none');
  }
  for (const r of external.list()) await external.status(r.idempotency_key); // pending work settles

  const sideEffects = external.sideEffectsByItem();
  let f1 = 0, f2 = 0, f4 = 0, failed = 0;
  for (const [i, p] of plans.entries()) {
    const id = `N-${i}`;
    const n = sideEffects.get(id) ?? 0;
    const a = !authorized(p) && n > 0;
    const b = n > 1;
    const d = (n > 0) !== Boolean(done.get(id));
    f1 += +a; f2 += +b; f4 += +d; failed += +(a || b || d);
  }
  return { F1_unauthorized: f1, F2_duplicate: f2, F4_disagreement: f4, items_failed: failed };
}

// ------------------------------------------------------------------ report

const rows: string[] = [];
const raw: Record<string, unknown> = {};
for (const seed of SEEDS) {
  const plans = makePlans(seed);
  const c = await runControlled(plans);
  const n = await runNaive(plans);
  raw[`seed_${seed}`] = { controlled: c, naive: n };
  rows.push(`| ${seed} | ${N} | ${c.unauthorized_requests} | ${c.duplicate_requests} | ${c.injected_stale} | ${c.failures.F1_unauthorized} | ${c.failures.F2_duplicate} | ${c.failures.F3_undetected_stale} | ${c.failures.F4_disagreement} | **${c.failures.items_failed}** | ${n.items_failed} (F1 ${n.F1_unauthorized}, F2 ${n.F2_duplicate}, F4 ${n.F4_disagreement}) |`);
}

const report = [
  `# Control-path evaluation (items=${N} per seed, seeds=${SEEDS.join(', ')})`,
  '',
  'Reproduce: `npm run eval:scenarios`. Deterministic for a given seed.',
  '',
  'Evaluated component: deterministic engine + simulated dispatch service. Classifier bypassed.',
  'Faults per authorized execution: 55% none, 15% external failure, 15% timeout (settles to success), 15% crash after success.',
  'Operator: 50% try gated items before approval, 50% re-click Execute, 20% of approval-required items never approved.',
  '',
  'An item fails on: F1 unauthorized side effect, F2 duplicate side effect, F3 undetected stale state, F4 internal/external disagreement after reconciliation.',
  '',
  '| Seed | Items | Unauthorized requests | Duplicate requests | Stale injected | F1 | F2 | F3 | F4 | Items failed | Naive ablation: items failed |',
  '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ...rows,
  '',
  '```json',
  JSON.stringify(raw, null, 2),
  '```',
].join('\n');

console.log(report);
mkdirSync(join(import.meta.dirname, 'results'), { recursive: true });
writeFileSync(join(import.meta.dirname, 'results', 'control-path.md'), report + '\n');
