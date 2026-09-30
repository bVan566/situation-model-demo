import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EVENTS, kinds, makeEngine } from './helpers.ts';

describe('external action lifecycle and terminal handling', () => {
  it('closes only after the external success is verified', async () => {
    const engine = makeEngine();
    const item = await engine.intake(EVENTS.reply);
    const r = await engine.execute(item.id);
    assert.equal(r.outcome, 'closed');
    assert.equal(r.item.action_status, 'succeeded');
    assert.match(r.item.closed_reason ?? '', /verified/);
    assert.ok(r.item.last_verified_at);
    const k = kinds(engine, item.id);
    assert.ok(k.indexOf('execution_started') < k.indexOf('execution_succeeded'));
    assert.equal(engine.store.attempts(item.id)[0].status, 'succeeded');
  });

  it('EXTERNAL FAILURE: does not report completion and routes to DECISIONS', async () => {
    const engine = makeEngine();
    const item = await engine.intake(EVENTS.reply);
    const r = await engine.execute(item.id, 'external_failure');
    assert.equal(r.outcome, 'failed');
    assert.equal(r.item.state, 'DECISIONS');
    assert.equal(r.item.action_status, 'failed');
    assert.equal(r.item.closed_reason, null);
  });

  it('allows a human-approved retry after a failure, with a new idempotency key', async () => {
    const engine = makeEngine();
    const item = await engine.intake(EVENTS.reply);
    await engine.execute(item.id, 'external_failure');
    engine.decide(item.id, 'retry', 'ops lead');
    const r = await engine.execute(item.id);
    assert.equal(r.outcome, 'closed');
    const keys = engine.store.attempts(item.id).map((a) => a.idempotency_key);
    assert.deepEqual(keys, [`${item.id}:send_customer_reply:1`, `${item.id}:send_customer_reply:2`]);
  });

  it('TIMEOUT: moves the item to WAITING with unknown status instead of assuming success', async () => {
    const engine = makeEngine();
    const item = await engine.intake(EVENTS.reply);
    const r = await engine.execute(item.id, 'external_timeout');
    assert.equal(r.outcome, 'pending');
    assert.equal(r.item.state, 'WAITING');
    assert.equal(r.item.action_status, 'unknown');
  });

  it('does not re-submit while an earlier attempt is still pending externally', async () => {
    const engine = makeEngine({ pendingPolls: 3 });
    const item = await engine.intake(EVENTS.reply);
    await engine.execute(item.id, 'external_timeout');
    const r = await engine.execute(item.id);
    assert.equal(r.outcome === 'blocked' && r.code, 'in_progress');
    assert.equal(engine.external.list().length, 1);
  });

  it('refuses to execute items with no external action', async () => {
    const engine = makeEngine();
    const item = await engine.intake(EVENTS.watching);
    engine.transition(item.id, 'NOW', 'threshold crossed');
    const r = await engine.execute(item.id);
    assert.equal(r.outcome === 'blocked' && r.code, 'no_action');
  });
});
