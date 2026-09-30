import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SCENARIOS } from '../src/scenarios.ts';
import { makeEngine } from './helpers.ts';

// Runs each Failure Lab button's setup, then the final step a presenter clicks,
// so the interactive demo cannot silently break.

describe('Failure Lab scenarios', () => {
  it('stale state: set up as disagreement, fixed by Reconcile', async () => {
    const engine = makeEngine();
    const { item } = await SCENARIOS.stale_state.run(engine);
    assert.deepEqual([item.state, item.action_status], ['NOW', 'in_flight']);
    assert.equal(engine.external.list(item.id)[0].status, 'succeeded');

    const report = await engine.reconcile();
    assert.equal(report.stale_corrected, 1);
    assert.equal(engine.get(item.id).state, 'CLOSED');
  });

  it('duplicate action: set up as CLOSED, re-Execute is blocked', async () => {
    const engine = makeEngine();
    const { item } = await SCENARIOS.duplicate_action.run(engine);
    assert.equal(item.state, 'CLOSED');

    const r = await engine.execute(item.id);
    assert.equal(r.outcome === 'blocked' && r.code, 'duplicate');
    assert.equal(engine.external.sideEffectsByItem().get(item.id), 1);
  });

  it('authority violation: urgent refund, Execute without approval is blocked', async () => {
    const engine = makeEngine();
    const { item } = await SCENARIOS.authority_violation.run(engine);
    assert.deepEqual([item.state, item.authority, item.approval_status], ['NOW', 'approval_required', 'pending']);

    const r = await engine.execute(item.id);
    assert.equal(r.outcome === 'blocked' && r.code, 'authority');
    assert.equal(engine.external.list().length, 0);
  });

  it('external failure: failure is not reported as completion', async () => {
    const engine = makeEngine();
    const { item } = await SCENARIOS.external_failure.run(engine);
    assert.deepEqual([item.state, item.action_status, item.closed_reason], ['DECISIONS', 'failed', null]);
    assert.equal(engine.external.list(item.id)[0].side_effects, 0);
  });
});
