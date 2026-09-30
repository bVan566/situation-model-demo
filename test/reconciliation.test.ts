import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SimulatedCrash } from '../src/engine.ts';
import { EVENTS, kinds, makeEngine } from './helpers.ts';

async function staleItem() {
  const engine = makeEngine();
  const item = await engine.intake(EVENTS.reply);
  await assert.rejects(engine.execute(item.id, 'crash_after_success'), SimulatedCrash);
  return { engine, id: item.id };
}

describe('reconciliation', () => {
  it('FAILURE CASE 1: detects a stale state and corrects it from the external source of truth', async () => {
    const { engine, id } = await staleItem();

    // Internal model and external system now disagree.
    const before = engine.get(id);
    assert.equal(before.state, 'NOW');
    assert.equal(before.action_status, 'in_flight');
    assert.equal(engine.external.list(id)[0].status, 'succeeded');

    const report = await engine.reconcile();
    assert.equal(report.stale_corrected, 1);

    const after = engine.get(id);
    assert.equal(after.state, 'CLOSED');
    assert.equal(after.action_status, 'succeeded');
    assert.match(after.closed_reason ?? '', /reconciliation/);
    assert.ok(kinds(engine, id).includes('stale_detected'));

    // Idempotent: a second pass finds nothing to fix.
    const again = await engine.reconcile();
    assert.equal(again.stale_corrected, 0);
    assert.equal(again.consistent, 1);
  });

  it('FAILURE CASE 2: blocks duplicate execution of a completed action', async () => {
    const engine = makeEngine();
    const item = await engine.intake(EVENTS.reply);
    await engine.execute(item.id);

    const r = await engine.execute(item.id);
    assert.equal(r.outcome === 'blocked' && r.code, 'duplicate');
    assert.equal(engine.external.list(item.id).length, 1);
    assert.equal(engine.external.sideEffectsByItem().get(item.id), 1);
  });

  it('blocks a duplicate even when internal state is stale, by checking the external ledger first', async () => {
    const { engine, id } = await staleItem();

    const r = await engine.execute(id); // operator sees "NOW" and clicks execute again
    assert.equal(r.outcome === 'blocked' && r.code, 'duplicate');
    assert.equal(r.item.state, 'CLOSED', 'the stale state was reconciled inline');
    assert.equal(engine.external.sideEffectsByItem().get(id), 1, 'the side effect happened exactly once');
    assert.equal(engine.store.attempts(id).length, 1, 'no second attempt was created');
  });

  it('settles a timed-out action: still pending, then succeeded', async () => {
    const engine = makeEngine({ pendingPolls: 2 });
    const item = await engine.intake(EVENTS.reply);
    await engine.execute(item.id, 'external_timeout');

    const first = await engine.reconcile(item.id);
    assert.equal(first.still_pending, 1);
    assert.equal(engine.get(item.id).state, 'WAITING');

    const second = await engine.reconcile(item.id);
    assert.equal(second.stale_corrected, 1);
    assert.equal(engine.get(item.id).state, 'CLOSED');
  });

  it('surfaces uncertainty when internal success has no external record', async () => {
    const engine = makeEngine();
    const item = await engine.intake(EVENTS.reply);
    await engine.execute(item.id, 'external_failure');
    engine.decide(item.id, 'retry', 'ops');
    // Corrupt internal state: claim success that never happened externally.
    engine.store.insertAttempt({ item_id: item.id, idempotency_key: 'bogus-key', action_type: 'send_customer_reply', status: 'succeeded', detail: 'forged', started_at: 'x', finished_at: 'x' });
    engine.store.updateItem(item.id, { action_status: 'succeeded' });

    const report = await engine.reconcile(item.id);
    assert.equal(report.anomalies, 1);
    const after = engine.get(item.id);
    assert.equal(after.state, 'DECISIONS', 'completion is not invented');
    assert.notEqual(after.state, 'CLOSED');
  });

  it('does not retry a recent in-flight attempt that has no external record yet (may be in transit)', async () => {
    const engine = makeEngine();
    const item = await engine.intake(EVENTS.reply);
    const justNow = new Date(Date.parse(item.created_at) + 1000).toISOString();
    engine.store.insertAttempt({ item_id: item.id, idempotency_key: `${item.id}:send_customer_reply:1`, action_type: 'send_customer_reply', status: 'in_flight', detail: '', started_at: justNow, finished_at: null });
    engine.store.updateItem(item.id, { action_status: 'in_flight' });

    const r = await engine.execute(item.id);
    assert.equal(r.outcome === 'blocked' && r.code, 'in_progress');
    assert.equal(engine.external.list(item.id).length, 0, 'nothing was re-submitted');
    assert.equal((await engine.reconcile(item.id)).still_pending, 1);
  });

  it('clears an old attempt that never reached the external system so it can be retried safely', async () => {
    const engine = makeEngine();
    const item = await engine.intake(EVENTS.reply);
    engine.store.insertAttempt({ item_id: item.id, idempotency_key: `${item.id}:send_customer_reply:1`, action_type: 'send_customer_reply', status: 'in_flight', detail: '', started_at: '2026-08-31T00:00:00.000Z', finished_at: null });
    engine.store.updateItem(item.id, { action_status: 'in_flight' });

    const report = await engine.reconcile(item.id);
    assert.equal(report.not_delivered, 1);
    const r = await engine.execute(item.id);
    assert.equal(r.outcome, 'closed');
    assert.equal(engine.external.sideEffectsByItem().get(item.id), 1);
  });
});
