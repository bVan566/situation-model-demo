// The 60-second demo as a terminal walkthrough, against a fresh in-memory system.
//   node scripts/demo.ts

import { Engine, SimulatedCrash } from '../src/engine.ts';
import { DispatchService } from '../src/external/dispatch-service.ts';
import { Store } from '../src/store.ts';

const engine = new Engine(new Store(), new DispatchService());
const event = 'Customer was charged twice for order 4417 and is requesting a refund of the duplicate charge.';

let n = 0;
const step = (title: string) => console.log(`\n\x1b[1m${++n}. ${title}\x1b[0m`);
const show = (label: string, value: unknown) => console.log(`   ${label.padEnd(20)} ${value}`);

step('Submit an operational event');
show('event', `"${event}"`);
const item = await engine.intake(event);

step('Situation Model classification (classifier)');
show('state', item.state);
show('action type', item.action_type);
show('rationale', item.classifier_rationale);

step('Authority assignment (deterministic policy)');
show('authority', item.authority);
show('approval', item.approval_status);
show('owner', item.owner);
show('terminal condition', item.terminal_condition);

step('Attempt the gated action without approval');
let r = await engine.execute(item.id);
show('outcome', `${r.outcome}${r.outcome === 'blocked' ? ` (${r.code})` : ''}`);
show('detail', r.detail);
show('external records', engine.external.list(item.id).length);

step('Human approves');
const approved = engine.approve(item.id, 'Dana, billing lead');
show('approval', `${approved.approval_status} by ${approved.approved_by} (bound to ${approved.id} only)`);

step('Execute the external action, and the process crashes after the dispatch service succeeds');
try {
  await engine.execute(item.id, 'crash_after_success');
} catch (err) {
  if (!(err instanceof SimulatedCrash)) throw err;
  show('crash', err.message);
}

step('Stale state exposed: the two systems disagree');
const stale = engine.get(item.id);
show('situation model', `${stale.state} / action ${stale.action_status}`);
show('dispatch service', engine.external.list(item.id).map((e) => `${e.idempotency_key} ${e.status}`).join(', '));

step('Run reconciliation');
const rep = await engine.reconcile();
show('stale corrected', rep.stale_corrected);
for (const f of rep.findings) show(f.item_id, f.detail);

step('Corrected state');
const fixed = engine.get(item.id);
show('state', fixed.state);
show('closed reason', fixed.closed_reason);

step('Attempt duplicate execution');
r = await engine.execute(item.id);
show('outcome', `${r.outcome}${r.outcome === 'blocked' ? ` (${r.code})` : ''}`);
show('detail', r.detail);
show('side effects', `${engine.external.sideEffectsByItem().get(item.id)} (exactly once)`);

console.log('\nMetrics:', engine.metrics());
