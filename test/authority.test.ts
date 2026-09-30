import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ACTION_TYPES, SITUATION_STATES, canTransition } from '../src/domain.ts';
import { policyFor } from '../src/policy.ts';
import { EVENTS, kinds, makeEngine } from './helpers.ts';

describe('authority and approval gates', () => {
  it('lets an autonomous action execute without approval', async () => {
    const engine = makeEngine();
    const item = await engine.intake(EVENTS.reply);
    const r = await engine.execute(item.id);
    assert.equal(r.outcome, 'closed');
  });

  it('FAILURE CASE 3: blocks an approval-required action that has not been approved', async () => {
    const engine = makeEngine();
    const item = await engine.intake(EVENTS.refund);
    assert.equal(item.state, 'NOW', 'the refund requires action now...');

    const r = await engine.execute(item.id);
    assert.equal(r.outcome, 'blocked');
    assert.equal(r.outcome === 'blocked' && r.code, 'authority');
    assert.equal(r.item.state, 'NOW', '...and stays actionable, but gated');
    assert.equal(r.item.approval_status, 'pending');
    assert.equal(engine.external.list().length, 0, 'nothing reached the external system');
    assert.ok(kinds(engine, item.id).includes('authority_blocked'));
  });

  it('executes an approval-required action only after approval', async () => {
    const engine = makeEngine();
    const item = await engine.intake(EVENTS.refund);
    engine.approve(item.id, 'dana (billing lead)');
    const r = await engine.execute(item.id);
    assert.equal(r.outcome, 'closed');
    assert.equal(engine.external.list().length, 1);
  });

  it('does not infer authority from a prior approval of the same action type', async () => {
    const engine = makeEngine();
    const first = await engine.intake(EVENTS.refund);
    engine.approve(first.id, 'dana');
    await engine.execute(first.id);

    const second = await engine.intake('Another customer was double-charged and is requesting a refund.');
    const r = await engine.execute(second.id);
    assert.equal(r.outcome, 'blocked');
    assert.equal(r.outcome === 'blocked' && r.code, 'authority');
  });

  it('never executes a human-only action, even when a human moves it to NOW', async () => {
    const engine = makeEngine();
    const item = await engine.intake(EVENTS.pricing);
    assert.equal(item.authority, 'human_only');
    assert.equal(item.state, 'DECISIONS');

    engine.transition(item.id, 'NOW', 'someone promoted it');
    const r = await engine.execute(item.id);
    assert.equal(r.outcome, 'blocked');
    assert.equal(r.item.state, 'DECISIONS', 'rerouted back to DECISIONS');
    assert.throws(() => engine.approve(item.id, 'dana'), /human-only/);
  });

  it('closes a human-only item only through a recorded human decision', async () => {
    const engine = makeEngine();
    const item = await engine.intake(EVENTS.pricing);
    const closed = engine.decide(item.id, 'close', 'vp sales', 'declined: price stays');
    assert.equal(closed.state, 'CLOSED');
    assert.match(closed.closed_reason ?? '', /vp sales/);
    assert.ok(kinds(engine, item.id).includes('decision_recorded'));
  });

  it('routes a rejected approval to DECISIONS and keeps it blocked', async () => {
    const engine = makeEngine();
    const item = await engine.intake(EVENTS.refund);
    const rejected = engine.reject(item.id, 'dana', 'charge was valid');
    assert.equal(rejected.state, 'DECISIONS');
    assert.equal(rejected.approval_status, 'rejected');
    const r = await engine.execute(item.id);
    assert.equal(r.outcome, 'blocked');
  });

  it('holds for every possible classifier output: no gated action reaches the external system without approval', async () => {
    // Whatever the classifier (rules or LLM) returns, authority is enforced on the
    // action actually sent downstream. Enumerates the full output space.
    for (const state of SITUATION_STATES) {
      for (const action of ACTION_TYPES) {
        const engine = makeEngine();
        const item = engine.createItem('any text', { state, action_type: action, summary: 's', next_action: 'n', trigger: '', rationale: 'enumerated' }, 'enumerated');
        if (item.state !== 'NOW' && canTransition(item.state, 'NOW')) engine.transition(item.id, 'NOW', 'force current');
        await engine.execute(item.id);

        const sent = engine.external.list(item.id);
        const expected = policyFor(action).external && policyFor(action).authority === 'autonomous' ? 1 : 0;
        assert.equal(sent.length, expected, `${state}/${action}`);
        for (const rec of sent) assert.equal(rec.action_type, item.action_type, 'downstream action is the one authority was checked for');
      }
    }
  });

  it('requires an approver identity', async () => {
    const engine = makeEngine();
    const item = await engine.intake(EVENTS.refund);
    assert.throws(() => engine.approve(item.id, '  '), /approver/);
  });
});
